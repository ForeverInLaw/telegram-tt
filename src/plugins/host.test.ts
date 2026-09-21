import { describe, expect, it } from 'vitest';

import type { ApiMessage } from '../api/types';
import type { TgPluginRuntime } from './runtime';
import type { TgPluginApi } from './types';

import {
  disablePlugin, enablePlugin, getPluginList, initPlugins, loadPluginModule, togglePlugin,
} from './host';
import { getMessageContextMenuItems } from './registry';

type CapturedError = { pluginName: string; action: string; error: unknown };

/** In-memory runtime double: a storage map plus captured per-plugin logs. */
function createFakeRuntime(enabledMap: Record<string, boolean> = {}) {
  const capturedErrors: CapturedError[] = [];

  const runtime: TgPluginRuntime = {
    isPluginEnabled: (pluginName) => enabledMap[pluginName] !== false,
    setPluginEnabled: (pluginName, isEnabled) => {
      enabledMap[pluginName] = isEnabled;
    },
    // Facade services are stubbed out; the lifecycle tests never dispatch them
    getActions: () => {
      throw new Error('not exercised');
    },
    getCurrentTabId: () => 0,
    mainThreadId: -1,
    getActiveMessageList: () => undefined,
    getActiveChatId: () => undefined,
    getCurrentUserId: () => undefined,
    getChat: () => undefined,
    getLocalizedString: (key) => key,
    createPluginReporter: (pluginName) => ({
      log: () => {},
      logError: (action, error) => {
        capturedErrors.push({ pluginName, action, error });
      },
      wrap: (callback) => (...args) => {
        try {
          callback(...args);
        } catch (error) {
          capturedErrors.push({ pluginName, action: 'callback failed', error });
        }
      },
    }),
  };

  return { runtime, capturedErrors };
}

describe('plugin host lifecycle', () => {
  it('registers and sets up a valid plugin', () => {
    const { runtime } = createFakeRuntime();
    const setupCalls: TgPluginApi[] = [];

    loadPluginModule(
      { name: 'alpha', setup: (tg) => { setupCalls.push(tg); } },
      'plugins/alpha/index.ts',
      runtime,
    );

    expect(setupCalls).toHaveLength(1);
    expect(getPluginList().find((plugin) => plugin.name === 'alpha')?.isEnabled).toBe(true);
  });

  it('skips modules without a valid default TgPlugin export', () => {
    const { runtime } = createFakeRuntime();

    loadPluginModule(undefined, 'plugins/empty/index.ts', runtime);
    loadPluginModule({ name: 'no-setup' }, 'plugins/no-setup/index.ts', runtime);
    loadPluginModule({ setup: () => {} }, 'plugins/no-name/index.ts', runtime);
    loadPluginModule({ name: '', setup: () => {} }, 'plugins/empty-name/index.ts', runtime);

    const names = getPluginList().map((plugin) => plugin.name);
    expect(names).not.toContain('no-setup');
    expect(names).not.toContain('');
  });

  it('skips a module whose plugin name is already registered', () => {
    const { runtime } = createFakeRuntime();
    let secondSetupRan = false;

    loadPluginModule({ name: 'dupe', setup: () => {} }, 'plugins/dupe/index.ts', runtime);
    loadPluginModule({
      name: 'dupe',
      setup: () => {
        secondSetupRan = true;
      },
    }, 'plugins/dupe-2/index.ts', runtime);

    expect(secondSetupRan).toBe(false);
    expect(getPluginList().filter((plugin) => plugin.name === 'dupe')).toHaveLength(1);
  });

  it('registers a disabled plugin without running its setup', () => {
    const { runtime } = createFakeRuntime({ 'disabled-one': false });
    let setupRan = false;

    loadPluginModule(
      { name: 'disabled-one', setup: () => { setupRan = true; } },
      'plugins/disabled-one/index.ts',
      runtime,
    );

    expect(setupRan).toBe(false);
    expect(getPluginList().find((plugin) => plugin.name === 'disabled-one')?.isEnabled).toBe(false);
  });

  it('runs the disposer and clears registry entries on disable', () => {
    const { runtime } = createFakeRuntime();
    const events: string[] = [];

    loadPluginModule({
      name: 'toggle-me',
      setup: (tg) => {
        tg.ui.addMessageContextMenuItem({
          label: 'Toggle me item',
          onClick: () => {
            events.push('click');
          },
        });
        return () => {
          events.push('disposer');
        };
      },
    }, 'plugins/toggle-me/index.ts', runtime);

    disablePlugin('toggle-me', runtime);

    expect(events).toEqual(['disposer']);
    expect(getMessageContextMenuItems().some((item) => item.label === 'Toggle me item')).toBe(false);
    expect(getPluginList().find((plugin) => plugin.name === 'toggle-me')?.isEnabled).toBe(false);
  });

  it('re-runs setup with a fresh tg object on enable and restores contributions', () => {
    const { runtime } = createFakeRuntime();
    const tgObjects: TgPluginApi[] = [];

    loadPluginModule({
      name: 're-enable-me',
      setup: (tg) => {
        tgObjects.push(tg);
        tg.ui.addMessageContextMenuItem({ label: 'Re-enable item', onClick: () => {} });
      },
    }, 'plugins/re-enable-me/index.ts', runtime);

    disablePlugin('re-enable-me', runtime);
    expect(getMessageContextMenuItems().some((item) => item.label === 'Re-enable item')).toBe(false);

    enablePlugin('re-enable-me', runtime);

    expect(tgObjects).toHaveLength(2);
    expect(tgObjects[0]).not.toBe(tgObjects[1]);
    expect(getMessageContextMenuItems().some((item) => item.label === 'Re-enable item')).toBe(true);
    expect(getPluginList().find((plugin) => plugin.name === 're-enable-me')?.isEnabled).toBe(true);
  });

  it('contains a throwing setup and keeps other plugins running', () => {
    const { runtime, capturedErrors } = createFakeRuntime();
    let otherSetupRan = false;

    loadPluginModule(
      { name: 'boom', setup: () => { throw new Error('boom'); } },
      'plugins/boom/index.ts',
      runtime,
    );
    loadPluginModule(
      { name: 'after-boom', setup: () => { otherSetupRan = true; } },
      'plugins/after-boom/index.ts',
      runtime,
    );

    expect(otherSetupRan).toBe(true);
    expect(capturedErrors.some(
      (entry) => entry.pluginName === 'boom' && entry.action === 'setup failed',
    )).toBe(true);
    expect(getPluginList().find((plugin) => plugin.name === 'boom')?.isEnabled).toBe(false);
  });

  it('clears partially registered contributions when setup throws', () => {
    const { runtime } = createFakeRuntime();

    loadPluginModule({
      name: 'partial-boom',
      setup: (tg) => {
        tg.ui.addMessageContextMenuItem({ label: 'Partial item', onClick: () => {} });
        throw new Error('boom');
      },
    }, 'plugins/partial-boom/index.ts', runtime);

    expect(getMessageContextMenuItems().some((item) => item.label === 'Partial item')).toBe(false);
  });

  it('contains a throwing plugin callback', () => {
    const { runtime, capturedErrors } = createFakeRuntime();

    loadPluginModule({
      name: 'throwing-callback',
      setup: (tg) => {
        tg.ui.addMessageContextMenuItem({
          label: 'Throwing item',
          onClick: () => { throw new Error('click boom'); },
        });
      },
    }, 'plugins/throwing-callback/index.ts', runtime);

    const item = getMessageContextMenuItems().find((menuItem) => menuItem.label === 'Throwing item');
    expect(item).toBeDefined();

    expect(() => item?.onClick({ id: 1, chatId: '1' } as ApiMessage)).not.toThrow();
    expect(capturedErrors.some(
      (entry) => entry.pluginName === 'throwing-callback' && entry.action === 'callback failed',
    )).toBe(true);
  });

  it('keeps a disabled plugin disabled across re-initialization with a fresh runtime', () => {
    const enabledMap: Record<string, boolean> = {};
    initPlugins(createFakeRuntime(enabledMap).runtime);

    expect(getPluginList().find((plugin) => plugin.name === 'hello-plugin')?.isEnabled).toBe(true);
    expect(getMessageContextMenuItems().some((item) => item.label === 'Plugin demo')).toBe(true);

    // `togglePlugin` closes over the runtime set by `initPlugins`.
    togglePlugin('hello-plugin', false);
    expect(getMessageContextMenuItems().some((item) => item.label === 'Plugin demo')).toBe(false);

    // A fresh runtime over the same storage simulates a page reload.
    initPlugins(createFakeRuntime(enabledMap).runtime);

    expect(getPluginList().find((plugin) => plugin.name === 'hello-plugin')?.isEnabled).toBe(false);
    expect(getMessageContextMenuItems().some((item) => item.label === 'Plugin demo')).toBe(false);

    togglePlugin('hello-plugin', true);
    expect(getMessageContextMenuItems().some((item) => item.label === 'Plugin demo')).toBe(true);
    expect(getPluginList().find((plugin) => plugin.name === 'hello-plugin')?.isEnabled).toBe(true);
  });

  it('lists the glob-loaded hello-plugin with its metadata', () => {
    initPlugins(createFakeRuntime().runtime);

    const helloPlugin = getPluginList().find((plugin) => plugin.name === 'hello-plugin');
    expect(helloPlugin?.version).toBe('0.1.0');
    expect(helloPlugin?.description).toBe('Adds a debug item to the message context menu.');
    expect(helloPlugin?.isEnabled).toBe(true);
  });
});

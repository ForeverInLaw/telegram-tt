import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiChat } from '../../api/types';
import type { PluginContext } from '../context';
import type { TgPluginReporter } from '../runtime';

const { showNotificationAction } = vi.hoisted(() => ({ showNotificationAction: vi.fn() }));

// The notification service (runtime.ts) reaches the app's global store and the
// multitab token; both load under jsdom, so only `getActions` is overridden —
// the real modules keep this suite aligned with what the runtime imports.
vi.mock('../../global', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../global')>();
  return {
    ...actual,
    getActions: () => ({ showNotification: showNotificationAction }),
  };
});
vi.mock('../../util/establishMultitabRole', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../util/establishMultitabRole')>();
  return {
    ...actual,
    getCurrentTabId: () => 12345,
  };
});

import { createPluginContext } from '../context';
import {
  getChatContextMenuItems, getComposerButtons, getMainMenuItems, getMessageContextMenuItems,
} from '../registry';
import { createUiSlice } from './ui';

type CapturedError = { action: string; error: unknown };

const TEST_PLUGIN_NAME = 'ui-slice-owner';

/** Builds a real plugin context over a capturing reporter, like the host does. */
function createTestContext(pluginName: string) {
  const capturedErrors: CapturedError[] = [];
  const reporter: TgPluginReporter = {
    log: () => {},
    logError: (action, error) => {
      capturedErrors.push({ action, error });
    },
    wrap: (callback) => (...args) => {
      try {
        callback(...args);
      } catch (error) {
        capturedErrors.push({ action: 'callback failed', error });
      }
    },
  };

  return { context: createPluginContext(pluginName, reporter), capturedErrors };
}

describe('ui slice', () => {
  let activeContext: PluginContext | undefined;

  beforeEach(() => {
    showNotificationAction.mockClear();
  });

  afterEach(() => {
    // Every test's context tears down its own contributions.
    activeContext?.runTeardowns();
    activeContext = undefined;
  });

  it('registers items on every surface in registration order', () => {
    const { context } = createTestContext(TEST_PLUGIN_NAME);
    activeContext = context;
    const ui = createUiSlice(context);

    ui.addMessageContextMenuItem({ label: 'Message item', onClick: () => {} });
    ui.addChatContextMenuItem({ label: 'Chat item', onClick: () => {} });
    ui.addMainMenuItem({ label: 'Main item', onClick: () => {} });
    ui.addComposerButton({ icon: 'star', label: 'Composer button', onClick: () => {} });

    expect(getMessageContextMenuItems().map((item) => item.label)).toEqual(['Message item']);
    expect(getChatContextMenuItems().map((item) => item.label)).toEqual(['Chat item']);
    expect(getMainMenuItems().map((item) => item.label)).toEqual(['Main item']);
    expect(getComposerButtons().map((item) => item.label)).toEqual(['Composer button']);
  });

  it('passes the descriptor payload to the wrapped callbacks', () => {
    const { context } = createTestContext(TEST_PLUGIN_NAME);
    activeContext = context;
    const ui = createUiSlice(context);
    const received: unknown[] = [];

    ui.addChatContextMenuItem({
      label: 'Chat item',
      onClick: (chat) => {
        received.push(chat);
      },
    });
    ui.addComposerButton({
      icon: 'star',
      label: 'Composer button',
      onClick: (composerContext) => {
        received.push(composerContext);
      },
    });

    const chatMenuItem = getChatContextMenuItems()[0];
    const composerButton = getComposerButtons()[0];

    const fakeChat = { id: 'chat-42' } as ApiChat;
    chatMenuItem.onClick(fakeChat);
    expect(received[0]).toBe(fakeChat);

    const composerContext = { chatId: 'chat-42', threadId: 5 };
    composerButton.onClick(composerContext);
    expect(received[1]).toEqual(composerContext);
  });

  it('contains a throwing handler at invocation and keeps the item registered', () => {
    const { context, capturedErrors } = createTestContext(TEST_PLUGIN_NAME);
    activeContext = context;
    const ui = createUiSlice(context);

    ui.addMainMenuItem({
      label: 'Throwing item',
      onClick: () => {
        throw new Error('item boom');
      },
    });

    const menuItem = getMainMenuItems()[0];
    expect(menuItem.label).toBe('Throwing item');

    expect(() => menuItem.onClick()).not.toThrow();
    expect(capturedErrors.some(({ action, error }) => (
      action === 'callback failed' && (error as Error).message === 'item boom'
    ))).toBe(true);
  });

  it('shows a notification with the descriptor payload, a fresh localId and the current tabId', () => {
    const { context } = createTestContext(TEST_PLUGIN_NAME);
    activeContext = context;
    const ui = createUiSlice(context);

    ui.showNotification({ title: 'Plugin title', message: 'Plugin body', icon: 'star', duration: 4000 });

    expect(showNotificationAction).toHaveBeenCalledTimes(1);
    expect(showNotificationAction).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Plugin title',
      message: 'Plugin body',
      icon: 'star',
      duration: 4000,
      tabId: 12345,
    }));

    const [payload] = showNotificationAction.mock.calls[0];
    expect(payload.localId).toMatch(/^plugin-notification-/);
  });

  it('stacks repeated notifications instead of deduping them by message', () => {
    const { context } = createTestContext(TEST_PLUGIN_NAME);
    activeContext = context;
    const ui = createUiSlice(context);

    ui.showNotification({ message: 'Repeated' });
    ui.showNotification({ message: 'Repeated' });

    expect(showNotificationAction).toHaveBeenCalledTimes(2);
    const [firstPayload, secondPayload] = showNotificationAction.mock.calls.map(([payload]) => payload);
    expect(firstPayload.localId).not.toBe(secondPayload.localId);
  });

  it('contains a throwing notification action and attributes it to the plugin', () => {
    const { context, capturedErrors } = createTestContext(TEST_PLUGIN_NAME);
    activeContext = context;
    const ui = createUiSlice(context);

    showNotificationAction.mockImplementationOnce(() => {
      throw new Error('action boom');
    });

    expect(() => ui.showNotification({ message: 'Broken' })).not.toThrow();
    expect(capturedErrors.some(({ action, error }) => (
      action === 'callback failed' && (error as Error).message === 'action boom'
    ))).toBe(true);
  });

  it('clears every surface of the plugin on teardown', () => {
    const { context } = createTestContext(TEST_PLUGIN_NAME);
    const ui = createUiSlice(context);

    ui.addMessageContextMenuItem({ label: 'Message item', onClick: () => {} });
    ui.addChatContextMenuItem({ label: 'Chat item', onClick: () => {} });
    ui.addMainMenuItem({ label: 'Main item', onClick: () => {} });
    ui.addComposerButton({ icon: 'star', label: 'Composer button', onClick: () => {} });

    context.runTeardowns();

    expect(getMessageContextMenuItems()).toHaveLength(0);
    expect(getChatContextMenuItems()).toHaveLength(0);
    expect(getMainMenuItems()).toHaveLength(0);
    expect(getComposerButtons()).toHaveLength(0);
  });

  it('clears only the disabled plugin and keeps other plugins registered', () => {
    const { context: contextA } = createTestContext('ui-slice-owner-a');
    const { context: contextB } = createTestContext('ui-slice-owner-b');
    const uiA = createUiSlice(contextA);
    const uiB = createUiSlice(contextB);

    uiA.addMainMenuItem({ label: 'Item A', onClick: () => {} });
    uiB.addMainMenuItem({ label: 'Item B', onClick: () => {} });

    contextA.runTeardowns();

    expect(getMainMenuItems().map((item) => item.label)).toEqual(['Item B']);
    contextB.runTeardowns();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiChat } from '../../api/types';
import type { PluginContext } from '../context';
import type { TgPluginReporter, TgPluginRuntime } from '../runtime';

import { createPluginContext } from '../context';
import {
  getChatContextMenuItems, getComposerButtons, getMainMenuItems, getMessageContextMenuItems,
} from '../registry';
import { createUiSlice } from './ui';

type CapturedError = { action: string; error: unknown };

const TEST_PLUGIN_NAME = 'ui-slice-owner';

/**
 * Builds the slice over a real plugin context and a minimal runtime double.
 * The ui slice consumes only the notification service, so every other runtime
 * capability stays unexercised and this suite imports no app modules.
 */
function createTestUiSlice(pluginName: string) {
  const capturedErrors: CapturedError[] = [];
  const showNotification = vi.fn();

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

  const runtime: TgPluginRuntime = {
    isPluginEnabled: () => true,
    setPluginEnabled: () => {},
    createPluginReporter: () => {
      throw new Error('the ui slice never creates a reporter');
    },
    subscribeApiUpdates: () => () => {},
    subscribeToStoreChanges: () => {},
    getActions: () => {
      throw new Error('the ui slice never dispatches actions');
    },
    getCurrentTabId: () => 0,
    mainThreadId: 0,
    getActiveMessageList: () => undefined,
    getActiveChatId: () => {
      throw new Error('the ui slice never reads the store');
    },
    getCurrentUserId: () => {
      throw new Error('the ui slice never reads the store');
    },
    getChat: () => {
      throw new Error('the ui slice never reads the store');
    },
    getUser: () => {
      throw new Error('the ui slice never reads the store');
    },
    getCommonBoxChatId: () => {
      throw new Error('the ui slice never reads the store');
    },
    getMessage: () => {
      throw new Error('the ui slice never reads the store');
    },
    getLocalizedString: () => {
      throw new Error('the ui slice never translates');
    },
    getStorageEngine: () => {
      throw new Error('the ui slice never touches storage');
    },
    getStorageEngineHandle: () => {
      throw new Error('the ui slice never touches storage');
    },
    showNotification,
  };

  const context = createPluginContext(pluginName, reporter);

  return {
    context,
    ui: createUiSlice(context, runtime),
    capturedErrors,
    showNotification,
  };
}

describe('ui slice', () => {
  let activeContext: PluginContext | undefined;

  afterEach(() => {
    // Every test's context tears down its own contributions.
    activeContext?.runTeardowns();
    activeContext = undefined;
  });

  it('registers items on every surface in registration order', () => {
    const { context, ui } = createTestUiSlice(TEST_PLUGIN_NAME);
    activeContext = context;

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
    const { context, ui } = createTestUiSlice(TEST_PLUGIN_NAME);
    activeContext = context;
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
    const { context, ui, capturedErrors } = createTestUiSlice(TEST_PLUGIN_NAME);
    activeContext = context;

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

  it('passes the notification descriptor to the runtime service', () => {
    const { context, ui, showNotification } = createTestUiSlice(TEST_PLUGIN_NAME);
    activeContext = context;

    ui.showNotification({ title: 'Plugin title', message: 'Plugin body', icon: 'star', duration: 4000 });

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith({
      title: 'Plugin title',
      message: 'Plugin body',
      icon: 'star',
      duration: 4000,
    });
  });

  it('forwards repeated notifications to the runtime service unchanged', () => {
    const { context, ui, showNotification } = createTestUiSlice(TEST_PLUGIN_NAME);
    activeContext = context;

    ui.showNotification({ message: 'Repeated' });
    ui.showNotification({ message: 'Repeated' });

    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(showNotification).toHaveBeenNthCalledWith(1, { message: 'Repeated' });
    expect(showNotification).toHaveBeenNthCalledWith(2, { message: 'Repeated' });
  });

  it('contains a throwing notification service and attributes it to the plugin', () => {
    const { context, ui, capturedErrors, showNotification } = createTestUiSlice(TEST_PLUGIN_NAME);
    activeContext = context;

    showNotification.mockImplementationOnce(() => {
      throw new Error('action boom');
    });

    expect(() => ui.showNotification({ message: 'Broken' })).not.toThrow();
    expect(capturedErrors.some(({ action, error }) => (
      action === 'callback failed' && (error as Error).message === 'action boom'
    ))).toBe(true);
  });

  it('clears every surface of the plugin on teardown', () => {
    const { context, ui } = createTestUiSlice(TEST_PLUGIN_NAME);

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
    const sliceA = createTestUiSlice('ui-slice-owner-a');
    const sliceB = createTestUiSlice('ui-slice-owner-b');

    sliceA.ui.addMainMenuItem({ label: 'Item A', onClick: () => {} });
    sliceB.ui.addMainMenuItem({ label: 'Item B', onClick: () => {} });

    sliceA.context.runTeardowns();

    expect(getMainMenuItems().map((item) => item.label)).toEqual(['Item B']);
    sliceB.context.runTeardowns();
  });
});

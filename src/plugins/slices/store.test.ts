import { describe, expect, it } from 'vitest';

import type { ApiChat } from '../../api/types';
import type { TgPluginRuntime } from '../runtime';

import { createPluginContext } from '../context';
import { createStoreSlice } from './store';

const TEST_PLUGIN_NAME = 'test-plugin';

type CapturedError = { action: string; error: unknown };

/** Builds the slice over injectable store reads; no `src/global` involved. */
function createTestStoreSlice() {
  const capturedErrors: CapturedError[] = [];
  const fakeChat = { id: '10' } as ApiChat;

  const runtime: TgPluginRuntime = {
    isPluginEnabled: () => true,
    setPluginEnabled: () => {},
    createPluginReporter: (pluginName) => ({
      log: () => {},
      logError: (action, error) => capturedErrors.push({ action, error }),
      wrap: (callback) => callback,
    }),
    // Event streams are not exercised by the facade slices
    subscribeApiUpdates: () => () => {},
    subscribeToStoreChanges: () => {},
    getActions: () => {
      throw new Error('the store slice never dispatches actions');
    },
    getCurrentTabId: () => 0,
    mainThreadId: 0,
    getActiveMessageList: () => undefined,
    getActiveChatId: () => '10',
    getCurrentUserId: () => '100',
    getChat: (chatId) => (chatId === '10' ? fakeChat : undefined),
    getLocalizedString: (key) => `translated:${key}`,
    showNotification: () => {
      throw new Error('the store slice never shows notifications');
    },
  };

  const context = createPluginContext(TEST_PLUGIN_NAME, runtime.createPluginReporter(TEST_PLUGIN_NAME));

  return {
    runtime,
    store: createStoreSlice(context, runtime),
    capturedErrors,
    fakeChat,
  };
}

describe('store slice', () => {
  it('returns the active chat id', () => {
    const { store } = createTestStoreSlice();

    expect(store.getActiveChatId()).toBe('10');
  });

  it('returns the current user id', () => {
    const { store } = createTestStoreSlice();

    expect(store.getCurrentUserId()).toBe('100');
  });

  it('returns stored chat data by id', () => {
    const { store, fakeChat } = createTestStoreSlice();

    expect(store.getChat('10')).toBe(fakeChat);
    expect(store.getChat('999')).toBeUndefined();
  });

  it('contains a throwing store read and yields undefined', () => {
    const { store, runtime, capturedErrors } = createTestStoreSlice();
    runtime.getActiveChatId = () => {
      throw new Error('boom');
    };

    expect(store.getActiveChatId()).toBeUndefined();

    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].action).toBe('store.getActiveChatId');
  });
});

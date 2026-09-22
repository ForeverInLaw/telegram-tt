import { describe, expect, it } from 'vitest';

import type { ApiChat } from '../../api/types';
import type { MessageList } from '../../types';
import type { TgPluginActions, TgPluginRuntime } from '../runtime';

import { createPluginContext } from '../context';
import { createApiSlice } from './api';

const TEST_PLUGIN_NAME = 'test-plugin';
const TEST_TAB_ID = 7;
const TEST_MAIN_THREAD_ID = -1;
const TEST_THREAD_ID = 99;

type ActionCall = { name: keyof TgPluginActions; payload: unknown };
type CapturedError = { action: string; error: unknown };

/** Builds the slice over recording actions and injectable store reads; no `src/global` involved. */
function createTestApiSlice({
  activeMessageList,
  chatIds = ['10'],
}: {
  activeMessageList?: MessageList;
  chatIds?: string[];
} = {}) {
  const actionCalls: ActionCall[] = [];
  const capturedErrors: CapturedError[] = [];

  const record = (name: keyof TgPluginActions) => (payload: unknown) => {
    actionCalls.push({ name, payload });
  };

  const actions: TgPluginActions = {
    deleteMessages: record('deleteMessages'),
    editMessage: record('editMessage'),
    openChat: record('openChat'),
    sendMessage: record('sendMessage'),
    setEditingId: record('setEditingId'),
    toggleReaction: record('toggleReaction'),
  };

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
    getActions: () => actions,
    getCurrentTabId: () => TEST_TAB_ID,
    mainThreadId: TEST_MAIN_THREAD_ID,
    getActiveMessageList: () => activeMessageList,
    getActiveChatId: () => activeMessageList?.chatId,
    getCurrentUserId: () => '100',
    getChat: (chatId) => (chatIds.includes(chatId) ? ({ id: chatId } as ApiChat) : undefined),
    getUser: () => undefined,
    getCommonBoxChatId: () => undefined,
    getMessage: () => undefined,
    getLocalizedString: (key) => `translated:${key}`,
    getStorageEngine: () => {
      throw new Error('the api slice never touches storage');
    },
    getStorageEngineHandle: () => {
      throw new Error('the api slice never touches storage');
    },
    showNotification: () => {
      throw new Error('the api slice never shows notifications');
    },
  };

  const context = createPluginContext(TEST_PLUGIN_NAME, runtime.createPluginReporter(TEST_PLUGIN_NAME));

  return {
    actions,
    api: createApiSlice(context, runtime),
    actionCalls,
    capturedErrors,
  };
}

describe('api facade slice', () => {
  it('sends a text message to the chat\'s main thread', () => {
    const { api, actionCalls } = createTestApiSlice();

    api.sendMessage('10', 'hello');

    expect(actionCalls).toEqual([{
      name: 'sendMessage',
      payload: {
        messageList: { chatId: '10', threadId: TEST_MAIN_THREAD_ID, type: 'thread' },
        text: 'hello',
        tabId: TEST_TAB_ID,
      },
    }]);
  });

  it('sends a text message into the chosen thread', () => {
    const { api, actionCalls } = createTestApiSlice();

    api.sendMessage('10', 'hello', { threadId: TEST_THREAD_ID });

    expect(actionCalls).toEqual([{
      name: 'sendMessage',
      payload: {
        messageList: { chatId: '10', threadId: TEST_THREAD_ID, type: 'thread' },
        text: 'hello',
        tabId: TEST_TAB_ID,
      },
    }]);
  });

  it('skips sending to a chat that is not in the store', () => {
    const { api, actionCalls, capturedErrors } = createTestApiSlice({ chatIds: [] });

    api.sendMessage('999', 'hello');

    expect(actionCalls).toEqual([]);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].action).toBe('api.sendMessage');
  });

  it('points the editing state at a message before editing it in the open chat', () => {
    const activeMessageList: MessageList = { chatId: '10', threadId: TEST_MAIN_THREAD_ID, type: 'thread' };
    const { api, actionCalls } = createTestApiSlice({ activeMessageList });

    api.editMessage('10', 5, 'edited');

    expect(actionCalls).toEqual([
      { name: 'setEditingId', payload: { messageId: 5, tabId: TEST_TAB_ID } },
      { name: 'editMessage', payload: { messageList: activeMessageList, text: 'edited', tabId: TEST_TAB_ID } },
    ]);
  });

  it('refuses to edit a chat that is not the open chat', () => {
    const activeMessageList: MessageList = { chatId: '10', threadId: TEST_MAIN_THREAD_ID, type: 'thread' };
    const { api, actionCalls, capturedErrors } = createTestApiSlice({ activeMessageList });

    api.editMessage('20', 5, 'edited');

    expect(actionCalls).toEqual([]);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].action).toBe('api.editMessage');
  });

  it('refuses to edit when no chat is open', () => {
    const { api, actionCalls, capturedErrors } = createTestApiSlice();

    api.editMessage('10', 5, 'edited');

    expect(actionCalls).toEqual([]);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].action).toBe('api.editMessage');
  });

  it('deletes messages with an explicit message list', () => {
    const { api, actionCalls } = createTestApiSlice();

    api.deleteMessages('10', [1, 2]);

    expect(actionCalls).toEqual([{
      name: 'deleteMessages',
      payload: {
        messageIds: [1, 2],
        messageList: { chatId: '10', threadId: TEST_MAIN_THREAD_ID, type: 'thread' },
        shouldDeleteForAll: undefined,
        tabId: TEST_TAB_ID,
      },
    }]);
  });

  it('passes the delete-for-all option through', () => {
    const { api, actionCalls } = createTestApiSlice();

    api.deleteMessages('10', [1], { shouldDeleteForAll: true });

    expect(actionCalls).toEqual([{
      name: 'deleteMessages',
      payload: {
        messageIds: [1],
        messageList: { chatId: '10', threadId: TEST_MAIN_THREAD_ID, type: 'thread' },
        shouldDeleteForAll: true,
        tabId: TEST_TAB_ID,
      },
    }]);
  });

  it('skips deleting in a chat that is not in the store', () => {
    const { api, actionCalls, capturedErrors } = createTestApiSlice({ chatIds: [] });

    api.deleteMessages('999', [1]);

    expect(actionCalls).toEqual([]);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].action).toBe('api.deleteMessages');
  });

  it('toggles an emoji reaction', () => {
    const { api, actionCalls } = createTestApiSlice();

    api.setReaction('10', 5, '👍');

    expect(actionCalls).toEqual([{
      name: 'toggleReaction',
      payload: {
        chatId: '10',
        messageId: 5,
        reaction: { type: 'emoji', emoticon: '👍' },
        tabId: TEST_TAB_ID,
      },
    }]);
  });

  it('opens a chat by id', () => {
    const { api, actionCalls } = createTestApiSlice();

    api.openChat('10');

    expect(actionCalls).toEqual([{ name: 'openChat', payload: { id: '10', tabId: TEST_TAB_ID } }]);
  });

  it('contains a throwing action instead of rethrowing it', () => {
    const { api, actions, capturedErrors } = createTestApiSlice();
    actions.openChat = () => {
      throw new Error('boom');
    };

    expect(() => api.openChat('10')).not.toThrow();

    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].action).toBe('api.openChat');
  });
});

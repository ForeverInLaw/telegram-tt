import './__testEnvironment';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../util/oggToWav');

import type { ApiChat, ApiMessage } from '../api/types';
import type { GlobalState } from '../global/types';
import type { RequiredGlobalActions } from '../global/types';
import type { TgPluginRuntime } from './runtime';

import { getGlobal, setGlobal } from '../global';
import { INITIAL_GLOBAL_STATE } from '../global/initialState';
import { updateListedIds } from '../global/reducers/messages';
import { MAIN_THREAD_ID } from '../api/types';
import { deleteMessages } from '../global/actions/apiUpdaters/messages';
import { getPluginList, initPlugins, togglePlugin } from './host';
import { resetSettings, updateSettings } from './anti-delete-plugin/settings';

const TEST_CHAT_ID = '100';
const TEST_BOT_CHAT_ID = '500';
const MAIN_ID = MAIN_THREAD_ID;

/**
 * Minimal actions double: the updater dispatches a handful of follow-up
 * actions (`requestChatUpdate`, `loadTopicById`, ...); all of them are
 * network round-trips irrelevant to the retention decision, so they no-op.
 */
function createActionsStub(): RequiredGlobalActions {
  return new Proxy({ _: undefined }, {
    get: () => () => {},
  }) as unknown as RequiredGlobalActions;
}

/** Builds a one-chat global with the given messages in the store. */
function createGlobalFixture(chats: Record<string, ApiChat>, messages: Record<string, ApiMessage>): GlobalState {
  const global = structuredClone(INITIAL_GLOBAL_STATE) as unknown as GlobalState;
  global.currentUserId = '1';
  global.chats.byId = chats;
  global.messages.byChatId = Object.fromEntries(Object.entries(messages).map(([chatId, message]) => {
    return [chatId, {
      byId: { [message.id]: message },
      ephemeralById: {},
      summaryById: {},
      threadsById: {
        [MAIN_ID]: {
          lastScrollOffset: undefined,
          lastViewportIds: undefined,
          listedIds: [message.id],
          threadInfo: {
            isCommentsInfo: false,
            threadId: MAIN_ID,
            lastMessageId: message.id,
            messagesCount: 1,
          } as never,
          readState: {} as never,
          localState: {},
        },
      },
    }];
  }));
  return global;
}

function createTextMessage(chatId: string, id: number): ApiMessage {
  return {
    id,
    chatId,
    date: 1730000000,
    isOutgoing: false,
    senderId: '2',
    content: { text: { text: `Message ${id}`, entities: [] } },
  };
}

/**
 * Runtime double for the plugin host: the anti-delete plugin registers and
 * runs `setup` (so `getPluginList` reports it enabled and `getSettings`
 * loads), while every runtime service answers from the fake global or a
 * safe default. `initPlugins` awaits the engine, so the caller awaits this.
 */
async function startPluginLifetime() {
  const runtime: TgPluginRuntime = {
    isPluginEnabled: () => true,
    setPluginEnabled: () => {},
    createPluginReporter: () => ({
      log: () => {},
      logError: () => {},
      wrap: (callback) => (...args: unknown[]) => callback(...args as []),
    }),
    subscribeApiUpdates: () => () => {},
    subscribeToStoreChanges: () => () => {},
    getActions: () => {
      throw new Error('not exercised');
    },
    showNotification: () => {
      throw new Error('not exercised');
    },
    getCurrentTabId: () => 0,
    mainThreadId: MAIN_ID,
    getActiveMessageList: () => undefined,
    getActiveChatId: () => undefined,
    getCurrentUserId: () => '1',
    getChat: (chatId) => getGlobal().chats.byId[chatId],
    getUser: (userId) => getGlobal().users.byId[userId],
    getCommonBoxChatId: () => undefined,
    getMessage: (chatId, messageId) => getGlobal().messages.byChatId[chatId]?.byId[messageId],
    getLocalizedString: (key) => key,
    getStorageEngine: () => Promise.resolve({
      putRecord: () => Promise.resolve(),
      getRecord: () => Promise.resolve(undefined),
      listRecords: () => Promise.resolve({ items: [], cursor: undefined }),
      deleteRecord: () => Promise.resolve(),
      clearRecords: () => Promise.resolve(),
      putBlob: () => Promise.resolve({ isStored: true }),
      getBlob: () => Promise.resolve(undefined),
      deleteBlob: () => Promise.resolve(),
      getUsage: () => Promise.resolve({ usedBytes: 0, budgetBytes: 100, quotaBytes: 1000 }),
      setBudgetBytes: () => Promise.resolve(),
      setPerBlobCapBytes: () => Promise.resolve(),
    }),
    getStorageEngineHandle: () => Promise.resolve({
      setBudgetBytes: () => Promise.resolve(),
      setPerBlobCapBytes: () => Promise.resolve(),
      getUsage: () => Promise.resolve({ usedBytes: 0, budgetBytes: 100, quotaBytes: 1000 }),
    }),
  };

  await initPlugins(runtime);
}

const enabledPlugin = () => getPluginList().find((plugin) => plugin.name === 'anti-delete')?.isEnabled;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  resetSettings();
  // The settings load may resolve after the assertions; drain it so no
  // rejection escapes the test
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve();
  }
});

describe('ghost retention: deleteMessages updater', () => {
  it('retains a capture-worthy deletion as a ghost (capability on)', async () => {
    await startPluginLifetime();
    expect(enabledPlugin()).toBe(true);

    const message = createTextMessage(TEST_CHAT_ID, 501);
    const global = createGlobalFixture(
      { [TEST_CHAT_ID]: { id: TEST_CHAT_ID, type: 'chatTypePrivate', title: 'Peer' } },
      { [TEST_CHAT_ID]: message },
    );
    setGlobal(global);

    deleteMessages(global, TEST_CHAT_ID, [501], createActionsStub());

    const retained = getGlobal().messages.byChatId[TEST_CHAT_ID].byId[501];
    expect(retained).toBeDefined();
    expect(retained.isArchivedDeleted).toBe(true);
    expect(retained.isDeleting).toBeUndefined();

    // The animation window passes: no physical removal, the ghost stays
    vi.advanceTimersByTime(400);
    const afterTimeout = getGlobal().messages.byChatId[TEST_CHAT_ID].byId[501];
    expect(afterTimeout).toBeDefined();
    expect(afterTimeout.isArchivedDeleted).toBe(true);
  });

  it('deletes exactly as before with the plugin disabled (capability off)', async () => {
    // Register the plugin, then toggle it off: the capability check must
    // observe a disabled plugin and fall back to the legacy delete path
    await startPluginLifetime();
    togglePlugin('anti-delete', false);
    expect(enabledPlugin()).toBe(false);

    const message = createTextMessage(TEST_CHAT_ID, 502);
    const global = createGlobalFixture(
      { [TEST_CHAT_ID]: { id: TEST_CHAT_ID, type: 'chatTypePrivate', title: 'Peer' } },
      { [TEST_CHAT_ID]: message },
    );
    setGlobal(global);

    deleteMessages(global, TEST_CHAT_ID, [502], createActionsStub());

    const flagged = getGlobal().messages.byChatId[TEST_CHAT_ID].byId[502];
    expect(flagged.isDeleting).toBe(true);
    expect(flagged.isArchivedDeleted).toBeUndefined();

    vi.advanceTimersByTime(400);

    expect(getGlobal().messages.byChatId[TEST_CHAT_ID].byId[502]).toBeUndefined();
  });

  it('never retains locally-initiated deletions', async () => {
    await startPluginLifetime();

    const message = createTextMessage(TEST_CHAT_ID, 503);
    const global = createGlobalFixture(
      { [TEST_CHAT_ID]: { id: TEST_CHAT_ID, type: 'chatTypePrivate', title: 'Peer' } },
      { [TEST_CHAT_ID]: message },
    );
    setGlobal(global);

    deleteMessages(global, TEST_CHAT_ID, [503], createActionsStub(), true);

    const localDeleted = getGlobal().messages.byChatId[TEST_CHAT_ID].byId[503];
    expect(localDeleted.isDeleting).toBe(true);
    expect(localDeleted.isArchivedDeleted).toBeUndefined();

    vi.advanceTimersByTime(400);
    expect(getGlobal().messages.byChatId[TEST_CHAT_ID].byId[503]).toBeUndefined();
  });

  it('does not retain bot chats while the bots toggle is off', async () => {
    await startPluginLifetime();
    updateSettings({ shouldCaptureBots: false });

    const message = createTextMessage(TEST_BOT_CHAT_ID, 504);
    const global = createGlobalFixture(
      {
        [TEST_CHAT_ID]: { id: TEST_CHAT_ID, type: 'chatTypePrivate', title: 'Peer' },
        [TEST_BOT_CHAT_ID]: { id: TEST_BOT_CHAT_ID, type: 'chatTypePrivate', title: 'Bot' },
      },
      { [TEST_BOT_CHAT_ID]: message },
    );
    global.users.byId[TEST_BOT_CHAT_ID] = { id: TEST_BOT_CHAT_ID, type: 'userTypeBot' } as never;
    setGlobal(global);

    deleteMessages(global, TEST_BOT_CHAT_ID, [504], createActionsStub());

    const botDeleted = getGlobal().messages.byChatId[TEST_BOT_CHAT_ID].byId[504];
    expect(botDeleted.isDeleting).toBe(true);
    expect(botDeleted.isArchivedDeleted).toBeUndefined();

    vi.advanceTimersByTime(400);
    expect(getGlobal().messages.byChatId[TEST_BOT_CHAT_ID].byId[504]).toBeUndefined();
  });
});

describe('ghost retention: merge tolerance', () => {
  it('keeps the ghost in the store across listed-ids merges', () => {
    const ghost = { ...createTextMessage(TEST_CHAT_ID, 501), isArchivedDeleted: true };
    const global = createGlobalFixture(
      { [TEST_CHAT_ID]: { id: TEST_CHAT_ID, type: 'chatTypePrivate', title: 'Peer' } },
      { [TEST_CHAT_ID]: ghost },
    );
    setGlobal(global);

    // The server no longer knows 501: a fresh page arrives without it. The
    // listed-ids merge is additive, so the ghost's id list survives and the
    // message stays in `byId`.
    const merged = updateListedIds(getGlobal(), TEST_CHAT_ID, MAIN_ID, [999]);
    setGlobal(merged);

    expect(merged.messages.byChatId[TEST_CHAT_ID].byId[501]).toBeDefined();
    expect(merged.messages.byChatId[TEST_CHAT_ID].byId[501].isArchivedDeleted).toBe(true);
  });
});

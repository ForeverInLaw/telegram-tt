import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiChat, ApiMessage, ApiUpdate, ApiUser } from '../../api/types';
import type { TgPluginRuntime } from '../runtime';
import type { TgStorageEngine } from '../storageEngine';
import type { TgPluginApi } from '../types';

import { buildTgApi } from '../api';
import { createPluginContext } from '../context';
import { disposeEventStreams, initEventStreams, removePluginEventHandlers } from '../events';
import antiDeletePlugin, { getArchive } from './index';
import { buildRevisionKey, REVISION_SCHEMA_VERSION } from './revisions';
import { resetSettings, updateSettings } from './settings';

const PLUGIN_NAME = 'anti-delete';
const TEST_CHAT_ID = '100';
const TEST_BOT_CHAT_ID = '500';
const CURRENT_USER_ID = '1';

/** In-memory engine double over the exact `TgStorageEngine` surface (mirrors capture.test.ts). */
function createFakeEngine() {
  const recordData = new Map<string, unknown>();
  const engine: TgStorageEngine = {
    putRecord: (key, record) => {
      recordData.set(key, record);
      return Promise.resolve();
    },
    getRecord: <T>(key: string) => Promise.resolve(recordData.get(key) as T | undefined),
    listRecords: <T>(options?: { prefix?: string; limit?: number; cursor?: string }) => {
      const keys = [...recordData.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .filter((key) => options?.cursor === undefined || key > options.cursor)
        .sort();
      const limit = options?.limit ?? 1000;
      const pageKeys = keys.slice(0, limit);
      return Promise.resolve({
        items: pageKeys.map((key) => ({ key, record: recordData.get(key) as T })),
        cursor: keys.length > pageKeys.length ? pageKeys[pageKeys.length - 1] : undefined,
      });
    },
    deleteRecord: (key) => {
      recordData.delete(key);
      return Promise.resolve();
    },
    clearRecords: (prefix) => {
      for (const key of [...recordData.keys()]) {
        if (prefix === undefined || key.startsWith(prefix)) {
          recordData.delete(key);
        }
      }
      return Promise.resolve();
    },
    putBlob: () => Promise.resolve({ isStored: true }),
    getBlob: () => Promise.resolve(undefined),
    deleteBlob: () => Promise.resolve(),
    clearBlobs: () => Promise.resolve(),
    getUsage: () => Promise.resolve({ usedBytes: 0, budgetBytes: 100, quotaBytes: 1000 }),
    setBudgetBytes: () => Promise.resolve(),
    setPerBlobCapBytes: () => Promise.resolve(),
  };

  return { engine, recordData };
}

/**
 * In-memory harness mirroring capture.test.ts: the fake store holds the
 * pre-edit messages, `emitApiUpdate` drives the exact stream seam the
 * production runtime subscribes, and the test mutates the store only AFTER
 * the handler returned, simulating the native edit reducer faithfully.
 */
/** The test harness surface the suite's helpers share. */
interface TestHarness {
  /** The fake engine's record table; keyed by namespaced storage key. */
  recordData: Map<string, unknown>;
  /** The fake store's message table; keyed `<chatId>:<messageId>`. */
  messages: Map<string, ApiMessage>;
  /** Builds the plugin's `tg` object and runs `setup` — one lifetime. */
  startPlugin(): Promise<{ tg: TgPluginApi; dispose: () => void }>;
  emitApiUpdate: (update: ApiUpdate) => void;
}

function createTestHarness(): TestHarness {
  const { engine, recordData } = createFakeEngine();
  const messages = new Map<string, ApiMessage>();
  const chats = new Map<string, ApiChat>();
  const users = new Map<string, ApiUser>();
  const apiUpdateListeners = new Set<(update: ApiUpdate) => void>();

  chats.set(TEST_CHAT_ID, { id: TEST_CHAT_ID, type: 'chatTypePrivate', title: 'Peer' });
  chats.set(TEST_BOT_CHAT_ID, { id: TEST_BOT_CHAT_ID, type: 'chatTypePrivate', title: 'Bot' });
  users.set(TEST_BOT_CHAT_ID, { id: TEST_BOT_CHAT_ID, type: 'userTypeBot' } as ApiUser);

  const runtime: TgPluginRuntime = {
    isPluginEnabled: () => true,
    setPluginEnabled: () => {},
    createPluginReporter: () => ({ log: () => {}, logError: () => {}, wrap: (cb) => cb }),
    subscribeApiUpdates: (listener) => {
      apiUpdateListeners.add(listener);
      return () => {
        apiUpdateListeners.delete(listener);
      };
    },
    subscribeToStoreChanges: () => () => {},
    getActions: () => {
      throw new Error('the revision pipeline never dispatches actions');
    },
    showNotification: () => {
      throw new Error('the revision pipeline never shows notifications');
    },
    getCurrentTabId: () => 0,
    mainThreadId: -1,
    getActiveMessageList: () => undefined,
    getActiveChatId: () => undefined,
    getCurrentUserId: () => CURRENT_USER_ID,
    getChat: (chatId) => chats.get(chatId),
    getUser: (userId) => users.get(userId),
    getCommonBoxChatId: () => undefined,
    getMessage: (chatId, messageId) => messages.get(`${chatId}:${messageId}`),
    getLocalizedString: (key, variables) => {
      if (key === 'DeletedMessagesEditHistoryCount') return `${variables?.count} edits`;
      return key;
    },
    getStorageEngine: () => Promise.resolve(engine),
    getStorageEngineHandle: () => Promise.resolve(engine),
  };

  return {
    runtime,
    recordData,
    /** The fake store's message table; keyed `<chatId>:<messageId>`. */
    messages,
    /** Builds the plugin's `tg` object and runs `setup` — one lifetime. */
    async startPlugin(): Promise<{ tg: TgPluginApi; dispose: () => void }> {
      const context = createPluginContext(PLUGIN_NAME, runtime.createPluginReporter(PLUGIN_NAME));
      const tg = buildTgApi(context, runtime);
      const disposer = antiDeletePlugin.setup(tg);
      // The real app awaits plugin init before any update flows; settle the
      // async settings load the same way so captures run with real settings
      await flushAsync();
      return { tg, dispose: () => disposer?.() };
    },
    emitApiUpdate: (update: ApiUpdate) => {
      for (const listener of apiUpdateListeners) {
        listener(update);
      }
    },
  };
}

/** Puts another user's plain text message into the fake store, pre-edit. */
function storeMessage(harness: TestHarness, messageId: number, text: string, chatId = TEST_CHAT_ID) {
  const message = {
    id: messageId,
    chatId,
    date: 1730000000,
    isOutgoing: false,
    senderId: '2',
    content: { text: { text, entities: [{ type: 'MessageEntityBold', offset: 0, length: 1 }] } },
  } as ApiMessage;
  harness.messages.set(`${chatId}:${messageId}`, message);
  return message;
}

/**
 * Emits a real edit update: the server's `UpdateEditMessage` carries the
 * FULL post-edit message with `isEdited: true` and the edit date.
 */
function emitEdit(
  harness: TestHarness,
  messageId: number,
  newText: string,
  editDate: number,
  chatId = TEST_CHAT_ID,
) {
  harness.emitApiUpdate({
    '@type': 'updateMessage',
    chatId,
    id: messageId,
    isFull: true,
    message: {
      id: messageId,
      chatId,
      date: 1730000000,
      isEdited: true,
      editDate,
      senderId: '2',
      content: { text: { text: newText } },
    } as ApiMessage,
  });
}

/** Emits a non-edit update (reactions/poll/webpage rides the same event). */
function emitNonEdit(harness: TestHarness, messageId: number, partial: Partial<ApiMessage>) {
  harness.emitApiUpdate({
    '@type': 'updateMessage',
    chatId: TEST_CHAT_ID,
    id: messageId,
    isFull: false,
    message: partial,
  });
}

/** Applies the edit to the fake store, like the native edit reducer would. */
function applyEditToStore(
  harness: TestHarness,
  messageId: number,
  newText: string,
  editDate: number,
  chatId = TEST_CHAT_ID,
) {
  const stored = harness.messages.get(`${chatId}:${messageId}`);
  harness.messages.set(`${chatId}:${messageId}`, {
    ...stored,
    isEdited: true,
    editDate,
    content: { ...stored?.content, text: { text: newText, entities: undefined } },
  } as ApiMessage);
}

/** Awaits the pending record writes and the settings load (all microtask-chained). */
async function flushAsync() {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve();
  }
}

let harness: TestHarness;

beforeEach(() => {
  harness = createTestHarness();
  initEventStreams(harness.runtime);
});

afterEach(() => {
  disposeEventStreams();
  removePluginEventHandlers(PLUGIN_NAME);
  // The plugin's module state must not leak between tests
  resetSettings();
  vi.restoreAllMocks();
});

describe('anti-delete plugin: revision capture round-trip', () => {
  it('captures a real edit as the PRE-EDIT revision, readable back with ids and edit date', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 501, 'The original wording');

    // The event fires in the same dispatch, BEFORE the native reducer applies
    // the edit — the handler must snapshot the still-previous revision
    emitEdit(harness, 501, 'The edited wording', 1730000500);
    applyEditToStore(harness, 501, 'The edited wording', 1730000500);
    await flushAsync();

    const revisions = await getArchive()!.readRevisions(TEST_CHAT_ID, 501);
    expect(revisions).toHaveLength(1);

    const revision = revisions[0];
    expect(revision.schemaVersion).toBe(REVISION_SCHEMA_VERSION);
    expect(revision.chatId).toBe(TEST_CHAT_ID);
    expect(revision.messageId).toBe(501);
    expect(revision.senderId).toBe('2');
    expect(revision.date).toBe(1730000000);
    expect(revision.editDate).toBe(1730000500);
    // The PRE-EDIT text: the store was mutated only after the handler ran
    expect(revision.text).toEqual({
      text: 'The original wording',
      entities: [{ type: 'MessageEntityBold', offset: 0, length: 1 }],
    });
    expect(revision.capturedAt).toBeGreaterThan(0);

    lifetime.dispose();
  });

  it('captures successive edits as an ordered, newest-first revision list', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 502, 'Revision zero');

    for (const [index, editDate] of [1730000100, 1730000200, 1730000300].entries()) {
      const newText = `Revision ${index + 1}`;
      emitEdit(harness, 502, newText, editDate);
      applyEditToStore(harness, 502, newText, editDate);
      await flushAsync();
    }

    const revisions = await getArchive()!.readRevisions(TEST_CHAT_ID, 502);
    expect(revisions).toHaveLength(3);
    // Newest-first: the flipped edit dates in the keys order the list
    expect(revisions.map((revision) => revision.editDate)).toEqual([1730000300, 1730000200, 1730000100]);
    // The newest entry is the second-to-last state (captured by the last
    // edit), the oldest is the original text (captured by the first edit)
    expect(revisions.map((revision) => revision.text.text)).toEqual([
      'Revision 2',
      'Revision 1',
      'Revision zero',
    ]);

    lifetime.dispose();
  });

  it('keys revisions by flipped edit date so the newest sorts first', () => {
    expect(buildRevisionKey(TEST_CHAT_ID, 503, 1730000300) < buildRevisionKey(TEST_CHAT_ID, 503, 1730000100))
      .toBe(true);
  });
});

describe('anti-delete plugin: revision capture filters', () => {
  it('skips this client\'s own edits (sender is the current user)', async () => {
    const lifetime = await harness.startPlugin();
    const ownMessage = {
      id: 601,
      chatId: TEST_CHAT_ID,
      date: 1730000000,
      isOutgoing: true,
      senderId: CURRENT_USER_ID,
      content: { text: { text: 'My own message' } },
    } as ApiMessage;
    harness.messages.set(`${TEST_CHAT_ID}:601`, ownMessage);

    harness.emitApiUpdate({
      '@type': 'updateMessage',
      chatId: TEST_CHAT_ID,
      id: 601,
      isFull: true,
      message: {
        ...ownMessage,
        isEdited: true,
        editDate: 1730000500,
        content: { text: { text: 'My own edited message' } },
      },
    });
    await flushAsync();

    expect(await getArchive()!.readRevisions(TEST_CHAT_ID, 601)).toEqual([]);

    lifetime.dispose();
  });

  it('skips non-edit updates: reactions, poll votes and web-page previews ride the same event', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 602, 'A message with reactions coming');

    emitNonEdit(harness, 602, { reactions: { recentReactions: [] } as ApiMessage['reactions'] });
    emitNonEdit(harness, 602, { content: { pollId: 'poll-1' } });
    emitNonEdit(harness, 602, { content: { text: { text: 'unchanged' } } });
    await flushAsync();

    expect(await getArchive()!.readRevisions(TEST_CHAT_ID, 602)).toEqual([]);

    lifetime.dispose();
  });

  it('skips edits of messages no longer in the store (nothing to snapshot)', async () => {
    const lifetime = await harness.startPlugin();
    emitEdit(harness, 9999, 'Never stored', 1730000500);
    await flushAsync();

    expect(await getArchive()!.readRevisions(TEST_CHAT_ID, 9999)).toEqual([]);

    lifetime.dispose();
  });

  it('skips media-only edits (revisions are text + metadata only)', async () => {
    const lifetime = await harness.startPlugin();
    const photoMessage = {
      id: 603,
      chatId: TEST_CHAT_ID,
      date: 1730000000,
      isOutgoing: false,
      senderId: '2',
      content: { photo: { mediaType: 'photo', id: 'photo-1', date: 1730000000, sizes: [] } },
    } as ApiMessage;
    harness.messages.set(`${TEST_CHAT_ID}:603`, photoMessage);

    emitEdit(harness, 603, 'fresh media', 1730000500);
    await flushAsync();

    expect(await getArchive()!.readRevisions(TEST_CHAT_ID, 603)).toEqual([]);

    lifetime.dispose();
  });
});

describe('anti-delete plugin: revision bots toggle', () => {
  it('skips bot-chat edits while the toggle is off, without a reload', async () => {
    const lifetime = await harness.startPlugin();
    updateSettings({ shouldCaptureBots: false });

    storeMessage(harness, 701, 'Bot wrote this', TEST_BOT_CHAT_ID);
    emitEdit(harness, 701, 'Bot edited this', 1730000500, TEST_BOT_CHAT_ID);
    await flushAsync();

    expect(await getArchive()!.readRevisions(TEST_BOT_CHAT_ID, 701)).toEqual([]);

    lifetime.dispose();
  });

  it('captures bot-chat edits again once the toggle is back on', async () => {
    const lifetime = await harness.startPlugin();
    updateSettings({ shouldCaptureBots: false });

    storeMessage(harness, 702, 'Bot wrote this', TEST_BOT_CHAT_ID);
    emitEdit(harness, 702, 'Bot edited this', 1730000500, TEST_BOT_CHAT_ID);
    await flushAsync();
    expect(await getArchive()!.readRevisions(TEST_BOT_CHAT_ID, 702)).toEqual([]);

    // The cache updates in memory, so the very next edit sees the toggle
    updateSettings({ shouldCaptureBots: true });
    storeMessage(harness, 703, 'Bot wrote more', TEST_BOT_CHAT_ID);
    emitEdit(harness, 703, 'Bot edited more', 1730000600, TEST_BOT_CHAT_ID);
    await flushAsync();

    const revisions = await getArchive()!.readRevisions(TEST_BOT_CHAT_ID, 703);
    expect(revisions.map((revision) => revision.text.text)).toEqual(['Bot wrote more']);

    lifetime.dispose();
  });

  it('captures bot-chat edits by default', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 704, 'Bot noise', TEST_BOT_CHAT_ID);
    emitEdit(harness, 704, 'Bot edited noise', 1730000500, TEST_BOT_CHAT_ID);
    await flushAsync();

    expect(await getArchive()!.readRevisions(TEST_BOT_CHAT_ID, 704)).toHaveLength(1);

    lifetime.dispose();
  });

  it('captures group-chat edits even while the bots toggle is off', async () => {
    const lifetime = await harness.startPlugin();
    updateSettings({ shouldCaptureBots: false });

    const groupChatId = '600';
    harness.messages.set('600:705', {
      id: 705,
      chatId: groupChatId,
      date: 1730000000,
      isOutgoing: false,
      senderId: '2',
      content: { text: { text: 'Group message' } },
    });
    emitEdit(harness, 705, 'Group edited', 1730000500, groupChatId);
    await flushAsync();

    expect(await getArchive()!.readRevisions(groupChatId, 705)).toHaveLength(1);

    lifetime.dispose();
  });
});

describe('anti-delete plugin: revisions and the delete pipeline', () => {
  it('keeps revisions of an edited-then-deleted message attached via ids (both records coexist)', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 801, 'Edited then deleted');
    emitEdit(harness, 801, 'Edited then deleted v2', 1730000500);
    applyEditToStore(harness, 801, 'Edited then deleted v2', 1730000500);
    await flushAsync();

    // The deletion captures the FINAL (post-edit) state
    harness.emitApiUpdate({ '@type': 'deleteMessages', ids: [801], chatId: TEST_CHAT_ID });
    harness.messages.delete(`${TEST_CHAT_ID}:801`);
    await flushAsync();

    const archive = getArchive()!;
    const page = await archive.readCaptures(TEST_CHAT_ID);
    expect(page.captures).toHaveLength(1);
    expect(page.captures[0].text?.text).toBe('Edited then deleted v2');

    // The revision stays attached to the same (chatId, messageId)
    const revisions = await archive.readRevisions(TEST_CHAT_ID, 801);
    expect(revisions.map((revision) => revision.text.text)).toEqual(['Edited then deleted']);

    lifetime.dispose();
  });

  it('per-chat clear removes revisions together with captures', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 802, 'Will be edited and cleared');
    emitEdit(harness, 802, 'Will be edited and cleared v2', 1730000500);
    applyEditToStore(harness, 802, 'Will be edited and cleared v2', 1730000500);
    await flushAsync();

    // Other chat's revisions must survive the per-chat clear
    storeMessage(harness, 803, 'Other chat', TEST_BOT_CHAT_ID);
    emitEdit(harness, 803, 'Other chat v2', 1730000500, TEST_BOT_CHAT_ID);
    await flushAsync();

    const archive = getArchive()!;
    await archive.clearCaptures(TEST_CHAT_ID);
    expect(await archive.readRevisions(TEST_CHAT_ID, 802)).toEqual([]);
    expect(await archive.readRevisions(TEST_BOT_CHAT_ID, 803)).toHaveLength(1);

    lifetime.dispose();
  });

  it('disables revision capture on plugin dispose (unsubscribes the edit event)', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 804, 'Captured before disabling');
    emitEdit(harness, 804, 'Captured before disabling v2', 1730000500);
    await flushAsync();
    expect(await getArchive()!.readRevisions(TEST_CHAT_ID, 804)).toHaveLength(1);

    lifetime.dispose();

    storeMessage(harness, 805, 'Not captured after disabling');
    emitEdit(harness, 805, 'Not captured after disabling v2', 1730000600);
    await flushAsync();

    // The archive surface went away with the lifetime
    expect(getArchive()).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiChat, ApiMessage, ApiUpdate, ApiUser } from '../../api/types';
import type { TgPluginRuntime } from '../runtime';
import type { TgStorageEngine } from '../storageEngine';
import type { TgPluginApi } from '../types';

import { buildTgApi } from '../api';
import { createPluginContext } from '../context';
import { disposeEventStreams, initEventStreams, removePluginEventHandlers } from '../events';
import { getPluginList, initPlugins, togglePlugin } from '../host';
import antiDeletePlugin, { getArchive } from './index';
import { resetSettings, updateSettings } from './settings';

type CapturedError = { pluginName: string; action: string; error: unknown };

const PLUGIN_NAME = 'anti-delete';
const TEST_CHAT_ID = '100';
const TEST_BOT_CHAT_ID = '500';

/**
 * In-memory engine double over the exact `TgStorageEngine` surface the
 * storage slice builds on: namespacing happens in the slice, so this map
 * stores namespaced keys exactly like the production record backend.
 */
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
 * In-memory runtime double: the fake store holds the messages and peers the
 * capture reads, the fake engine holds the records, and `emitApiUpdate`
 * drives the exact stream seam the production runtime subscribes.
 */
function createTestHarness() {
  const { engine, recordData } = createFakeEngine();
  const capturedErrors: CapturedError[] = [];
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
    subscribeApiUpdates: (listener) => {
      apiUpdateListeners.add(listener);
      return () => {
        apiUpdateListeners.delete(listener);
      };
    },
    subscribeToStoreChanges: () => () => {},
    getActions: () => {
      throw new Error('the capture pipeline never dispatches actions');
    },
    showNotification: () => {
      throw new Error('the capture pipeline never shows notifications');
    },
    getCurrentTabId: () => 0,
    mainThreadId: -1,
    getActiveMessageList: () => undefined,
    getActiveChatId: () => undefined,
    getCurrentUserId: () => '1',
    getChat: (chatId) => chats.get(chatId),
    getUser: (userId) => users.get(userId),
    getCommonBoxChatId: () => undefined,
    getMessage: (chatId, messageId) => messages.get(`${chatId}:${messageId}`),
    fetchMessageMedia: () => Promise.resolve([]),
    getLocalizedString: (key) => key,
    getStorageEngine: () => Promise.resolve(engine),
    getStorageEngineHandle: () => Promise.resolve(engine),
  };

  return {
    runtime,
    capturedErrors,
    recordData,
    /** The fake store's message table; keyed `<chatId>:<messageId>`. */
    messages,
    init() {
      initEventStreams(runtime);
    },
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

type TestHarness = ReturnType<typeof createTestHarness>;

/** Emits a server-side (non-local) deletion of one message in the test chat. */
function emitDeletion(harness: TestHarness, messageId: number, chatId = TEST_CHAT_ID) {
  harness.emitApiUpdate({ '@type': 'deleteMessages', ids: [messageId], chatId });
}

/** Puts a plain text message into the fake store, like a `newMessage` update would. */
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

/** Awaits the pending record writes and the settings load (all microtask-chained). */
async function flushAsync() {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve();
  }
}

let harness: TestHarness;

beforeEach(() => {
  harness = createTestHarness();
  harness.init();
});

afterEach(() => {
  disposeEventStreams();
  removePluginEventHandlers(PLUGIN_NAME);
  // The plugin's module state must not leak between tests; each test builds
  // its own harness, exactly like the host builds a fresh lifetime
  resetSettings();
  vi.restoreAllMocks();
});

describe('anti-delete plugin: capture round-trip', () => {
  it('captures a witnessed deletion readable back through the archive', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 501, 'Going to delete this');
    emitDeletion(harness, 501);
    await flushAsync();

    const archive = getArchive();
    expect(archive).toBeDefined();

    const page = await archive?.readCaptures(TEST_CHAT_ID) ?? { captures: [], nextCursor: undefined };
    expect(page.captures).toHaveLength(1);

    const capture = page.captures[0];
    expect(capture.schemaVersion).toBe(2);
    expect(capture.chatId).toBe(TEST_CHAT_ID);
    expect(capture.messageId).toBe(501);
    expect(capture.senderId).toBe('2');
    expect(capture.date).toBe(1730000000);
    expect(capture.text).toEqual({
      text: 'Going to delete this',
      entities: [{ type: 'MessageEntityBold', offset: 0, length: 1 }],
    });
    expect(capture.content.type).toBe('text');
    expect(capture.source).toBe('delete');
    expect(capture.capturedAt).toBeGreaterThan(0);

    lifetime.dispose();
  });

  it('paginates the archive newest-first with a cursor', async () => {
    const lifetime = await harness.startPlugin();
    for (const messageId of [10, 20, 30, 40]) {
      storeMessage(harness, messageId, `Message ${messageId}`);
    }
    harness.emitApiUpdate({ '@type': 'deleteMessages', ids: [10, 20, 30, 40], chatId: TEST_CHAT_ID });
    await flushAsync();

    const archive = getArchive()!;

    const firstPage = await archive.readCaptures(TEST_CHAT_ID, { limit: 2 });
    expect(firstPage.captures.map((capture) => capture.messageId)).toEqual([40, 30]);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await archive.readCaptures(TEST_CHAT_ID, { limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.captures.map((capture) => capture.messageId)).toEqual([20, 10]);
    expect(secondPage.nextCursor).toBeUndefined();

    lifetime.dispose();
  });

  it('searches captures by text, case-insensitively', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 11, 'Plain note');
    storeMessage(harness, 12, 'URGENT memo');
    emitDeletion(harness, 11);
    emitDeletion(harness, 12);
    await flushAsync();

    const result = await getArchive()!.searchCaptures(TEST_CHAT_ID, 'urgent');
    expect(result.captures.map((capture) => capture.messageId)).toEqual([12]);

    lifetime.dispose();
  });

  it('counts and clears captures per chat, leaving other chats untouched', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 21, 'In chat 100');
    storeMessage(harness, 22, 'In bot chat', TEST_BOT_CHAT_ID);
    emitDeletion(harness, 21);
    emitDeletion(harness, 22, TEST_BOT_CHAT_ID);
    await flushAsync();

    const archive = getArchive()!;
    expect(await archive.getCaptureCount(TEST_CHAT_ID)).toBe(1);
    expect(await archive.getCaptureCount(TEST_BOT_CHAT_ID)).toBe(1);

    await archive.clearCaptures(TEST_CHAT_ID);
    expect(await archive.getCaptureCount(TEST_CHAT_ID)).toBe(0);
    expect(await archive.getCaptureCount(TEST_BOT_CHAT_ID)).toBe(1);

    lifetime.dispose();
  });
});

describe('anti-delete plugin: capture filters', () => {
  it('skips locally-initiated deletions', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 601, 'Deleted by me');
    harness.emitApiUpdate({ '@type': 'deleteMessages', ids: [601], chatId: TEST_CHAT_ID, isLocal: true });
    await flushAsync();

    expect(await getArchive()!.getCaptureCount(TEST_CHAT_ID)).toBe(0);

    lifetime.dispose();
  });

  it('skips deletions whose chat the app could not resolve', async () => {
    const lifetime = await harness.startPlugin();
    harness.emitApiUpdate({ '@type': 'deleteMessages', ids: [602] });
    await flushAsync();

    expect(await getArchive()!.getCaptureCount(TEST_CHAT_ID)).toBe(0);

    lifetime.dispose();
  });

  it('skips messages no longer in the store (nothing to snapshot)', async () => {
    const lifetime = await harness.startPlugin();
    emitDeletion(harness, 9999);
    await flushAsync();

    expect(await getArchive()!.getCaptureCount(TEST_CHAT_ID)).toBe(0);

    lifetime.dispose();
  });

  it('skips service notifications (chat actions carry no recoverable content)', async () => {
    const lifetime = await harness.startPlugin();
    const serviceMessage = {
      id: 603,
      chatId: TEST_CHAT_ID,
      date: 1730000000,
      isOutgoing: false,
      content: { action: { type: 'chatCreate' } },
    } as ApiMessage;
    harness.messages.set(`${TEST_CHAT_ID}:603`, serviceMessage);
    emitDeletion(harness, 603);
    await flushAsync();

    expect(await getArchive()!.getCaptureCount(TEST_CHAT_ID)).toBe(0);

    lifetime.dispose();
  });

  it('captures media messages with a content summary instead of live media objects', async () => {
    const lifetime = await harness.startPlugin();
    const photoMessage = {
      id: 604,
      chatId: TEST_CHAT_ID,
      date: 1730000000,
      isOutgoing: false,
      senderId: '2',
      content: {
        photo: {
          mediaType: 'photo',
          id: 'photo-1',
          date: 1730000000,
          sizes: [],
        },
      },
    } as ApiMessage;
    harness.messages.set(`${TEST_CHAT_ID}:604`, photoMessage);
    emitDeletion(harness, 604);
    await flushAsync();

    const page = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(page.captures[0].content).toEqual({
      type: 'photo',
      mediaId: 'photo-1',
      fileName: undefined,
      mimeType: undefined,
      size: undefined,
      duration: undefined,
    });
    // The record is plain serializable data, not a store reference
    expect(JSON.stringify(page.captures[0])).toContain('"mediaId":"photo-1"');

    lifetime.dispose();
  });
});

describe('anti-delete plugin: bots toggle', () => {
  it('skips bot-chat deletions while the toggle is off, without a reload', async () => {
    const lifetime = await harness.startPlugin();
    updateSettings({ shouldCaptureBots: false });

    storeMessage(harness, 701, 'Bot says hi', TEST_BOT_CHAT_ID);
    emitDeletion(harness, 701, TEST_BOT_CHAT_ID);
    await flushAsync();

    expect(await getArchive()!.getCaptureCount(TEST_BOT_CHAT_ID)).toBe(0);

    lifetime.dispose();
  });

  it('captures bot-chat deletions again once the toggle is back on', async () => {
    const lifetime = await harness.startPlugin();
    updateSettings({ shouldCaptureBots: false });

    storeMessage(harness, 702, 'Bot says hi', TEST_BOT_CHAT_ID);
    emitDeletion(harness, 702, TEST_BOT_CHAT_ID);
    await flushAsync();
    expect(await getArchive()!.getCaptureCount(TEST_BOT_CHAT_ID)).toBe(0);

    // The cache updates in memory, so the very next capture sees the toggle
    updateSettings({ shouldCaptureBots: true });
    storeMessage(harness, 703, 'Bot says more', TEST_BOT_CHAT_ID);
    emitDeletion(harness, 703, TEST_BOT_CHAT_ID);
    await flushAsync();

    const page = await getArchive()!.readCaptures(TEST_BOT_CHAT_ID);
    expect(page.captures.map((capture) => capture.messageId)).toEqual([703]);

    lifetime.dispose();
  });

  it('captures bot-chat deletions by default', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 704, 'Bot noise', TEST_BOT_CHAT_ID);
    emitDeletion(harness, 704, TEST_BOT_CHAT_ID);
    await flushAsync();

    expect(await getArchive()!.getCaptureCount(TEST_BOT_CHAT_ID)).toBe(1);

    lifetime.dispose();
  });

  it('captures group chats even while the bots toggle is off (detection is private-chats-only)', async () => {
    const lifetime = await harness.startPlugin();
    updateSettings({ shouldCaptureBots: false });

    const groupChatId = '600';
    harness.messages.set('600:701', {
      id: 701,
      chatId: groupChatId,
      date: 1730000000,
      isOutgoing: false,
      senderId: '2',
      content: { text: { text: 'Group message' } },
    });
    emitDeletion(harness, 701, groupChatId);
    await flushAsync();

    expect(await getArchive()!.getCaptureCount(groupChatId)).toBe(1);

    lifetime.dispose();
  });
});

describe('anti-delete plugin: snapshot race', () => {
  it('reads the message synchronously before the store removes it', async () => {
    const lifetime = await harness.startPlugin();
    const message = storeMessage(harness, 801, 'Still intact right now');

    // The native delete pipeline removes the message only after the update
    // dispatch (a frame later); the handler must have read it inside the
    // dispatch, so removing it here simulates the reducer faithfully
    emitDeletion(harness, 801);
    harness.messages.delete(`${TEST_CHAT_ID}:801`);
    await flushAsync();

    const page = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(page.captures).toHaveLength(1);
    expect(page.captures[0].text?.text).toBe('Still intact right now');
    // The record mirrors the pre-delete message data
    expect(page.captures[0].senderId).toBe(message.senderId);
    expect(page.captures[0].date).toBe(message.date);

    lifetime.dispose();
  });
});

describe('anti-delete plugin: error containment', () => {
  it('contains a failing record write and keeps the plugin running', async () => {
    const lifetime = await harness.startPlugin();
    storeMessage(harness, 901, 'This write will fail');

    const originalPutRecord = harness.runtime.getStorageEngine;
    harness.runtime.getStorageEngine = () => Promise.reject(new Error('engine down'));
    emitDeletion(harness, 901);
    await flushAsync();
    harness.runtime.getStorageEngine = originalPutRecord;

    // The next capture works: a failed write never breaks the subscription
    storeMessage(harness, 902, 'This write will succeed');
    emitDeletion(harness, 902);
    await flushAsync();

    const page = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(page.captures.map((capture) => capture.messageId)).toEqual([902]);

    lifetime.dispose();
  });
});

describe('anti-delete plugin: host lifecycle (disable / re-enable)', () => {
  /**
   * Host-level harness: a runtime whose enabled map the host toggles, the
   * same fake store/engine seams as above, plus the real host driving the
   * plugin's `setup`/disposer through the Settings toggle path.
   */
  function createHostHarness() {
    const { engine, recordData } = createFakeEngine();
    const capturedErrors: CapturedError[] = [];
    const messages = new Map<string, ApiMessage>();
    const chats = new Map<string, ApiChat>();
    const users = new Map<string, ApiUser>();
    const apiUpdateListeners = new Set<(update: ApiUpdate) => void>();
    const enabledMap: Record<string, boolean> = {};

    chats.set(TEST_CHAT_ID, { id: TEST_CHAT_ID, type: 'chatTypePrivate', title: 'Peer' });

    const runtime: TgPluginRuntime = {
      isPluginEnabled: (pluginName, isEnabledByDefault) => enabledMap[pluginName] ?? isEnabledByDefault,
      setPluginEnabled: (pluginName, isEnabled) => {
        enabledMap[pluginName] = isEnabled;
      },
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
      subscribeApiUpdates: (listener) => {
        apiUpdateListeners.add(listener);
        return () => {
          apiUpdateListeners.delete(listener);
        };
      },
      subscribeToStoreChanges: () => () => {},
      getActions: () => {
        throw new Error('the capture pipeline never dispatches actions');
      },
      showNotification: () => {
        throw new Error('the capture pipeline never shows notifications');
      },
      getCurrentTabId: () => 0,
      mainThreadId: -1,
      getActiveMessageList: () => undefined,
      getActiveChatId: () => undefined,
      getCurrentUserId: () => '1',
      getChat: (chatId) => chats.get(chatId),
      getUser: (userId) => users.get(userId),
      getCommonBoxChatId: () => undefined,
      getMessage: (chatId, messageId) => messages.get(`${chatId}:${messageId}`),
      fetchMessageMedia: () => Promise.resolve([]),
      getLocalizedString: (key) => key,
      getStorageEngine: () => Promise.resolve(engine),
      getStorageEngineHandle: () => Promise.resolve(engine),
    };

    return {
      runtime,
      enabledMap,
      capturedErrors,
      recordData,
      messages,
      emitApiUpdate: (update: ApiUpdate) => {
        for (const listener of apiUpdateListeners) {
          listener(update);
        }
      },
    };
  }

  it('stops capture on disable, resumes on re-enable, and keeps records across both', async () => {
    const host = createHostHarness();
    await initPlugins(host.runtime);

    // Enabled by default: a witnessed deletion captures
    storeHostMessage(host, 1001, 'Captured before disabling');
    host.emitApiUpdate({ '@type': 'deleteMessages', ids: [1001], chatId: TEST_CHAT_ID });
    await flushAsync();
    expect(await getArchive()!.getCaptureCount(TEST_CHAT_ID)).toBe(1);

    // Disable: the disposer runs, the archive surface goes away, capture stops
    togglePlugin('anti-delete', false);
    expect(getArchive()).toBeUndefined();

    storeHostMessage(host, 1002, 'Captured while disabled? No');
    host.emitApiUpdate({ '@type': 'deleteMessages', ids: [1002], chatId: TEST_CHAT_ID });
    await flushAsync();

    // Re-enable: setup runs fresh and the earlier records survived
    togglePlugin('anti-delete', true);
    expect(getArchive()).toBeDefined();
    expect(await getArchive()!.getCaptureCount(TEST_CHAT_ID)).toBe(1);

    storeHostMessage(host, 1003, 'Captured after re-enabling');
    host.emitApiUpdate({ '@type': 'deleteMessages', ids: [1003], chatId: TEST_CHAT_ID });
    await flushAsync();

    const page = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(page.captures.map((capture) => capture.messageId)).toEqual([1003, 1001]);
  });

  it('lists the plugin in the Settings list, enabled by default, with its metadata', async () => {
    const host = createHostHarness();
    await initPlugins(host.runtime);

    const info = getPluginList().find((plugin) => plugin.name === 'anti-delete');
    expect(info?.isEnabled).toBe(true);
    expect(info?.version).toBe('0.1.0');
    expect(info?.description).toBe('Keeps an archive of messages others deleted, with text, metadata and senders.');
  });

  /** Stores a message into the host harness's fake store. */
  function storeHostMessage(host: ReturnType<typeof createHostHarness>, messageId: number, text: string) {
    host.messages.set(`${TEST_CHAT_ID}:${messageId}`, {
      id: messageId,
      chatId: TEST_CHAT_ID,
      date: 1730000000,
      isOutgoing: false,
      senderId: '2',
      content: { text: { text } },
    });
  }
});

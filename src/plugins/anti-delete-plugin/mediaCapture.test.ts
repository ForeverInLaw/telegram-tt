import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiChat, ApiMessage, ApiUpdate, ApiUser } from '../../api/types';
import type { TgPluginRuntime } from '../runtime';
import type { TgStorageEngine } from '../storageEngine';
import type { TgMediaBlob, TgPluginApi } from '../types';

import { buildTgApi } from '../api';
import { createPluginContext } from '../context';
import { disposeEventStreams, initEventStreams, removePluginEventHandlers } from '../events';
import { buildCaptureKey, buildMediaKey, CAPTURE_SCHEMA_VERSION } from './capture';
import antiDeletePlugin, { getArchive } from './index';
import { formatMediaSize, resolveMediaResolution } from './mediaCapture';
import { resetSettings, updateSettings } from './settings';

const PLUGIN_NAME = 'anti-delete';
const TEST_CHAT_ID = '100';

/** Options the fake `fetchMessageMedia` answers; each capture may re-program it. */
type FetchFake = (
  chatId: string, messageId: number, options?: { shouldPrefetchVideo?: boolean },
) => Promise<TgMediaBlob[]>;

/**
 * In-memory engine double over the exact `TgStorageEngine` surface the
 * storage slice builds on, extended with real blob semantics: per-blob cap
 * rejection mirrors the production engine's contract.
 */
function createFakeEngine(perBlobCapBytes: number) {
  const recordData = new Map<string, unknown>();
  const blobData = new Map<string, Blob>();
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
    putBlob: (key, blob) => {
      if (blob.size > perBlobCapBytes) {
        return Promise.resolve({ isStored: false, reason: 'overCap' as const });
      }
      blobData.set(key, blob);
      return Promise.resolve({ isStored: true });
    },
    getBlob: (key) => Promise.resolve(blobData.get(key)),
    deleteBlob: (key) => {
      blobData.delete(key);
      return Promise.resolve();
    },
    clearBlobs: (prefix) => {
      for (const key of [...blobData.keys()]) {
        if (prefix === undefined || key.startsWith(prefix)) {
          blobData.delete(key);
        }
      }
      return Promise.resolve();
    },
    getUsage: () => Promise.resolve({ usedBytes: 0, budgetBytes: 100, quotaBytes: 1000 }),
    setBudgetBytes: () => Promise.resolve(),
    setPerBlobCapBytes: () => Promise.resolve(),
  };

  return { engine, recordData, blobData };
}

/**
 * Harness over the real plugin lifecycle: the fake `fetchMessageMedia` is
 * the media read seam, the fake engine holds records and blobs, and
 * `emitApiUpdate` drives the exact stream seam the production runtime
 * subscribes.
 */
function createTestHarness(perBlobCapBytes = 64 * 1024 * 1024) {
  const { engine, recordData, blobData } = createFakeEngine(perBlobCapBytes);
  const messages = new Map<string, ApiMessage>();
  const chats = new Map<string, ApiChat>();
  const users = new Map<string, ApiUser>();
  const apiUpdateListeners = new Set<(update: ApiUpdate) => void>();
  const fetchCalls: Array<{ chatId: string; messageId: number; options?: { shouldPrefetchVideo?: boolean } }> = [];

  let fetchFake: FetchFake = () => Promise.resolve([]);

  chats.set(TEST_CHAT_ID, { id: TEST_CHAT_ID, type: 'chatTypePrivate', title: 'Peer' });

  const runtime: TgPluginRuntime = {
    isPluginEnabled: () => true,
    setPluginEnabled: () => {},
    createPluginReporter: () => ({
      log: () => {},
      logError: () => {},
      wrap: (callback) => callback,
    }),
    subscribeApiUpdates: (listener) => {
      apiUpdateListeners.add(listener);
      return () => {
        apiUpdateListeners.delete(listener);
      };
    },
    subscribeToStoreChanges: () => () => {},
    getActions: () => {
      throw new Error('the media capture pipeline never dispatches actions');
    },
    showNotification: () => {
      throw new Error('the media capture pipeline never shows notifications');
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
    fetchMessageMedia: (chatId, messageId, options) => {
      fetchCalls.push({ chatId, messageId, options });
      return fetchFake(chatId, messageId, options);
    },
    getLocalizedString: (key) => key,
    getStorageEngine: () => Promise.resolve(engine),
    getStorageEngineHandle: () => Promise.resolve(engine),
  };

  return {
    runtime,
    engine,
    recordData,
    blobData,
    /** Every `fetchMessageMedia` call, in order (assert the prefetch flag). */
    fetchCalls,
    /** Re-programs the fake media read for the next captures. */
    setFetchFake: (fake: FetchFake) => {
      fetchFake = fake;
    },
    /** The fake store's message table; keyed `<chatId>:<messageId>`. */
    messages,
    init() {
      initEventStreams(runtime);
    },
    /** Builds the plugin's `tg` object and runs `setup` — one lifetime. */
    startPlugin(): { tg: TgPluginApi; dispose: () => void } {
      const context = createPluginContext(PLUGIN_NAME, runtime.createPluginReporter(PLUGIN_NAME));
      const tg = buildTgApi(context, runtime);
      const disposer = antiDeletePlugin.setup(tg);
      return { tg, dispose: () => disposer?.() };
    },
    emitDeletion(messageId: number) {
      const update: ApiUpdate = { '@type': 'deleteMessages', ids: [messageId], chatId: TEST_CHAT_ID };
      for (const listener of apiUpdateListeners) {
        listener(update);
      }
    },
  };
}

type TestHarness = ReturnType<typeof createTestHarness>;

/** A photo message, like a `newMessage` update would store it. */
function storePhotoMessage(harness: TestHarness, messageId: number) {
  harness.messages.set(`${TEST_CHAT_ID}:${messageId}`, {
    id: messageId,
    chatId: TEST_CHAT_ID,
    date: 1730000000,
    isOutgoing: false,
    senderId: '2',
    content: {
      photo: { mediaType: 'photo', id: 'photo-1', date: 1730000000, sizes: [] },
    },
  });
}

/** A video message; `isGif: false` distinguishes it from an animated GIF. */
function storeVideoMessage(harness: TestHarness, messageId: number, isGif = false) {
  harness.messages.set(`${TEST_CHAT_ID}:${messageId}`, {
    id: messageId,
    chatId: TEST_CHAT_ID,
    date: 1730000000,
    isOutgoing: false,
    senderId: '2',
    content: {
      video: {
        mediaType: 'video',
        id: 'video-1',
        mimeType: 'video/mp4',
        duration: 5,
        fileName: 'clip.mp4',
        size: 100,
        isGif,
      },
    },
  });
}

/** The blob the fake media read hands the capture for a cached photo. */
function photoBlob(): TgMediaBlob {
  return {
    kind: 'photo',
    mimeType: undefined,
    fileName: undefined,
    sizeBytes: 12,
    blob: new Blob(['photo-bytes']),
  };
}

/** The blob the fake media read hands the capture for a prefetched video. */
function videoBlob(sizeBytes = 12): TgMediaBlob {
  return {
    kind: 'video',
    mimeType: 'video/mp4',
    fileName: 'clip.mp4',
    sizeBytes,
    blob: new Blob([new Uint8Array(sizeBytes)]),
  };
}

/** Awaits the kicked record writes and media copies (microtask chains). */
async function flushAsync() {
  for (let tick = 0; tick < 20; tick += 1) {
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

describe('anti-delete plugin: media capture', () => {
  it('copies a cached photo blob into plugin storage and enriches the record', async () => {
    const lifetime = harness.startPlugin();
    harness.setFetchFake(() => Promise.resolve([photoBlob()]));
    storePhotoMessage(harness, 501);
    harness.emitDeletion(501);
    await flushAsync();

    // The blob landed in the plugin's own storage under the documented key
    const mediaKey = buildMediaKey(TEST_CHAT_ID, 501, 'photo');
    expect(harness.blobData.has(`anti-delete:${mediaKey}`)).toBe(true);

    // The record gained its media ref; the rest of the record is intact
    const record = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(record.captures[0].media).toEqual([{ key: mediaKey, kind: 'photo', sizeBytes: 12 }]);
    expect(record.captures[0].schemaVersion).toBe(CAPTURE_SCHEMA_VERSION);

    lifetime.dispose();
  });

  it('writes the record before the media resolves (the record never waits)', async () => {
    const lifetime = harness.startPlugin();
    const { promise: fetchPromise, resolve: resolveFetch } = Promise.withResolvers<TgMediaBlob[]>();
    harness.setFetchFake(() => fetchPromise);
    storePhotoMessage(harness, 502);
    harness.emitDeletion(502);

    // The media read is still pending, but the record is already readable
    const recordKey = `anti-delete:${buildCaptureKey(TEST_CHAT_ID, 502)}`;
    await Promise.resolve();
    expect(harness.recordData.has(recordKey)).toBe(true);

    // Only now the blob resolves and the enrichment lands
    resolveFetch([photoBlob()]);
    await flushAsync();
    const stored = harness.recordData.get(recordKey) as { media?: unknown[] };
    expect(Array.isArray(stored.media)).toBe(true);

    lifetime.dispose();
  });

  it('skips the video media read entirely while the prefetch toggle is off', async () => {
    const lifetime = harness.startPlugin();
    storeVideoMessage(harness, 503);
    harness.emitDeletion(503);
    await flushAsync();

    // The media read ran but carried no prefetch flag: the runtime's video
    // policy sees the flag and resolves no video bytes
    expect(harness.fetchCalls).toEqual([{
      chatId: TEST_CHAT_ID,
      messageId: 503,
      options: { shouldPrefetchVideo: false },
    }]);
    expect(harness.blobData.size).toBe(0);

    // And the record stays record-only
    const page = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(page.captures[0].media).toBeUndefined();

    lifetime.dispose();
  });

  it('prefetches and stores the video with the toggle on, passing the flag through', async () => {
    const lifetime = harness.startPlugin();
    updateSettings({ shouldPrefetchVideos: true });
    harness.setFetchFake(() => Promise.resolve([videoBlob()]));
    storeVideoMessage(harness, 504);
    harness.emitDeletion(504);
    await flushAsync();

    expect(harness.fetchCalls).toEqual([{
      chatId: TEST_CHAT_ID,
      messageId: 504,
      options: { shouldPrefetchVideo: true },
    }]);

    const mediaKey = buildMediaKey(TEST_CHAT_ID, 504, 'video');
    expect(harness.blobData.has(`anti-delete:${mediaKey}`)).toBe(true);

    const page = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(page.captures[0].media).toEqual([{ key: mediaKey, kind: 'video', sizeBytes: 12 }]);

    lifetime.dispose();
  });

  it('degrades to record-only when the blob exceeds the per-blob cap', async () => {
    const cappedHarness = createTestHarness(8);
    cappedHarness.init();
    const lifetime = cappedHarness.startPlugin();
    cappedHarness.setFetchFake(() => Promise.resolve([photoBlob()]));
    storePhotoMessage(cappedHarness, 505);
    cappedHarness.emitDeletion(505);
    await flushAsync();

    // Over the cap: no blob, and the record keeps its metadata only
    expect(cappedHarness.blobData.size).toBe(0);
    const page = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(page.captures).toHaveLength(1);
    expect(page.captures[0].media).toBeUndefined();
    expect(page.captures[0].content.type).toBe('photo');

    lifetime.dispose();
  });

  it('degrades to record-only when nothing is cached (fetch resolves [])', async () => {
    const lifetime = harness.startPlugin();
    harness.setFetchFake(() => Promise.resolve([]));
    storePhotoMessage(harness, 506);
    harness.emitDeletion(506);
    await flushAsync();

    const page = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(page.captures).toHaveLength(1);
    expect(page.captures[0].media).toBeUndefined();

    lifetime.dispose();
  });

  it('degrades to record-only when the blob store rejects, and never throws', async () => {
    const lifetime = harness.startPlugin();
    harness.setFetchFake(() => Promise.resolve([photoBlob()]));
    storePhotoMessage(harness, 507);

    // Sabotage only the blob write: the record write shares the engine and
    // must survive the failing blob copy
    const originalPutBlob = harness.engine.putBlob;
    harness.engine.putBlob = () => Promise.reject(new Error('blob backend down'));
    harness.emitDeletion(507);
    await flushAsync();
    harness.engine.putBlob = originalPutBlob;

    // The record stayed intact; only its media enrichment is missing
    const page = await getArchive()!.readCaptures(TEST_CHAT_ID);
    expect(page.captures).toHaveLength(1);
    expect(page.captures[0].media).toBeUndefined();
    expect(page.captures[0].content.type).toBe('photo');

    lifetime.dispose();
  });

  it('clears a chat\'s media blobs together with its records', async () => {
    const lifetime = harness.startPlugin();
    harness.setFetchFake(() => Promise.resolve([photoBlob()]));
    storePhotoMessage(harness, 508);
    harness.emitDeletion(508);
    await flushAsync();

    expect(harness.blobData.size).toBe(1);

    await getArchive()!.clearCaptures(TEST_CHAT_ID);
    expect(await getArchive()!.getCaptureCount(TEST_CHAT_ID)).toBe(0);
    expect(harness.blobData.size).toBe(0);

    lifetime.dispose();
  });
});

describe('anti-delete plugin: viewer media resolution', () => {
  it('resolves an available blob for a capture with stored media', async () => {
    const blob = new Blob(['bytes']);
    const getBlob = (key: string) => Promise.resolve(key === 'media:100:x:photo' ? blob : undefined);

    const resolution = await resolveMediaResolution(getBlob, {
      media: [{ key: 'media:100:x:photo', kind: 'photo', sizeBytes: 5 }],
    });
    expect(resolution.status).toBe('available');
    if (resolution.status === 'available') {
      expect(resolution.kind).toBe('photo');
      expect(resolution.sizeBytes).toBe(5);
      expect(resolution.blob).toBe(blob);
    }
  });

  it('resolves the never-captured placeholder for a record-only capture', async () => {
    const resolution = await resolveMediaResolution(() => Promise.resolve(undefined), { media: undefined });
    expect(resolution).toEqual({ status: 'placeholder', reason: 'neverCaptured' });
  });

  it('resolves the evicted placeholder when the blob no longer reads', async () => {
    const resolution = await resolveMediaResolution(() => Promise.resolve(undefined), {
      media: [{ key: 'media:100:x:photo', kind: 'photo', sizeBytes: 5 }],
    });
    expect(resolution).toEqual({ status: 'placeholder', reason: 'evicted' });
  });

  it('formats media sizes like a file manager line', () => {
    expect(formatMediaSize(512)).toBe('512 B');
    expect(formatMediaSize(2048)).toBe('2 KB');
    expect(formatMediaSize(5 * 1024 * 1024)).toBe('5 MB');
  });
});

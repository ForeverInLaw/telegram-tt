import { describe, expect, it, vi } from 'vitest';

import type { PluginContext } from '../context';
import type { TgPluginRuntime } from '../runtime';
import type { TgStorageEngine } from '../storageEngine';

import { createStorageSlice } from './storage';

const TEST_PLUGIN_NAME = 'alpha';

type CapturedError = { action: string; error: unknown };

/** Engine double: the contract surface backed by in-memory maps. */
function createFakeEngine() {
  const recordData = new Map<string, unknown>();
  const blobData = new Map<string, Blob>();
  const engine = {
    recordData,
    blobData,
    putRecord: vi.fn((key: string, record: unknown) => {
      recordData.set(key, record);
      return Promise.resolve();
    }),
    getRecord: vi.fn(<T>(key: string) => Promise.resolve(recordData.get(key) as T | undefined)),
    listRecords: vi.fn(<T>(options?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = options?.prefix ?? '';
      const keys = [...recordData.keys()].filter((key) => key.startsWith(prefix)).sort();
      const items = keys.map((key) => ({ key, record: recordData.get(key) as T }));
      const page = options?.limit === undefined ? { items } : { items: items.slice(0, options.limit) };
      return Promise.resolve(page);
    }),
    deleteRecord: vi.fn((key: string) => {
      recordData.delete(key);
      return Promise.resolve();
    }),
    clearRecords: vi.fn((prefix?: string) => {
      for (const key of [...recordData.keys()]) {
        if (prefix === undefined || key.startsWith(prefix)) {
          recordData.delete(key);
        }
      }
      return Promise.resolve();
    }),
    putBlob: vi.fn((key: string, blob: Blob) => {
      blobData.set(key, blob);
      return Promise.resolve({ isStored: true } as const);
    }),
    getBlob: vi.fn((key: string) => Promise.resolve(blobData.get(key))),
    deleteBlob: vi.fn((key: string) => {
      blobData.delete(key);
      return Promise.resolve();
    }),
    getUsage: vi.fn(() => Promise.resolve({ usedBytes: 10, budgetBytes: 100, quotaBytes: 1000 })),
    setBudgetBytes: vi.fn(() => Promise.resolve()),
    setPerBlobCapBytes: vi.fn(() => Promise.resolve()),
  };

  return engine satisfies TgStorageEngine;
}

/** Builds the slice over an injectable engine; no real backends involved. */
function createTestSlice(engine: TgStorageEngine | undefined) {
  const capturedErrors: CapturedError[] = [];
  const registeredTeardowns: Array<() => void> = [];

  const runtime: TgPluginRuntime = {
    isPluginEnabled: () => true,
    setPluginEnabled: () => {},
    createPluginReporter: (pluginName) => ({
      log: () => {},
      logError: (action, error) => {
        capturedErrors.push({ action: `${pluginName}:${action}`, error });
      },
      wrap: (callback) => callback,
    }),
    subscribeApiUpdates: () => () => {},
    subscribeToStoreChanges: () => {},
    getActions: () => {
      throw new Error('not exercised');
    },
    showNotification: () => {
      throw new Error('not exercised');
    },
    getCurrentTabId: () => 0,
    mainThreadId: 0,
    getActiveMessageList: () => undefined,
    getActiveChatId: () => undefined,
    getCurrentUserId: () => undefined,
    getChat: () => undefined,
    getLocalizedString: (key) => key,
    getStorageEngine: () => (engine ? Promise.resolve(engine) : Promise.reject(new Error('no engine'))),
    getStorageEngineHandle: () => {
      throw new Error('the slice never exposes the engine handle');
    },
  };

  const reporter = runtime.createPluginReporter(TEST_PLUGIN_NAME);
  const context: PluginContext = {
    pluginName: TEST_PLUGIN_NAME,
    wrap: reporter.wrap,
    onTeardown: (teardown) => {
      registeredTeardowns.push(teardown);
    },
    runTeardowns: () => {
      const pending = registeredTeardowns.splice(0);
      for (const teardown of pending) {
        teardown();
      }
    },
  };

  return {
    storage: createStorageSlice(context, runtime),
    context,
    capturedErrors,
    registeredTeardowns,
  };
}

describe('storage slice: namespacing', () => {
  it('stores record keys namespaced per plugin and strips the namespace on reads', async () => {
    const engine = createFakeEngine();
    const { storage } = createTestSlice(engine);

    await storage.putRecord('pref', { text: 'hello' });

    expect(engine.recordData.get('alpha:pref')).toEqual({ text: 'hello' });
    expect(await storage.getRecord<{ text: string }>('pref')).toEqual({ text: 'hello' });
  });

  it('hides another plugin\'s keys: a raw engine read of the bare key stays invisible', async () => {
    const engine = createFakeEngine();
    const { storage } = createTestSlice(engine);

    // Plugin beta's data, written directly through the (shared) engine
    await engine.putRecord('beta:pref', { text: 'theirs' });

    expect(await storage.getRecord('pref')).toBeUndefined();
    expect(await storage.getRecord('beta:pref')).toBeUndefined();
  });

  it('lists only the calling plugin\'s records with bare keys', async () => {
    const engine = createFakeEngine();
    const { storage } = createTestSlice(engine);

    await storage.putRecord('chat:1:a', 1);
    await storage.putRecord('chat:1:b', 2);
    await engine.putRecord('beta:chat:1:a', 3);

    const page = await storage.listRecords<number>({ prefix: 'chat:1:' });

    expect(page.items).toEqual([
      { key: 'chat:1:a', record: 1 },
      { key: 'chat:1:b', record: 2 },
    ]);
  });

  it('clears only the calling plugin\'s records', async () => {
    const engine = createFakeEngine();
    const { storage } = createTestSlice(engine);

    await storage.putRecord('key', 1);
    await engine.putRecord('beta:key', 2);

    await storage.clearRecords();

    expect(engine.recordData.has('alpha:key')).toBe(false);
    expect(engine.recordData.get('beta:key')).toBe(2);
    expect(engine.clearRecords).toHaveBeenCalledWith('alpha:');
  });

  it('namespaces blobs through the same prefix', async () => {
    const engine = createFakeEngine();
    const { storage } = createTestSlice(engine);
    const blob = new Blob(['bytes']);

    await storage.putBlob('media', blob);

    expect(engine.blobData.get('alpha:media')).toBe(blob);
    expect(await storage.getBlob('media')).toBe(blob);

    await storage.deleteBlob('media');
    expect(engine.blobData.has('alpha:media')).toBe(false);
  });
});

describe('storage slice: error containment', () => {
  it('resolves safe defaults when the engine is missing', async () => {
    const { storage, capturedErrors } = createTestSlice(undefined);

    await expect(storage.putRecord('key', 1)).resolves.toBeUndefined();
    await expect(storage.getRecord('key')).resolves.toBeUndefined();
    await expect(storage.listRecords()).resolves.toEqual({ items: [] });
    await expect(storage.deleteRecord('key')).resolves.toBeUndefined();
    await expect(storage.clearRecords()).resolves.toBeUndefined();
    await expect(storage.putBlob('key', new Blob(['b']))).resolves.toEqual({
      isStored: false, reason: 'unavailable',
    });
    await expect(storage.getBlob('key')).resolves.toBeUndefined();
    await expect(storage.deleteBlob('key')).resolves.toBeUndefined();
    await expect(storage.getUsage()).resolves.toEqual({
      usedBytes: 0, budgetBytes: 0, quotaBytes: 0,
    });

    expect(capturedErrors.map(({ action }) => action)).toEqual([
      'alpha:storage.putRecord',
      'alpha:storage.getRecord',
      'alpha:storage.listRecords',
      'alpha:storage.deleteRecord',
      'alpha:storage.clearRecords',
      'alpha:storage.putBlob',
      'alpha:storage.getBlob',
      'alpha:storage.deleteBlob',
      'alpha:storage.getUsage',
    ]);
  });

  it('contains a throwing engine method and resolves to a safe result', async () => {
    const engine = createFakeEngine();
    engine.getRecord.mockRejectedValue(new Error('backend down'));
    const { storage, capturedErrors } = createTestSlice(engine);

    await expect(storage.getRecord('key')).resolves.toBeUndefined();

    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].action).toBe('alpha:storage.getRecord');
  });

  it('reports a failing blob put as a record-only result, never a throw', async () => {
    const engine = createFakeEngine();
    engine.putBlob.mockRejectedValue(new Error('opfs denied'));
    const { storage } = createTestSlice(engine);

    await expect(storage.putBlob('key', new Blob(['b']))).resolves.toEqual({
      isStored: false, reason: 'unavailable',
    });
  });

  it('passes the engine usage through untouched', async () => {
    const engine = createFakeEngine();
    const { storage } = createTestSlice(engine);

    await expect(storage.getUsage()).resolves.toEqual({
      usedBytes: 10, budgetBytes: 100, quotaBytes: 1000,
    });
  });
});

describe('storage slice: teardown', () => {
  it('registers no teardown — storage data outlives disable/enable', async () => {
    const engine = createFakeEngine();
    const { storage, registeredTeardowns } = createTestSlice(engine);

    await storage.putRecord('key', 1);
    await storage.putBlob('blob', new Blob(['b']));
    // Running the plugin's teardowns (disable) must not touch the engine
    await storage.deleteRecord('other');

    expect(registeredTeardowns).toEqual([]);
    expect(engine.recordData.get('alpha:key')).toBe(1);
  });
});

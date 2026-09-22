import { afterEach, describe, expect, it } from 'vitest';

import type { TgPluginRuntime } from '../runtime';
import type { TgPluginApi } from '../types';

import { buildTgApi } from '../api';
import { createPluginContext } from '../context';
import { DEFAULT_BUDGET_BYTES, DEFAULT_PER_BLOB_CAP_BYTES } from '../storageEngine';
import { getSettings, loadSettings, resetSettings, SETTINGS_KEY, updateSettings } from './settings';

const PLUGIN_NAME = 'anti-delete';

/** In-memory storage double: a map behind the slice's namespaced keys. */
function createFakeStorage() {
  const records = new Map<string, unknown>();
  const storage: TgPluginApi['storage'] = {
    putRecord: (key, record) => {
      records.set(`${PLUGIN_NAME}:${key}`, record);
      return Promise.resolve();
    },
    getRecord: <T>(key: string) => (
      Promise.resolve(records.get(`${PLUGIN_NAME}:${key}`) as T | undefined)
    ),
    listRecords: () => Promise.resolve({ items: [] }),
    deleteRecord: () => Promise.resolve(),
    clearRecords: () => Promise.resolve(),
    putBlob: () => Promise.resolve({ isStored: true }),
    getBlob: () => Promise.resolve(undefined),
    deleteBlob: () => Promise.resolve(),
    clearBlobs: () => Promise.resolve(),
    getUsage: () => Promise.resolve({ usedBytes: 0, budgetBytes: 0, quotaBytes: 0 }),
    setBudgetBytes: () => Promise.resolve(),
    setPerBlobCapBytes: () => Promise.resolve(),
  };
  return { records, storage };
}

/** Builds a minimal `tg` over a fake storage slice; no real runtime involved. */
function createTestTg(storage: TgPluginApi['storage']): TgPluginApi {
  const runtime: TgPluginRuntime = {
    isPluginEnabled: () => true,
    setPluginEnabled: () => {},
    createPluginReporter: () => ({ log: () => {}, logError: () => {}, wrap: (callback) => callback }),
    subscribeApiUpdates: () => () => {},
    subscribeToStoreChanges: () => () => {},
    getActions: () => {
      throw new Error('settings never dispatch actions');
    },
    showNotification: () => {
      throw new Error('settings never shows notifications');
    },
    getCurrentTabId: () => 0,
    mainThreadId: -1,
    getActiveMessageList: () => undefined,
    getActiveChatId: () => undefined,
    getCurrentUserId: () => undefined,
    getChat: () => undefined,
    getUser: () => undefined,
    getCommonBoxChatId: () => undefined,
    getMessage: () => undefined,
    fetchMessageMedia: () => Promise.resolve([]),
    getLocalizedString: (key) => key,
    getStorageEngine: () => {
      throw new Error('settings tests use the fake slice directly');
    },
    getStorageEngineHandle: () => {
      throw new Error('settings tests use the fake slice directly');
    },
  };
  const context = createPluginContext(PLUGIN_NAME, runtime.createPluginReporter(PLUGIN_NAME));
  // The settings module touches only `tg.storage` and `tg.util`; the rest of
  // the assembled `tg` runs against the harmless fake runtime above.
  return { ...buildTgApi(context, runtime), storage };
}

/** Awaits the settings load (a microtask chain through the slice). */
async function flushAsync() {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  resetSettings();
});

describe('anti-delete plugin: settings', () => {
  it('loads the spec defaults on a fresh store', async () => {
    const { storage } = createFakeStorage();
    loadSettings(createTestTg(storage));
    await flushAsync();

    expect(getSettings()).toEqual({
      shouldCaptureBots: true,
      shouldGhostBeTransparent: true,
      shouldPrefetchVideos: false,
      budgetBytes: DEFAULT_BUDGET_BYTES,
      perBlobCapBytes: DEFAULT_PER_BLOB_CAP_BYTES,
    });
  });

  it('fills defaults for fields a stored record omits', async () => {
    const { storage, records } = createFakeStorage();
    // A record written before the ghost toggle existed
    records.set(`${PLUGIN_NAME}:${SETTINGS_KEY}`, { shouldCaptureBots: false });

    loadSettings(createTestTg(storage));
    await flushAsync();

    expect(getSettings().shouldCaptureBots).toBe(false);
    expect(getSettings().shouldGhostBeTransparent).toBe(true);
    expect(getSettings().budgetBytes).toBe(DEFAULT_BUDGET_BYTES);
  });

  it('persists an update and reads it back through a fresh load', async () => {
    const { storage, records } = createFakeStorage();
    loadSettings(createTestTg(storage));
    await flushAsync();

    updateSettings({ shouldCaptureBots: false, budgetBytes: 1024 });
    await flushAsync();

    // The patch persisted, versioned
    expect(records.get(`${PLUGIN_NAME}:${SETTINGS_KEY}`)).toEqual({
      schemaVersion: 1,
      shouldCaptureBots: false,
      shouldGhostBeTransparent: true,
      shouldPrefetchVideos: false,
      budgetBytes: 1024,
      perBlobCapBytes: DEFAULT_PER_BLOB_CAP_BYTES,
    });

    // A fresh load (the next lifetime) reads the stored record
    resetSettings();
    loadSettings(createTestTg(storage));
    await flushAsync();
    expect(getSettings().shouldCaptureBots).toBe(false);
    expect(getSettings().budgetBytes).toBe(1024);
  });

  it('applies an update to the in-memory cache immediately (no reload, no await)', () => {
    const { storage } = createFakeStorage();
    loadSettings(createTestTg(storage));

    // Synchronous: the very next deletion handler sees the new value
    updateSettings({ shouldCaptureBots: false });
    expect(getSettings().shouldCaptureBots).toBe(false);
  });

  it('resets to defaults on disable (no stale cache leaks into the next lifetime)', async () => {
    const { storage } = createFakeStorage();
    loadSettings(createTestTg(storage));
    await flushAsync();

    updateSettings({ shouldCaptureBots: false });
    resetSettings();

    expect(getSettings()).toEqual({
      shouldCaptureBots: true,
      shouldGhostBeTransparent: true,
      shouldPrefetchVideos: false,
      budgetBytes: DEFAULT_BUDGET_BYTES,
      perBlobCapBytes: DEFAULT_PER_BLOB_CAP_BYTES,
    });
  });

  it('skips persisting while the plugin is disabled', async () => {
    resetSettings();
    const { records } = createFakeStorage();

    // No `loadSettings` ran, so there is no lifetime to write from
    updateSettings({ shouldCaptureBots: false });
    await flushAsync();

    expect(getSettings().shouldCaptureBots).toBe(false);
    expect(records.size).toBe(0);
  });
});

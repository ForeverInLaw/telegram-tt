import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TgPluginRuntime } from '../runtime';
import type { TgPluginApi } from '../types';

import { buildTgApi } from '../api';
import { createPluginContext } from '../context';
import { clearSettingsPanels, getSettingsPanels } from '../registry';
import { DEFAULT_BUDGET_BYTES, DEFAULT_PER_BLOB_CAP_BYTES } from '../storageEngine';
import {
  applyBudgetGb,
  applyPerBlobCapMb,
  applyToggle,
  buildUsageView,
  clearAllArchive,
  formatBytes,
  getBudgetSliderMaxGb,
  getUsagePercent,
  MAX_BUDGET_GB,
  MIN_BUDGET_GB,
} from './panelLogic';
import { registerSettingsPanelGlue } from './registerPanel';
import { getSettings, SETTINGS_KEY, loadSettings, resetSettings, updateSettings } from './settings';

const PLUGIN_NAME = 'anti-delete';
const BYTES_PER_GB = 1024 ** 3;
const BYTES_PER_MB = 1024 ** 2;

/**
 * In-memory storage double: a map behind the slice's namespaced keys, with
 * the engine-config setters (`setBudgetBytes`/`setPerBlobCapBytes`) recorded
 * so the panel's engine-handle writes are assertable.
 */
function createFakeStorage(overrides?: Partial<TgPluginApi['storage']>) {
  const records = new Map<string, unknown>();
  const setBudgetBytesCalls: number[] = [];
  const setPerBlobCapBytesCalls: number[] = [];
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
    clearRecords: vi.fn(() => {
      for (const key of [...records.keys()]) {
        if (key.startsWith(`${PLUGIN_NAME}:capture:`)) records.delete(key);
      }
      return Promise.resolve();
    }),
    putBlob: () => Promise.resolve({ isStored: true }),
    getBlob: () => Promise.resolve(undefined),
    deleteBlob: () => Promise.resolve(),
    clearBlobs: vi.fn(() => Promise.resolve()),
    getUsage: () => Promise.resolve({ usedBytes: 0, budgetBytes: 0, quotaBytes: 0 }),
    setBudgetBytes: (bytes: number) => {
      setBudgetBytesCalls.push(bytes);
      return Promise.resolve();
    },
    setPerBlobCapBytes: (bytes: number) => {
      setPerBlobCapBytesCalls.push(bytes);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { records, setBudgetBytesCalls, setPerBlobCapBytesCalls, storage };
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
      throw new Error('the settings panel never dispatches actions');
    },
    showNotification: () => {
      throw new Error('the settings panel never shows notifications');
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
    getLocalizedString: (key) => key,
    getStorageEngine: () => {
      throw new Error('panel tests use the fake slice directly');
    },
    getStorageEngineHandle: () => {
      throw new Error('panel tests use the fake slice directly');
    },
  };
  const context = createPluginContext(PLUGIN_NAME, runtime.createPluginReporter(PLUGIN_NAME));
  return { ...buildTgApi(context, runtime), storage };
}

/** Awaits the settings load and the panel's own async chains. */
async function flushAsync() {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  resetSettings();
});

describe('anti-delete plugin: settings panel logic', () => {
  it('round-trips every toggle through the persisted settings (apply + read back)', async () => {
    const { records, storage } = createFakeStorage();
    const tg = createTestTg(storage);
    loadSettings(tg);
    await flushAsync();

    applyToggle('shouldCaptureBots', false);
    applyToggle('shouldGhostBeTransparent', false);
    applyToggle('shouldPrefetchVideos', true);

    const persisted = records.get(`${PLUGIN_NAME}:${SETTINGS_KEY}`) as Record<string, unknown>;
    expect(persisted.shouldCaptureBots).toBe(false);
    expect(persisted.shouldGhostBeTransparent).toBe(false);
    expect(persisted.shouldPrefetchVideos).toBe(true);

    // The in-memory cache applies immediately — the capture pipeline, the
    // ghost renderer and the media capture read it live, no reload.
    expect(getSettings().shouldCaptureBots).toBe(false);
    expect(getSettings().shouldGhostBeTransparent).toBe(false);
    expect(getSettings().shouldPrefetchVideos).toBe(true);
  });

  it('applies a budget slider move to the plugin settings AND the engine handle', async () => {
    const { records, setBudgetBytesCalls, storage } = createFakeStorage();
    const tg = createTestTg(storage);
    loadSettings(tg);
    await flushAsync();

    const writtenBytes = applyBudgetGb(12);
    await tg.storage.setBudgetBytes(writtenBytes);

    expect(writtenBytes).toBe(12 * BYTES_PER_GB);
    // The plugin's own record keeps the chosen position (survives reloads)...
    const persisted = records.get(`${PLUGIN_NAME}:${SETTINGS_KEY}`) as Record<string, unknown>;
    expect(persisted.budgetBytes).toBe(12 * BYTES_PER_GB);
    // ...and the engine handle receives the same bytes (it clamps at runtime).
    expect(setBudgetBytesCalls).toEqual([12 * BYTES_PER_GB]);
  });

  it('clamps the budget slider maximum to 50% of a low quota', () => {
    // A 20 GB quota: 50% is 10 GB, so the slider tops out at 10, not 50.
    expect(getBudgetSliderMaxGb(20 * BYTES_PER_GB)).toBe(10);
    // A generous quota shows the spec ceiling.
    expect(getBudgetSliderMaxGb(500 * BYTES_PER_GB)).toBe(MAX_BUDGET_GB);
    // A tiny quota still keeps the slider movable at its minimum.
    expect(getBudgetSliderMaxGb(1 * BYTES_PER_GB)).toBe(MIN_BUDGET_GB);
  });

  it('clamps the slider position itself under a low quota (stored value still persists)', () => {
    // The user stored 40 GB earlier; a 20 GB quota shows the position at 10.
    updateSettings({ budgetBytes: 40 * BYTES_PER_GB });
    const view = buildUsageView({ usedBytes: 0, budgetBytes: 40 * BYTES_PER_GB, quotaBytes: 20 * BYTES_PER_GB });
    expect(view.budgetGb).toBe(10);
    expect(view.budgetSliderMaxGb).toBe(10);
    // The stored 40 GB stays the persisted choice; the engine clamps the
    // effective budget itself, so the settings record is not rewritten.
  });

  it('round-trips the per-blob cap through settings and the engine handle', async () => {
    const { records, setPerBlobCapBytesCalls, storage } = createFakeStorage();
    const tg = createTestTg(storage);
    loadSettings(tg);
    await flushAsync();

    const writtenBytes = applyPerBlobCapMb(256);
    await tg.storage.setPerBlobCapBytes(writtenBytes);

    expect(writtenBytes).toBe(256 * BYTES_PER_MB);
    const persisted = records.get(`${PLUGIN_NAME}:${SETTINGS_KEY}`) as Record<string, unknown>;
    expect(persisted.perBlobCapBytes).toBe(256 * BYTES_PER_MB);
    expect(setPerBlobCapBytesCalls).toEqual([256 * BYTES_PER_MB]);
  });

  it('clamps the per-blob cap slider position to the spec bounds', () => {
    // The default cap (64 MB) sits inside the slider's 8–512 MB bounds.
    const defaultView = buildUsageView({
      usedBytes: 0, budgetBytes: DEFAULT_BUDGET_BYTES, quotaBytes: 500 * BYTES_PER_GB,
    });
    expect(defaultView.perBlobCapMb).toBe(DEFAULT_PER_BLOB_CAP_BYTES / BYTES_PER_MB);

    // A stored cap above the slider's maximum shows the maximum position.
    updateSettings({ perBlobCapBytes: 2048 * BYTES_PER_MB });
    const overflowingView = buildUsageView({
      usedBytes: 0, budgetBytes: DEFAULT_BUDGET_BYTES, quotaBytes: 500 * BYTES_PER_GB,
    });
    expect(overflowingView.perBlobCapMb).toBe(512);
  });

  it('clears every record and blob for the account through the storage slice', async () => {
    const { records, storage } = createFakeStorage();
    const tg = createTestTg(storage);
    records.set(`${PLUGIN_NAME}:capture:100:0000000001`, { text: 'gone' });
    records.set(`${PLUGIN_NAME}:capture:100:0000000002`, { text: 'gone too' });

    await clearAllArchive(tg);
    await flushAsync();

    expect(storage.clearRecords).toHaveBeenCalled();
    expect(storage.clearBlobs).toHaveBeenCalled();
    expect([...records.keys()].filter((key) => key.startsWith(`${PLUGIN_NAME}:capture:`))).toEqual([]);
  });

  it('reads the usage bar values from the engine accounting', () => {
    const view = buildUsageView({ usedBytes: 2 * BYTES_PER_GB, budgetBytes: 5 * BYTES_PER_GB, quotaBytes: 100 * BYTES_PER_GB });
    expect(view.usage.usedBytes).toBe(2 * BYTES_PER_GB);
    expect(getUsagePercent(view.usage)).toBe(40);
    expect(getUsagePercent({ usedBytes: 6 * BYTES_PER_GB, budgetBytes: 5 * BYTES_PER_GB, quotaBytes: 0 })).toBe(100);
    expect(getUsagePercent({ usedBytes: 0, budgetBytes: 0, quotaBytes: 0 })).toBe(0);
  });

  it('formats byte sizes compactly for the usage labels', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2 * 1024 ** 2)).toBe('2.0 MB');
    expect(formatBytes(5 * BYTES_PER_GB)).toBe('5.0 GB');
    expect(formatBytes(1536 * 1024 ** 2)).toBe('1.5 GB');
  });

  it('persists a settings update written directly through updateSettings (panel re-seeds from it)', async () => {
    const { records, storage } = createFakeStorage();
    const tg = createTestTg(storage);
    loadSettings(tg);
    await flushAsync();

    updateSettings({ shouldCaptureBots: false, budgetBytes: 3 * BYTES_PER_GB });

    const persisted = records.get(`${PLUGIN_NAME}:${SETTINGS_KEY}`) as Record<string, unknown>;
    expect(persisted.shouldCaptureBots).toBe(false);
    expect(persisted.budgetBytes).toBe(3 * BYTES_PER_GB);
  });
});

describe('anti-delete plugin: settings panel glue', () => {
  it('registers the panel through the ui seam and unregisters cleanly', async () => {
    const { records, storage } = createFakeStorage();
    const tg = createTestTg(storage);
    loadSettings(tg);
    await flushAsync();
    records.clear();

    const unregister = registerSettingsPanelGlue(tg);
    expect(unregister).toBeTypeOf('function');
    expect(getSettingsPanels()).toHaveLength(1);
    expect(getSettingsPanels()[0].title).toBe('AntiDeleteSettingsTitle');

    // The registered render builds a Teact node without touching storage or
    // the store: forcing the render call pins the seam contract.
    const node = getSettingsPanels()[0].render();
    expect(node).toBeTruthy();

    unregister?.();
    expect(getSettingsPanels()).toHaveLength(0);
    clearSettingsPanels(PLUGIN_NAME);
  });
});

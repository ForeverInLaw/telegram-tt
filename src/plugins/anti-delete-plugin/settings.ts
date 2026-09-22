import type { TgPluginApi } from '../types';

import { DEFAULT_BUDGET_BYTES, DEFAULT_PER_BLOB_CAP_BYTES } from '../storageEngine';

/** Version of the settings record layout; a bump is a forward migration. */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Storage key holding the plugin's settings record (inside the plugin's namespace). */
export const SETTINGS_KEY = 'settings';

/** Persisted plugin settings; every field has a spec default. */
export interface AntiDeleteSettings {
  /** Capture deletions in chats with a bot counterpart. */
  shouldCaptureBots: boolean;
  /** Render retained ghosts semi-transparent (read by the ghost-retention ticket). */
  shouldGhostBeTransparent: boolean;
  /** Prefetch deleted videos while the file reference is alive (read by the media ticket). */
  shouldPrefetchVideos: boolean;
  /** Media budget; the storage engine clamps it to 50% of the origin quota. */
  budgetBytes: number;
  /** Cap on one media blob; larger blobs stay record-only. */
  perBlobCapBytes: number;
}

/** On-disk shape: the versioned payload plus the fields a stored record may omit. */
type PersistedSettings = Partial<AntiDeleteSettings> & { schemaVersion?: number };

/** Spec defaults, aligned with the storage engine's own defaults. */
export const DEFAULT_ANTI_DELETE_SETTINGS: AntiDeleteSettings = {
  shouldCaptureBots: true,
  shouldGhostBeTransparent: true,
  shouldPrefetchVideos: false,
  budgetBytes: DEFAULT_BUDGET_BYTES,
  perBlobCapBytes: DEFAULT_PER_BLOB_CAP_BYTES,
};

// Module state of the current lifetime: the settings record is loaded into
// memory once per `setup` (the deletion handler runs synchronously and must
// not read storage per event), and the slice reference serves later
// `updateSettings` calls (the settings UI has no `tg` object at hand). The
// disposer clears both, so a disabled plugin owns no stale settings.

let settingsCache: AntiDeleteSettings = { ...DEFAULT_ANTI_DELETE_SETTINGS };
let areSettingsLoaded = false;
let settingsTg: TgPluginApi | undefined;

/** Whether the persisted settings record has settled into the cache this lifetime. */
export function areSettingsReady(): boolean {
  return areSettingsLoaded;
}

/**
 * Loads the settings into the in-memory cache for this lifetime. Called from
 * `setup`; missing fields fall back to the defaults, so a record written
 * before a new field existed loads cleanly. Until the async read settles,
 * `areSettingsReady` answers `false`: capture filters treat early deletions
 * conservatively rather than trusting defaults over the user's persisted
 * toggles.
 */
export function loadSettings(tg: TgPluginApi): void {
  settingsTg = tg;
  areSettingsLoaded = false;

  tg.storage.getRecord<PersistedSettings>(SETTINGS_KEY).then((stored) => {
    settingsCache = mergeSettings(stored);
    areSettingsLoaded = true;

    // The engine's META record and the plugin's settings can diverge (a
    // wiped namespace, a manual record edit); the persisted settings are
    // the source of truth, so they push into the engine on load
    void tg.storage.setBudgetBytes(settingsCache.budgetBytes).catch((err) => {
      tg.util.log('budget push failed', err);
    });
    void tg.storage.setPerBlobCapBytes(settingsCache.perBlobCapBytes).catch((err) => {
      tg.util.log('per-blob cap push failed', err);
    });
  }).catch((err) => {
    // The slice already contains backend errors; this guards the chain itself
    tg.util.log('settings load failed', err);
  });
}

/**
 * Applies a settings patch: merges it into the in-memory cache (subsequent
 * captures see the new values without a reload) and persists the merged
 * record. A no-op while the plugin is disabled (no lifetime to write from).
 */
export function updateSettings(patch: Partial<AntiDeleteSettings>): void {
  settingsCache = mergeSettings({ ...settingsCache, ...patch });

  if (settingsTg === undefined) return;

  settingsTg.storage.putRecord(SETTINGS_KEY, {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    ...settingsCache,
  }).catch((err) => {
    // The slice already contains backend errors; this guards the chain itself
    settingsTg?.util.log('settings persist failed', err);
  });
}

/** The cached settings of the current lifetime; defaults before the record loads. */
export function getSettings(): AntiDeleteSettings {
  return settingsCache;
}

/**
 * Clears the cache and the lifetime reference; called on disable so no state
 * leaks into the next lifetime.
 */
export function resetSettings(): void {
  settingsCache = { ...DEFAULT_ANTI_DELETE_SETTINGS };
  areSettingsLoaded = false;
  settingsTg = undefined;
}

function mergeSettings(stored: PersistedSettings | undefined): AntiDeleteSettings {
  return {
    shouldCaptureBots: stored?.shouldCaptureBots ?? DEFAULT_ANTI_DELETE_SETTINGS.shouldCaptureBots,
    shouldGhostBeTransparent: stored?.shouldGhostBeTransparent
      ?? DEFAULT_ANTI_DELETE_SETTINGS.shouldGhostBeTransparent,
    shouldPrefetchVideos: stored?.shouldPrefetchVideos ?? DEFAULT_ANTI_DELETE_SETTINGS.shouldPrefetchVideos,
    budgetBytes: stored?.budgetBytes ?? DEFAULT_ANTI_DELETE_SETTINGS.budgetBytes,
    perBlobCapBytes: stored?.perBlobCapBytes ?? DEFAULT_ANTI_DELETE_SETTINGS.perBlobCapBytes,
  };
}

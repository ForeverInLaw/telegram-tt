/**
 * Budgeted storage engine behind the `tg.storage` contract slice.
 *
 * The engine owns three platform services, injected so tests run on doubles:
 * a record backend (IndexedDB via idb-keyval in production), a blob backend
 * (OPFS in production), and `navigator.storage` (quota estimate + persist).
 * Everything above the seam is engine policy and stays platform-free:
 *
 * - Records are unbudgeted and never evicted.
 * - Blobs live under a budget: `min(budget setting, 50% of the quota)`.
 * - Writing past the budget evicts the oldest captured blobs first (LRU by
 *   `capturedAt`, the index order is the tie-breaker), best-effort: a
 *   failed eviction logs and never blocks the write path.
 * - Blobs above the per-blob cap are rejected record-only (`'overCap'`).
 * - Usage is tracked incrementally: a startup estimate seeds the counter,
 *   every put/delete applies its delta, and the counter is persisted in the
 *   record store so restarts stay accurate without scans.
 *
 * The engine is per account slot: each slot gets its own record store and
 * blob directory, so accounts never mix. Plugins never see each other's
 * data: every key arrives already namespaced (`<pluginName>:<key>`, applied
 * by the slice) and blob files nest in per-plugin directories.
 */
import type { TgBlobPutResult, TgListRecordsOptions, TgListRecordsPage, TgStorageUsage } from './types';

import { IdbStore } from '../util/browser/idb';
import { ACCOUNT_SLOT } from '../util/multiaccount';

/** Version of the record store layout; a bump is a forward migration. */
export const STORAGE_SCHEMA_VERSION = 1;

/** Default media budget: 5 GB, clamped to 50% of the origin quota at runtime. */
export const DEFAULT_BUDGET_BYTES = 5 * 1024 ** 3;
/** Default cap on one blob: 64 MB; larger media stays record-only. */
export const DEFAULT_PER_BLOB_CAP_BYTES = 64 * 1024 ** 2;

/** Share of the origin quota the blob space may occupy at most. */
const QUOTA_SHARE = 0.5;
/** Upper bound on one `listRecords` page, whatever the caller requests. */
const MAX_LIST_LIMIT = 1000;

const META_KEY = '__meta';
const USAGE_KEY = '__usage';
const BLOB_INDEX_KEY = '__blob-index';
const IDB_STORE_PREFIX = 'tt-plugin-storage';
const OPFS_DIR_PREFIX = 'plugin-storage';
const UNNAMED_PLUGIN_DIR = '_';

/** Shape persisted in the meta record; drives forward migrations. */
interface TgStorageMeta {
  schemaVersion: number;
  budgetBytes: number;
  perBlobCapBytes: number;
}

/** Incremental usage counter persisted in the record store. */
interface TgStorageUsageRecord {
  usedBytes: number;
}

/** One blob index entry; the whole set is the LRU eviction index. */
export interface TgStorageBlobEntry {
  key: string;
  sizeBytes: number;
  capturedAt: number;
}

/** Minimal record backend: idb-keyval-shaped, so `IdbStore` satisfies it. */
export interface TgRecordBackend {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

/** Minimal blob backend: a flat put/get/remove file space. */
export interface TgBlobBackend {
  put(key: string, blob: Blob): Promise<void>;
  get(key: string): Promise<Blob | undefined>;
  remove(key: string): Promise<void>;
}

/** The `navigator.storage` surface the engine needs, injected for tests. */
export interface TgStorageEstimator {
  estimate(): Promise<{ usage: number; quota: number }>;
  persist(): Promise<boolean>;
}

/** Environment services the engine runs on; production wiring lives in `createDefaultServices`. */
export interface TgStorageServices {
  recordBackend: TgRecordBackend;
  /** `undefined` disables the blob space: puts resolve `reason: 'unavailable'`. */
  blobBackend: TgBlobBackend | undefined;
  estimator: TgStorageEstimator;
  /** Injected clock so eviction order is pinnable in tests. */
  now: () => number;
  /** Error log for best-effort paths (evictions, migrations); prefixed by the caller. */
  logError: (message: string, error: unknown) => void;
}

/**
 * The engine surface the `tg.storage` slice builds on. Every method may
 * reject on a broken backend; the slice contains errors per contract.
 */
export interface TgStorageEngine {
  putRecord: (key: string, record: unknown) => Promise<void>;
  getRecord: <T>(key: string) => Promise<T | undefined>;
  listRecords: <T>(options?: TgListRecordsOptions) => Promise<TgListRecordsPage<T>>;
  deleteRecord: (key: string) => Promise<void>;
  /** Removes records; pass a `prefix` to keep unrelated records (e.g. other plugins'). */
  clearRecords: (prefix?: string) => Promise<void>;

  putBlob: (key: string, blob: Blob) => Promise<TgBlobPutResult>;
  getBlob: (key: string) => Promise<Blob | undefined>;
  deleteBlob: (key: string) => Promise<void>;

  getUsage: () => Promise<TgStorageUsage>;
  setBudgetBytes: (bytes: number) => Promise<void>;
  setPerBlobCapBytes: (bytes: number) => Promise<void>;
}

/** Engine-scoped config surface for the runtime (settings UI); a subset of the engine. */
export type TgStorageEngineHandle = Pick<TgStorageEngine, 'setBudgetBytes' | 'setPerBlobCapBytes' | 'getUsage'>;

/**
 * Builds the production services: a per-slot idb-keyval store, the per-slot
 * OPFS blob backend (opened lazily on first use, so a slow or denied OPFS
 * root never blocks engine construction) and `navigator.storage`.
 */
export function createDefaultServices(): TgStorageServices {
  const slot = ACCOUNT_SLOT || 1;
  const slotStore = new IdbStore(`${IDB_STORE_PREFIX}_${slot}`);

  return {
    recordBackend: {
      get: (key) => slotStore.get(key),
      set: (key, value) => slotStore.set(key, value),
      del: (key) => slotStore.del(key),
      keys: () => slotStore.keys() as Promise<string[]>,
      clear: () => slotStore.clear(),
    },
    blobBackend: createOpfsBlobBackend(slot),
    estimator: {
      estimate: async () => {
        const estimate = await navigator.storage.estimate();
        return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
      },
      persist: () => navigator.storage.persist(),
    },
    now: () => Date.now(),
    logError: (message, error) => {
      // eslint-disable-next-line no-console
      console.error(`[plugins] storage engine ${message}:`, error);
    },
  };
}

/**
 * A lazily-opening OPFS backend: `undefined` until the first blob operation
 * proves OPFS unavailable, then permanently disabled (graceful fallback).
 */
function createOpfsBlobBackend(slot: number): TgBlobBackend {
  // A plugin name → directory handle cache; directory handles are cheap to
  // reuse and a fresh `getDirectoryHandle` on every blob read adds a hop.
  const pluginDirs = new Map<string, FileSystemDirectoryHandle>();
  let isDisabled = false;

  async function openPluginDir(pluginName: string) {
    const { getDirectory } = navigator.storage;
    if (!getDirectory || isDisabled) {
      return undefined;
    }
    try {
      const root = await getDirectory.call(navigator.storage);
      const slotDir = await root.getDirectoryHandle(`${OPFS_DIR_PREFIX}_${slot}`, { create: true });
      const cachedDir = pluginDirs.get(pluginName);
      const dir = cachedDir ?? await slotDir.getDirectoryHandle(pluginName, { create: true });
      pluginDirs.set(pluginName, dir);
      return dir;
    } catch (err) {
      // A denied OPFS root degrades to the disabled blob space rather than a broken engine
      isDisabled = true;
      // eslint-disable-next-line no-console
      console.error('[plugins] storage engine failed to open the OPFS blob backend:', err);
      return undefined;
    }
  }

  return {
    put: async (key, blob) => {
      const { pluginName, fileName } = splitBlobKey(key);
      const dir = await openPluginDir(pluginName);
      if (!dir) {
        throw new Error('the OPFS blob backend is unavailable');
      }
      const fileHandle = await dir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    },
    get: async (key) => {
      const { pluginName, fileName } = splitBlobKey(key);
      const dir = await openPluginDir(pluginName);
      if (!dir) {
        return undefined;
      }
      try {
        const fileHandle = await dir.getFileHandle(fileName);
        return await fileHandle.getFile();
      } catch (err) {
        // `getFileHandle` rejects for a missing file; a missing blob reads as `undefined`
        return undefined;
      }
    },
    remove: async (key) => {
      const { pluginName, fileName } = splitBlobKey(key);
      const dir = await openPluginDir(pluginName);
      if (!dir) {
        throw new Error('the OPFS blob backend is unavailable');
      }
      await dir.removeEntry(fileName);
    },
  };
}

/** Splits a namespaced blob key back into its plugin dir and file name. */
function splitBlobKey(key: string) {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex === -1) {
    return { pluginName: UNNAMED_PLUGIN_DIR, fileName: key };
  }
  return {
    pluginName: key.slice(0, separatorIndex),
    fileName: key.slice(separatorIndex + 1),
  };
}

/**
 * Builds the engine over injected services. The returned promise settles once
 * the startup estimate, the persisted usage counter and any forward
 * migration have run; the host awaits it before any plugin receives its
 * `tg` object, so slices see a fully initialized engine.
 */
export async function createStorageEngine(services: TgStorageServices): Promise<TgStorageEngine> {
  const { recordBackend, blobBackend, estimator, now, logError } = services;

  let meta: TgStorageMeta = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    budgetBytes: DEFAULT_BUDGET_BYTES,
    perBlobCapBytes: DEFAULT_PER_BLOB_CAP_BYTES,
  };
  let usageBytes = 0;
  let quotaBytes = 0;
  let blobIndex: TgStorageBlobEntry[] = [];
  let areWritesReady = false;
  let hasPersistBeenRequested = false;

  try {
    await migrateForward();
    const [estimate, usageRecord, index] = await Promise.all([
      estimator.estimate(),
      recordBackend.get<TgStorageUsageRecord>(USAGE_KEY),
      recordBackend.get<TgStorageBlobEntry[]>(BLOB_INDEX_KEY),
    ]);
    quotaBytes = estimate.quota;
    // First boot seeds the counter from the origin estimate; later boots trust
    // the persisted counter, which is exact per-delta. The estimate counts
    // the app's own caches too, but only until the first write re-persists
    // the exact value — a startup blob scan is what the incremental
    // accounting exists to avoid.
    usageBytes = usageRecord ? usageRecord.usedBytes : estimate.usage;
    blobIndex = index ?? [];
    areWritesReady = true;
  } catch (err) {
    // A failed init leaves the engine read-only; the environment may recover
    logError('init failed', err);
  }

  async function migrateForward() {
    const storedMeta = await recordBackend.get<TgStorageMeta>(META_KEY);
    if (!storedMeta) {
      // No meta record means a pre-versioning store; the record space is
      // version-free (plugins version their own payloads), so migrating
      // forward is the version stamp itself. Future versions chain their
      // steps here, each writing the meta record at its own version.
      await recordBackend.set(META_KEY, meta);
      return;
    }

    if (storedMeta.schemaVersion === STORAGE_SCHEMA_VERSION) {
      // The meta record also carries the budget config; adopt it
      meta = {
        schemaVersion: storedMeta.schemaVersion,
        budgetBytes: storedMeta.budgetBytes,
        perBlobCapBytes: storedMeta.perBlobCapBytes,
      };
      return;
    }

    if (storedMeta.schemaVersion > STORAGE_SCHEMA_VERSION) {
      // A newer schema belongs to a newer client; refuse to touch it rather
      // than corrupt it (the engine stays read-only after this throw)
      throw new Error(`record store schema v${storedMeta.schemaVersion} is newer than supported`);
    }

    await recordBackend.set(META_KEY, meta);
    // eslint-disable-next-line no-console
    console.warn(`[plugins] storage engine migrated schema v${storedMeta.schemaVersion} → v${STORAGE_SCHEMA_VERSION}`);
  }

  /** Asks the origin to persist storage once per engine; failures are ignored. */
  async function requestPersistOnce() {
    if (hasPersistBeenRequested) {
      return;
    }
    hasPersistBeenRequested = true;
    try {
      await estimator.persist();
    } catch (err) {
      // A denied or missing persist is fine; the write proceeds either way
    }
  }

  function getBudgetBytes() {
    return Math.min(meta.budgetBytes, Math.floor(quotaBytes * QUOTA_SHARE));
  }

  async function persistUsage() {
    await recordBackend.set(USAGE_KEY, { usedBytes: usageBytes } satisfies TgStorageUsageRecord);
  }

  async function persistIndex() {
    await recordBackend.set(BLOB_INDEX_KEY, blobIndex);
  }

  /**
   * Evicts the oldest captured blobs until `incomingBytes` fits the budget.
   * Best-effort: every failure logs and moves on, so a stuck backend never
   * blocks the caller (records are unbudgeted and never touched here).
   */
  async function evictForBytes(incomingBytes: number): Promise<boolean> {
    let projectedBytes = usageBytes + incomingBytes;
    while (projectedBytes > getBudgetBytes() && blobIndex.length > 0) {
      const [oldest] = blobIndex;
      blobIndex = blobIndex.slice(1);
      projectedBytes -= oldest.sizeBytes;
      // Count the space as freed even when the file removal fails: an
      // undeletable file is stuck on disk either way, and the index keeps
      // serving exact reads.
      usageBytes = Math.max(0, usageBytes - oldest.sizeBytes);

      if (blobBackend) {
        try {
          await blobBackend.remove(oldest.key);
        } catch (err) {
          logError(`failed to evict blob ${oldest.key}`, err);
        }
      }
    }

    await Promise.all([persistUsage(), persistIndex()]);
    return projectedBytes <= getBudgetBytes();
  }

  async function putBlob(key: string, blob: Blob): Promise<TgBlobPutResult> {
    if (!areWritesReady) {
      return { isStored: false, reason: 'unavailable' };
    }
    if (blob.size > meta.perBlobCapBytes) {
      return { isStored: false, reason: 'overCap' };
    }
    if (!blobBackend) {
      return { isStored: false, reason: 'unavailable' };
    }

    const previousSizeBytes = blobIndex.find((entry) => entry.key === key)?.sizeBytes ?? 0;
    try {
      // The net delta drives eviction: overwriting a blob only needs its growth
      const isFitting = await evictForBytes(blob.size - previousSizeBytes);
      if (!isFitting) {
        return { isStored: false, reason: 'overBudget' };
      }
      await blobBackend.put(key, blob);
    } catch (err) {
      logError(`failed to put blob ${key}`, err);
      return { isStored: false, reason: 'unavailable' };
    }

    // The delta applies only after a confirmed write; the previous entry is
    // re-read because the eviction loop above may have removed it already.
    const oldEntry = blobIndex.find((entry) => entry.key === key);
    blobIndex = blobIndex.filter((entry) => entry.key !== key);
    usageBytes = Math.max(0, usageBytes - (oldEntry?.sizeBytes ?? 0)) + blob.size;
    blobIndex.push({ key, sizeBytes: blob.size, capturedAt: now() });

    await Promise.all([persistUsage(), persistIndex(), requestPersistOnce()]);
    return { isStored: true };
  }

  async function deleteBlob(key: string) {
    const entry = blobIndex.find((blobEntry) => blobEntry.key === key);
    blobIndex = blobIndex.filter((blobEntry) => blobEntry.key !== key);
    usageBytes = Math.max(0, usageBytes - (entry?.sizeBytes ?? 0));

    try {
      if (blobBackend && entry) {
        await blobBackend.remove(key);
      }
      await Promise.all([persistUsage(), persistIndex()]);
    } catch (err) {
      logError(`failed to delete blob ${key}`, err);
    }
  }

  async function putRecord(key: string, record: unknown) {
    if (!areWritesReady) {
      throw new Error('storage engine writes are unavailable');
    }
    await recordBackend.set(key, record);
    // The first record write also asks the origin to persist storage
    await requestPersistOnce();
  }

  async function deleteRecord(key: string) {
    if (!areWritesReady) {
      return;
    }
    await recordBackend.del(key);
  }

  async function listRecords<T>(options?: TgListRecordsOptions): Promise<TgListRecordsPage<T>> {
    const prefix = options?.prefix ?? '';
    const limit = Math.min(options?.limit ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT);
    const afterKey = options?.cursor;

    const keys = (await recordBackend.keys()).filter((key) => {
      if (!key.startsWith(prefix)) {
        return false;
      }
      return afterKey === undefined || key > afterKey;
    });

    const pageKeys = keys.slice(0, limit);
    if (pageKeys.length === 0) {
      return { items: [] };
    }

    const records = await Promise.all(pageKeys.map((key) => recordBackend.get<T>(key)));
    return {
      items: pageKeys.map((key, index) => ({ key, record: records[index] as T })),
      cursor: keys.length > pageKeys.length ? pageKeys[pageKeys.length - 1] : undefined,
    };
  }

  async function clearRecords(prefix?: string) {
    if (!areWritesReady) {
      return;
    }
    if (prefix === undefined) {
      await recordBackend.clear();
      // `clear` wipes the engine's own records too; re-stamp them
      blobIndex = [];
      usageBytes = 0;
      await Promise.all([recordBackend.set(META_KEY, meta), persistUsage(), persistIndex()]);
      return;
    }

    const keys = (await recordBackend.keys()).filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => recordBackend.del(key)));
  }

  async function setBudgetBytes(bytes: number) {
    if (!areWritesReady) {
      return;
    }
    meta = { ...meta, budgetBytes: bytes };
    await recordBackend.set(META_KEY, meta);
  }

  async function setPerBlobCapBytes(bytes: number) {
    if (!areWritesReady) {
      return;
    }
    meta = { ...meta, perBlobCapBytes: bytes };
    await recordBackend.set(META_KEY, meta);
  }

  function getUsage(): Promise<TgStorageUsage> {
    return Promise.resolve({
      usedBytes: usageBytes,
      budgetBytes: getBudgetBytes(),
      quotaBytes,
    });
  }

  async function getBlob(key: string) {
    if (!blobBackend) {
      return undefined;
    }
    try {
      return await blobBackend.get(key);
    } catch (err) {
      logError(`failed to read blob ${key}`, err);
      return undefined;
    }
  }

  return {
    putRecord,
    getRecord: recordBackend.get,
    listRecords,
    deleteRecord,
    clearRecords,
    putBlob,
    getBlob,
    deleteBlob,
    getUsage,
    setBudgetBytes,
    setPerBlobCapBytes,
  };
}

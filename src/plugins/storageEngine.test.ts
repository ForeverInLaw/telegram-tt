import { describe, expect, it, vi } from 'vitest';

import type { TgRecordBackend, TgStorageServices } from './storageEngine';

import {
  createStorageEngine,
  DEFAULT_BUDGET_BYTES, DEFAULT_PER_BLOB_CAP_BYTES, STORAGE_SCHEMA_VERSION } from './storageEngine';

/** In-memory record backend: one Map per slot, IDB-shaped promises. */
function createMemoryRecordBackend(): TgRecordBackend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    set: (key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    },
    del: (key: string) => {
      data.delete(key);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...data.keys()].sort()),
    clear: () => {
      data.clear();
      return Promise.resolve();
    },
  };
}

/** In-memory blob backend recording writes so eviction order is assertable. */
function createMemoryBlobBackend() {
  const blobs = new Map<string, Blob>();
  let shouldFailRemoval = false;
  return {
    blobs,
    failRemovals: () => {
      shouldFailRemoval = true;
    },
    put: (key: string, blob: Blob) => {
      blobs.set(key, blob);
      return Promise.resolve();
    },
    get: (key: string) => Promise.resolve(blobs.get(key)),
    remove: (key: string) => {
      if (shouldFailRemoval) {
        return Promise.reject(new Error('removal failed'));
      }
      blobs.delete(key);
      return Promise.resolve();
    },
  };
}

/** Controllable `navigator.storage` double counting persist calls. */
function createFakeEstimator(quotaBytes: number, usageBytes = 0) {
  const estimate = vi.fn(() => Promise.resolve({ usage: usageBytes, quota: quotaBytes }));
  const persist = vi.fn(() => Promise.resolve(true));
  return { estimate, persist };
}

/** Controllable clock so eviction order (LRU by capture time) is pinnable. */
function createFakeClock() {
  let time = 0;
  return {
    now: () => {
      time += 1;
      return time;
    },
  };
}

/** Builds services over fresh in-memory backends; `partial` overrides pieces. */
function createTestServices(partial?: Partial<TgStorageServices> & { quotaBytes?: number }) {
  const recordBackend = createMemoryRecordBackend();
  const blobBackend = createMemoryBlobBackend();
  const estimator = createFakeEstimator(partial?.quotaBytes ?? 500 * 1024 ** 3);
  const clock = createFakeClock();
  const logError = vi.fn();

  const services: TgStorageServices = {
    recordBackend,
    blobBackend,
    estimator,
    now: clock.now,
    logError,
  };

  return {
    services,
    recordBackend,
    blobBackend,
    estimator,
    clock,
    logError,
  };
}

function createBlob(sizeBytes: number) {
  return new Blob([new Uint8Array(sizeBytes)]);
}

const TEST_BUDGET = 1024 * 1024; // 1 MB budget in these tests

describe('storage engine: records', () => {
  it('round-trips a record', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setBudgetBytes(TEST_BUDGET);

    await engine.putRecord('plugin-a:key', { text: 'hello' });

    expect(await engine.getRecord<{ text: string }>('plugin-a:key')).toEqual({ text: 'hello' });
  });

  it('lists records by prefix with cursor pagination', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.putRecord('plugin-a:chat:1:msg1', { id: 1 });
    await engine.putRecord('plugin-a:chat:1:msg2', { id: 2 });
    await engine.putRecord('plugin-a:chat:2:msg1', { id: 3 });
    await engine.putRecord('plugin-b:chat:1:msg1', { id: 4 });

    const chat1Page = await engine.listRecords<{ id: number }>({ prefix: 'plugin-a:chat:1:' });
    expect(chat1Page.items.map((item) => item.key)).toEqual([
      'plugin-a:chat:1:msg1', 'plugin-a:chat:1:msg2',
    ]);

    const allPage = await engine.listRecords<{ id: number }>({ prefix: 'plugin-a:', limit: 2 });
    expect(allPage.cursor).toBe('plugin-a:chat:1:msg2');
    const restPage = await engine.listRecords<{ id: number }>({ prefix: 'plugin-a:', cursor: allPage.cursor });
    expect(restPage.items.map((item) => item.key)).toEqual(['plugin-a:chat:2:msg1']);
    expect(restPage.cursor).toBeUndefined();
  });

  it('clears only the given prefix, keeping other plugins\' records', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.putRecord('plugin-a:key', 1);
    await engine.putRecord('plugin-b:key', 2);

    await engine.clearRecords('plugin-a:');

    expect(await engine.getRecord('plugin-a:key')).toBeUndefined();
    expect(await engine.getRecord('plugin-b:key')).toBe(2);
    // The engine's own meta record survives a prefix clear
    expect(await test.recordBackend.data.get('__meta')).toBeDefined();
  });
});

describe('storage engine: budget clamp', () => {
  it('clamps the budget to 50% of a low quota while records are still accepted', async () => {
    const test = createTestServices({ quotaBytes: 1024 });
    const engine = await createStorageEngine(test.services);

    const usage = await engine.getUsage();

    // min(5 GB default, floor(1024 * 0.5)) = 512 bytes, not 5 GB
    expect(usage.budgetBytes).toBe(512);
    expect(usage.quotaBytes).toBe(1024);
    // Records are unbudgeted: even a full blob space accepts them
    await engine.putRecord('plugin-a:key', { text: 'still accepted' });
    expect(await engine.getRecord<{ text: string }>('plugin-a:key')).toEqual({ text: 'still accepted' });
  });

  it('honors a lowered budget setting over the default', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);

    await engine.setBudgetBytes(TEST_BUDGET);

    expect((await engine.getUsage()).budgetBytes).toBe(TEST_BUDGET);
  });
});

describe('storage engine: per-blob cap', () => {
  it('rejects blobs over the cap without throwing and keeps under-cap blobs', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setBudgetBytes(TEST_BUDGET);

    const overCap = await engine.putBlob('plugin-a:big', createBlob(DEFAULT_PER_BLOB_CAP_BYTES + 1));
    const underCap = await engine.putBlob('plugin-a:small', createBlob(10));

    expect(overCap).toEqual({ isStored: false, reason: 'overCap' });
    expect(underCap).toEqual({ isStored: true });
    expect(await engine.getBlob('plugin-a:big')).toBeUndefined();
    expect((await engine.getUsage()).usedBytes).toBe(10);
  });

  it('honors a lowered per-blob cap setting', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);

    await engine.setPerBlobCapBytes(100);

    expect(await engine.putBlob('plugin-a:key', createBlob(101))).toEqual({ isStored: false, reason: 'overCap' });
    expect(await engine.putBlob('plugin-a:key', createBlob(100))).toEqual({ isStored: true });
  });
});

describe('storage engine: LRU eviction', () => {
  it('evicts the oldest captured blobs first and keeps the most recent', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setBudgetBytes(200);
    // Remove the default per-blob cap so every test blob fits it
    await engine.setPerBlobCapBytes(1024 * 1024);

    // The fake clock ticks per put, so capturedAt is strictly ordered
    await engine.putBlob('plugin-a:old', createBlob(100)); // capturedAt 1
    await engine.putBlob('plugin-a:middle', createBlob(60)); // capturedAt 2
    await engine.putBlob('plugin-a:new', createBlob(30)); // capturedAt 3

    // 100 + 60 + 30 = 190 ≤ 200; a 50-byte blob forces 240 > 200 → evict
    // `old` (190-100+50=140 ≤ 200 fits after one eviction)
    const result = await engine.putBlob('plugin-a:incoming', createBlob(50));

    expect(result).toEqual({ isStored: true });
    expect(await engine.getBlob('plugin-a:old')).toBeUndefined();
    expect(test.blobBackend.blobs.has('plugin-a:old')).toBe(false);
    expect(await engine.getBlob('plugin-a:middle')).toBeDefined();
    expect(await engine.getBlob('plugin-a:new')).toBeDefined();
    expect(await engine.getBlob('plugin-a:incoming')).toBeDefined();
    expect((await engine.getUsage()).usedBytes).toBe(140);
  });

  it('evicts in capturedAt order regardless of write order of equal-size blobs', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setBudgetBytes(100);
    await engine.setPerBlobCapBytes(1024 * 1024);

    await engine.putBlob('plugin-a:first', createBlob(60)); // capturedAt 1
    await engine.putBlob('plugin-a:second', createBlob(60)); // capturedAt 2

    // 60 + 60 + 60 = 180 > 100 → evict both older blobs, keep the newest
    await engine.putBlob('plugin-a:third', createBlob(60));

    expect(test.blobBackend.blobs.has('plugin-a:first')).toBe(false);
    expect(test.blobBackend.blobs.has('plugin-a:second')).toBe(false);
    expect(test.blobBackend.blobs.has('plugin-a:third')).toBe(true);
    expect((await engine.getUsage()).usedBytes).toBe(60);
  });

  it('reports overBudget when even full eviction cannot fit the blob', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setBudgetBytes(100);
    await engine.setPerBlobCapBytes(1024 * 1024);

    await engine.putBlob('plugin-a:old', createBlob(40));
    const result = await engine.putBlob('plugin-a:huge', createBlob(101));

    expect(result).toEqual({ isStored: false, reason: 'overBudget' });
    // The over-budget write still evicted the old blob to try to fit
    expect(test.blobBackend.blobs.has('plugin-a:old')).toBe(false);
    expect((await engine.getUsage()).usedBytes).toBe(0);
  });

  it('counts a replaced blob by its net delta, not double', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setBudgetBytes(200);
    await engine.setPerBlobCapBytes(1024 * 1024);

    await engine.putBlob('plugin-a:key', createBlob(60));
    await engine.putBlob('plugin-a:key', createBlob(80));

    expect((await engine.getUsage()).usedBytes).toBe(80);
    // The replacement is the newest capture: it survives a budget squeeze
    await engine.putBlob('plugin-a:other', createBlob(100));
    expect(await engine.getBlob('plugin-a:key')).toBeDefined();
    expect((await engine.getUsage()).usedBytes).toBe(180);
  });

  it('evicts immediately when the budget shrinks below current usage', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setBudgetBytes(200);
    await engine.setPerBlobCapBytes(1024 * 1024);

    await engine.putBlob('plugin-a:old', createBlob(100)); // capturedAt 1
    await engine.putBlob('plugin-a:new', createBlob(60)); // capturedAt 2

    // The slider moves down: the squeeze evicts oldest-captured-first without
    // waiting for the next blob write
    await engine.setBudgetBytes(100);

    expect(test.blobBackend.blobs.has('plugin-a:old')).toBe(false);
    expect(await engine.getBlob('plugin-a:new')).toBeDefined();
    expect((await engine.getUsage()).usedBytes).toBe(60);
  });

  it('never blocks on a failed eviction', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setBudgetBytes(100);
    await engine.setPerBlobCapBytes(1024 * 1024);

    await engine.putBlob('plugin-a:old', createBlob(60));
    test.blobBackend.failRemovals();

    // The removal fails, but the put still succeeds and usage accounting holds
    const result = await engine.putBlob('plugin-a:new', createBlob(60));

    expect(result).toEqual({ isStored: true });
    expect(test.logError).toHaveBeenCalledWith(
      'failed to evict blob plugin-a:old',
      expect.any(Error),
    );
    expect((await engine.getUsage()).usedBytes).toBe(60);

    // Records are unbudgeted: they never wait on eviction at all
    await engine.putRecord('plugin-a:key', { text: 'record write never blocked' });
    expect(await engine.getRecord<{ text: string }>('plugin-a:key')).toEqual({
      text: 'record write never blocked',
    });
  });
});

describe('storage engine: usage accounting', () => {
  it('seeds usage from the estimate on first boot and from the persisted counter on restart', async () => {
    const test = createTestServices({ quotaBytes: 1000 });
    const firstEngine = await createStorageEngine(test.services);
    await firstEngine.setBudgetBytes(TEST_BUDGET);
    await firstEngine.setPerBlobCapBytes(1024 * 1024);

    // First boot: no persisted counter, the estimate seeds it
    expect((await firstEngine.getUsage()).usedBytes).toBe(0);

    await firstEngine.putBlob('plugin-a:key', createBlob(70));
    await firstEngine.deleteBlob('plugin-a:key');
    await firstEngine.putBlob('plugin-a:key2', createBlob(30));

    // Restart over the same backends: the persisted counter (30) wins over
    // the estimate (0), so restarts stay exact without scanning.
    const restartedEngine = await createStorageEngine(test.services);

    expect((await restartedEngine.getUsage()).usedBytes).toBe(30);
    // The budget setting also survives the restart via the meta record, still
    // clamped to 50% of the (low) quota: min(1 MB, 500) = 500
    expect((await restartedEngine.getUsage()).budgetBytes).toBe(500);
  });

  it('accounts deleted blobs and reports usage through getUsage', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setPerBlobCapBytes(1024 * 1024);

    await engine.putBlob('plugin-a:a', createBlob(10));
    await engine.putBlob('plugin-a:b', createBlob(20));
    await engine.deleteBlob('plugin-a:a');

    const usage = await engine.getUsage();
    expect(usage.usedBytes).toBe(20);
    expect(usage.budgetBytes).toBe(Math.min(DEFAULT_BUDGET_BYTES, Math.floor(usage.quotaBytes * 0.5)));
  });

  it('does not seed usage on a fresh store even when the origin estimate overflows the budget', async () => {
    // A fresh store (no persisted usage counter, no blob index) with an
    // origin-wide estimate far above the budget: seeding from the estimate
    // would reject every blob write forever (nothing to evict), so a fresh
    // store starts at zero and the first blob fits
    const recordBackend = createMemoryRecordBackend();
    const blobBackend = createMemoryBlobBackend();
    const clock = createFakeClock();
    const services: TgStorageServices = {
      recordBackend,
      blobBackend,
      // The origin reports 400 of 1000 quota used — far above the 500 budget
      estimator: createFakeEstimator(1000, 400),
      now: clock.now,
      logError: vi.fn(),
    };
    const engine = await createStorageEngine(services);
    await engine.setBudgetBytes(500);
    await engine.setPerBlobCapBytes(1024 * 1024);

    expect((await engine.getUsage()).usedBytes).toBe(0);

    const result = await engine.putBlob('plugin-a:fresh', createBlob(60));

    expect(result).toEqual({ isStored: true });
    expect((await engine.getUsage()).usedBytes).toBe(60);
  });
});

describe('storage engine: persist', () => {
  it('requests persist() exactly once on the first write', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);
    await engine.setPerBlobCapBytes(1024 * 1024);

    await engine.putBlob('plugin-a:a', createBlob(10));
    await engine.putBlob('plugin-a:b', createBlob(10));
    await engine.putRecord('plugin-a:key', 1);

    expect(test.estimator.persist).toHaveBeenCalledTimes(1);
  });

  it('requests persist() once for a record-only write path too', async () => {
    const test = createTestServices();
    const engine = await createStorageEngine(test.services);

    await engine.putRecord('plugin-a:key', 1);
    await engine.putRecord('plugin-a:key2', 2);

    expect(test.estimator.persist).toHaveBeenCalledTimes(1);
  });

  it('ignores a failing persist()', async () => {
    const test = createTestServices();
    test.estimator.persist.mockRejectedValue(new Error('denied'));
    const engine = await createStorageEngine(test.services);
    await engine.setPerBlobCapBytes(1024 * 1024);

    const result = await engine.putBlob('plugin-a:a', createBlob(10));

    expect(result).toEqual({ isStored: true });
  });
});

describe('storage engine: schema versioning', () => {
  it('stamps a fresh store with the current schema version', async () => {
    const test = createTestServices();
    await createStorageEngine(test.services);

    expect(test.recordBackend.data.get('__meta')).toEqual({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      budgetBytes: DEFAULT_BUDGET_BYTES,
      perBlobCapBytes: DEFAULT_PER_BLOB_CAP_BYTES,
    });
  });

  it('migrates an older-version store forward and keeps its records', async () => {
    const test = createTestServices();
    // An older-version store: a v0 meta-less record space with data
    await test.recordBackend.set('plugin-a:key', { text: 'pre-versioning data' });
    test.recordBackend.data.set('__meta', {
      schemaVersion: 0,
      budgetBytes: 123,
      perBlobCapBytes: 456,
    });

    const engine = await createStorageEngine(test.services);

    // The record survived; the meta record moved to the current version
    expect(await engine.getRecord<{ text: string }>('plugin-a:key')).toEqual({ text: 'pre-versioning data' });
    const meta = test.recordBackend.data.get('__meta') as { schemaVersion: number };
    expect(meta.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
  });

  it('stays read-only rather than corrupting a newer-version store', async () => {
    const test = createTestServices();
    test.recordBackend.data.set('__meta', {
      schemaVersion: STORAGE_SCHEMA_VERSION + 1,
      budgetBytes: DEFAULT_BUDGET_BYTES,
      perBlobCapBytes: DEFAULT_PER_BLOB_CAP_BYTES,
    });

    const engine = await createStorageEngine(test.services);

    // The newer meta record is untouched and writes resolve safe-negative
    const meta = test.recordBackend.data.get('__meta') as { schemaVersion: number };
    expect(meta.schemaVersion).toBe(STORAGE_SCHEMA_VERSION + 1);
    expect(await engine.putBlob('plugin-a:a', createBlob(10))).toEqual({ isStored: false, reason: 'unavailable' });
    await expect(engine.putRecord('plugin-a:key', 1)).rejects.toThrow();
  });
});

describe('storage engine: per-account isolation', () => {
  it('keeps account A\'s writes invisible to account B across separate engines', async () => {
    // Two engines over separate backends mirror two account slots: the
    // production services scope the IDB store name and OPFS dir per slot
    // (`tt-plugin-storage_<slot>` / `plugin-storage_<slot>`), so each slot's
    // engine only ever sees its own backend.
    const accountA = createTestServices();
    const accountB = createTestServices();
    const engineA = await createStorageEngine(accountA.services);
    const engineB = await createStorageEngine(accountB.services);
    await engineA.setPerBlobCapBytes(1024 * 1024);

    await engineA.putRecord('plugin-a:key', { text: 'account A data' });
    await engineA.putBlob('plugin-a:media', createBlob(10));

    expect(await engineB.getRecord('plugin-a:key')).toBeUndefined();
    expect(await engineB.getBlob('plugin-a:media')).toBeUndefined();
    // B's record space holds only its own engine meta record, never A's data
    expect((await engineB.listRecords()).items.map((item) => item.key)).toEqual(['__meta']);

    // Writes through B never disturb A's data
    await engineB.putRecord('plugin-a:key', { text: 'account B data' });
    expect(await engineA.getRecord<{ text: string }>('plugin-a:key')).toEqual({ text: 'account A data' });
  });
});

describe('storage engine: missing blob backend', () => {
  it('degrades blob writes to record-only semantics and keeps records working', async () => {
    const test = createTestServices();
    test.services.blobBackend = undefined;
    const engine = await createStorageEngine(test.services);
    await engine.setPerBlobCapBytes(1024 * 1024);

    expect(await engine.putBlob('plugin-a:a', createBlob(10))).toEqual({ isStored: false, reason: 'unavailable' });
    expect(await engine.getBlob('plugin-a:a')).toBeUndefined();

    await engine.putRecord('plugin-a:key', 1);
    expect(await engine.getRecord('plugin-a:key')).toBe(1);
  });
});

import type { PluginContext } from '../context';
import type { TgPluginRuntime } from '../runtime';
import type { TgListRecordsOptions, TgPluginApi, TgStorageUsage } from '../types';

/**
 * Storage slice: the shared budgeted engine (`src/plugins/storageEngine.ts`)
 * namespaced per calling plugin. Keys are stored namespaced as
 * `<pluginName>:<key>` and blob files nest in per-plugin directories, so one
 * plugin never sees another's data. Every method is error-contained: a
 * failing call logs with the plugin name and resolves to a safe result. The
 * engine may reject (a broken backend, a failed start) — the slice then
 * answers with its safe defaults instead of throwing.
 *
 * The slice keeps no per-plugin state, so it registers no teardown: storage
 * data outlives a plugin's disable/enable cycle by design.
 */
export function createStorageSlice(context: PluginContext, runtime: TgPluginRuntime): TgPluginApi['storage'] {
  const reporter = runtime.createPluginReporter(context.pluginName);
  const namespace = `${context.pluginName}:`;

  function toNamespacedKey(key: string) {
    return `${namespace}${key}`;
  }

  function toBareKey(key: string) {
    return key.slice(namespace.length);
  }

  return {
    putRecord: async (key, record) => {
      try {
        const engine = await runtime.getStorageEngine();
        await engine.putRecord(toNamespacedKey(key), record);
      } catch (error) {
        reporter.logError('storage.putRecord', error);
      }
    },

    getRecord: async <T>(key: string) => {
      try {
        const engine = await runtime.getStorageEngine();
        return await engine.getRecord<T>(toNamespacedKey(key));
      } catch (error) {
        reporter.logError('storage.getRecord', error);
        return undefined;
      }
    },

    listRecords: async <T>(options?: TgListRecordsOptions) => {
      try {
        const engine = await runtime.getStorageEngine();

        // Cursors and item keys cross this boundary bare (the plugin's own
        // key space); the namespace is applied here and stripped from results.
        const page = await engine.listRecords<T>({
          prefix: options?.prefix === undefined ? namespace : `${namespace}${options.prefix}`,
          limit: options?.limit,
          cursor: options?.cursor === undefined ? undefined : toNamespacedKey(options.cursor),
        });

        return {
          items: page.items.map(({ key, record }) => ({ key: toBareKey(key), record })),
          cursor: page.cursor === undefined ? undefined : toBareKey(page.cursor),
        };
      } catch (error) {
        reporter.logError('storage.listRecords', error);
        return { items: [] };
      }
    },

    deleteRecord: async (key) => {
      try {
        const engine = await runtime.getStorageEngine();
        await engine.deleteRecord(toNamespacedKey(key));
      } catch (error) {
        reporter.logError('storage.deleteRecord', error);
      }
    },

    clearRecords: async () => {
      try {
        const engine = await runtime.getStorageEngine();
        await engine.clearRecords(namespace);
      } catch (error) {
        reporter.logError('storage.clearRecords', error);
      }
    },

    putBlob: async (key, blob) => {
      try {
        const engine = await runtime.getStorageEngine();
        return await engine.putBlob(toNamespacedKey(key), blob);
      } catch (error) {
        reporter.logError('storage.putBlob', error);
        return { isStored: false, reason: 'unavailable' as const };
      }
    },

    getBlob: async (key) => {
      try {
        const engine = await runtime.getStorageEngine();
        return await engine.getBlob(toNamespacedKey(key));
      } catch (error) {
        reporter.logError('storage.getBlob', error);
        return undefined;
      }
    },

    deleteBlob: async (key) => {
      try {
        const engine = await runtime.getStorageEngine();
        await engine.deleteBlob(toNamespacedKey(key));
      } catch (error) {
        reporter.logError('storage.deleteBlob', error);
      }
    },

    clearBlobs: async () => {
      try {
        const engine = await runtime.getStorageEngine();
        // The namespace prefix keeps other plugins' blobs (and their
        // accounting) intact, exactly like `clearRecords` does for records.
        await engine.clearBlobs(namespace);
      } catch (error) {
        reporter.logError('storage.clearBlobs', error);
      }
    },

    getUsage: async () => {
      try {
        const engine = await runtime.getStorageEngine();
        return await engine.getUsage();
      } catch (error) {
        reporter.logError('storage.getUsage', error);
        return { usedBytes: 0, budgetBytes: 0, quotaBytes: 0 } satisfies TgStorageUsage;
      }
    },

    setBudgetBytes: async (bytes) => {
      try {
        // The handle is the engine-wide config surface; a plugin calling it is
        // the settings UI that owns the budget's semantics.
        const engineHandle = await runtime.getStorageEngineHandle();
        await engineHandle.setBudgetBytes(bytes);
      } catch (error) {
        reporter.logError('storage.setBudgetBytes', error);
      }
    },

    setPerBlobCapBytes: async (bytes) => {
      try {
        const engineHandle = await runtime.getStorageEngineHandle();
        await engineHandle.setPerBlobCapBytes(bytes);
      } catch (error) {
        reporter.logError('storage.setPerBlobCapBytes', error);
      }
    },
  };
}

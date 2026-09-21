/**
 * Composition root for the plugin layer: the ONLY module under src/plugins
 * allowed to touch environment and app services (localStorage, console).
 * The host and its slices receive these capabilities through the
 * `TgPluginRuntime` interface, so tests inject fakes.
 */

const STORAGE_KEY = 'tt-plugins';
const LOG_PREFIX = '%c[plugins]';
const LOG_STYLE = 'color:#40bfc4';

type PluginEnabledMap = Record<string, boolean>;

/** Per-plugin logging and error containment used by the host and its slices. */
export interface TgPluginReporter {
  log: (message: string) => void;
  logError: (action: string, error: unknown) => void;
  /** Wraps a plugin callback so a throw is logged with the plugin name and contained. */
  wrap: <Args extends unknown[]>(callback: (...args: Args) => void) => (...args: Args) => void;
}

/** Environment services the plugin host runs on; injectable for tests. */
export interface TgPluginRuntime {
  /** Persisted enabled flag, global (not per-account); plugins default to enabled. */
  isPluginEnabled: (pluginName: string) => boolean;
  setPluginEnabled: (pluginName: string, isEnabled: boolean) => void;
  createPluginReporter: (pluginName: string) => TgPluginReporter;
}

function loadEnabledMap(): PluginEnabledMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as PluginEnabledMap;
    return parsed || {};
  } catch (e) {
    return {};
  }
}

function createReporter(pluginName: string): TgPluginReporter {
  const reporter: TgPluginReporter = {
    log: (message) => {
      // eslint-disable-next-line no-console
      console.log(LOG_PREFIX, LOG_STYLE, pluginName, message);
    },
    logError: (action, error) => {
      // eslint-disable-next-line no-console
      console.error(`[plugins] ${pluginName} ${action}:`, error);
    },
    wrap: (callback) => (...args) => {
      try {
        callback(...args);
      } catch (error) {
        reporter.logError('callback failed', error);
      }
    },
  };

  return reporter;
}

/** Builds the production runtime backed by localStorage. */
export function createPluginRuntime(): TgPluginRuntime {
  return {
    isPluginEnabled: (pluginName) => loadEnabledMap()[pluginName] !== false,
    setPluginEnabled: (pluginName, isEnabled) => {
      const enabledMap = loadEnabledMap();
      enabledMap[pluginName] = isEnabled;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(enabledMap));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[plugins] failed to persist enabled state:', err);
      }
    },
    createPluginReporter: (pluginName) => createReporter(pluginName),
  };
}

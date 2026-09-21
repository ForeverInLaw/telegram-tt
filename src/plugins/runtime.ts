/**
 * Composition root for the plugin layer: the ONLY module under src/plugins
 * allowed to touch environment and app services (localStorage, console).
 * The host and its slices receive these capabilities through the
 * `TgPluginRuntime` interface, so tests inject fakes.
 */

import { addCallback, removeCallback } from '../lib/teact/teactn';
import { addActionHandler, getGlobal } from '../global';

import type { ApiUpdate } from '../api/types';
import type { ActionReturnType } from '../global/types';

import { getCurrentTabId } from '../util/establishMultitabRole';

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
  /** Raw store updates from the worker-to-store pipeline; returns an unsubscribe function. */
  subscribeApiUpdates: (listener: (update: ApiUpdate) => void) => () => void;
  /** Notifies after every global change (throttled to tick end); returns an unsubscribe function. */
  subscribeToStoreChanges: (listener: () => void) => () => void;
  /** Chat id of the currently open chat; `undefined` when no chat is open. */
  getActiveChatId: () => string | undefined;
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

/** Builds the production runtime backed by localStorage and the global store. */
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
    subscribeApiUpdates: (listener) => {
      apiUpdateListeners.add(listener);
      return () => {
        apiUpdateListeners.delete(listener);
      };
    },
    subscribeToStoreChanges: (listener) => {
      const notify = () => listener();
      addCallback(notify);
      return () => removeCallback(notify);
    },
    getActiveChatId: readActiveChatId,
  };
}

// --- Event stream services consumed by src/plugins/events.ts ------------------

/**
 * TeactN supports several handlers per action name but only offers
 * registration (no removal), so the plugin layer adds exactly one
 * `'apiUpdate'` handler here — alongside the native apiUpdaters — and fans
 * updates out to a set it can subscribe/unsubscribe itself.
 */
const apiUpdateListeners = new Set<(update: ApiUpdate) => void>();

addActionHandler('apiUpdate', (_global, _actions, update): ActionReturnType => {
  for (const listener of apiUpdateListeners) {
    listener(update);
  }
});

/** Chat id of the currently open chat; `undefined` while no chat is open. */
function readActiveChatId(): string | undefined {
  const global = getGlobal();
  // Until the `init` action the store has no tab state for this tab, so
  // `byTabId` may be missing and the tab entry undefined; both mean "no chat".
  const tabState = global.byTabId?.[getCurrentTabId()];
  if (!tabState) return undefined;

  // Inlined `selectCurrentMessageList` (last message list = current chat):
  // its module tree runs `window.matchMedia` at import time, which the
  // vitest jsdom environment does not provide.
  return tabState.messageLists.at(-1)?.chatId;
}

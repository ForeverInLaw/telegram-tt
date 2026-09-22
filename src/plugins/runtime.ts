/**
 * Composition root for the plugin layer: the ONLY module under src/plugins
 * allowed to touch environment and app services (localStorage, console, the
 * app's global store). The translation fn is injected by the app entry
 * because its own module transitively loads jsdom-incompatible imports; the
 * host and its slices receive these capabilities through the
 * `TgPluginRuntime` interface, so tests inject fakes.
 */
import { addCallback, removeCallback } from '../lib/teact/teactn';
import { addActionHandler, getActions, getGlobal } from '../global';

import type { ApiChat, ApiUpdate } from '../api/types';
import type { GlobalActions } from '../global';
import type { ActionReturnType } from '../global/types';
import type { MessageList, ThreadId } from '../types';
import type { LangKey, LangVariable } from '../types/language';
import type { LangFn } from '../util/localization';
import type { TgStorageEngine, TgStorageEngineHandle } from './storageEngine';
import type { TgUiNotification } from './types';
import { MAIN_THREAD_ID } from '../api/types';

import { getCurrentTabId } from '../util/establishMultitabRole';
import { LOG_PREFIX, LOG_STYLE } from './logConstants';
import { createDefaultServices, createStorageEngine } from './storageEngine';

const STORAGE_KEY = 'tt-plugins';
const PLUGIN_NOTIFICATION_LOCAL_ID_PREFIX = 'plugin-notification-';

type PluginEnabledMap = Record<string, boolean>;

// The account-scoped storage engine is built once per runtime (app boot), not
// per plugin, so usage accounting and the eviction index are shared. It is
// created lazily on first use, so merely importing this module never touches
// IndexedDB/OPFS (tests import it in jsdom).
let storageEnginePromise: Promise<TgStorageEngine> | undefined;

/** The app store actions the action facade dispatches through. */
export type TgPluginActions = Pick<
  GlobalActions,
  'deleteMessages' | 'editMessage' | 'openChat' | 'sendMessage' | 'setEditingId' | 'toggleReaction'
>;

// The typed `LangFn` overloads narrow variables per key; the runtime exposes
// the plain `(key, variables)` form that the translation fn implements.
type TranslateFn = (key: LangKey, variables?: Record<string, LangVariable>) => string;

/** Per-plugin logging and error containment used by the host and its slices. */
export interface TgPluginReporter {
  log: (message: string) => void;
  logError: (action: string, error: unknown) => void;
  /** Wraps a plugin callback so a throw is logged with the plugin name and contained. */
  wrap: <Args extends unknown[]>(callback: (...args: Args) => void) => (...args: Args) => void;
}

/** App and environment services the plugin host runs on; injectable for tests. */
export interface TgPluginRuntime {
  /**
   * Persisted enabled flag, global (not per-account); falls back to the
   * plugin's `isEnabledByDefault` manifest flag, then to `true`.
   */
  isPluginEnabled: (pluginName: string, isEnabledByDefault: boolean) => boolean;
  setPluginEnabled: (pluginName: string, isEnabled: boolean) => void;
  createPluginReporter: (pluginName: string) => TgPluginReporter;
  /** Raw store updates from the worker-to-store pipeline; returns an unsubscribe function. */
  subscribeApiUpdates: (listener: (update: ApiUpdate) => void) => () => void;
  /** Notifies after every global change (throttled to tick end); returns an unsubscribe function. */
  subscribeToStoreChanges: (listener: () => void) => () => void;
  /** The app's store actions; facade calls ride the same optimistic pipeline as UI calls. */
  getActions: () => TgPluginActions;
  /** The tab facade calls are scoped to; passed on every tab-scoped action call. */
  getCurrentTabId: () => number;
  /** The app's main-thread id, used when a call addresses a chat's default thread. */
  mainThreadId: ThreadId;
  /** The currently open message list (chat, thread and list type); `undefined` when no chat is open. */
  getActiveMessageList: () => MessageList | undefined;
  /** Chat id of the currently open chat; `undefined` when no chat is open. */
  getActiveChatId: () => string | undefined;
  /** The signed-in user's id; `undefined` when signed out. */
  getCurrentUserId: () => string | undefined;
  /** Chat (or private user) lookup; returns plain store data. */
  getChat: (chatId: string) => Readonly<ApiChat> | undefined;
  /** Translates an app lang key with optional substitution variables. */
  getLocalizedString: (key: LangKey, variables?: Record<string, LangVariable>) => string;
  /** Shows an in-app notification through the app's own notification pipeline. */
  showNotification: (notification: TgUiNotification) => void;
  /**
   * The account-scoped budgeted storage engine shared by every plugin's
   * `tg.storage` slice; rejects when the engine failed to start. The engine
   * outlives plugins: it is created once at host startup, not per plugin.
   */
  getStorageEngine: () => Promise<TgStorageEngine>;
  /** Engine-scoped config (budget, per-blob cap) for the plugin settings UI. */
  getStorageEngineHandle: () => Promise<TgStorageEngineHandle>;
}

function loadEnabledMap(): PluginEnabledMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as PluginEnabledMap;
    return parsed || {};
  } catch (err) {
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

/**
 * Builds the production runtime backed by localStorage and the app's store.
 * The translation fn arrives as a parameter because statically importing
 * `src/util/localization` here would load jsdom-incompatible modules into
 * plugin tests (the same reason the store reads below are inlined).
 */
export function createPluginRuntime(getTranslationFn: () => LangFn): TgPluginRuntime {
  const runtime: TgPluginRuntime = {
    isPluginEnabled: (pluginName, isEnabledByDefault) => loadEnabledMap()[pluginName] ?? isEnabledByDefault,
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
    getActions: () => getActions(),
    getCurrentTabId: () => getCurrentTabId(),
    mainThreadId: MAIN_THREAD_ID,
    getActiveMessageList: readActiveMessageList,
    getActiveChatId: () => readActiveMessageList()?.chatId,
    getCurrentUserId: () => getGlobal().currentUserId,
    getChat: (chatId) => {
      // Inlined `selectChat` (chats first, then private users): the selectors
      // module tree runs `window.matchMedia` at import time, which the
      // vitest jsdom environment does not provide
      const global = getGlobal();
      return global.chats.byId[chatId] || global.users.byId[chatId];
    },
    getLocalizedString: (key, variables) => (getTranslationFn() as unknown as TranslateFn)(key, variables),
    showNotification,
    getStorageEngine: () => {
      storageEnginePromise ??= createStorageEngine(createDefaultServices());
      return storageEnginePromise;
    },
    getStorageEngineHandle: async () => {
      const engine = await runtime.getStorageEngine();
      return {
        setBudgetBytes: engine.setBudgetBytes,
        setPerBlobCapBytes: engine.setPerBlobCapBytes,
        getUsage: engine.getUsage,
      };
    },
  };

  return runtime;
}

// --- Notification service -----------------------------------------------------

// Notification calls get a fresh id so repeated ones stack instead of deduping
// on an identical message (the action dedupes by message without a localId).
let notificationCounter = 0;

/** Shows a plugin notification through the app's own pipeline (`showNotification` action). */
function showNotification(notification: TgUiNotification) {
  notificationCounter += 1;
  getActions().showNotification({
    title: notification.title,
    message: notification.message,
    icon: notification.icon,
    duration: notification.duration,
    localId: `${PLUGIN_NOTIFICATION_LOCAL_ID_PREFIX}${notificationCounter}`,
    tabId: getCurrentTabId(),
  });
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

/** The currently open message list (the last entry of the tab's list stack). */
function readActiveMessageList(): MessageList | undefined {
  // Until the `init` action the store has no tab state for this tab, so
  // `byTabId` may be missing and the tab entry undefined; both mean "no chat".
  // Inlined `selectCurrentMessageList`: its module tree runs
  // `window.matchMedia` at import time, which the vitest jsdom environment
  // does not provide.
  return getGlobal().byTabId?.[getCurrentTabId()]?.messageLists.at(-1);
}

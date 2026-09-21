/**
 * Composition root for the plugin layer: the ONLY module under src/plugins
 * allowed to touch environment and app services (localStorage, console, the
 * app's global store). The translation fn is injected by the app entry
 * because its own module transitively loads jsdom-incompatible imports; the
 * host and its slices receive every capability through the `TgPluginRuntime`
 * interface, so tests inject fakes.
 */

import { getActions, getGlobal } from '../global';

import type { ApiChat } from '../api/types';
import type { GlobalActions } from '../global';
import type { MessageList, ThreadId } from '../types';
import type { LangKey, LangVariable } from '../types/language';
import type { LangFn } from '../util/localization';
import { MAIN_THREAD_ID } from '../api/types';

import { getCurrentTabId } from '../util/establishMultitabRole';

const STORAGE_KEY = 'tt-plugins';
const LOG_PREFIX = '%c[plugins]';
const LOG_STYLE = 'color:#40bfc4';

type PluginEnabledMap = Record<string, boolean>;

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
  /** Persisted enabled flag, global (not per-account); plugins default to enabled. */
  isPluginEnabled: (pluginName: string) => boolean;
  setPluginEnabled: (pluginName: string, isEnabled: boolean) => void;
  createPluginReporter: (pluginName: string) => TgPluginReporter;
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

/**
 * Builds the production runtime backed by localStorage and the app's store.
 * The translation fn arrives as a parameter because statically importing
 * `src/util/localization` here would load jsdom-incompatible modules into
 * plugin tests (the same reason the store reads below are inlined).
 */
export function createPluginRuntime(getTranslationFn: () => LangFn): TgPluginRuntime {
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
  };
}

/** The currently open message list (the last entry of the tab's list stack). */
function readActiveMessageList(): MessageList | undefined {
  // Until the `init` action the store has no tab state for this tab, so
  // `byTabId` may be missing and the tab entry undefined; both mean "no chat".
  // Inlined `selectCurrentMessageList`: its module tree runs
  // `window.matchMedia` at import time, which the vitest jsdom environment
  // does not provide.
  return getGlobal().byTabId?.[getCurrentTabId()]?.messageLists.at(-1);
}

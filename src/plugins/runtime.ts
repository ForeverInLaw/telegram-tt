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

import type { ApiChat, ApiMessage, ApiUpdate, ApiUser } from '../api/types';
import type { GlobalActions } from '../global';
import type { ActionReturnType } from '../global/types';
import type { MessageList, ThreadId } from '../types';
import type { LangKey, LangVariable } from '../types/language';
import type { LangFn } from '../util/localization';
import type { TgStorageEngine, TgStorageEngineHandle } from './storageEngine';
import type { TgMediaBlob, TgUiNotification } from './types';
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
  /**
   * User lookup (the `ApiUser` record behind a private chat's peer);
   * returns plain store data.
   */
  getUser: (userId: string) => Readonly<ApiUser> | undefined;
  /**
   * Resolves the chat a common-box message id (no `chatId` in the update)
   * belongs to; `undefined` when the store knows no such message.
   */
  getCommonBoxChatId: (messageId: number) => string | undefined;
  /** Message lookup by chat and id; returns plain store data. */
  getMessage: (chatId: string, messageId: number) => Readonly<ApiMessage> | undefined;
  /**
   * Reads a message's media blobs out of the app's media cache (downloading
   * video bytes for real while the file reference lives). The production
   * impl lives in `fetchMessageMediaFromApp` below; tests inject a fake.
   */
  fetchMessageMedia: (
    chatId: string,
    messageId: number,
    options?: { shouldPrefetchVideo?: boolean },
  ) => Promise<TgMediaBlob[]>;
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
    getUser: (userId) => {
      // Inlined `selectUser`: the selectors module tree runs
      // `window.matchMedia` at import time, which the vitest jsdom
      // environment does not provide
      return getGlobal().users.byId[userId];
    },
    getCommonBoxChatId: (messageId) => {
      // Inlined `selectCommonBoxChatId` (last-message hint, then a scan of
      // common-box chats' messages): the selectors module tree runs
      // `window.matchMedia` at import time, which the vitest jsdom
      // environment does not provide
      const global = getGlobal();
      const isCommonBox = (chat: ApiChat) => (
        chat.type === 'chatTypePrivate' || chat.type === 'chatTypeBasicGroup'
      );
      const fromLastMessage = Object.values(global.chats.byId).find((chat) => (
        isCommonBox(chat) && global.chats.lastMessageIds.all?.[chat.id] === messageId
      ));
      if (fromLastMessage) {
        return fromLastMessage.id;
      }

      const { byChatId } = global.messages;
      return Object.keys(byChatId).find((chatId) => {
        // `selectChat` checks chats first, then private users
        const chat = global.chats.byId[chatId] || global.users.byId[chatId];
        return Boolean(chat && isCommonBox(chat) && byChatId[chatId]?.byId[messageId]);
      });
    },
    getMessage: (chatId, messageId) => {
      // Inlined `selectChatMessage`: the selectors module tree runs
      // `window.matchMedia` at import time, which the vitest jsdom
      // environment does not provide
      return getGlobal().messages.byChatId?.[chatId]?.byId?.[messageId];
    },
    fetchMessageMedia: (chatId, messageId, options) => (
      fetchMessageMediaFromApp(chatId, messageId, options?.shouldPrefetchVideo ?? false)
    ),
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
 *
 * ORDERING INVARIANT: TeactN runs same-action handlers in registration
 * order, and the app entry imports this module (via `initPlugins`, awaited
 * in `src/index.tsx`) BEFORE the apiUpdaters register (they register when
 * `Main` → `global/actions/all` evaluates). So this fan-out runs BEFORE the
 * native reducers in every `'apiUpdate'` dispatch — the capture model
 * (`getMessage` still sees the pre-delete/pre-edit message) depends on this
 * import order. A reorder of these imports silently inverts it.
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

// --- Media capture service ------------------------------------------------------

// The native bridge (`mediaCaptureNative`) statically imports the app's
// media helpers, whose module trees run browser-only side effects at import
// time (`window.matchMedia`, service-worker setup) that the vitest jsdom
// environment cannot provide. The import is dynamic for exactly that reason:
// the bridge must not load until the first real capture call, or every jsdom
// suite importing this module would break.
let mediaCaptureBridgePromise: Promise<typeof import('./mediaCaptureNative')> | undefined;

function loadMediaCaptureNative(): Promise<typeof import('./mediaCaptureNative')> {
  mediaCaptureBridgePromise ??= import('./mediaCaptureNative');
  return mediaCaptureBridgePromise;
}

/**
 * Reads one message's already-downloaded media blobs out of the app's media
 * cache, so a plugin can copy them before the delete pipeline unloads them.
 * Video bytes download for real (while the file reference is still alive)
 * only with `shouldPrefetchVideo`. A message without captureable media, or
 * any failure, resolves `[]` — the caller degrades to a record-only capture.
 */
async function fetchMessageMediaFromApp(
  chatId: string,
  messageId: number,
  shouldPrefetchVideo: boolean,
): Promise<TgMediaBlob[]> {
  const message = getGlobal().messages.byChatId?.[chatId]?.byId?.[messageId];
  if (message === undefined) return [];

  const media = pickMessageMedia(message, shouldPrefetchVideo);
  if (media === undefined) return [];

  try {
    const bridge = await loadMediaCaptureNative();
    const blob = await bridge.fetchMessageMediaBlob(message, media.kind, shouldPrefetchVideo);
    if (blob === undefined) return [];

    return [{
      kind: media.kind,
      mimeType: media.mimeType,
      fileName: media.fileName,
      sizeBytes: blob.size,
      blob,
    }];
  } catch {
    return [];
  }
}

/**
 * The message's primary media descriptor, or `undefined` for kinds this
 * service does not capture (webPage/poll/etc.) and for plain videos while
 * prefetch is off (the progressive cache never holds the full bytes).
 */
function pickMessageMedia(
  message: Readonly<ApiMessage>,
  shouldPrefetchVideo: boolean,
): { kind: TgMediaBlob['kind']; mimeType: string | undefined; fileName: string | undefined } | undefined {
  const { content } = message;

  if (content.photo) {
    return { kind: 'photo', mimeType: undefined, fileName: undefined };
  }
  if (content.video) {
    // A GIF is a video document; the viewer renders it inline like a photo
    const kind = content.video.isGif ? 'gif' : 'video';
    if (kind === 'video' && !shouldPrefetchVideo) return undefined;
    return { kind, mimeType: content.video.mimeType, fileName: content.video.fileName };
  }
  if (content.sticker) {
    return { kind: 'sticker', mimeType: undefined, fileName: undefined };
  }
  if (content.document) {
    return { kind: 'document', mimeType: content.document.mimeType, fileName: content.document.fileName };
  }
  if (content.audio) {
    return { kind: 'audio', mimeType: content.audio.mimeType, fileName: content.audio.fileName };
  }
  if (content.voice) {
    return { kind: 'voice', mimeType: undefined, fileName: undefined };
  }

  return undefined;
}

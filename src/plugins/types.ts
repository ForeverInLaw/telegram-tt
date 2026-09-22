import type { ApiChat, ApiMessage, ApiUser } from '../api/types';
import type { TeactNode } from '../lib/teact/teact';
import type { ThreadId } from '../types';
import type { IconName } from '../types/icons';
import type { LangKey, LangVariable, RegularLangKey } from '../types/language';

/** A node factory plugins pass to `tg.ui` render surfaces; re-exported here so plugin code stays within the import policy. */
export type TgTeactNode = TeactNode;

/**
 * A full screen a plugin opens through `tg.ui.openScreen`. The app renders the
 * node produced by `render` inside its own overlay container with a header
 * (title, back button); the plugin never touches UI primitives.
 */
export interface TgPluginScreen {
  /** Header title; a plain string, already localized by the plugin. */
  title: string;
  /** Node factory the container calls to render the screen body; a fresh node per render. */
  render: () => TgTeactNode;
  /** Called when the screen closes (back button, container unmount, plugin disable). */
  onClose?: () => void;
}

/**
 * Declarative descriptor for a context-menu item contributed by a plugin.
 * Plugins never touch UI primitives directly: the host renders these
 * descriptors with its own MenuItem, so plugin code stays stable
 * across upstream UI refactors.
 */
export interface TgMessageContextMenuItem {
  /** Icon name from src/types/icons/font.ts (e.g. 'bug', 'heart'). */
  icon?: IconName;
  /** Menu item text. */
  label: string;
  /** Called when the item is clicked; receives the message the menu was opened on. */
  onClick: (message: ApiMessage) => void;
  /** Destructive items are rendered red (like Delete). */
  destructive?: boolean;
}

/**
 * The API object every plugin receives in `setup(tg)`.
 * Keep it small and additive: never break existing plugins.
 */
export interface TgPluginApi {
  ui: {
    /** Add an item to the message right-click context menu. */
    addMessageContextMenuItem: (item: TgMessageContextMenuItem) => void;
    /** Add an item to the chat-list right-click context menu. */
    addChatContextMenuItem: (item: TgChatContextMenuItem) => void;
    /** Add an entry to the main ("burger") menu. */
    addMainMenuItem: (item: TgMainMenuItem) => void;
    /** Add an icon button to the chat composer bar. */
    addComposerButton: (item: TgComposerButton) => void;
    /** Show an in-app notification with title and body. */
    showNotification: (notification: TgUiNotification) => void;
    /**
     * Opens the plugin's full screen in the app's own overlay container
     * (header with the title, back navigation). Returns a close function;
     * closing also fires the screen's `onClose`. Opening another screen
     * replaces the current one; disabling the plugin closes its open screen.
     */
    openScreen: (screen: TgPluginScreen) => () => void;
    /**
     * Registers the plugin's settings panel, rendered inside Settings →
     * Plugins under the plugin's own list entry. Returns the unregister
     * function; the host also removes the panel when the plugin is disabled.
     */
    registerSettingsPanel: (panel: TgSettingsPanelRegistration) => () => void;
  };
  /**
   * Subscribe to an app event and receive its typed payload; returns the
   * unsubscribe function for that one handler. Every handler a plugin
   * registered is removed when the plugin is disabled.
   */
  on: <Event extends TgEventName>(
    event: Event,
    handler: (payload: TgEventPayloads[Event]) => void,
  ) => () => void;
  /** Message/chat action facade riding the app's own store-action pipeline. */
  api: TgApiSlice;
  /** Read-only store reads; plain data, never store handles. */
  store: TgStoreSlice;
  /** Per-plugin logging and the app's localized strings. */
  util: TgUtilSlice;
  /**
   * Per-plugin persistent storage with a quota-aware budget: JSON records in
   * IndexedDB, binary blobs in OPFS, each scoped per plugin and per account
   * — one plugin cannot read another's data, and accounts never mix.
   */
  storage: TgStorageSlice;
}

export interface TgPlugin {
  /** Unique plugin name, used as the registry key. */
  name: string;
  version?: string;
  /** Short summary shown under the plugin name in Settings. */
  description?: string;
  /**
   * Enabled state until the user toggles the plugin in Settings; `true` when
   * omitted. The bundled demo plugins declare `false` to stay off by default.
   */
  isEnabledByDefault?: boolean;
  /** Called at app startup and on every re-enable with a fresh `tg` object. */
  setup: (tg: TgPluginApi) => void | (() => void);
}

/** Convenience identity helper mirroring Vite's defineConfig convention. */
export function definePlugin(plugin: TgPlugin): TgPlugin {
  return plugin;
}

/** Declarative descriptor for a chat-list context-menu item contributed by a plugin. */
export interface TgChatContextMenuItem {
  /** Icon name from src/types/icons/font.ts; omitted icons fall back to a neutral one. */
  icon?: IconName;
  /** Menu item text. */
  label: string;
  /** Called when the item is clicked; receives the chat the menu was opened on. */
  onClick: (chat: ApiChat) => void;
  /** Destructive items are rendered red (like Delete). */
  destructive?: boolean;
}

/** Declarative descriptor for a main ("burger") menu entry contributed by a plugin. */
export interface TgMainMenuItem {
  /** Icon name from src/types/icons/font.ts. */
  icon?: IconName;
  /** Menu item text. */
  label: string;
  /** Called when the entry is clicked. */
  onClick: () => void;
  /** Destructive entries are rendered red (like Delete). */
  destructive?: boolean;
}

/** Declarative descriptor for a composer-bar button contributed by a plugin. */
export interface TgComposerButton {
  /** Icon name from src/types/icons/font.ts. */
  icon: IconName;
  /** Accessible label; the button renders icon-only. */
  label: string;
  /** Called when the button is clicked; receives the composer's chat and thread. */
  onClick: (context: { chatId: string; threadId: ThreadId }) => void;
}

/** Data for an in-app notification shown through the app's own notification pipeline. */
export interface TgUiNotification {
  /** Bold first line; omitted when only a body is needed. */
  title?: string;
  /** Notification body text. */
  message: string;
  /** Icon name from src/types/icons/font.ts; the renderer defaults to an info icon. */
  icon?: IconName;
  /** Auto-dismiss delay in ms; the renderer defaults to 3000. */
  duration?: number;
}

/**
 * Declarative descriptor for a plugin's settings panel. The app renders the
 * returned node with its own Settings primitives and styling inside
 * Settings → Plugins; the panel is removed when the plugin is disabled.
 */
export interface TgSettingsPanelRegistration {
  /** Panel section heading, an app lang key without variables. */
  title: RegularLangKey;
  /** Renders the panel's Teact node; called per render of the settings screen. */
  render: () => TeactNode;
}

/** Names of the app events a plugin can observe through `tg.on`. */
export type TgEventName = 'message:new' | 'message:edited' | 'message:deleted' | 'chat:opened';

/** Payload of `message:new`: a message arrived in a chat. */
export interface TgMessageNewPayload {
  chatId: string;
  messageId: number;
  message: ApiMessage;
}

/**
 * Payload of `message:edited`: the app updated a message's stored data — an
 * edit, but also a reaction change, a poll vote, a web-page preview, fresh
 * media. `message` carries only the updated fields, so treat it as partial.
 */
export interface TgMessageEditedPayload {
  chatId: string;
  messageId: number;
  message: Partial<ApiMessage>;
}

/**
 * Why the deletion happened. `'delete'` covers plain, batch and admin-purge
 * deletions; `'historyClear'` is a full chat clear; `'ttl'` is a self-destruct
 * timer or ephemeral expiry.
 */
export type TgDeletionSource = 'delete' | 'historyClear' | 'ttl';

/** One deleted message with the chat the app resolved it to. */
export interface TgDeletedMessageItem {
  /** Chat the message belonged to; `undefined` when the store no longer knows it. */
  chatId: string | undefined;
  /** The deleted message's id. */
  messageId: number;
  /** `true` when this client's own action initiated the deletion; server-driven deletions are `false`. */
  isLocal: boolean;
}

/**
 * Payload of `message:deleted`: the deletion's source plus one resolved item
 * per deleted message. The app resolves common-box chat ids and marks
 * locally-initiated deletions itself, so handlers never guess or read the
 * store mid-handler. Scheduled-message cancellation is not a deletion and
 * never fires this event.
 */
export interface TgMessageDeletedPayload {
  source: TgDeletionSource;
  items: TgDeletedMessageItem[];
}

/** Payload of `chat:opened`: the active chat changed; `undefined` means the chat closed. */
export interface TgChatOpenedPayload {
  chatId: string | undefined;
}

/** Per-event payload types for `tg.on`. */
export type TgEventPayloads = {
  'message:new': TgMessageNewPayload;
  'message:edited': TgMessageEditedPayload;
  'message:deleted': TgMessageDeletedPayload;
  'chat:opened': TgChatOpenedPayload;
};

/** Options for `tg.api.sendMessage`. */
export interface TgSendMessageOptions {
  /** Topic (thread) to send into; defaults to the chat's main thread. */
  threadId?: ThreadId;
}

/** Options for `tg.api.deleteMessages`. */
export interface TgDeleteMessagesOptions {
  /** Pass `true` to delete for everyone where the sender's rights allow it. */
  shouldDeleteForAll?: boolean;
}

/**
 * One media blob read out of the app's media cache (or freshly downloaded,
 * for prefetchable kinds). `kind` mirrors the message's media field, so the
 * caller can pick a rendering strategy without re-inspecting the message.
 */
export interface TgMediaBlob {
  kind: 'photo' | 'gif' | 'sticker' | 'document' | 'video' | 'audio' | 'voice';
  mimeType: string | undefined;
  fileName: string | undefined;
  /** Blob size in bytes; the caller applies its own per-blob cap. */
  sizeBytes: number;
  blob: Blob;
}

/** Options for `tg.api.fetchMessageMedia`. */
export interface TgFetchMessageMediaOptions {
  /**
   * Pass `true` to also fetch a video's bytes while its file reference is
   * still alive (a real download, not a cache read). Without it, video media
   * resolves to an empty list unless the bytes are already cached.
   */
  shouldPrefetchVideo?: boolean;
}

/**
 * Action facade: fire-and-forget wrappers over the app's own store actions, so
 * plugins inherit the app's optimistic-update pipeline. Every method is
 * error-contained: a rejected call logs with the plugin name and returns.
 */
export interface TgApiSlice {
  /**
   * Sends a text message to a chat. The chat must exist in the store;
   * unknown chats are logged and skipped.
   */
  sendMessage: (chatId: string, text: string, options?: TgSendMessageOptions) => void;
  /**
   * Replaces a message's text. Only the currently open chat can be edited:
   * the underlying app action edits whatever the open thread's editing state
   * points at, so the facade first points that state at `messageId` in the
   * active message list. Editing a different chat is logged and skipped.
   */
  editMessage: (chatId: string, messageId: number, text: string) => void;
  /**
   * Deletes messages by ids. Always addresses the chat's main thread
   * explicitly, so the currently open chat does not matter.
   */
  deleteMessages: (chatId: string, messageIds: number[], options?: TgDeleteMessagesOptions) => void;
  /**
   * Toggles an emoji reaction on a message: sets it when the current user has
   * not reacted yet, and removes the user's reaction when it is already set.
   */
  setReaction: (chatId: string, messageId: number, emoticon: string) => void;
  /** Opens a chat, replacing the currently open message list. */
  openChat: (chatId: string) => void;
  /**
   * Reads the message's media blobs out of the app's media cache. Call it
   * synchronously inside a `message:deleted` handler: the native delete
   * pipeline unloads the message's cached media a frame later, so the
   * returned promise must start while the data is still alive. Video bytes
   * download for real while the file reference lives, and only with
   * `shouldPrefetchVideo`. Resolves `[]` when nothing is cached (or on any
   * error — the call is contained, never throws).
   */
  fetchMessageMedia: (
    chatId: string,
    messageId: number,
    options?: TgFetchMessageMediaOptions,
  ) => Promise<TgMediaBlob[]>;
}

/**
 * Read-only store reads. Every method returns plain data (or `undefined`),
 * never store handles, so plugins cannot mutate the app's state.
 */
export interface TgStoreSlice {
  /** The open chat's id; `undefined` when no chat is open. */
  getActiveChatId: () => string | undefined;
  /** The signed-in user's id; `undefined` when signed out. */
  getCurrentUserId: () => string | undefined;
  /** Chat (or private user) data by id, as a read-only view of the stored object. */
  getChat: (chatId: string) => Readonly<ApiChat> | undefined;
  /**
   * User data by id (the `ApiUser` record behind a private chat's peer) —
   * a read-only view; `undefined` when the store knows no such user.
   */
  getUser: (userId: string) => Readonly<ApiUser> | undefined;
  /**
   * Message data by chat and id, as a read-only view of the stored object;
   * `undefined` once the message is gone from the store.
   */
  getMessage: (chatId: string, messageId: number) => Readonly<ApiMessage> | undefined;
}

/** Utility slice: namespaced logging and the app's localized strings. */
export interface TgUtilSlice {
  /**
   * Logs to the console, prefixed with the plugin name. Non-string arguments
   * are JSON-serialized.
   */
  log: (...args: unknown[]) => void;
  /**
   * Translates an app lang key (see `src/assets/localization/fallback.strings`)
   * with optional substitution variables. Returns the raw key when translation
   * fails.
   */
  getLocalizedString: (key: LangKey, variables?: Record<string, LangVariable>) => string;
}

// --- tg.storage ----------------------------------------------------------------
//
// A budgeted storage engine exposed to every plugin as a contract slice (see
// src/plugins/storageEngine.ts). Keys are namespaced per calling plugin and
// scoped per account slot, so plugins and accounts never see each other's
// data. Records are small JSON values kept in IndexedDB and are never evicted;
// blobs are binary values kept in OPFS under a shared budget — writing past
// the budget evicts the oldest captured blobs first.

/** Result of `tg.storage.putBlob`. */
export interface TgBlobPutResult {
  /** Whether the blob bytes were written; `false` means the record must carry the truth. */
  isStored: boolean;
  /** Present when `isStored` is `false`; names the failure mode. */
  reason?: 'overCap' | 'overBudget' | 'unavailable';
}

/** Storage footprint of the blob space, as reported by `tg.storage.getUsage`. */
export interface TgStorageUsage {
  /** Bytes used by stored blobs, tracked incrementally (startup estimate + deltas). */
  usedBytes: number;
  /** Effective blob budget: `min(budget setting, 50% of the storage quota)`. */
  budgetBytes: number;
  /** The origin storage quota reported by `navigator.storage.estimate()`. */
  quotaBytes: number;
}

/** Options for `tg.storage.listRecords`. */
export interface TgListRecordsOptions {
  /** Restrict the listing to keys starting with this prefix. */
  prefix?: string;
  /** Page size; the engine caps the request at its own maximum. */
  limit?: number;
  /** Opaque resume point returned by a previous page's `cursor`. */
  cursor?: string;
}

/** One page of `tg.storage.listRecords`. */
export interface TgListRecordsPage<T> {
  items: Array<{ key: string; record: T }>;
  /** Pass to the next call to continue after the last item; `undefined` ends the listing. */
  cursor?: string;
}

/**
 * Persistent storage scoped per plugin and per account. Every method is
 * error-contained: a failing call logs with the plugin name and resolves to
 * a safe result, never throws. Storage outlives enable/disable — data is
 * cleared only through the explicit remove/clear methods.
 */
export interface TgStorageSlice {
  /** Persists a small JSON record; records are unbudgeted and never evicted. */
  putRecord: (key: string, record: unknown) => Promise<void>;
  /** Reads one record; `undefined` when missing or unparsable. */
  getRecord: <T>(key: string) => Promise<T | undefined>;
  /**
   * Lists records by key, ascending. `cursor` pages through the plugin's
   * whole record space; a `prefix` narrows the walk (e.g. `'chat:100:'`
   * lists one chat's archive), and `limit` bounds the page size.
   */
  listRecords: <T>(options?: TgListRecordsOptions) => Promise<TgListRecordsPage<T>>;
  /** Removes one record; a missing key resolves without error. */
  deleteRecord: (key: string) => Promise<void>;
  /** Removes every record of the calling plugin; blobs are untouched. */
  clearRecords: () => Promise<void>;

  /**
   * Persists blob bytes under `key`; a record-only archive is indicated by
   * the result, never by a throw. Blobs over the per-blob cap resolve
   * `{ isStored: false, reason: 'overCap' }`; an exhausted budget resolves
   * `reason: 'overBudget'` after eviction could not make room; a missing
   * OPFS backend resolves `reason: 'unavailable'`.
   */
  putBlob: (key: string, blob: Blob) => Promise<TgBlobPutResult>;
  /** Reads blob bytes; `undefined` when missing (e.g. evicted) or unavailable. */
  getBlob: (key: string) => Promise<Blob | undefined>;
  /** Removes one blob; a missing key resolves without error. */
  deleteBlob: (key: string) => Promise<void>;
  /**
   * Removes every blob of the calling plugin (its OPFS directory) and resets
   * the shared usage accounting accordingly; records are untouched.
   */
  clearBlobs: () => Promise<void>;
  /** Footprint of the blob space: used, budget and quota bytes. */
  getUsage: () => Promise<TgStorageUsage>;
  /**
   * Sets the engine-wide media budget in bytes; the engine clamps the
   * effective budget to 50% of the origin quota. Intended for the settings
   * UI of the plugin that owns the budget's semantics.
   */
  setBudgetBytes: (bytes: number) => Promise<void>;
  /**
   * Sets the engine-wide cap on one blob in bytes; larger media stays
   * record-only. Intended for the settings UI of the plugin that owns the
   * cap's semantics.
   */
  setPerBlobCapBytes: (bytes: number) => Promise<void>;
}

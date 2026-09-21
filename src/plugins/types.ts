import type { ApiChat, ApiMessage } from '../api/types';
import type { ThreadId } from '../types';
import type { IconName } from '../types/icons';
import type { LangKey, LangVariable } from '../types/language';

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
  };
  /** Message/chat action facade riding the app's own store-action pipeline. */
  api: TgApiSlice;
  /** Read-only store reads; plain data, never store handles. */
  store: TgStoreSlice;
  /** Per-plugin logging and the app's localized strings. */
  util: TgUtilSlice;
}

export interface TgPlugin {
  /** Unique plugin name, used as the registry key. */
  name: string;
  version?: string;
  /** Short summary shown under the plugin name in Settings. */
  description?: string;
  /** Called at app startup and on every re-enable with a fresh `tg` object. */
  setup: (tg: TgPluginApi) => void | (() => void);
}

/** Convenience identity helper mirroring Vite's defineConfig convention. */
export function definePlugin(plugin: TgPlugin): TgPlugin {
  return plugin;
}

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

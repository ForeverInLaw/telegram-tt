import type { ApiMessage } from '../api/types';
import type { IconName } from '../types/icons';

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
  /**
   * Subscribe to an app event and receive its typed payload; returns the
   * unsubscribe function for that one handler. Every handler a plugin
   * registered is removed when the plugin is disabled.
   */
  on: <Event extends TgEventName>(
    event: Event,
    handler: (payload: TgEventPayloads[Event]) => void,
  ) => () => void;
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

/** Names of the app events a plugin can observe through `tg.on`. */
export type TgEventName = 'message:new' | 'message:edited' | 'message:deleted' | 'chat:opened';

/** Payload of `message:new`: a message arrived in a chat. */
export interface TgMessageNewPayload {
  chatId: string;
  messageId: number;
  message: ApiMessage;
}

/** Payload of `message:edited`: a message was edited; `message` may be partial. */
export interface TgMessageEditedPayload {
  chatId: string;
  messageId: number;
  message: Partial<ApiMessage>;
}

/** Payload of `message:deleted`: `chatId` is unknown for some chats in the source update. */
export interface TgMessageDeletedPayload {
  chatId: string | undefined;
  messageIds: number[];
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

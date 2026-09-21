import type { ApiChat, ApiMessage } from '../api/types';
import type { ThreadId } from '../types';
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
    /** Add an item to the chat-list right-click context menu. */
    addChatContextMenuItem: (item: TgChatContextMenuItem) => void;
    /** Add an entry to the main ("burger") menu. */
    addMainMenuItem: (item: TgMainMenuItem) => void;
    /** Add an icon button to the chat composer bar. */
    addComposerButton: (item: TgComposerButton) => void;
    /** Show an in-app notification with title and body. */
    showNotification: (notification: TgUiNotification) => void;
  };
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

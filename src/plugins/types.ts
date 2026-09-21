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

import type { TgMessageContextMenuItem } from './types';

/**
 * Central registry that UI components read from. Plugins write here
 * only through the host's ui slice (src/plugins/slices/ui.ts), which
 * enforces one entry per plugin name for v1.
 */
const messageContextMenuItems = new Map<string, TgMessageContextMenuItem>();
let cachedItems: TgMessageContextMenuItem[] = [];

function rebuildItems() {
  cachedItems = [...messageContextMenuItems.values()];
}

export function registerMessageContextMenuItem(pluginName: string, item: TgMessageContextMenuItem) {
  messageContextMenuItems.set(pluginName, item);
  rebuildItems();
}

/** Removes one plugin's entry; called when the plugin is disabled. */
export function clearMessageContextMenuItems(pluginName: string) {
  if (!messageContextMenuItems.delete(pluginName)) return;
  rebuildItems();
}

/** Returns a stable-reference array; safe to call from render. */
export function getMessageContextMenuItems(): TgMessageContextMenuItem[] {
  return cachedItems;
}

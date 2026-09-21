import type { TgMessageContextMenuItem } from './types';

/**
 * Central registry that UI components read from. Plugins write here
 * only through the host (src/plugins/host.ts), which enforces
 * one entry per plugin name for v1.
 */
const messageContextMenuItems = new Map<string, TgMessageContextMenuItem>();

export function registerMessageContextMenuItem(pluginName: string, item: TgMessageContextMenuItem) {
  messageContextMenuItems.set(pluginName, item);
}

/** Returns a stable-reference array; safe to call from render. */
export function getMessageContextMenuItems(): TgMessageContextMenuItem[] {
  return [...messageContextMenuItems.values()];
}

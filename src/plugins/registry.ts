import type {
  TgChatContextMenuItem, TgComposerButton, TgMainMenuItem, TgMessageContextMenuItem,
  TgSettingsPanelRegistration,
} from './types';

/**
 * Central per-surface registries that UI components read from. Plugins write
 * here only through the host's ui slice (src/plugins/slices/ui.ts), which
 * wraps their callbacks and tears the entries down on disable.
 *
 * Every surface instance returns a stable-reference array: the same instance
 * until a registration changes, so render seams never create new props.
 */

/** One plugin's entry in a surface registry: the item plus its owner. */
type SurfaceEntry<T> = { pluginName: string; item: T };

/** Builds one surface's registry; entries keep registration order. */
function createSurfaceRegistry<T>() {
  const entries: SurfaceEntry<T>[] = [];
  let cachedItems: readonly T[] = [];

  function rebuildItems() {
    cachedItems = Object.freeze(entries.map(({ item }) => item));
  }

  function register(pluginName: string, item: T) {
    entries.push({ pluginName, item });
    rebuildItems();
  }

  /** Removes every entry one plugin registered; called when the plugin is disabled. */
  function clearByPlugin(pluginName: string) {
    if (!entries.some((entry) => entry.pluginName === pluginName)) return;

    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].pluginName === pluginName) entries.splice(i, 1);
    }
    rebuildItems();
  }

  /** Returns a stable-reference array; safe to call from render. */
  function getAll(): readonly T[] {
    return cachedItems;
  }

  return { register, clearByPlugin, getAll };
}

const messageContextMenuRegistry = createSurfaceRegistry<TgMessageContextMenuItem>();
const chatContextMenuRegistry = createSurfaceRegistry<TgChatContextMenuItem>();
const mainMenuRegistry = createSurfaceRegistry<TgMainMenuItem>();
const composerButtonRegistry = createSurfaceRegistry<TgComposerButton>();
const settingsPanelRegistry = createSurfaceRegistry<TgSettingsPanelRegistration>();

// Kept exported one-by-one so native seams import a named getter per surface.

export function registerMessageContextMenuItem(pluginName: string, item: TgMessageContextMenuItem) {
  messageContextMenuRegistry.register(pluginName, item);
}

/** Removes one plugin's entries; called when the plugin is disabled. */
export function clearMessageContextMenuItems(pluginName: string) {
  messageContextMenuRegistry.clearByPlugin(pluginName);
}

/** Returns a stable-reference array; safe to call from render. */
export function getMessageContextMenuItems(): readonly TgMessageContextMenuItem[] {
  return messageContextMenuRegistry.getAll();
}

export function registerChatContextMenuItem(pluginName: string, item: TgChatContextMenuItem) {
  chatContextMenuRegistry.register(pluginName, item);
}

export function clearChatContextMenuItems(pluginName: string) {
  chatContextMenuRegistry.clearByPlugin(pluginName);
}

export function getChatContextMenuItems(): readonly TgChatContextMenuItem[] {
  return chatContextMenuRegistry.getAll();
}

export function registerMainMenuItem(pluginName: string, item: TgMainMenuItem) {
  mainMenuRegistry.register(pluginName, item);
}

export function clearMainMenuItems(pluginName: string) {
  mainMenuRegistry.clearByPlugin(pluginName);
}

export function getMainMenuItems(): readonly TgMainMenuItem[] {
  return mainMenuRegistry.getAll();
}

export function registerComposerButton(pluginName: string, item: TgComposerButton) {
  composerButtonRegistry.register(pluginName, item);
}

export function clearComposerButtons(pluginName: string) {
  composerButtonRegistry.clearByPlugin(pluginName);
}

export function getComposerButtons(): readonly TgComposerButton[] {
  return composerButtonRegistry.getAll();
}

export function registerSettingsPanel(pluginName: string, panel: TgSettingsPanelRegistration) {
  settingsPanelRegistry.register(pluginName, panel);
}

export function clearSettingsPanels(pluginName: string) {
  settingsPanelRegistry.clearByPlugin(pluginName);
}

/** Returns a stable-reference array; safe to call from render. */
export function getSettingsPanels(): readonly TgSettingsPanelRegistration[] {
  return settingsPanelRegistry.getAll();
}

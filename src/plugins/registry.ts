import type {
  TgChatContextMenuItem, TgComposerButton, TgMainMenuItem, TgMessageContextMenuItem,
  TgPluginScreen, TgSettingsPanelRegistration,
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

// Settings screens re-render on every toggle already (they read the host
// list), but a plugin registered mid-session must appear without one; a tiny
// notification set lets SettingsPlugins subscribe like the screen container.
const settingsPanelListeners = new Set<() => void>();

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
  notifySettingsPanelsChanged();
}

export function clearSettingsPanels(pluginName: string) {
  // The reference stays stable when the plugin had no panels; no notification either.
  const panelsBefore = settingsPanelRegistry.getAll();
  settingsPanelRegistry.clearByPlugin(pluginName);
  if (settingsPanelRegistry.getAll() !== panelsBefore) {
    notifySettingsPanelsChanged();
  }
}

export function getSettingsPanels(): readonly TgSettingsPanelRegistration[] {
  return settingsPanelRegistry.getAll();
}

/** Subscribes to settings-panel registration changes; returns the unsubscribe function. */
export function subscribeToSettingsPanels(listener: () => void): () => void {
  settingsPanelListeners.add(listener);
  return () => {
    settingsPanelListeners.delete(listener);
  };
}

function notifySettingsPanelsChanged() {
  for (const listener of settingsPanelListeners) {
    listener();
  }
}

// --- Active plugin screen ---------------------------------------------------
//
// A singleton, not a list surface: `openScreen` replaces whatever screen is
// open, so the app renders at most one plugin screen at a time. The container
// subscribes through `subscribeToPluginScreen` and re-renders on every change.

/** The open screen plus its owning plugin; `undefined` while no screen is open. */
type ActivePluginScreen = { pluginName: string; screen: TgPluginScreen };

let activePluginScreen: ActivePluginScreen | undefined;
const pluginScreenListeners = new Set<() => void>();

/** Opens a plugin screen, replacing the currently open one (firing its `onClose` first). */
export function openPluginScreen(pluginName: string, screen: TgPluginScreen) {
  activePluginScreen?.screen.onClose?.();
  activePluginScreen = { pluginName, screen };
  notifyPluginScreenChanged();
}

/** Closes the open screen when it belongs to `pluginName`; a no-op otherwise. */
export function closePluginScreen(pluginName: string) {
  if (activePluginScreen?.pluginName !== pluginName) return;

  activePluginScreen.screen.onClose?.();
  activePluginScreen = undefined;
  notifyPluginScreenChanged();
}

/** Closes any open screen; used by the app's own back navigation. */
export function closeActivePluginScreen() {
  if (activePluginScreen === undefined) return;

  activePluginScreen.screen.onClose?.();
  activePluginScreen = undefined;
  notifyPluginScreenChanged();
}

/** Returns the open screen entry; `undefined` while no screen is open. */
export function getActivePluginScreen(): ActivePluginScreen | undefined {
  return activePluginScreen;
}

/** Subscribes to screen open/close changes; returns the unsubscribe function. */
export function subscribeToPluginScreen(listener: () => void): () => void {
  pluginScreenListeners.add(listener);
  return () => {
    pluginScreenListeners.delete(listener);
  };
}

function notifyPluginScreenChanged() {
  for (const listener of pluginScreenListeners) {
    listener();
  }
}

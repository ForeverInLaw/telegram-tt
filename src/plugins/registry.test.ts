import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TgMessageContextMenuItem } from './types';

import {
  clearChatContextMenuItems, clearComposerButtons, clearMainMenuItems, clearMessageContextMenuItems,
  clearSettingsPanels, closeActivePluginScreen, closePluginScreen, getActivePluginScreen,
  getChatContextMenuItems, getComposerButtons, getMainMenuItems, getMessageContextMenuItems,
  getPluginScreenVersion, getSettingsPanels, openPluginScreen, registerChatContextMenuItem,
  registerComposerButton, registerMainMenuItem, registerMessageContextMenuItem, registerSettingsPanel,
  subscribeToPluginScreen, subscribeToSettingsPanels,
} from './registry';

/** Registries are module-level state; tests clean up their own plugin names. */
const PLUGIN_NAMES = [
  'registry-order-a', 'registry-order-b', 'registry-stable-a', 'registry-stable-b',
  'registry-clear-a', 'registry-clear-b', 'registry-clear-unknown', 'registry-single-surface',
  'registry-screen-a', 'registry-screen-b', 'registry-panels-a', 'registry-panels-b',
];

function clearAllPluginNames() {
  for (const pluginName of PLUGIN_NAMES) {
    clearMessageContextMenuItems(pluginName);
    clearChatContextMenuItems(pluginName);
    clearMainMenuItems(pluginName);
    clearComposerButtons(pluginName);
    clearSettingsPanels(pluginName);
    closePluginScreen(pluginName);
  }
}

function createItem(label: string): TgMessageContextMenuItem {
  return { label, onClick: () => {} };
}

/** Builds a minimal screen descriptor with spies for the screen lifecycle. */
function createTestScreen(title: string) {
  const render = vi.fn(() => undefined);
  const onClose = vi.fn();
  return { screen: { title, render, onClose }, render, onClose };
}

describe('surface registries', () => {
  afterEach(() => {
    clearAllPluginNames();
    expect(getMessageContextMenuItems()).toHaveLength(0);
    expect(getChatContextMenuItems()).toHaveLength(0);
    expect(getMainMenuItems()).toHaveLength(0);
    expect(getComposerButtons()).toHaveLength(0);
  });

  it('preserves registration order across and within plugins', () => {
    registerMessageContextMenuItem('registry-order-a', createItem('A1'));
    registerMessageContextMenuItem('registry-order-a', createItem('A2'));
    registerMessageContextMenuItem('registry-order-b', createItem('B1'));
    registerMessageContextMenuItem('registry-order-a', createItem('A3'));

    const labels = getMessageContextMenuItems().map((item) => item.label);
    expect(labels).toEqual(['A1', 'A2', 'B1', 'A3']);
  });

  it('returns a stable reference while registrations do not change', () => {
    registerMessageContextMenuItem('registry-stable-a', createItem('Stable item'));
    const itemsAfterRegister = getMessageContextMenuItems();

    expect(itemsAfterRegister.some((item) => item.label === 'Stable item')).toBe(true);
    expect(getMessageContextMenuItems()).toBe(itemsAfterRegister);
    expect(getMessageContextMenuItems()).toBe(getMessageContextMenuItems());

    registerMessageContextMenuItem('registry-stable-b', createItem('Another item'));

    const itemsAfterSecondRegister = getMessageContextMenuItems();
    expect(itemsAfterSecondRegister).not.toBe(itemsAfterRegister);
    expect(itemsAfterSecondRegister.some((item) => item.label === 'Another item')).toBe(true);
    expect(getMessageContextMenuItems()).toBe(itemsAfterSecondRegister);
  });

  it('keeps the reference stable when clearing an unknown plugin', () => {
    registerMessageContextMenuItem('registry-clear-unknown', createItem('Unknown-clearing probe'));
    const items = getMessageContextMenuItems();

    clearMessageContextMenuItems('registry-not-registered');

    expect(getMessageContextMenuItems()).toBe(items);
  });

  it('clears only the named plugin entries on every surface', () => {
    registerMessageContextMenuItem('registry-clear-a', createItem('Message A'));
    registerMessageContextMenuItem('registry-clear-b', createItem('Message B'));
    registerChatContextMenuItem('registry-clear-a', { label: 'Chat A', onClick: () => {} });
    registerChatContextMenuItem('registry-clear-b', { label: 'Chat B', onClick: () => {} });
    registerMainMenuItem('registry-clear-a', { label: 'Main A', onClick: () => {} });
    registerMainMenuItem('registry-clear-b', { label: 'Main B', onClick: () => {} });
    registerComposerButton('registry-clear-a', { icon: 'star', label: 'Composer A', onClick: () => {} });
    registerComposerButton('registry-clear-b', { icon: 'star', label: 'Composer B', onClick: () => {} });

    clearMessageContextMenuItems('registry-clear-a');
    clearChatContextMenuItems('registry-clear-a');
    clearMainMenuItems('registry-clear-a');
    clearComposerButtons('registry-clear-a');

    expect(getMessageContextMenuItems().map((item) => item.label)).toEqual(['Message B']);
    expect(getChatContextMenuItems().map((item) => item.label)).toEqual(['Chat B']);
    expect(getMainMenuItems().map((item) => item.label)).toEqual(['Main B']);
    expect(getComposerButtons().map((item) => item.label)).toEqual(['Composer B']);
  });

  it('keeps other surfaces untouched when only one surface is cleared', () => {
    registerMessageContextMenuItem('registry-single-surface', createItem('Single message item'));
    registerMainMenuItem('registry-single-surface', { label: 'Single main item', onClick: () => {} });

    clearMessageContextMenuItems('registry-single-surface');

    expect(getMessageContextMenuItems().some((item) => item.label === 'Single message item')).toBe(false);
    expect(getMainMenuItems().some((item) => item.label === 'Single main item')).toBe(true);
  });
});

describe('active plugin screen', () => {
  afterEach(() => {
    clearAllPluginNames();
    expect(getActivePluginScreen()).toBeUndefined();
    expect(getSettingsPanels()).toHaveLength(0);
  });

  it('opens a screen under its plugin and closes it through closePluginScreen', () => {
    const { screen, render, onClose } = createTestScreen('Registry screen');

    openPluginScreen('registry-screen-a', screen);

    const active = getActivePluginScreen();
    expect(active?.pluginName).toBe('registry-screen-a');
    expect(active?.screen.title).toBe('Registry screen');

    // The registry stores the descriptor as given (the ui slice wraps the factory)
    expect(active?.screen.render).toBe(render);
    expect(render).not.toHaveBeenCalled();

    closePluginScreen('registry-screen-a');

    expect(getActivePluginScreen()).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('replaces the open screen, firing the previous screen onClose', () => {
    const first = createTestScreen('First');
    const second = createTestScreen('Second');

    openPluginScreen('registry-screen-a', first.screen);
    openPluginScreen('registry-screen-b', second.screen);

    expect(getActivePluginScreen()?.screen.title).toBe('Second');
    expect(first.onClose).toHaveBeenCalledTimes(1);
    expect(second.onClose).not.toHaveBeenCalled();

    // Closing by a different plugin name leaves the open screen alone
    closePluginScreen('registry-screen-a');
    expect(getActivePluginScreen()?.screen.title).toBe('Second');
    expect(second.onClose).not.toHaveBeenCalled();

    closeActivePluginScreen();
    expect(getActivePluginScreen()).toBeUndefined();
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on open and close, with a bumped version', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPluginScreen(listener);
    const versionBefore = getPluginScreenVersion();
    const { screen } = createTestScreen('Versioned');

    openPluginScreen('registry-screen-a', screen);
    const versionAfterOpen = getPluginScreenVersion();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(versionAfterOpen).toBeGreaterThan(versionBefore);

    listener.mockClear();
    closePluginScreen('registry-screen-a');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPluginScreenVersion()).toBeGreaterThan(versionAfterOpen);

    listener.mockClear();
    unsubscribe();
    // No-op close: no notification, no version bump
    closePluginScreen('registry-screen-a');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('settings panels', () => {
  afterEach(() => {
    clearAllPluginNames();
    expect(getSettingsPanels()).toHaveLength(0);
  });

  it('lists registered panels in order and clears them per plugin', () => {
    const renderA = vi.fn(() => undefined);
    const renderB = vi.fn(() => undefined);

    registerSettingsPanel('registry-panels-a', { render: renderA });
    registerSettingsPanel('registry-panels-b', { render: renderB });

    expect(getSettingsPanels().map((panel) => panel.render)).toEqual([renderA, renderB]);

    clearSettingsPanels('registry-panels-a');

    expect(getSettingsPanels().map((panel) => panel.render)).toEqual([renderB]);
  });

  it('notifies subscribers on register and clear', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToSettingsPanels(listener);

    registerSettingsPanel('registry-panels-a', { render: () => undefined });
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    clearSettingsPanels('registry-panels-a');
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    // Clearing a plugin without panels keeps the stable reference: no notification
    clearSettingsPanels('registry-panels-b');
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });
});

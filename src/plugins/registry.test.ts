import { afterEach, describe, expect, it } from 'vitest';

import type { TgMessageContextMenuItem } from './types';

import {
  clearChatContextMenuItems, clearComposerButtons, clearMainMenuItems, clearMessageContextMenuItems,
  getChatContextMenuItems, getComposerButtons, getMainMenuItems, getMessageContextMenuItems,
  registerChatContextMenuItem, registerComposerButton, registerMainMenuItem, registerMessageContextMenuItem,
} from './registry';

/** Registries are module-level state; tests clean up their own plugin names. */
const PLUGIN_NAMES = [
  'registry-order-a', 'registry-order-b', 'registry-stable-a', 'registry-stable-b',
  'registry-clear-a', 'registry-clear-b', 'registry-clear-unknown', 'registry-single-surface',
];

function clearAllPluginNames() {
  for (const pluginName of PLUGIN_NAMES) {
    clearMessageContextMenuItems(pluginName);
    clearChatContextMenuItems(pluginName);
    clearMainMenuItems(pluginName);
    clearComposerButtons(pluginName);
  }
}

function createItem(label: string): TgMessageContextMenuItem {
  return { label, onClick: () => {} };
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

import { describe, expect, it } from 'vitest';

import type { TgMessageContextMenuItem } from './types';

import {
  clearMessageContextMenuItems, getMessageContextMenuItems, registerMessageContextMenuItem,
} from './registry';

function createItem(label: string): TgMessageContextMenuItem {
  return { label, onClick: () => {} };
}

describe('message context menu registry', () => {
  it('returns a stable reference while registrations do not change', () => {
    const itemsBefore = getMessageContextMenuItems();
    registerMessageContextMenuItem('stable-owner', createItem('Stable item'));
    const itemsAfter = getMessageContextMenuItems();

    expect(itemsAfter).not.toBe(itemsBefore);
    expect(getMessageContextMenuItems()).toBe(itemsAfter);
  });

  it('clears only the named plugin entry', () => {
    registerMessageContextMenuItem('owner-a', createItem('Item A'));
    registerMessageContextMenuItem('owner-b', createItem('Item B'));

    clearMessageContextMenuItems('owner-a');

    const labels = getMessageContextMenuItems().map((item) => item.label);
    expect(labels).not.toContain('Item A');
    expect(labels).toContain('Item B');
  });

  it('keeps the reference stable when clearing an unknown plugin', () => {
    const items = getMessageContextMenuItems();

    clearMessageContextMenuItems('unknown-owner');

    expect(getMessageContextMenuItems()).toBe(items);
  });
});

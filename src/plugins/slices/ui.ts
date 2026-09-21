import type { PluginContext } from '../context';
import type { TgMessageContextMenuItem, TgPluginApi } from '../types';

import { clearMessageContextMenuItems, registerMessageContextMenuItem } from '../registry';

/** UI-contributions slice: message context menu items. */
export function createUiSlice(context: PluginContext): TgPluginApi['ui'] {
  const { pluginName, wrap, onTeardown } = context;
  onTeardown(() => clearMessageContextMenuItems(pluginName));

  return {
    addMessageContextMenuItem: (item: TgMessageContextMenuItem) => {
      registerMessageContextMenuItem(pluginName, {
        ...item,
        onClick: wrap(item.onClick),
      });
    },
  };
}

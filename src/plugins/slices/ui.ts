import type { PluginContext } from '../context';
import type { TgPluginRuntime } from '../runtime';
import type {
  TgChatContextMenuItem, TgComposerButton, TgMainMenuItem, TgMessageContextMenuItem, TgPluginApi,
  TgSettingsPanelRegistration, TgUiNotification,
} from '../types';

import {
  clearChatContextMenuItems, clearComposerButtons, clearMainMenuItems, clearMessageContextMenuItems,
  clearSettingsPanels, registerChatContextMenuItem, registerComposerButton, registerMainMenuItem,
  registerMessageContextMenuItem, registerSettingsPanel,
} from '../registry';

/**
 * UI-contributions slice. Every method registers a declarative descriptor in
 * its surface registry (plugins never touch UI primitives), wraps plugin
 * callbacks so a throw is contained and logged, and schedules the registry
 * cleanup through `onTeardown` so disabling the plugin clears every surface.
 * Environment services arrive through the runtime, like in every other slice.
 */
export function createUiSlice(context: PluginContext, runtime: TgPluginRuntime): TgPluginApi['ui'] {
  const { pluginName, wrap, onTeardown } = context;

  onTeardown(() => {
    clearMessageContextMenuItems(pluginName);
    clearChatContextMenuItems(pluginName);
    clearMainMenuItems(pluginName);
    clearComposerButtons(pluginName);
    clearSettingsPanels(pluginName);
  });

  return {
    addMessageContextMenuItem: (item: TgMessageContextMenuItem) => {
      registerMessageContextMenuItem(pluginName, {
        ...item,
        onClick: wrap(item.onClick),
      });
    },
    addChatContextMenuItem: (item: TgChatContextMenuItem) => {
      registerChatContextMenuItem(pluginName, {
        ...item,
        onClick: wrap(item.onClick),
      });
    },
    addMainMenuItem: (item: TgMainMenuItem) => {
      registerMainMenuItem(pluginName, {
        ...item,
        onClick: wrap(item.onClick),
      });
    },
    addComposerButton: (item: TgComposerButton) => {
      registerComposerButton(pluginName, {
        ...item,
        onClick: wrap(item.onClick),
      });
    },
    registerSettingsPanel: (panel: TgSettingsPanelRegistration) => {
      registerSettingsPanel(pluginName, panel);
      return () => {
        clearSettingsPanels(pluginName);
      };
    },
    showNotification: (notification: TgUiNotification) => {
      // The runtime service can throw (e.g. a malformed payload); contain it like a callback
      wrap(() => runtime.showNotification(notification))();
    },
  };
}

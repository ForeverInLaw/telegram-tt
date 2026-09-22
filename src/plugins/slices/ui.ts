import type { PluginContext } from '../context';
import type { TgPluginReporter, TgPluginRuntime } from '../runtime';
import type {
  TgChatContextMenuItem, TgComposerButton, TgMainMenuItem, TgMessageContextMenuItem, TgPluginApi,
  TgPluginScreen, TgSettingsPanelRegistration, TgTeactNode, TgUiNotification,
} from '../types';

import {
  clearChatContextMenuItems, clearComposerButtons, clearMainMenuItems, clearMessageContextMenuItems,
  clearSettingsPanels, closePluginScreen, openPluginScreen, registerChatContextMenuItem,
  registerComposerButton, registerMainMenuItem, registerMessageContextMenuItem, registerSettingsPanel,
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
  // The screen render factory returns a node (not void), so `wrap` cannot
  // carry it; its containment gets the reporter directly, like the util slice.
  const reporter = runtime.createPluginReporter(pluginName);

  onTeardown(() => {
    clearMessageContextMenuItems(pluginName);
    clearChatContextMenuItems(pluginName);
    clearMainMenuItems(pluginName);
    clearComposerButtons(pluginName);
    clearSettingsPanels(pluginName);
    // Closing the plugin's open screen fires its wrapped `onClose`, which
    // must not outlive the teardown it belongs to.
    closePluginScreen(pluginName);
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
      registerSettingsPanel(pluginName, {
        title: panel.title,
        render: createContainedRender(reporter, panel.render, 'settings panel render failed'),
      });
      return () => {
        clearSettingsPanels(pluginName);
      };
    },
    showNotification: (notification: TgUiNotification) => {
      // The runtime service can throw (e.g. a malformed payload); contain it like a callback
      wrap(() => runtime.showNotification(notification))();
    },
    openScreen: (screen: TgPluginScreen) => {
      const wrappedScreen: TgPluginScreen = {
        title: screen.title,
        render: createContainedRender(reporter, screen.render, 'screen render failed'),
        onClose: screen.onClose === undefined ? undefined : wrap(screen.onClose),
      };

      openPluginScreen(pluginName, wrappedScreen);

      // Keyed by plugin: closes the plugin's CURRENT screen only. A stale fn
      // (its screen was replaced by another open, or the teardown closed it)
      // finds a foreign or absent screen and does nothing.
      return () => {
        closePluginScreen(pluginName);
      };
    },
  };
}

/**
 * Wraps a plugin node factory so a throw is logged with the plugin name and
 * the container renders an empty node instead. `wrap` cannot carry a return
 * value, so render containment gets its own reporter-based wrapper.
 */
function createContainedRender(
  reporter: TgPluginReporter,
  render: () => TgTeactNode,
  action: string,
): () => TgTeactNode {
  return () => {
    try {
      return render();
    } catch (error) {
      reporter.logError(action, error);
      return undefined;
    }
  };
}

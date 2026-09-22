import type { TgPluginApi } from '../types';

import AntiDeleteSettingsPanel from './settingsPanel';

/**
 * Registers the plugin's settings panel through the app's settings-panel seam
 * (`tg.ui.registerSettingsPanel`, rendered inside Settings → Plugins). The
 * capability guard keeps the plugin loadable on an app build without the
 * seam: a missing method logs and registers nothing. Returns the seam's
 * unregister function for the plugin's disposer.
 */
export function registerSettingsPanelGlue(tg: TgPluginApi): (() => void) | undefined {
  if (typeof tg.ui.registerSettingsPanel !== 'function') {
    tg.util.log('settings panel seam is unavailable; panel not registered');
    return undefined;
  }

  return tg.ui.registerSettingsPanel({
    title: 'AntiDeleteSettingsTitle',
    render: () => <AntiDeleteSettingsPanel tg={tg} />,
  });
}

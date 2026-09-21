import type { RegularLangKey } from '../../types/language';

import { IS_TAURI } from '../browser/globalEnvironment';
import { getTranslationFn } from '../localization';

// Tray menu item ids as declared in `tauri/src/tray/mod.rs`.
const TRAY_LABEL_KEYS: Record<string, RegularLangKey> = {
  open: 'TrayMenuOpen',
  quit: 'TrayMenuQuit',
  autostart: 'TrayMenuAutostart',
  check_updates: 'TrayMenuCheckUpdates',
};

/**
 * Sends the localized tray menu labels to the shell. Items without a resolved
 * translation are skipped; the Rust side falls back to its English defaults
 * for those ids.
 */
export function updateTrayMenu() {
  if (!IS_TAURI || !window.tauri?.setMenuTranslations) return;

  const lang = getTranslationFn();

  const labels: Record<string, string> = {};
  for (const [id, key] of Object.entries(TRAY_LABEL_KEYS)) {
    const label = lang(key);
    // Untranslated keys resolve to the key name itself
    if (label === key || !label) continue;
    labels[id] = label;
  }

  window.tauri.setMenuTranslations(labels).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to update tray menu translations', err);
  });
}

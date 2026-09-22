/**
 * Ghost-retention capability: the seam between the anti-delete plugin and the
 * native delete pipeline. The shared `deleteMessages` updater consults this
 * module synchronously (the check runs inside the update dispatch, before the
 * native reducers), so it stays pure: no side effects, no async reads, no
 * store mutation. Plugin FOLDERS never import src/global; this plugin-layer
 * seam module may (like runtime.ts), because app code importing from
 * src/plugins is the legal direction — the native updater imports this module,
 * so the selectors it needs arrive from the app side.
 *
 * Capability follows the plugin host state: the Settings toggle runs the
 * plugin's disposer and `setPluginEnabled`, so a disabled plugin retains
 * nothing with no extra registration seam. Capture-worthiness mirrors the
 * plugin's own capture filters (`captureDeletedMessages` in the plugin
 * folder): locally-initiated deletions, bot chats while the bots toggle is
 * off, and service notifications stay out.
 */
import type { GlobalState } from '../global/types';

import { selectChatMessage, selectIsChatWithBot } from '../global/selectors';
import { isServiceMessage } from './anti-delete-plugin/capture';
import { areSettingsReady, getSettings } from './anti-delete-plugin/settings';
import { getPluginList } from './host';

/** Whether the anti-delete plugin's lifetime is currently active. */
export function isAntiDeleteActive(): boolean {
  return getPluginList().some((plugin) => plugin.name === 'anti-delete' && plugin.isEnabled);
}

/**
 * The one capability check the native `deleteMessages` updater consults per
 * message: `true` means the message is marked `isArchivedDeleted` instead of
 * `isDeleting`, skipping the delete animation and physical removal.
 */
export function shouldRetainDeletedMessage(
  global: GlobalState, chatId: string, messageId: number, isLocal: boolean,
): boolean {
  // Locally-initiated deletions (this client's own delete action, an upload
  // cancel) are never retention material
  if (isLocal) return false;

  if (!isAntiDeleteActive()) return false;

  // Until the persisted settings settle, the bots toggle answers from
  // defaults; retention waits like capture does, so the user's stored
  // choice stays authoritative
  if (!areSettingsReady()) return false;

  // Bot chats follow the bots toggle, mirroring the capture filter
  if (!getSettings().shouldCaptureBots && selectIsChatWithBot(global, chatId)) return false;

  // Service notifications (chat created, someone pinned a message) carry no
  // recoverable content; unknown ids (already gone) have nothing to retain
  const message = selectChatMessage(global, chatId, messageId);
  if (message === undefined || isServiceMessage(message)) return false;

  return true;
}

import type { TgMessageDeletedPayload, TgPluginApi } from '../types';
import type { AntiDeleteArchive } from './archive';
import type { AntiDeleteCaptureRecord } from './capture';
import { definePlugin } from '../types';

import { createArchive } from './archive';
import { buildCaptureKey, buildCaptureRecord, isServiceMessage } from './capture';
import { captureMessageMedia } from './mediaCapture';
import { registerSettingsPanelGlue } from './registerPanel';
import { captureRevisionFromUpdate, isBotChat } from './revisions';
import { areSettingsReady, getSettings, loadSettings, resetSettings } from './settings';
import { createArchiveViewerScreen } from './viewer';

/**
 * Anti-delete plugin: keeps an archive of the messages this client saw get
 * deleted. The `message:deleted` handler snapshots each still-intact
 * message from the store (the event fires in the same update dispatch,
 * before the native reducers remove the message) and persists a plain
 * record through `tg.storage`. Locally-initiated deletions and bot chats
 * (while the bots toggle is off) stay out of the archive. Captured records
 * live in the storage slice, so they survive plugin disable/enable.
 */
export default definePlugin({
  name: 'anti-delete',
  version: '0.1.0',
  description: 'Keeps an archive of messages others deleted, with text, metadata and senders.',
  // Spec default: archival works out of the box
  isEnabledByDefault: true,
  setup(tg) {
    // Load the persisted settings into the in-memory cache. The deletion
    // handler reads the cache synchronously: a storage read is async, and
    // the handler must not await anything (the snapshot window closes the
    // moment the handler returns).
    loadSettings(tg);

    const archive = createArchive(tg);
    runtimeArchive = archive;

    // The chat (header and chat-list) context-menu item opening the archive
    // viewer. The item always shows: capture counts are async, and the
    // viewer's empty state covers capture-less chats.
    tg.ui.addChatContextMenuItem({
      icon: 'delete',
      label: tg.util.getLocalizedString('DeletedMessages'),
      onClick: (chat) => {
        tg.ui.openScreen(createArchiveViewerScreen(archive, chat.id, tg.util.getLocalizedString));
      },
    });

    // The settings panel renders under Settings → Plugins through the
    // `registerSettingsPanel` seam.
    const unregisterPanel = registerSettingsPanelGlue(tg);
    const unsubscribe = tg.on('message:deleted', (payload) => {
      captureDeletedMessages(tg, payload);
    });
    // Edit history: a separate, self-contained subscription so parallel
    // pipelines (media capture) merge trivially
    const unsubscribeEdits = tg.on('message:edited', (payload) => {
      captureRevisionFromUpdate(tg, payload);
    });

    return () => {
      unregisterPanel?.();
      unsubscribe();
      unsubscribeEdits();
      resetSettings();
      runtimeArchive = undefined;
    };
  },
});

// --- Runtime module state -------------------------------------------------------
//
// The current lifetime's archive: tests and later tickets read the archive
// without a `tg` object at hand. The disposer clears it, so a disabled
// plugin exposes no archive.

let runtimeArchive: AntiDeleteArchive | undefined;

/** The current lifetime's archive API; `undefined` while the plugin is disabled. */
export function getArchive(): AntiDeleteArchive | undefined {
  return runtimeArchive;
}

// --- Capture pipeline -------------------------------------------------------------

/**
 * Filters and captures one deletion event. The snapshot loop runs fully
 * synchronously inside the handler: `getMessage` must read the store before
 * the native delete pipeline removes the message, so nothing awaits here.
 * The record writes themselves are async (fired, errors contained).
 */
function captureDeletedMessages(tg: TgPluginApi, payload: TgMessageDeletedPayload): void {
  const { source, items } = payload;

  // Deletions arriving before the persisted settings settle would capture
  // against defaults; skipping keeps the user's toggles authoritative
  if (!areSettingsReady()) return;

  for (const item of items) {
    // This client's own deletions are not archive material
    if (item.isLocal) continue;

    // The app could not resolve the message's chat, so there is nothing to attach a record to
    if (item.chatId === undefined) continue;

    // Bot chats follow the bots toggle; ambiguous detections default to capturing
    if (!getSettings().shouldCaptureBots && isBotChat(tg, item.chatId)) continue;

    // The message is still intact at this point of the dispatch; the
    // snapshot must happen right here, synchronously.
    const message = tg.store.getMessage(item.chatId, item.messageId);
    if (message === undefined) continue;

    // Service notifications (chat created, someone pinned a message) carry
    // no recoverable content
    if (isServiceMessage(message)) continue;

    // The name snapshot rides the same synchronous window as the message:
    // the user record may leave the store with the message
    const senderName = message.senderId === undefined
      ? undefined
      : resolveSenderName(tg, message.senderId);

    const record = buildCaptureRecord(item.chatId, item.messageId, message, source, senderName);
    const captureKey = buildCaptureKey(item.chatId, item.messageId);

    // The write is async by contract; the slice contains backend errors, and
    // this catch guards the chain itself so a throw never reaches the host.
    // A record may already exist (a re-emitted deletion): the merge keeps
    // its copied media refs, so a re-capture never orphans stored blobs.
    const recordWrite = tg.storage.getRecord<AntiDeleteCaptureRecord>(captureKey).then((existing) => {
      const mergedRecord = existing === undefined ? record : {
        ...record,
        media: existing.media,
      };
      return tg.storage.putRecord(captureKey, mergedRecord);
    }).catch((err) => {
      tg.util.log('capture persist failed', err);
    });

    // Media copy, kicked synchronously (void — the record never waits for
    // it): the underlying cache read must start while the message's media
    // is still alive, before the native delete pipeline unloads it.
    captureMessageMedia(tg, record, recordWrite);
  }
}

/**
 * The sender's display name (first + last, falling back per field present),
 * snapshotted while the store still knows the user. Anonymous channel posts
 * and unresolvable ids stay `undefined`; the viewer falls back to the id.
 */
function resolveSenderName(tg: TgPluginApi, senderId: string): string | undefined {
  const user = tg.store.getUser(senderId);
  if (user === undefined) return undefined;

  if (user.firstName && user.lastName) {
    return `${user.firstName} ${user.lastName}`;
  }

  return user.firstName ?? user.lastName;
}

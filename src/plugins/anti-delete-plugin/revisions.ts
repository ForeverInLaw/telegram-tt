import type { TgMessageEditedPayload, TgPluginApi } from '../types';
import type { AntiDeleteFormattedText, AntiDeleteMessage } from './capture';

import { isServiceMessage } from './capture';
import { getSettings } from './settings';

/** Version of the revision record layout; a bump is a forward migration. */
export const REVISION_SCHEMA_VERSION = 1;

/**
 * One captured edit revision: the message's PRE-EDIT text snapshot, taken
 * while the store still held the previous revision (the `message:edited`
 * event fires in the same update dispatch, before the native edit reducer
 * applies the new content). Plain serializable data, never a store reference.
 */
export interface AntiDeleteRevisionRecord {
  schemaVersion: number;
  chatId: string;
  messageId: number;
  /** Sender's user/chat id; `undefined` for channel posts and anonymous admins. */
  senderId: string | undefined;
  /** Unix date of the original message. */
  date: number;
  /** Unix date of the edit that superseded this revision. */
  editDate: number;
  /** The pre-edit revision's formatted text. */
  text: AntiDeleteFormattedText;
  /** Unix timestamp of the capture (the moment the edit arrived). */
  capturedAt: number;
}

/**
 * Edit dates fit in 10 digits, so subtracting the date from this base keeps a
 * message's revision keys fixed-width: ascending key order runs newest-first,
 * exactly like the capture keys' flipped message ids.
 */
const KEY_FLIP_BASE = 9_999_999_999;
const KEY_ID_WIDTH = 10;
const KEY_PREFIX = 'revision';

/** Builds the `listRecords` prefix holding one message's whole revision list. */
export function buildRevisionKeyPrefix(chatId: string, messageId: number): string {
  return `${KEY_PREFIX}:${chatId}:${messageId}:`;
}

/** Builds the `listRecords` prefix holding one chat's whole revision archive. */
export function buildRevisionChatKeyPrefix(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:`;
}

/**
 * Builds one revision's storage key:
 * `revision:<chatId>:<messageId>:<flipped edit date>`.
 */
export function buildRevisionKey(chatId: string, messageId: number, editDate: number): string {
  const flippedDate = String(KEY_FLIP_BASE - editDate).padStart(KEY_ID_WIDTH, '0');
  return `${buildRevisionKeyPrefix(chatId, messageId)}${flippedDate}`;
}

/**
 * Filters and captures one edit event. The snapshot runs fully synchronously
 * inside the handler: `getMessage` must read the store before the native edit
 * reducer applies the new content, so nothing awaits here. The record write
 * itself is async (fired, errors contained).
 */
export function captureRevisionFromUpdate(tg: TgPluginApi, payload: TgMessageEditedPayload): void {
  const { chatId, messageId, message } = payload;

  // Reactions, poll votes, web-page previews, sending states and fresh media
  // ride the same event; only real edits carry the `isEdited` flag (the api
  // builder sets it from the server edit date)
  if (!message.isEdited) return;

  // This client's own edits are not archive material
  if (tg.store.getCurrentUserId() === message.senderId) return;

  // Bot chats follow the bots toggle; ambiguous detections default to capturing
  if (!getSettings().shouldCaptureBots && isBotChat(tg, chatId)) return;

  // The store still holds the pre-edit revision at this point of the dispatch;
  // the snapshot must happen right here, synchronously.
  const storedMessage = tg.store.getMessage(chatId, messageId);
  if (storedMessage === undefined) return;

  // Service notifications carry no recoverable content
  if (isServiceMessage(storedMessage)) return;

  // Revisions are text + metadata only; media-only messages have no
  // text revision to keep
  const text = storedMessage.content.text;
  if (text === undefined) return;

  const record = buildRevisionRecord(chatId, messageId, storedMessage, message);

  // The write is async by contract; the slice contains backend errors, and
  // this catch guards the chain itself so a throw never reaches the host
  void tg.storage.putRecord(buildRevisionKey(chatId, messageId, record.editDate), record).catch((err) => {
    tg.util.log('revision persist failed', err);
  });
}

/**
 * Snapshots the pre-edit revision into a plain record. The edit date comes
 * from the update payload (the server's `editDate`), falling back to the
 * stored message's own field, then to the capture moment.
 */
function buildRevisionRecord(
  chatId: string,
  messageId: number,
  storedMessage: Readonly<AntiDeleteMessage>,
  update: Readonly<Partial<AntiDeleteMessage>>,
): AntiDeleteRevisionRecord {
  return {
    schemaVersion: REVISION_SCHEMA_VERSION,
    chatId,
    messageId,
    senderId: storedMessage.senderId,
    date: storedMessage.date,
    editDate: update.editDate ?? storedMessage.editDate ?? Math.floor(Date.now() / 1000),
    text: {
      text: storedMessage.content.text?.text ?? '',
      entities: storedMessage.content.text?.entities,
    },
    capturedAt: Date.now(),
  };
}

/**
 * A bot chat is a private chat whose peer is a bot user. Shared with the
 * deletion capture pipeline (`index.ts`): the chat record carries no bot
 * flag, so the check reads the user record the private chat resolves to;
 * unknown users and non-private chat types capture.
 */
export function isBotChat(tg: TgPluginApi, chatId: string): boolean {
  const chat = tg.store.getChat(chatId);
  if (chat?.type !== 'chatTypePrivate') return false;

  const user = tg.store.getUser(chatId);
  return user !== undefined && user.type === 'userTypeBot';
}

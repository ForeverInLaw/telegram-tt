import type { TgDeletionSource, TgEventPayloads } from '../types';

/** Version of the capture record layout; a bump is a forward migration. */
export const CAPTURE_SCHEMA_VERSION = 1;

/**
 * The message shape the store slice returns, reached through the contract
 * only (the payload type re-exports `ApiMessage`).
 */
export type AntiDeleteMessage = TgEventPayloads['message:new']['message'];

/** A message entity captured structurally; entities are plain serializable data. */
export interface AntiDeleteMessageEntity {
  type: string;
  offset: number;
  length: number;
  [extraField: string]: unknown;
}

/** The message's formatted text (`content.text`), captured as plain serializable data. */
export interface AntiDeleteFormattedText {
  text: string;
  entities: AntiDeleteMessageEntity[] | undefined;
}

/** Which media field the captured message carried. */
export type AntiDeleteContentType = 'text' | 'photo' | 'video' | 'sticker' | 'document' | 'audio'
  | 'voice' | 'poll' | 'webpage' | 'contact' | 'location' | 'game' | 'invoice' | 'dice' | 'story'
  | 'todo' | 'giveaway' | 'paidMedia' | 'other';

/** Minimal serializable media descriptors the archive viewer and the media capture rebuild on. */
export interface AntiDeleteContentSummary {
  type: AntiDeleteContentType;
  /** Server-side media id for re-downloadable kinds (photo, video, sticker, audio, voice). */
  mediaId: string | undefined;
  fileName: string | undefined;
  mimeType: string | undefined;
  size: number | undefined;
  duration: number | undefined;
}

/** One captured deletion: plain serializable data, never a live store reference. */
export interface AntiDeleteCaptureRecord {
  schemaVersion: number;
  chatId: string;
  messageId: number;
  /** Sender's user/chat id; `undefined` for channel posts and anonymous admins. */
  senderId: string | undefined;
  /** Unix date of the original message. */
  date: number;
  /** The message's formatted text, when it had one. */
  text: AntiDeleteFormattedText | undefined;
  content: AntiDeleteContentSummary;
  /** Why the message went: plain/admin delete, chat clear or a self-destruct timer. */
  source: TgDeletionSource;
  /** Unix timestamp of the capture (the moment the deletion arrived). */
  capturedAt: number;
}

/**
 * Message ids fit in 10 digits, so subtracting the id from this base keeps a
 * chat's capture keys fixed-width: ascending key order runs newest-first, and
 * the storage engine's cursor paging walks the archive exactly the way the
 * viewer scrolls (upwards into older captures).
 */
const KEY_FLIP_BASE = 9_999_999_999;
const KEY_ID_WIDTH = 10;
const KEY_PREFIX = 'capture';

/** Builds the `listRecords` prefix holding one chat's whole capture archive. */
export function buildCaptureKeyPrefix(chatId: string): string {
  return `${KEY_PREFIX}:${chatId}:`;
}

/** Builds one capture's storage key: `capture:<chatId>:<flipped message id>`. */
export function buildCaptureKey(chatId: string, messageId: number): string {
  const flippedId = String(KEY_FLIP_BASE - messageId).padStart(KEY_ID_WIDTH, '0');
  return `${buildCaptureKeyPrefix(chatId)}${flippedId}`;
}

/**
 * Snapshots the still-intact message into a plain record. Runs synchronously
 * inside the deletion handler, before the native delete pipeline removes the
 * message from the store.
 */
export function buildCaptureRecord(
  chatId: string,
  messageId: number,
  message: Readonly<AntiDeleteMessage>,
  source: TgDeletionSource,
): AntiDeleteCaptureRecord {
  const text = message.content.text;

  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    chatId,
    messageId,
    senderId: message.senderId,
    date: message.date,
    text: text === undefined ? undefined : { text: text.text, entities: text.entities },
    content: summarizeContent(message.content),
    source,
    capturedAt: Date.now(),
  };
}

/** Service notifications (chat actions like "pinned a message") carry no recoverable content. */
export function isServiceMessage(message: Readonly<AntiDeleteMessage>): boolean {
  return message.content.action !== undefined;
}

function summarizeContent(content: Readonly<AntiDeleteMessage>['content']): AntiDeleteContentSummary {
  // Media kinds carry descriptors; the rest record their type only
  if (content.photo) {
    return summarize('photo', { mediaId: content.photo.id });
  }
  if (content.video) {
    return summarize('video', {
      mediaId: content.video.id,
      fileName: content.video.fileName,
      mimeType: content.video.mimeType,
      size: content.video.size,
      duration: content.video.duration,
    });
  }
  if (content.sticker) {
    return summarize('sticker', { mediaId: content.sticker.id });
  }
  if (content.document) {
    return summarize('document', {
      fileName: content.document.fileName,
      mimeType: content.document.mimeType,
      size: content.document.size,
    });
  }
  if (content.audio) {
    return summarize('audio', {
      mediaId: content.audio.id,
      fileName: content.audio.fileName,
      mimeType: content.audio.mimeType,
      size: content.audio.size,
      duration: content.audio.duration,
    });
  }
  if (content.voice) {
    return summarize('voice', {
      mediaId: content.voice.id,
      size: content.voice.size,
      duration: content.voice.duration,
    });
  }
  if (content.pollId) {
    return summarize('poll');
  }
  if (content.webPage) {
    return summarize('webpage');
  }
  if (content.contact) {
    return summarize('contact');
  }
  if (content.location) {
    return summarize('location');
  }
  if (content.game) {
    return summarize('game');
  }
  if (content.invoice) {
    return summarize('invoice');
  }
  if (content.dice) {
    return summarize('dice');
  }
  if (content.storyData) {
    return summarize('story');
  }
  if (content.todo) {
    return summarize('todo');
  }
  if (content.giveaway || content.giveawayResults) {
    return summarize('giveaway');
  }
  if (content.paidMedia) {
    return summarize('paidMedia');
  }
  if (content.text) {
    return summarize('text');
  }
  return summarize('other');
}

function summarize(
  type: AntiDeleteContentType,
  fields: Partial<AntiDeleteContentSummary> = {},
): AntiDeleteContentSummary {
  return {
    type,
    mediaId: fields.mediaId,
    fileName: fields.fileName,
    mimeType: fields.mimeType,
    size: fields.size,
    duration: fields.duration,
  };
}

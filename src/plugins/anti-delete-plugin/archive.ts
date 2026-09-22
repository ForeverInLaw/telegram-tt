import type { TgPluginApi } from '../types';
import type { AntiDeleteCaptureRecord } from './capture';

import { buildCaptureKeyPrefix } from './capture';

/** Read options for `AntiDeleteArchive.readCaptures`; both fields optional. */
export interface AntiDeleteReadOptions {
  /** Page size; the archive caps the request at its own maximum. */
  limit?: number;
  /**
   * Opaque resume point returned by a previous page's `nextCursor`; pass it
   * back to continue the walk into older captures.
   */
  cursor?: string;
}

/** One page of the per-chat archive walk: newest-first, cursor-paged. */
export interface AntiDeleteReadPage {
  captures: AntiDeleteCaptureRecord[];
  /**
   * The cursor the next page's `options.cursor` takes; `undefined` when the
   * walk reached the archive's end (no older captures).
   */
  nextCursor: string | undefined;
}

/** One page of the per-chat text search: newest-first; a search is exhaustive, no cursor. */
export interface AntiDeleteSearchPage {
  captures: AntiDeleteCaptureRecord[];
}

/** Page size bound for archive walks; one viewer screen holds far less than this. */
const MAX_PAGE_LIMIT = 100;

/**
 * The archive's public API, built once per plugin lifetime in `setup` (see
 * `createArchive`). Reads operate on stored records only, so the archive
 * stays readable whether or not fresh captures are landing.
 */
export interface AntiDeleteArchive {
  /**
   * Lists one chat's captures newest-first (the capture keys flip the message
   * id, so ascending storage order runs newest first), one page per call:
   * pass the returned `nextCursor` as the next call's `cursor` to scroll
   * upwards into older captures.
   */
  readCaptures: (chatId: string, options?: AntiDeleteReadOptions) => Promise<AntiDeleteReadPage>;
  /** Lists one chat's captures whose text contains the (case-insensitive) query. */
  searchCaptures: (chatId: string, query: string) => Promise<AntiDeleteSearchPage>;
  /**
   * Removes every capture record of one chat, plus the media blobs the
   * records reference (the blob keys walk beside their records, so a
   * record-less blob never lingers).
   */
  clearCaptures: (chatId: string) => Promise<void>;
  /** Number of captured deletions currently stored for one chat. */
  getCaptureCount: (chatId: string) => Promise<number>;
  /**
   * Reads one capture's copied media blob; `undefined` when the copy never
   * succeeded (record-only capture) or the blob was evicted.
   */
  getMediaBlob: (key: string) => Promise<Blob | undefined>;
}

/**
 * Builds the archive API over the plugin's own storage slice. The `tg`
 * object is captured per call site, so the host's enable/disable cycle
 * (a fresh `tg` per lifetime) never mixes slices.
 */
export function createArchive(tg: TgPluginApi): AntiDeleteArchive {
  const { storage } = tg;

  async function readCaptures(chatId: string, options?: AntiDeleteReadOptions): Promise<AntiDeleteReadPage> {
    const page = await storage.listRecords<AntiDeleteCaptureRecord>({
      prefix: buildCaptureKeyPrefix(chatId),
      limit: Math.min(options?.limit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT),
      cursor: options?.cursor,
    });

    return {
      captures: page.items.map(({ record }) => record),
      nextCursor: page.cursor,
    };
  }

  async function searchCaptures(chatId: string, query: string): Promise<AntiDeleteSearchPage> {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return { captures: [] };
    }

    const prefix = buildCaptureKeyPrefix(chatId);
    const captures: AntiDeleteCaptureRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.listRecords<AntiDeleteCaptureRecord>({ prefix, cursor });
      for (const { record } of page.items) {
        if (record.text?.text.toLowerCase().includes(normalizedQuery)) {
          captures.push(record);
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined);

    return { captures };
  }

  async function clearCaptures(chatId: string): Promise<void> {
    const prefix = buildCaptureKeyPrefix(chatId);
    let cursor: string | undefined;
    do {
      const page = await storage.listRecords<AntiDeleteCaptureRecord>({ prefix, cursor });

      // A capture's media blobs walk beside its record (see `buildMediaKey`),
      // so clearing the chat drops both; a blob whose record went missing
      // earlier stays (its key shares the chat prefix, not the record's).
      await Promise.all(page.items.flatMap(({ record }) => (
        record.media === undefined ? [] : record.media.map(({ key }) => storage.deleteBlob(key))
      )));
      await Promise.all(page.items.map(({ key }) => storage.deleteRecord(key)));
      cursor = page.cursor;
    } while (cursor !== undefined);
  }

  async function getCaptureCount(chatId: string): Promise<number> {
    const prefix = buildCaptureKeyPrefix(chatId);
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await storage.listRecords<AntiDeleteCaptureRecord>({ prefix, cursor });
      count += page.items.length;
      cursor = page.cursor;
    } while (cursor !== undefined);

    return count;
  }

  return { readCaptures, searchCaptures, clearCaptures, getCaptureCount, getMediaBlob: storage.getBlob };
}

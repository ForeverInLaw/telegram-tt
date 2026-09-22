import type { TgPluginApi } from '../types';
import type { AntiDeleteCaptureRecord, AntiDeleteMediaRef } from './capture';

import { buildCaptureKey, buildMediaKey } from './capture';
import { getSettings } from './settings';

/**
 * Copy-at-delete: kicks the media copy for one captured message without
 * blocking the capture record. The record write itself is NOT awaited by the
 * caller — this function receives its promise and the enrichment waits for
 * it. The media read still starts immediately (synchronously kicked inside
 * the deletion handler), while the message's file reference and cached
 * blobs are still alive — the native delete pipeline unloads them a frame
 * later. Every failure degrades to a record-only capture: blobs that miss
 * the cache, exceed the per-blob cap or fail to store are logged and
 * skipped, and the record stays intact.
 */
export function captureMessageMedia(
  tg: TgPluginApi,
  record: AntiDeleteCaptureRecord,
  recordWrite: Promise<void>,
): void {
  // Text-only captures have no media to copy; the content summary mirrors
  // the message's media field, so `text` means nothing to do.
  if (record.content.type === 'text') return;

  void copyMessageMedia(tg, record, recordWrite).catch((err) => {
    // The chain guard: `fetchMessageMedia` and `putBlob`/`putRecord` contain
    // their own errors; this catch keeps a programming error off the host.
    tg.util.log('media capture failed', err);
  });
}

/** Reads the message's media and copies each found blob into plugin storage. */
async function copyMessageMedia(
  tg: TgPluginApi,
  record: AntiDeleteCaptureRecord,
  recordWrite: Promise<void>,
): Promise<void> {
  const { chatId, messageId } = record;
  const blobs = await tg.api.fetchMessageMedia(chatId, messageId, {
    shouldPrefetchVideo: getSettings().shouldPrefetchVideos,
  });

  const mediaRefs: AntiDeleteMediaRef[] = [];
  for (const media of blobs) {
    const key = buildMediaKey(chatId, messageId, media.kind);
    const result = await tg.storage.putBlob(key, media.blob);
    if (result.isStored) {
      mediaRefs.push({ key, kind: media.kind, sizeBytes: media.sizeBytes });
    } else {
      // `overCap`/`overBudget`/`unavailable`: record-only by design, and the
      // reason reaches the log for the settings user to act on.
      tg.util.log(`media blob not stored (${result.reason ?? 'unknown'}): ${key}`);
    }
  }

  if (mediaRefs.length === 0) return;

  // The record write settles before the enrichment reads, so a failed or
  // slow record write degrades to a dangling blob (logged), never a
  // clobbered or enriched-missing record.
  await recordWrite;
  const storedRecord = await tg.storage.getRecord<AntiDeleteCaptureRecord>(buildCaptureKey(chatId, messageId));
  if (storedRecord === undefined) {
    // The record write failed: without an owning record the blobs would sit
    // in budgeted storage forever unreferenced, so this copy cleans up
    // (best-effort — a failed removal logs and leaves the blob to the LRU)
    tg.util.log('media capture found no record to enrich; removing just-stored blobs');
    await Promise.all(mediaRefs.map(({ key }) => (
      tg.storage.deleteBlob(key).catch((err) => {
        tg.util.log('orphan blob removal failed', err);
      })
    )));
    return;
  }

  await tg.storage.putRecord(buildCaptureKey(chatId, messageId), {
    ...storedRecord,
    media: mediaRefs,
  });
}

/** What a viewer row renders for a capture's media. */
export type AntiDeleteMediaResolution =
  | { status: 'available'; kind: AntiDeleteMediaRef['kind']; sizeBytes: number; blob: Blob }
  | { status: 'placeholder'; reason: 'neverCaptured' | 'evicted' };

/**
 * Resolves one capture's renderable media: reads the first stored media
 * ref's blob and reports presence. A record without media refs renders the
 * placeholder (`neverCaptured` — copy never succeeded), a ref whose blob no
 * longer reads renders it too (`evicted` — budget pressure removed it).
 * Pure seam over the storage read — the viewer test drives it without Teact.
 */
export async function resolveMediaResolution(
  getBlob: (key: string) => Promise<Blob | undefined>,
  capture: Pick<AntiDeleteCaptureRecord, 'media'>,
): Promise<AntiDeleteMediaResolution> {
  const firstRef = capture.media?.[0];
  if (firstRef === undefined) {
    return { status: 'placeholder', reason: 'neverCaptured' };
  }

  const blob = await getBlob(firstRef.key);
  if (blob === undefined) {
    return { status: 'placeholder', reason: 'evicted' };
  }

  return { status: 'available', kind: firstRef.kind, sizeBytes: firstRef.sizeBytes, blob };
}

/**
 * The viewer's inline-render kinds (object-URL `<img>`); the rest render
 * chips. A type guard, so the render switch narrows the kind union.
 */
export function isInlineMediaKind(kind: AntiDeleteMediaRef['kind']): kind is 'photo' | 'gif' {
  return kind === 'photo' || kind === 'gif';
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

/** Formats byte counts for the viewer's media chips, like a file manager line. */
export function formatMediaSize(sizeBytes: number): string {
  let size = sizeBytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const rounded = unitIndex === 0 ? size : Math.round(size * 10) / 10;
  return `${rounded} ${SIZE_UNITS[unitIndex]}`;
}

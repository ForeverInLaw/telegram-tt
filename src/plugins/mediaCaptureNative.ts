/**
 * Native media reads for `tg.api.fetchMessageMedia` (see runtime.ts). This
 * module statically imports the app's media helpers, whose module trees run
 * browser-only side effects at import time (`window.matchMedia` in the
 * component tree, service-worker setup in `mediaLoader`) — the vitest jsdom
 * environment provides neither, so runtime.ts imports this bridge lazily,
 * on the first `fetchMessageMedia` call, keeping the test surface clean.
 */
import { getGlobal } from '../global';

import type { ApiMessage } from '../api/types';
import type { SizeTarget } from '../api/types/messages';
import { ApiMediaFormat } from '../api/types';

import { MEDIA_CACHE_NAME } from '../config';
import { getMessageMediaHash } from '../global/helpers/messageMedia';
import { getMessageStatefulContent } from '../global/helpers/messages';
import * as cacheApi from '../util/cacheApi';
import { fetchBlob } from '../util/files';
import * as mediaLoader from '../util/mediaLoader';

/** The cache target holding the full bytes per captureable media kind. */
const FULL_BYTES_TARGET: Record<string, SizeTarget> = {
  photo: 'full',
  gif: 'download',
  sticker: 'full',
  document: 'full',
  audio: 'download',
  voice: 'download',
};

/**
 * Reads the message's primary media blob out of the media cache (or the
 * media loader's memory), prefetching video bytes for real while the file
 * reference is still alive. `undefined` means nothing to capture — the caller
 * degrades to a record-only capture.
 */
export async function fetchMessageMediaBlob(
  message: Readonly<ApiMessage>,
  mediaKind: 'photo' | 'gif' | 'sticker' | 'document' | 'video' | 'audio' | 'voice',
  shouldPrefetchVideo: boolean,
): Promise<Blob | undefined> {
  // The stateful content only matters for poll/story/webPage media, none of
  // which reach this call; resolving it keeps the hash helper honest anyway.
  const statefulContent = getMessageStatefulContent(getGlobal(), message);
  const target: SizeTarget = mediaKind === 'video'
    ? 'download'
    : FULL_BYTES_TARGET[mediaKind];
  const hash = getMessageMediaHash(message, statefulContent, target);
  if (hash === undefined) return undefined;

  if (mediaKind === 'video' && shouldPrefetchVideo) {
    return prefetchVideoBlob(hash);
  }

  // The cache read is the common path: the media was downloaded to render the
  // message the user saw disappear.
  const cached = await cacheApi.fetch(MEDIA_CACHE_NAME, hash, cacheApi.Type.Blob);
  if (cached !== undefined) return cached;

  // The memory cache holds prepared (blob URL) media for the open chat; a
  // blob URL resolves back to the bytes through `fetchBlob`.
  const prepared = mediaLoader.getFromMemory(hash);
  if (prepared !== undefined) {
    try {
      return await fetchBlob(prepared);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Downloads the video's bytes while the file reference is still valid. */
async function prefetchVideoBlob(hash: string): Promise<Blob | undefined> {
  try {
    // `mediaLoader.fetch` rides the app's own download pipeline (cache
    // first, remote behind it), so an already-cached video costs no traffic.
    const prepared = await mediaLoader.fetch(hash, ApiMediaFormat.BlobUrl);
    return await fetchBlob(prepared);
  } catch {
    return undefined;
  }
}

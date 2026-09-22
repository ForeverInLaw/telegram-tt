import type { TgStorageUsage } from '../types';

import { getSettings, updateSettings } from './settings';

/** Bytes per binary gigabyte; the budget slider's unit. */
const BYTES_PER_GB = 1024 ** 3;
/** Bytes per binary megabyte; the per-blob cap slider's unit. */
const BYTES_PER_MB = 1024 ** 2;

/** Spec slider bounds: the media budget moves between 1 and 50 GB. */
export const MIN_BUDGET_GB = 1;
export const MAX_BUDGET_GB = 50;
/** Spec slider bounds: the per-blob cap moves between 8 and 512 MB. */
export const MIN_PER_BLOB_CAP_MB = 8;
export const MAX_PER_BLOB_CAP_MB = 512;
/** Share of the origin quota the effective budget never exceeds (engine's own clamp). */
const QUOTA_SHARE = 0.5;

/** Byte sizes the compact formatter walks through, in ascending order. */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * The slider's maximum position in GB under the current quota: 50 GB or
 * 50% of the origin quota, whichever is lower — a low-quota environment
 * shows the clamped maximum instead of the spec ceiling.
 */
export function getBudgetSliderMaxGb(quotaBytes: number): number {
  return Math.max(MIN_BUDGET_GB, Math.min(MAX_BUDGET_GB, Math.floor((quotaBytes * QUOTA_SHARE) / BYTES_PER_GB)));
}

/** The budget slider's current position in GB, clamped to the slider's own bounds. */
export function readBudgetGb(budgetBytes: number, quotaBytes: number): number {
  return Math.max(MIN_BUDGET_GB, Math.min(getBudgetSliderMaxGb(quotaBytes), Math.floor(budgetBytes / BYTES_PER_GB)));
}

/** The per-blob cap slider's current position in MB, clamped to the slider's own bounds. */
export function readPerBlobCapMb(perBlobCapBytes: number): number {
  return Math.max(MIN_PER_BLOB_CAP_MB, Math.min(MAX_PER_BLOB_CAP_MB, Math.floor(perBlobCapBytes / BYTES_PER_MB)));
}

/** Formats bytes compactly for the usage bar (e.g. `4.6 GB`, `512 MB`, `700 KB`). */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return `0 ${SIZE_UNITS[0]}`;

  const unitIndex = Math.min(SIZE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const size = bytes / (1024 ** unitIndex);
  const isSingleDigit = size < 10;
  const formattedSize = isSingleDigit ? size.toFixed(1) : String(Math.round(size));
  return `${formattedSize} ${SIZE_UNITS[unitIndex]}`;
}

/** Percent of the budget the used bytes fill, for the usage bar's fill width. */
export function getUsagePercent(usage: TgStorageUsage): number {
  if (usage.budgetBytes <= 0) return 0;
  return Math.min(100, Math.round((usage.usedBytes / usage.budgetBytes) * 100));
}

/**
 * Applies a toggle from the settings panel: patches the persisted settings,
 * which the capture pipeline (bots), the ghost renderer (transparency) and
 * the media capture (video prefetch) read live from the settings cache.
 */
type ToggleKey = 'shouldCaptureBots' | 'shouldGhostBeTransparent' | 'shouldPrefetchVideos';

export function applyToggle(key: ToggleKey, value: boolean): void {
  updateSettings({ [key]: value });
}

/**
 * Applies a budget slider move: persists the chosen value in the plugin's
 * settings (so the slider position survives reloads) and pushes the bytes to
 * the engine, which clamps the effective budget to 50% of the quota at
 * runtime. Returns the written byte count.
 */
export function applyBudgetGb(gigabytes: number): number {
  const budgetBytes = gigabytes * BYTES_PER_GB;
  updateSettings({ budgetBytes });
  return budgetBytes;
}

/**
 * Applies a per-blob cap slider move: persists the chosen value in the
 * plugin's settings and pushes the bytes to the engine. Returns the written
 * byte count.
 */
export function applyPerBlobCapMb(megabytes: number): number {
  const perBlobCapBytes = megabytes * BYTES_PER_MB;
  updateSettings({ perBlobCapBytes });
  return perBlobCapBytes;
}

/**
 * Wipes the whole archive for the current account: every capture record and
 * every blob of this plugin. The storage slice scopes both calls to the
 * plugin's namespace, and the engine resets the shared usage accounting —
 * the usage bar reads zero on its next poll.
 */
export async function clearAllArchive(tg: {
  storage: {
    clearRecords: () => Promise<void>;
    clearBlobs: () => Promise<void>;
  };
}): Promise<void> {
  await Promise.all([tg.storage.clearRecords(), tg.storage.clearBlobs()]);
}

/** The panel's view of one storage usage snapshot plus the slider bounds derived from it. */
export interface AntiDeleteUsageView {
  usage: TgStorageUsage;
  /** Budget slider position in GB under the current settings and quota. */
  budgetGb: number;
  /** Budget slider maximum in GB under the current quota (clamped). */
  budgetSliderMaxGb: number;
  /** Per-blob cap slider position in MB. */
  perBlobCapMb: number;
}

/**
 * Builds the panel's whole view model from one usage snapshot: the usage bar
 * and both sliders' positions, the budget maximum clamped to 50% of the
 * quota so a low-quota environment shows its own ceiling.
 */
export function buildUsageView(usage: TgStorageUsage): AntiDeleteUsageView {
  const settings = getSettings();
  return {
    usage,
    budgetGb: readBudgetGb(settings.budgetBytes, usage.quotaBytes),
    budgetSliderMaxGb: getBudgetSliderMaxGb(usage.quotaBytes),
    perBlobCapMb: readPerBlobCapMb(settings.perBlobCapBytes),
  };
}

import type { Update } from '@tauri-apps/plugin-updater';
import type { RegularLangKey } from '../../types/language';

import { getActions } from '../../global';

import { createCallbackManager } from '../callbacks';

export type AppUpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready';

export type AppUpdateLastCheckResult = 'up-to-date' | 'update-found' | 'error';

export type AppUpdateState = {
  status: AppUpdateStatus;
  /** Outcome of the last manual check; silent (startup and periodic) checks do not change it. */
  lastCheckResult?: AppUpdateLastCheckResult;
  /** Message of the last failed check or download. */
  error?: string;
};

export type AppUpdateEvent =
  | { type: 'start-check' }
  | { type: 'no-update'; isManual?: boolean }
  | { type: 'update-found'; isManual?: boolean }
  | { type: 'downloaded' }
  | { type: 'download-failed'; error?: string; isManual?: boolean }
  | { type: 'reset' };

const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

const DEFAULT_UPDATE_ERROR = 'Update failed';

/** Maps the outcome of a settled manual check to the notification shown to the user. */
const MANUAL_CHECK_NOTIFICATION_KEYS = {
  'up-to-date': 'NoUpdatesAvailable',
  'update-found': 'UpdateAvailableNow',
  error: 'UpdateCheckFailed',
} satisfies Record<AppUpdateLastCheckResult, RegularLangKey>;

const INITIAL_APP_UPDATE_STATE: AppUpdateState = { status: 'idle' };

const updateStateCallbacks = createCallbackManager<(state: AppUpdateState) => void>();

let appUpdateState: AppUpdateState = INITIAL_APP_UPDATE_STATE;
let storedUpdate: Update | undefined;
let isInitialized = false;

/** Pure transition reducer of the update pipeline; unit-tested in `appUpdates.test.ts`. */
export function reduceAppUpdateStatus(state: AppUpdateState, event: AppUpdateEvent): AppUpdateState {
  switch (event.type) {
    case 'start-check':
      return { ...state, status: 'checking' };
    case 'no-update':
      return event.isManual
        ? { status: 'idle', lastCheckResult: 'up-to-date' }
        : { ...state, status: 'idle' };
    case 'update-found':
      return event.isManual
        ? { status: 'downloading', lastCheckResult: 'update-found' }
        : { ...state, status: 'downloading' };
    case 'downloaded':
      return { ...state, status: 'ready' };
    case 'download-failed': {
      const error = event.error ?? DEFAULT_UPDATE_ERROR;
      return event.isManual
        ? { status: 'idle', lastCheckResult: 'error', error }
        : { ...state, status: 'idle', error };
    }
    case 'reset':
      return INITIAL_APP_UPDATE_STATE;
  }
}

export function getAppUpdateState() {
  return appUpdateState;
}

export function subscribeToAppUpdates(callback: (state: AppUpdateState) => void) {
  return updateStateCallbacks.addCallback(callback);
}

/** Runs a silent check and silently downloads the update when one is found. */
export function checkForUpdates({ isManual }: { isManual?: boolean } = {}) {
  if (!window.tauri?.withUpdater || appUpdateState.status !== 'idle') return;

  dispatchAppUpdateEvent({ type: 'start-check' });
  void runUpdateCheck({ isManual });
}

/** Applies the update and relaunches the app; installing is always an explicit user action. */
export function installUpdate() {
  const update = storedUpdate;
  if (!update) return;

  const { status } = appUpdateState;
  if (status === 'checking' || status === 'downloading') return;

  if (status === 'ready') {
    void relaunchApp();
    return;
  }

  // A stored update that failed to download earlier: retry, then relaunch on success
  void downloadUpdate(update).then((isDownloaded) => {
    if (isDownloaded) void relaunchApp();
  });
}

/** Starts the silent check on startup, the periodic check and the tray-requested manual check. */
export function initAppUpdates() {
  if (isInitialized || !window.tauri?.withUpdater) return;
  isInitialized = true;

  checkForUpdates();
  setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);

  // The tray 'Check for updates' item (tauri/src/tray) asks the web side to run a manual check
  void import('@tauri-apps/api/event')
    .then(({ listen }) => {
      void listen('update-check-requested', () => {
        checkForUpdates({ isManual: true });
      });
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Failed to listen for update-check-requested', err);
    });
}

function dispatchAppUpdateEvent(event: AppUpdateEvent) {
  appUpdateState = reduceAppUpdateStatus(appUpdateState, event);
  updateStateCallbacks.runCallbacks(appUpdateState);
}

async function runUpdateCheck({ isManual }: { isManual?: boolean }) {
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();

    if (!update) {
      dispatchAppUpdateEvent({ type: 'no-update', isManual });
      if (isManual) notifyManualCheckResult('up-to-date');
      return;
    }

    storedUpdate = update;
    await downloadUpdate(update, isManual);
  } catch (err) {
    handleUpdateError(err, isManual);
  }
}

/** Downloads and installs the update, reporting the outcome through the state machine. */
async function downloadUpdate(update: Update, isManual?: boolean) {
  dispatchAppUpdateEvent({ type: 'update-found', isManual });
  if (isManual) notifyManualCheckResult('update-found');

  try {
    await update.downloadAndInstall();
    dispatchAppUpdateEvent({ type: 'downloaded' });
    return true;
  } catch (err) {
    handleUpdateError(err, isManual);
    return false;
  }
}

async function relaunchApp() {
  try {
    await window.tauri.relaunch();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to relaunch the app', err);
  }
}

function handleUpdateError(err: unknown, isManual?: boolean) {
  // eslint-disable-next-line no-console
  console.error('App update failed', err);
  dispatchAppUpdateEvent({
    type: 'download-failed',
    isManual,
    error: err instanceof Error ? err.message : String(err),
  });
  if (isManual) notifyManualCheckResult('error');
}

/** Shows the outcome of a settled manual check; silent checks never notify. */
function notifyManualCheckResult(result: AppUpdateLastCheckResult) {
  getActions().showNotification({
    message: { key: MANUAL_CHECK_NOTIFICATION_KEYS[result] },
  });
}

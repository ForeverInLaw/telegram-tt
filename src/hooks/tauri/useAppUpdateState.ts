import type { AppUpdateState } from '../../util/tauri/appUpdates';

import { useEffect, useState } from '../../lib/teact/teact';

import { getAppUpdateState, subscribeToAppUpdates } from '../../util/tauri/appUpdates';

/** Tracks the current app update state, re-rendering the component on every change. */
export default function useAppUpdateState(): AppUpdateState {
  const [appUpdateState, setAppUpdateState] = useState(getAppUpdateState);

  useEffect(() => (
    subscribeToAppUpdates(setAppUpdateState)
  ), []);

  return appUpdateState;
}

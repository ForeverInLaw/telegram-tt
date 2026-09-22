import type { PluginContext } from './context';
import type { TgPluginRuntime } from './runtime';
import type { TgPluginApi } from './types';

import { createApiSlice } from './slices/api';
import { createEventsSlice } from './slices/events';
import { createStorageSlice } from './slices/storage';
import { createStoreSlice } from './slices/store';
import { createUiSlice } from './slices/ui';
import { createUtilSlice } from './slices/util';

/**
 * Assembles the `tg` object a plugin receives in `setup(tg)`.
 * Every slice lives in its own file under src/plugins/slices and is
 * added here with a single line.
 */
export function buildTgApi(context: PluginContext, runtime: TgPluginRuntime): TgPluginApi {
  return {
    ui: createUiSlice(context, runtime),
    on: createEventsSlice(context),
    api: createApiSlice(context, runtime),
    store: createStoreSlice(context, runtime),
    util: createUtilSlice(context, runtime),
    storage: createStorageSlice(context, runtime),
  };
}

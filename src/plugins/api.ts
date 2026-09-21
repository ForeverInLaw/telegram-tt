import type { PluginContext } from './context';
import type { TgPluginApi } from './types';

import { createEventsSlice } from './slices/events';
import { createUiSlice } from './slices/ui';

/**
 * Assembles the `tg` object a plugin receives in `setup(tg)`.
 * Every slice lives in its own file under src/plugins/slices and is
 * added here with a single line.
 */
export function buildTgApi(context: PluginContext): TgPluginApi {
  return {
    ui: createUiSlice(context),
    on: createEventsSlice(context),
  };
}

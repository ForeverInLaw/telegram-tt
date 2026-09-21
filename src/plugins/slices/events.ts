import type { PluginContext } from '../context';
import type { TgEventName, TgEventPayloads, TgPluginApi } from '../types';

import { removePluginEventHandlers, subscribePluginEvent } from '../events';

/**
 * Events slice: `tg.on(event, handler)`. Registers through the plugin event
 * bus (src/plugins/events.ts) with the plugin's context, so every handler is
 * error-contained and bulk-removed when the plugin is disabled.
 */
export function createEventsSlice(context: PluginContext): TgPluginApi['on'] {
  const { pluginName, onTeardown } = context;
  onTeardown(() => removePluginEventHandlers(pluginName));

  return <Event extends TgEventName>(
    event: Event,
    handler: (payload: TgEventPayloads[Event]) => void,
  ) => subscribePluginEvent(event, handler, context);
}

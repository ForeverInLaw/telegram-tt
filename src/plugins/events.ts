/**
 * Plugin event bus. A pure module: the host injects the runtime's primitive
 * streams (raw store updates and store-change notifications, provided by
 * src/plugins/runtime.ts) and this module maps them onto the plugin-facing
 * `tg.on` events defined in src/plugins/types.ts.
 */
import type { PluginContext } from './context';
import type { TgPluginRuntime } from './runtime';
import type { TgEventName, TgEventPayloads } from './types';

/** Payload union across all events. */
type AnyEventPayload = TgEventPayloads[TgEventName];

/** One subscription: the wrapped handler plus the plugin that owns it. */
type EventHandlerEntry = {
  pluginName: string;
  /** Wrapped through the owning plugin's reporter, so a throw is logged and contained. */
  run: (payload: AnyEventPayload) => void;
};

const handlersByEvent = new Map<TgEventName, Set<EventHandlerEntry>>();

let streamUnsubscribers: (() => void)[] = [];
let lastChatId: string | undefined;

/**
 * Subscribes the runtime's streams once and maps their output onto plugin
 * events. Idempotent: previous streams are disposed first, so a host re-init
 * never double-delivers.
 */
export function initEventStreams(runtime: TgPluginRuntime) {
  disposeEventStreams();
  // Baseline the active chat so the first emission happens only on a real change.
  lastChatId = runtime.getActiveChatId();

  streamUnsubscribers = [
    runtime.subscribeApiUpdates((update) => {
      // This handler runs in the same `'apiUpdate'` dispatch as the native
      // reducers and may run before them, so payloads are mapped from the
      // update object, never from store reads.
      switch (update['@type']) {
        case 'newMessage':
          emitPluginEvent('message:new', {
            chatId: update.chatId,
            messageId: update.id,
            message: update.message,
          });
          break;
        case 'updateMessage':
          emitPluginEvent('message:edited', {
            chatId: update.chatId,
            messageId: update.id,
            // The source update carries only the updated fields, so `message` is partial.
            message: update.message,
          });
          break;
        case 'deleteMessages': {
          const isLocal = update.isLocal ?? false;
          // `deleteScheduledMessages` is a separate update type, so scheduled
          // cancellations never reach this event by design.
          emitPluginEvent('message:deleted', {
            source: update.source ?? 'delete',
            items: update.ids.map((messageId) => ({
              // Common-box updates carry no chatId; the runtime resolves each
              // id's chat from the store, which still holds the message at
              // this point of the dispatch.
              chatId: update.chatId ?? runtime.getCommonBoxChatId(messageId),
              messageId,
              isLocal,
            })),
          });
          break;
        }
      }
    }),
    runtime.subscribeToStoreChanges(() => {
      // Store-change notifications are throttled to tick end and deferred
      // during heavy animations, so `chat:opened` can lag the navigation.
      const chatId = runtime.getActiveChatId();
      if (chatId === lastChatId) return;

      lastChatId = chatId;
      emitPluginEvent('chat:opened', { chatId });
    }),
  ];
}

/** Unsubscribes the runtime streams; emissions stop until the next init. */
export function disposeEventStreams() {
  for (const unsubscribe of streamUnsubscribers) {
    unsubscribe();
  }
  streamUnsubscribers = [];
}

/**
 * Fan-out to every subscriber of one event. Handlers run through their owner's
 * `wrap`, so a throwing handler is logged with its plugin name and the other
 * subscribers still receive.
 */
export function emitPluginEvent<Event extends TgEventName>(name: Event, payload: TgEventPayloads[Event]) {
  const handlers = handlersByEvent.get(name);
  if (!handlers) return;

  // Copy: a handler may unsubscribe (itself or others) during dispatch.
  for (const entry of [...handlers]) {
    entry.run(payload);
  }
}

/** Registers one handler for a plugin; returns its unsubscribe function. */
export function subscribePluginEvent<Event extends TgEventName>(
  event: Event,
  handler: (payload: TgEventPayloads[Event]) => void,
  context: PluginContext,
): () => void {
  const wrapped = context.wrap(handler);
  // Handlers are stored type-erased; the event/handler pairing is checked at this boundary.
  const entry: EventHandlerEntry = {
    pluginName: context.pluginName,
    run: (payload) => wrapped(payload as TgEventPayloads[Event]),
  };

  getOrCreateHandlers(event).add(entry);

  return () => {
    handlersByEvent.get(event)?.delete(entry);
  };
}

/** Removes every handler one plugin registered, across all events. */
export function removePluginEventHandlers(pluginName: string) {
  for (const handlers of handlersByEvent.values()) {
    for (const entry of handlers) {
      if (entry.pluginName === pluginName) {
        handlers.delete(entry);
      }
    }
  }
}

/** Introspection helper for tests: the total number of registered handlers. */
export function countPluginEventHandlers(): number {
  let total = 0;
  for (const handlers of handlersByEvent.values()) {
    total += handlers.size;
  }
  return total;
}

function getOrCreateHandlers(event: TgEventName): Set<EventHandlerEntry> {
  let handlers = handlersByEvent.get(event);
  if (!handlers) {
    handlers = new Set();
    handlersByEvent.set(event, handlers);
  }
  return handlers;
}

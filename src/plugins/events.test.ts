import { afterEach, describe, expect, it } from 'vitest';

import type { ApiMessage, ApiUpdate } from '../api/types';
import type { PluginContext } from './context';
import type { TgPluginRuntime } from './runtime';
import type { TgChatOpenedPayload, TgPluginApi } from './types';

import { buildTgApi } from './api';
import { createPluginContext } from './context';
import {
  countPluginEventHandlers, disposeEventStreams, initEventStreams, removePluginEventHandlers,
} from './events';

type CapturedError = { pluginName: string; action: string; error: unknown };

const TEST_PLUGIN_NAMES = ['alpha', 'beta'];

/**
 * In-memory runtime double: the plugin layer only needs primitive streams.
 * `emitApiUpdate` / `notifyStoreChange` drive the exact seams the production
 * runtime subscribes to (the `'apiUpdate'` action handler and the global
 * change callback), so this suite never imports src/global.
 */
function createFakeRuntime(activeChatId?: string) {
  const capturedErrors: CapturedError[] = [];
  const apiUpdateListeners = new Set<(update: ApiUpdate) => void>();
  const storeChangeListeners = new Set<() => void>();
  let currentChatId = activeChatId;

  const runtime: TgPluginRuntime = {
    isPluginEnabled: () => true,
    setPluginEnabled: () => {},
    subscribeApiUpdates: (listener) => {
      apiUpdateListeners.add(listener);
      return () => {
        apiUpdateListeners.delete(listener);
      };
    },
    subscribeToStoreChanges: (listener) => {
      storeChangeListeners.add(listener);
      return () => {
        storeChangeListeners.delete(listener);
      };
    },
    getActiveChatId: () => currentChatId,
    // Facade services are stubbed out; the events suite never dispatches them
    getActions: () => {
      throw new Error('not exercised');
    },
    getCurrentTabId: () => 0,
    mainThreadId: -1,
    getActiveMessageList: () => undefined,
    getCurrentUserId: () => undefined,
    getChat: () => undefined,
    getLocalizedString: (key) => key,
    createPluginReporter: (pluginName) => ({
      log: () => {},
      logError: (action, error) => {
        capturedErrors.push({ pluginName, action, error });
      },
      wrap: (callback) => (...args) => {
        try {
          callback(...args);
        } catch (error) {
          capturedErrors.push({ pluginName, action: 'callback failed', error });
        }
      },
    }),
  };

  return {
    runtime,
    capturedErrors,
    emitApiUpdate: (update: ApiUpdate) => {
      for (const listener of apiUpdateListeners) {
        listener(update);
      }
    },
    notifyStoreChange: () => {
      for (const listener of storeChangeListeners) {
        listener();
      }
    },
    /** Sets the active chat and notifies a store change, like `openChat` would. */
    setActiveChatId: (chatId: string | undefined) => {
      currentChatId = chatId;
      for (const listener of storeChangeListeners) {
        listener();
      }
    },
  };
}

type FakeRuntime = ReturnType<typeof createFakeRuntime>;

/** One plugin lifetime: the context and `tg` object the host builds for it. */
function createPluginLifetime(pluginName: string, fake: FakeRuntime): { context: PluginContext; tg: TgPluginApi } {
  const context = createPluginContext(pluginName, fake.runtime.createPluginReporter(pluginName));
  return { context, tg: buildTgApi(context, fake.runtime) };
}

/** Minimal ApiUpdate-shaped fixtures; only the mapped fields matter to the bus. */
function createMessage(id: number): ApiMessage {
  return { id, chatId: '100' } as ApiMessage;
}

function createNewMessageUpdate(id: number): ApiUpdate {
  return {
    '@type': 'newMessage',
    chatId: '100',
    id,
    message: createMessage(id),
  };
}

function createUpdateMessageUpdate(id: number): ApiUpdate {
  return {
    '@type': 'updateMessage',
    chatId: '100',
    id,
    isFull: false,
    // The source update may carry only the edited fields.
    message: { isEdited: true },
  };
}

afterEach(() => {
  disposeEventStreams();
  for (const pluginName of TEST_PLUGIN_NAMES) {
    removePluginEventHandlers(pluginName);
  }
});

describe('plugin events: message events', () => {
  it('delivers message:new with the payload mapped from a newMessage update', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const received: { chatId: string; messageId: number; message: ApiMessage }[] = [];
    tg.on('message:new', (payload) => {
      received.push(payload);
    });

    fake.emitApiUpdate(createNewMessageUpdate(501));

    expect(received).toEqual([{
      chatId: '100',
      messageId: 501,
      message: createMessage(501),
    }]);
  });

  it('delivers message:edited with the partial message from an updateMessage update', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const received: { chatId: string; messageId: number; message: Partial<ApiMessage> }[] = [];
    tg.on('message:edited', (payload) => {
      received.push(payload);
    });

    fake.emitApiUpdate(createUpdateMessageUpdate(502));

    expect(received).toEqual([{
      chatId: '100',
      messageId: 502,
      message: { isEdited: true },
    }]);
  });

  it('delivers message:deleted with ids and the optional chatId from a deleteMessages update', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const received: { chatId: string | undefined; messageIds: number[] }[] = [];
    tg.on('message:deleted', (payload) => {
      received.push(payload);
    });

    fake.emitApiUpdate({ '@type': 'deleteMessages', ids: [7, 8, 9] });
    fake.emitApiUpdate({ '@type': 'deleteMessages', ids: [1], chatId: '100' });

    expect(received).toEqual([
      { chatId: undefined, messageIds: [7, 8, 9] },
      { chatId: '100', messageIds: [1] },
    ]);
  });

  it('delivers one update to every subscriber of the same event', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const alpha = createPluginLifetime('alpha', fake).tg;
    const beta = createPluginLifetime('beta', fake).tg;

    const deliveries: string[] = [];
    alpha.on('message:new', () => {
      deliveries.push('alpha');
    });
    beta.on('message:new', () => {
      deliveries.push('beta');
    });

    fake.emitApiUpdate(createNewMessageUpdate(1));

    expect(deliveries).toEqual(['alpha', 'beta']);
  });

  it('ignores updates that map to no plugin event', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    let deliveries = 0;
    tg.on('message:new', () => {
      deliveries += 1;
    });

    fake.emitApiUpdate({ '@type': 'deleteHistory', chatId: '100' });

    expect(deliveries).toBe(0);
  });
});

describe('plugin events: unsubscribe', () => {
  it('stops delivery for that handler after the returned unsubscribe is called', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const deliveries: number[] = [];
    const unsubscribe = tg.on('message:new', ({ messageId }) => {
      deliveries.push(messageId);
    });

    fake.emitApiUpdate(createNewMessageUpdate(1));
    unsubscribe();
    fake.emitApiUpdate(createNewMessageUpdate(2));

    expect(deliveries).toEqual([1]);
    expect(countPluginEventHandlers()).toBe(0);
  });

  it('only removes the unsubscribed handler, not the plugin\'s other handlers', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const deliveries: string[] = [];
    const unsubscribeFirst = tg.on('message:new', () => {
      deliveries.push('first');
    });
    tg.on('message:new', () => {
      deliveries.push('second');
    });

    unsubscribeFirst();
    fake.emitApiUpdate(createNewMessageUpdate(1));

    expect(deliveries).toEqual(['second']);
    expect(countPluginEventHandlers()).toBe(1);
  });

  it('keeps delivering to other plugins after one plugin unsubscribes', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const alpha = createPluginLifetime('alpha', fake).tg;
    const beta = createPluginLifetime('beta', fake).tg;

    const deliveries: string[] = [];
    const unsubscribeAlpha = alpha.on('message:new', () => {
      deliveries.push('alpha');
    });
    beta.on('message:new', () => {
      deliveries.push('beta');
    });

    unsubscribeAlpha();
    fake.emitApiUpdate(createNewMessageUpdate(1));

    expect(deliveries).toEqual(['beta']);
  });
});

describe('plugin events: teardown on disable', () => {
  it('removes every handler a plugin registered across all events', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const deliveries: string[] = [];
    tg.on('message:new', () => {
      deliveries.push('alpha:new');
    });
    tg.on('message:edited', () => {
      deliveries.push('alpha:edited');
    });
    tg.on('chat:opened', () => {
      deliveries.push('alpha:chat');
    });

    removePluginEventHandlers('alpha');

    fake.emitApiUpdate(createNewMessageUpdate(1));
    fake.emitApiUpdate(createUpdateMessageUpdate(1));
    fake.setActiveChatId('100');

    expect(deliveries).toEqual([]);
    expect(countPluginEventHandlers()).toBe(0);
  });

  it('leaves other plugins\' deliveries untouched when one plugin is disabled', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const alpha = createPluginLifetime('alpha', fake).tg;
    const beta = createPluginLifetime('beta', fake).tg;

    const deliveries: string[] = [];
    alpha.on('message:new', () => {
      deliveries.push('alpha');
    });
    beta.on('message:new', () => {
      deliveries.push('beta');
    });

    removePluginEventHandlers('alpha');
    fake.emitApiUpdate(createNewMessageUpdate(1));

    expect(deliveries).toEqual(['beta']);
    expect(countPluginEventHandlers()).toBe(1);
  });

  it('stops deliveries through the teardown the events slice registers on the context', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { context, tg } = createPluginLifetime('alpha', fake);

    const deliveries: number[] = [];
    tg.on('message:new', ({ messageId }) => {
      deliveries.push(messageId);
    });

    // What `disablePlugin` does after the plugin's own disposer.
    context.runTeardowns();
    fake.emitApiUpdate(createNewMessageUpdate(1));

    expect(deliveries).toEqual([]);
    expect(countPluginEventHandlers()).toBe(0);
  });
});

describe('plugin events: error containment', () => {
  it('logs a throwing handler with its plugin name and keeps other subscribers receiving', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const alpha = createPluginLifetime('alpha', fake).tg;
    const beta = createPluginLifetime('beta', fake).tg;

    const boomError = new Error('handler boom');
    alpha.on('message:new', () => {
      throw boomError;
    });
    const betaDeliveries: number[] = [];
    beta.on('message:new', ({ messageId }) => {
      betaDeliveries.push(messageId);
    });

    expect(() => fake.emitApiUpdate(createNewMessageUpdate(42))).not.toThrow();

    expect(fake.capturedErrors).toEqual([
      { pluginName: 'alpha', action: 'callback failed', error: boomError },
    ]);
    expect(betaDeliveries).toEqual([42]);
  });

  it('still delivers when a handler unsubscribes a sibling handler mid-emit', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const alpha = createPluginLifetime('alpha', fake).tg;
    const beta = createPluginLifetime('beta', fake).tg;

    const betaDeliveries: number[] = [];
    alpha.on('message:new', () => {
      // Mutating the handler set mid-emit must not break the in-flight fan-out.
      removePluginEventHandlers('beta');
    });
    beta.on('message:new', ({ messageId }) => {
      betaDeliveries.push(messageId);
    });

    expect(() => fake.emitApiUpdate(createNewMessageUpdate(5))).not.toThrow();

    // The emit snapshot was taken before the mutation, so beta receives this one.
    expect(betaDeliveries).toEqual([5]);
    expect(countPluginEventHandlers()).toBe(1);
  });
});

describe('plugin events: chat:opened', () => {
  it('emits on active chat change with the new chat id, not on unrelated changes', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const received: TgChatOpenedPayload[] = [];
    tg.on('chat:opened', (payload) => {
      received.push(payload);
    });

    fake.setActiveChatId('100');
    fake.notifyStoreChange(); // unrelated store change: active chat still '100'
    fake.setActiveChatId('200');
    fake.setActiveChatId(undefined);

    expect(received).toEqual([
      { chatId: '100' },
      { chatId: '200' },
      { chatId: undefined },
    ]);
  });

  it('does not emit at init time for the already-open chat', () => {
    const fake = createFakeRuntime('100');
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    let deliveries = 0;
    tg.on('chat:opened', () => {
      deliveries += 1;
    });

    fake.notifyStoreChange();

    expect(deliveries).toBe(0);
  });

  it('does not emit for a store change that leaves the active chat as it was', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    fake.setActiveChatId('100'); // opens before this plugin subscribed: no replay

    const { tg } = createPluginLifetime('alpha', fake);
    const received: TgChatOpenedPayload[] = [];
    tg.on('chat:opened', (payload) => {
      received.push(payload);
    });

    fake.setActiveChatId('100');

    expect(received).toEqual([]);
  });
});

describe('plugin events: init and dispose', () => {
  it('disposes previous streams on re-init and does not double-deliver', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const messageDeliveries: number[] = [];
    const chatDeliveries: TgChatOpenedPayload[] = [];
    tg.on('message:new', ({ messageId }) => {
      messageDeliveries.push(messageId);
    });
    tg.on('chat:opened', (payload) => {
      chatDeliveries.push(payload);
    });

    fake.emitApiUpdate(createNewMessageUpdate(1));
    fake.setActiveChatId('300');

    expect(messageDeliveries).toEqual([1]);
    expect(chatDeliveries).toEqual([{ chatId: '300' }]);
  });

  it('stops delivering after the streams are disposed', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const deliveries: number[] = [];
    tg.on('message:new', ({ messageId }) => {
      deliveries.push(messageId);
    });

    disposeEventStreams();
    fake.emitApiUpdate(createNewMessageUpdate(2));

    expect(deliveries).toEqual([]);
  });

  it('re-baselines the active chat on re-init, so no chat:opened replay occurs', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);
    fake.setActiveChatId('100');
    initEventStreams(fake.runtime);
    const { tg } = createPluginLifetime('alpha', fake);

    const received: TgChatOpenedPayload[] = [];
    tg.on('chat:opened', (payload) => {
      received.push(payload);
    });

    fake.notifyStoreChange();

    expect(received).toEqual([]);
  });

  it('delivers again after handlers were re-registered on re-enable', () => {
    const fake = createFakeRuntime();
    initEventStreams(fake.runtime);

    let deliveries = 0;
    createPluginLifetime('alpha', fake).tg.on('message:new', () => {
      deliveries += 1;
    });

    removePluginEventHandlers('alpha');
    createPluginLifetime('alpha', fake).tg.on('message:new', () => {
      deliveries += 1;
    });

    fake.emitApiUpdate(createNewMessageUpdate(1));

    expect(deliveries).toBe(1);
    expect(countPluginEventHandlers()).toBe(1);
  });
});

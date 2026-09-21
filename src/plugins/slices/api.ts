import type { MessageList, ThreadId } from '../../types';
import type { PluginContext } from '../context';
import type { TgPluginRuntime } from '../runtime';
import type { TgPluginApi } from '../types';

/**
 * Action-facade slice: thin, fire-and-forget wrappers over the app's own
 * store actions. Stays pure — every app service arrives through the runtime.
 */
export function createApiSlice(context: PluginContext, runtime: TgPluginRuntime): TgPluginApi['api'] {
  const reporter = runtime.createPluginReporter(context.pluginName);

  // Facade calls are contained: a guard rejection or a throwing action logs
  // with the plugin name and never breaks the client.
  const runContained = (actionName: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      reporter.logError(`api.${actionName}`, error);
    }
  };

  return {
    sendMessage: (chatId, text, options) => runContained('sendMessage', () => {
      if (!runtime.getChat(chatId)) {
        reporter.logError('api.sendMessage', new Error(`chat ${chatId} is not in the store`));
        return;
      }

      const threadId = options?.threadId ?? runtime.mainThreadId;
      runtime.getActions().sendMessage({
        messageList: buildThreadMessageList(chatId, threadId),
        text,
        tabId: runtime.getCurrentTabId(),
      });
    }),
    editMessage: (chatId, messageId, text) => runContained('editMessage', () => {
      const activeMessageList = runtime.getActiveMessageList();
      if (activeMessageList?.chatId !== chatId) {
        reporter.logError(
          'api.editMessage',
          new Error(`only the open chat can be edited (chat ${chatId} is not open)`),
        );
        return;
      }

      // The app's `editMessage` action edits the message the open thread's
      // editing state points at, so the facade sets that state first.
      const tabId = runtime.getCurrentTabId();
      const actions = runtime.getActions();
      actions.setEditingId({ messageId, tabId });
      actions.editMessage({ messageList: activeMessageList, text, tabId });
    }),
    deleteMessages: (chatId, messageIds, options) => runContained('deleteMessages', () => {
      if (!runtime.getChat(chatId)) {
        reporter.logError('api.deleteMessages', new Error(`chat ${chatId} is not in the store`));
        return;
      }

      runtime.getActions().deleteMessages({
        messageIds,
        // The handler falls back to the currently open chat without an explicit list
        messageList: buildThreadMessageList(chatId, runtime.mainThreadId),
        shouldDeleteForAll: options?.shouldDeleteForAll,
        tabId: runtime.getCurrentTabId(),
      });
    }),
    setReaction: (chatId, messageId, emoticon) => runContained('setReaction', () => {
      runtime.getActions().toggleReaction({
        chatId,
        messageId,
        reaction: { type: 'emoji', emoticon },
        tabId: runtime.getCurrentTabId(),
      });
    }),
    openChat: (chatId) => runContained('openChat', () => {
      runtime.getActions().openChat({ id: chatId, tabId: runtime.getCurrentTabId() });
    }),
  };
}

function buildThreadMessageList(chatId: string, threadId: ThreadId): MessageList {
  return { chatId, threadId, type: 'thread' };
}

import type { PluginContext } from '../context';
import type { TgPluginRuntime } from '../runtime';
import type { TgPluginApi } from '../types';

/**
 * Store slice: read-only access to plain store data. Never exposes store
 * handles, so plugin code cannot mutate the app's state.
 */
export function createStoreSlice(context: PluginContext, runtime: TgPluginRuntime): TgPluginApi['store'] {
  const reporter = runtime.createPluginReporter(context.pluginName);

  // Reads are contained: a throwing getter logs with the plugin name and
  // yields `undefined` instead of breaking the caller.
  const readContained = <T>(readName: string, read: () => T): T | undefined => {
    try {
      return read();
    } catch (error) {
      reporter.logError(`store.${readName}`, error);
      return undefined;
    }
  };

  return {
    getActiveChatId: () => readContained('getActiveChatId', () => runtime.getActiveChatId()),
    getCurrentUserId: () => readContained('getCurrentUserId', () => runtime.getCurrentUserId()),
    getChat: (chatId) => readContained('getChat', () => runtime.getChat(chatId)),
    getUser: (userId) => readContained('getUser', () => runtime.getUser(userId)),
    getMessage: (chatId, messageId) => readContained('getMessage', () => runtime.getMessage(chatId, messageId)),
  };
}

import { definePlugin } from '../types';

/**
 * Example plugin: adds an "Echo reply" item to the message context menu that
 * sends a canned reply to the message's chat, combining the action facade
 * (`tg.api`), the store reads (`tg.store`) and `tg.util` logging.
 */
export default definePlugin({
  name: 'echo-plugin',
  version: '0.1.0',
  description: 'Replies to any message with a canned echo text.',
  // Demo plugin: off until the user enables it in Settings → Plugins
  isEnabledByDefault: false,
  setup(tg) {
    tg.ui.addMessageContextMenuItem({
      icon: 'reply',
      label: 'Echo reply',
      onClick: (message) => {
        const activeChatId = tg.store.getActiveChatId();

        // Echoing your own messages would look broken, so skip them
        if (message.senderId === tg.store.getCurrentUserId()) {
          tg.util.log('skipped own message', message.id);
          return;
        }

        tg.util.log('echoing message', message.id, 'to chat', message.chatId, '(active chat:', activeChatId, ')');
        tg.api.sendMessage(message.chatId, `Echo! (sent while chat ${activeChatId ?? 'none'} was open)`);
      },
    });
  },
});

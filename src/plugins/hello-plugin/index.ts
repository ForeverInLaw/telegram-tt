import { definePlugin } from '../types';

/**
 * Showcase plugin for the contract documented in `src/plugins/README.md`: one
 * minimal, runnable use of every surface — `tg.ui`, `tg.on`, `tg.api`,
 * `tg.store` and `tg.util`. Each README snippet has a counterpart in this file.
 */
export default definePlugin({
  name: 'hello-plugin',
  version: '0.2.0',
  description: 'Runnable showcase of the plugin contract — see src/plugins/README.md.',
  // Demo plugin: off until the user enables it in Settings → Plugins
  isEnabledByDefault: false,
  setup(tg) {
    // Store reads happen outside event handlers; handlers trust their payload
    const currentUserId = tg.store.getCurrentUserId();

    tg.ui.addMessageContextMenuItem({
      icon: 'heart',
      label: 'Plugin demo',
      onClick: (message) => {
        const chat = tg.store.getChat(message.chatId);
        tg.util.log('toggling a reaction in', chat?.title ?? message.chatId);
        // Toggles: the same call sets the reaction and removes it again
        tg.api.setReaction(message.chatId, message.id, '👍');
        tg.ui.showNotification({ message: tg.util.getLocalizedString('Done') });
      },
    });

    const unsubscribe = tg.on('message:new', ({ chatId, messageId, message }) => {
      tg.util.log('message:new', { chatId, messageId, isOwn: message.senderId === currentUserId });
    });

    return () => {
      unsubscribe();
      tg.util.log('torn down');
    };
  },
});

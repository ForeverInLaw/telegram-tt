import { definePlugin } from '../types';

/**
 * Demo plugin for every plugin UI surface: a chat context-menu item, a main
 * ("burger") menu entry, a composer bar button and in-app notifications.
 * Each contribution surfaces a notification so the whole chain is visible.
 */
export default definePlugin({
  name: 'ui-demo-plugin',
  version: '0.1.0',
  description: 'Adds demo items to the chat context menu, main menu and composer bar.',
  setup(tg) {
    tg.ui.addChatContextMenuItem({
      icon: 'lamp',
      label: 'Plugin demo (chat)',
      onClick: (chat) => {
        tg.util.log('chat', chat.id);
        tg.ui.showNotification({
          title: 'ui-demo-plugin',
          message: `Triggered from the chat context menu (chatId: ${chat.id})`,
          icon: 'lamp',
        });
      },
    });

    tg.ui.addMainMenuItem({
      icon: 'star',
      label: 'Plugin demo (main menu)',
      onClick: () => {
        tg.ui.showNotification({
          title: 'ui-demo-plugin',
          message: 'Triggered from the main menu',
          duration: 5000,
        });
      },
    });

    tg.ui.addComposerButton({
      icon: 'message',
      label: 'Plugin demo (composer)',
      onClick: ({ chatId, threadId }) => {
        tg.ui.showNotification({
          message: `Triggered from the composer (chatId: ${chatId}, threadId: ${threadId})`,
        });
      },
    });
  },
});

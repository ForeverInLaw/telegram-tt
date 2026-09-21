import { definePlugin } from '../types';

/**
 * Example plugin: adds a debug item to the message context menu.
 * Drop new plugins as sibling folders with an index.ts — they are
 * picked up automatically by src/plugins/host.ts.
 */
export default definePlugin({
  name: 'hello-plugin',
  version: '0.1.0',
  description: 'Adds a debug item to the message context menu.',
  setup(tg) {
    tg.ui.addMessageContextMenuItem({
      icon: 'bug',
      label: 'Plugin demo',
      onClick: (message) => {
        // eslint-disable-next-line no-console
        console.log('[hello-plugin] message', message);
        window.alert(`Plugin demo!\n\nmessageId: ${message.id}\nchatId: ${message.chatId}`);
      },
    });

    return () => {
      // eslint-disable-next-line no-console
      console.log('[hello-plugin] torn down');
    };
  },
});

import type { TgPlugin, TgPluginApi } from './types';
import { registerMessageContextMenuItem } from './registry';

/**
 * Every folder under src/plugins with an index.ts file is a plugin:
 * it must default-export a TgPlugin ({ name, setup(tg) }).
 * Hot-reloaded by Vite like the rest of the app.
 */
const modules = import.meta.glob('./*/index.ts', { eager: true }) as Record<
  string, { default: TgPlugin }
>;

// eslint-disable-next-line no-console
const log = (...args: unknown[]) => console.log('%c[plugins]', 'color:#40bfc4', ...args);

export function initPlugins() {
  for (const [path, module] of Object.entries(modules)) {
    const plugin = module.default;

    if (!plugin || typeof plugin.setup !== 'function') {
      log(`skipped ${path}: no default TgPlugin export`);
      continue;
    }

    const tg: TgPluginApi = {
      ui: {
        addMessageContextMenuItem: (item) => registerMessageContextMenuItem(plugin.name, item),
      },
    };

    try {
      plugin.setup(tg);
      log(`loaded ${plugin.name}${plugin.version ? `@${plugin.version}` : ''}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[plugins] ${plugin.name} setup failed:`, error);
    }
  }
}

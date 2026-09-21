import type { PluginContext } from '../context';
import type { TgPluginRuntime } from '../runtime';
import type { TgPluginApi } from '../types';

/** Utility slice: namespaced logging and the app's localized strings. */
export function createUtilSlice(context: PluginContext, runtime: TgPluginRuntime): TgPluginApi['util'] {
  const reporter = runtime.createPluginReporter(context.pluginName);

  return {
    // The reporter prefixes every line with the plugin name, so plugin logs
    // are distinguishable in the shared console.
    log: (...args) => {
      const message = args.map(formatLogArg).join(' ');
      reporter.log(message);
    },
    getLocalizedString: (key, variables) => {
      try {
        return runtime.getLocalizedString(key, variables);
      } catch (error) {
        // The raw key is the most useful fallback a caller can render
        reporter.logError('util.getLocalizedString', error);
        return key;
      }
    },
  };
}

function formatLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  return JSON.stringify(arg) ?? String(arg);
}

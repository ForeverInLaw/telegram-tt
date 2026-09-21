import type { TgPluginReporter } from './runtime';

/**
 * Per-plugin plumbing the host builds for one enabled lifetime.
 * Slice builders receive it and register their cleanup through
 * `onTeardown`, so disabling a plugin clears every slice's state.
 */
export interface PluginContext {
  pluginName: string;
  /** Wraps a plugin callback so a throw is logged and contained. */
  wrap: TgPluginReporter['wrap'];
  /** Schedules a cleanup fn to run when the plugin is disabled. */
  onTeardown: (teardown: () => void) => void;
  /** Runs and clears all teardown fns; a throwing fn is logged and skipped. */
  runTeardowns: () => void;
}

export function createPluginContext(pluginName: string, reporter: TgPluginReporter): PluginContext {
  const teardowns: (() => void)[] = [];

  return {
    pluginName,
    wrap: reporter.wrap,
    onTeardown: (teardown) => {
      teardowns.push(teardown);
    },
    runTeardowns: () => {
      const pendingTeardowns = teardowns.splice(0);
      for (const teardown of pendingTeardowns) {
        try {
          teardown();
        } catch (error) {
          reporter.logError('teardown failed', error);
        }
      }
    },
  };
}

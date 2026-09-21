/**
 * Plugin lifecycle host. Loads every plugin folder under src/plugins,
 * runs or skips `setup` based on the persisted enabled state, and exposes
 * runtime toggling for the Settings screen.
 *
 * src/plugins is a leaf layer: it never imports from src/global or src/api
 * (only the reverse direction, app UI importing from src/plugins, is legal).
 * All environment services arrive through `TgPluginRuntime` (src/plugins/runtime.ts),
 * so the lifecycle is testable with a fake runtime.
 */
import type { PluginContext } from './context';
import type { TgPluginReporter, TgPluginRuntime } from './runtime';
import type { TgPlugin } from './types';

import { buildTgApi } from './api';
import { createPluginContext } from './context';

/** A discovered plugin module: any folder with an `index.ts` default export. */
type PluginModuleMap = Record<string, { default?: unknown }>;

const modules: PluginModuleMap = import.meta.glob('./*/index.ts', { eager: true });

/** Plain data for the Settings screen; stable references until plugins are toggled. */
export interface TgPluginInfo {
  name: string;
  version?: string;
  description?: string;
  isEnabled: boolean;
}

/** Everything an enabled plugin owns: a fresh `tg` slice set plus the setup disposer. */
type EnabledPlugin = {
  context: PluginContext;
  disposer?: () => void;
};

const loadedPlugins = new Map<string, TgPlugin>();
const enabledPlugins = new Map<string, EnabledPlugin>();
let pluginList: TgPluginInfo[] = [];

// Runtime provided by the app entry at boot; Settings closes over it via `togglePlugin`.
let activeRuntime: TgPluginRuntime | undefined;

// eslint-disable-next-line no-console
const log = (...args: unknown[]) => console.log('%c[plugins]', 'color:#40bfc4', ...args);

/** Loads every discovered plugin module; called once at app startup. */
export function initPlugins(runtime: TgPluginRuntime) {
  activeRuntime = runtime;
  loadedPlugins.clear();
  enabledPlugins.clear();
  rebuildPluginList();

  for (const [path, pluginModule] of Object.entries(modules)) {
    loadPluginModule(pluginModule?.default, path, runtime);
  }
}

/**
 * Validates a module's default export and registers the plugin in host state;
 * runs `setup` unless the plugin is disabled. Invalid and duplicate-name
 * modules are logged and skipped.
 */
export function loadPluginModule(pluginExport: unknown, path: string, runtime: TgPluginRuntime) {
  if (!isValidPlugin(pluginExport)) {
    log(`skipped ${path}: no valid default TgPlugin export`);
    return;
  }

  const plugin = pluginExport;
  if (loadedPlugins.has(plugin.name)) {
    log(`skipped ${path}: duplicate plugin name "${plugin.name}"`);
    return;
  }

  const reporter = runtime.createPluginReporter(plugin.name);
  loadedPlugins.set(plugin.name, plugin);

  if (!runtime.isPluginEnabled(plugin.name)) {
    reporter.log('is disabled, setup skipped');
    rebuildPluginList();
    return;
  }

  setupPlugin(plugin, reporter, runtime);
  rebuildPluginList();
}

/** Re-runs a registered plugin's setup with a fresh `tg` object and persists the choice. */
export function enablePlugin(pluginName: string, runtime: TgPluginRuntime) {
  const plugin = loadedPlugins.get(pluginName);
  if (!plugin) return;

  if (!enabledPlugins.has(pluginName)) {
    setupPlugin(plugin, runtime.createPluginReporter(pluginName), runtime);
  }

  runtime.setPluginEnabled(pluginName, true);
  rebuildPluginList();
}

/** Runs the disposer, clears the plugin's registry entries and subscriptions, persists the choice. */
export function disablePlugin(pluginName: string, runtime: TgPluginRuntime) {
  const enabledPlugin = enabledPlugins.get(pluginName);

  if (enabledPlugin) {
    enabledPlugins.delete(pluginName);

    const reporter = runtime.createPluginReporter(pluginName);
    try {
      enabledPlugin.disposer?.();
    } catch (error) {
      reporter.logError('disposer failed', error);
    }

    enabledPlugin.context.runTeardowns();
  }

  runtime.setPluginEnabled(pluginName, false);
  rebuildPluginList();
}

/** Runtime toggle for the Settings screen; closes over the runtime set by `initPlugins`. */
export function togglePlugin(pluginName: string, isEnabled: boolean) {
  const runtime = activeRuntime!;

  if (isEnabled) {
    enablePlugin(pluginName, runtime);
  } else {
    disablePlugin(pluginName, runtime);
  }
}

/** Host state read by the Settings screen on mount; no `withGlobal` needed for plugin state. */
export function getPluginList(): TgPluginInfo[] {
  return pluginList;
}

function setupPlugin(plugin: TgPlugin, reporter: TgPluginReporter, runtime: TgPluginRuntime) {
  if (enabledPlugins.has(plugin.name)) return;

  const context = createPluginContext(plugin.name, reporter);
  const tg = buildTgApi(context, runtime);

  try {
    const disposer = plugin.setup(tg);
    enabledPlugins.set(plugin.name, {
      context,
      disposer: typeof disposer === 'function' ? disposer : undefined,
    });
    reporter.log(`loaded${plugin.version ? `@${plugin.version}` : ''}`);
  } catch (error) {
    reporter.logError('setup failed', error);
    // A failed setup must not leave partial contributions registered.
    context.runTeardowns();
  }
}

function isValidPlugin(value: unknown): value is TgPlugin {
  return Boolean(value) && typeof value === 'object'
    && typeof (value as TgPlugin).name === 'string' && (value as TgPlugin).name !== ''
    && typeof (value as TgPlugin).setup === 'function';
}

function rebuildPluginList() {
  pluginList = [...loadedPlugins.values()].map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    isEnabled: enabledPlugins.has(plugin.name),
  }));
}

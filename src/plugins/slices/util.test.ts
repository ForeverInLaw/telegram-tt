import { describe, expect, it } from 'vitest';

import type { TgPluginRuntime } from '../runtime';

import { createUtilSlice } from './util';
import { createPluginContext } from '../context';

const TEST_PLUGIN_NAME = 'echo-plugin';

type CapturedError = { action: string; error: unknown };

/** Builds the slice over a capturing reporter and an injectable translation fn. */
function createTestUtilSlice() {
  const capturedLogs: string[] = [];
  const capturedErrors: CapturedError[] = [];

  const runtime: TgPluginRuntime = {
    isPluginEnabled: () => true,
    setPluginEnabled: () => {},
    createPluginReporter: (pluginName) => ({
      // Prefixing like the production reporter proves the slice logs through
      // a reporter bound to the plugin's name
      log: (message) => capturedLogs.push(`${pluginName}: ${message}`),
      logError: (action, error) => capturedErrors.push({ action, error }),
      wrap: (callback) => callback,
    }),
    // Event streams are not exercised by the facade slices
    subscribeApiUpdates: () => () => {},
    subscribeToStoreChanges: () => {},
    getActions: () => {
      throw new Error('the util slice never dispatches actions');
    },
    getCurrentTabId: () => 0,
    mainThreadId: 0,
    getActiveMessageList: () => undefined,
    getActiveChatId: () => {
      throw new Error('the util slice never reads the store');
    },
    getCurrentUserId: () => {
      throw new Error('the util slice never reads the store');
    },
    getChat: () => {
      throw new Error('the util slice never reads the store');
    },
    getLocalizedString: (key, variables) => `translated:${key}:${JSON.stringify(variables ?? {})}`,
    showNotification: () => {
      throw new Error('the util slice never shows notifications');
    },
  };

  const context = createPluginContext(TEST_PLUGIN_NAME, runtime.createPluginReporter(TEST_PLUGIN_NAME));

  return {
    runtime,
    util: createUtilSlice(context, runtime),
    capturedErrors,
    capturedLogs,
  };
}

describe('util slice', () => {
  it('logs JSON-serialized args through the plugin-name reporter', () => {
    const { util, capturedLogs } = createTestUtilSlice();

    util.log('hello', { world: true });

    expect(capturedLogs).toEqual(['echo-plugin: hello {"world":true}']);
  });

  it('logs non-JSON values as plain text', () => {
    const { util, capturedLogs } = createTestUtilSlice();

    util.log('value', undefined);

    expect(capturedLogs).toEqual(['echo-plugin: value undefined']);
  });

  it('contains args JSON serialization throws on and falls back to String', () => {
    const { util, capturedLogs } = createTestUtilSlice();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => util.log('bigint', 10n)).not.toThrow();
    expect(() => util.log('cyclic', cyclic)).not.toThrow();

    expect(capturedLogs).toEqual([
      'echo-plugin: bigint 10',
      'echo-plugin: cyclic [object Object]',
    ]);
  });

  it('passes the key and variables to the translation fn', () => {
    const { util } = createTestUtilSlice();

    expect(util.getLocalizedString('SettingsPluginsAbout', { name: 'Amy' }))
      .toBe('translated:SettingsPluginsAbout:{"name":"Amy"}');

    expect(util.getLocalizedString('SettingsPluginsAbout')).toBe('translated:SettingsPluginsAbout:{}');
  });

  it('returns the raw key when translation fails', () => {
    const { util, runtime, capturedErrors } = createTestUtilSlice();
    runtime.getLocalizedString = () => {
      throw new Error('boom');
    };

    expect(util.getLocalizedString('SettingsPluginsAbout')).toBe('SettingsPluginsAbout');

    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].action).toBe('util.getLocalizedString');
  });
});

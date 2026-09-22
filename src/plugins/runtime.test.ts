import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addActionHandler } from '../global';

import type { GlobalActions } from '../global';
import type { ActionReturnType } from '../global/types';

import { getCurrentTabId } from '../util/establishMultitabRole';
import { createPluginRuntime } from './runtime';

const STORAGE_KEY = 'tt-plugins';

/** Payload the store's `showNotification` action receives. */
type ShownNotification = Parameters<GlobalActions['showNotification']>[0];

// Captured through the store's own dispatch pipeline — the exact seam the
// runtime's notification service calls into — so this suite mocks no modules.
const shownNotifications: ShownNotification[] = [];

addActionHandler('showNotification', (_global, _actions, payload): ActionReturnType => {
  shownNotifications.push(payload);
});

// The translation fn itself is not exercised in this suite; it is injected
// only because runtime.ts must not import its jsdom-incompatible module.
function createTestRuntime() {
  return createPluginRuntime(vi.fn());
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('plugin runtime storage', () => {
  it('falls back to the manifest default when no flag is stored', () => {
    expect(createTestRuntime().isPluginEnabled('hello-plugin', true)).toBe(true);
    expect(createTestRuntime().isPluginEnabled('hello-plugin', false)).toBe(false);
  });

  it('keeps a stored disabled flag visible to fresh runtime instances', () => {
    createTestRuntime().setPluginEnabled('hello-plugin', false);

    expect(createTestRuntime().isPluginEnabled('hello-plugin', true)).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{"hello-plugin":false}');
  });

  it('falls back to the manifest default when the stored payload is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');

    expect(createTestRuntime().isPluginEnabled('hello-plugin', true)).toBe(true);
    expect(createTestRuntime().isPluginEnabled('hello-plugin', false)).toBe(false);
  });

  it('falls back to the manifest default when the stored payload is null', () => {
    localStorage.setItem(STORAGE_KEY, 'null');

    expect(createTestRuntime().isPluginEnabled('hello-plugin', true)).toBe(true);
    expect(createTestRuntime().isPluginEnabled('hello-plugin', false)).toBe(false);
  });

  it('keeps an explicit enable stored for a default-off plugin', () => {
    createTestRuntime().setPluginEnabled('hello-plugin', true);

    expect(createTestRuntime().isPluginEnabled('hello-plugin', false)).toBe(true);
  });
});

describe('plugin runtime notification service', () => {
  beforeEach(() => {
    shownNotifications.length = 0;
  });

  it('shows a notification with a fresh localId and the current tab id', () => {
    createTestRuntime().showNotification({
      title: 'Plugin title',
      message: 'Plugin body',
      icon: 'star',
      duration: 4000,
    });

    expect(shownNotifications).toHaveLength(1);
    expect(shownNotifications[0]).toEqual(expect.objectContaining({
      title: 'Plugin title',
      message: 'Plugin body',
      icon: 'star',
      duration: 4000,
      tabId: getCurrentTabId(),
    }));
    expect(shownNotifications[0].localId).toMatch(/^plugin-notification-/);
  });

  it('stacks repeated notifications instead of deduping them by message', () => {
    const runtime = createTestRuntime();

    runtime.showNotification({ message: 'Repeated' });
    runtime.showNotification({ message: 'Repeated' });

    expect(shownNotifications).toHaveLength(2);
    expect(shownNotifications[0].localId).not.toBe(shownNotifications[1].localId);
  });
});

describe('plugin reporter', () => {
  it('logs a throwing wrapped callback with the plugin name and does not rethrow', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = createTestRuntime().createPluginReporter('hello-plugin');

    const callback = () => {
      throw new Error('boom');
    };

    expect(() => reporter.wrap(callback)()).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('[plugins] hello-plugin callback failed:', expect.any(Error));
  });

  it('passes arguments through to the wrapped callback', () => {
    const received: number[] = [];
    const reporter = createTestRuntime().createPluginReporter('hello-plugin');

    reporter.wrap((value: number) => {
      received.push(value);
    })(42);

    expect(received).toEqual([42]);
  });

  it('prefixes log output with the plugin name', () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reporter = createTestRuntime().createPluginReporter('hello-plugin');

    reporter.log('hello');

    expect(consoleLog).toHaveBeenCalledWith('%c[plugins]', 'color:#40bfc4', 'hello-plugin', 'hello');
  });
});

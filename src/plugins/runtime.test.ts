import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPluginRuntime } from './runtime';

const STORAGE_KEY = 'tt-plugins';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('plugin runtime storage', () => {
  it('treats plugins without a stored flag as enabled', () => {
    expect(createPluginRuntime().isPluginEnabled('hello-plugin')).toBe(true);
  });

  it('keeps a stored disabled flag visible to fresh runtime instances', () => {
    createPluginRuntime().setPluginEnabled('hello-plugin', false);

    expect(createPluginRuntime().isPluginEnabled('hello-plugin')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{"hello-plugin":false}');
  });

  it('falls back to enabled when the stored payload is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');

    expect(createPluginRuntime().isPluginEnabled('hello-plugin')).toBe(true);
  });

  it('falls back to enabled when the stored payload is null', () => {
    localStorage.setItem(STORAGE_KEY, 'null');

    expect(createPluginRuntime().isPluginEnabled('hello-plugin')).toBe(true);
  });
});

describe('plugin reporter', () => {
  it('logs a throwing wrapped callback with the plugin name and does not rethrow', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = createPluginRuntime().createPluginReporter('hello-plugin');

    const callback = () => {
      throw new Error('boom');
    };

    expect(() => reporter.wrap(callback)()).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith('[plugins] hello-plugin callback failed:', expect.any(Error));
  });

  it('passes arguments through to the wrapped callback', () => {
    const received: number[] = [];
    const reporter = createPluginRuntime().createPluginReporter('hello-plugin');

    reporter.wrap((value: number) => {
      received.push(value);
    })(42);

    expect(received).toEqual([42]);
  });
});

import { describe, expect, it } from 'vitest';

import type { AppUpdateEvent, AppUpdateState } from './appUpdates';

import { reduceAppUpdateStatus } from './appUpdates';

const IDLE_STATE: AppUpdateState = { status: 'idle' };

function reduceEvents(state: AppUpdateState, ...events: AppUpdateEvent[]) {
  return events.reduce(reduceAppUpdateStatus, state);
}

describe('reduceAppUpdateStatus', () => {
  it('runs the silent flow: idle → checking → downloading → ready', () => {
    const state = reduceEvents(
      IDLE_STATE,
      { type: 'start-check' },
      { type: 'update-found' },
      { type: 'downloaded' },
    );

    expect(state).toEqual({ status: 'ready' });
  });

  it('returns to idle without touching the manual result when a silent check finds no update', () => {
    const state = reduceEvents(
      { status: 'idle', lastCheckResult: 'up-to-date' },
      { type: 'start-check' },
      { type: 'no-update' },
    );

    expect(state).toEqual({ status: 'idle', lastCheckResult: 'up-to-date' });
  });

  it('reports an error and returns to idle when a silent download fails', () => {
    const state = reduceEvents(
      { status: 'idle', lastCheckResult: 'update-found' },
      { type: 'start-check' },
      { type: 'update-found' },
      { type: 'download-failed', error: 'network down' },
    );

    expect(state).toEqual({ status: 'idle', lastCheckResult: 'update-found', error: 'network down' });
  });

  it('marks the manual check as up-to-date and clears a previous error', () => {
    const state = reduceEvents(
      { status: 'idle', error: 'network down' },
      { type: 'start-check' },
      { type: 'no-update', isManual: true },
    );

    expect(state).toEqual({ status: 'idle', lastCheckResult: 'up-to-date' });
  });

  it('marks the manual check as update-found while downloading', () => {
    const state = reduceEvents(
      IDLE_STATE,
      { type: 'start-check' },
      { type: 'update-found', isManual: true },
    );

    expect(state).toEqual({ status: 'downloading', lastCheckResult: 'update-found' });
  });

  it('marks the manual check as error and keeps the failure message', () => {
    const state = reduceEvents(
      IDLE_STATE,
      { type: 'start-check' },
      { type: 'download-failed', isManual: true, error: 'signature mismatch' },
    );

    expect(state).toEqual({ status: 'idle', lastCheckResult: 'error', error: 'signature mismatch' });
  });

  it('falls back to a default message when a failure carries no error text', () => {
    const state = reduceEvents(IDLE_STATE, { type: 'download-failed' });

    expect(state.error).toBeTruthy();
  });

  it('resets to the initial idle state', () => {
    const state = reduceEvents(
      { status: 'ready', lastCheckResult: 'update-found' },
      { type: 'reset' },
    );

    expect(state).toEqual({ status: 'idle' });
  });
});

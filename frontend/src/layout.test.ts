import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {acknowledgeLayout, readLayout, rememberMaximized, restoreMaximized} from './layout';
beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());
it('retains a click across immediate reload even when the server still has the previous value', () => {
  const click = rememberMaximized('alice', true);
  expect(restoreMaximized('alice', false)).toBe(true);
  acknowledgeLayout('alice', click.revision, true);
  expect(readLayout('alice')?.pending).toBe(false);
  expect(restoreMaximized('alice', false)).toBe(false);
});
it('does not let an older request acknowledge a later change', () => {
  const first = rememberMaximized('alice', true);
  rememberMaximized('alice', false);
  acknowledgeLayout('alice', first.revision, true);
  expect(readLayout('alice')).toMatchObject({pending: true, maximized: false});
  expect(restoreMaximized('alice', true)).toBe(false);
});
it('isolates account layouts and accepts server changes once local changes are saved', () => {
  rememberMaximized('alice', true);
  expect(restoreMaximized('bob', false)).toBe(false);
  expect(restoreMaximized('alice', false)).toBe(true);
  expect(restoreMaximized('bob', true)).toBe(true);
});
it('tolerates invalid cached data', () => {
  localStorage.setItem('gotty-hub:layout:alice', 'null');
  expect(restoreMaximized('alice', true)).toBe(true);
});
it('does not acknowledge a different value saved by an older browser tab', () => {
  const latest = rememberMaximized('alice', false);
  acknowledgeLayout('alice', latest.revision, true);
  expect(readLayout('alice')?.pending).toBe(true);
});
it('works on HTTP origins where randomUUID is unavailable', () => {
  vi.stubGlobal('crypto', {getRandomValues: crypto.getRandomValues.bind(crypto)});
  const click = rememberMaximized('alice', true);
  expect(click.revision).toHaveLength(32);
  expect(restoreMaximized('alice', false)).toBe(true);
});

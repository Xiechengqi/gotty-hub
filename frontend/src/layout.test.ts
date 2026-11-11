import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {acknowledgeLayout, readLayout, rememberMaximized, restoreMaximized, acknowledgeWorkspace, readWorkspaceCache, rememberWorkspace, restoreWorkspace} from './layout';
import {saveWorkspace, type Workspace} from './workspace/state';
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

const workspace = (): Workspace => ({opened: ['a', 'b', 'c'], active: 'c', split: {left: 'b', right: 'c', focused: 'right', ratio: 0.64}});
it('retains the complete workspace across reload before the server save', () => {
  rememberWorkspace('alice', workspace());
  expect(restoreWorkspace('alice', {opened: ['a'], active: 'a', split: false}, ['a', 'b', 'c'])).toEqual(workspace());
});
it('does not acknowledge an older focus, pair or ratio after a newer interaction', () => {
  const earlier = rememberWorkspace('alice', workspace());
  const latest = {...workspace(), active: 'b', split: {...workspace().split!, focused: 'left' as const, ratio: 0.4}};
  rememberWorkspace('alice', latest);
  acknowledgeWorkspace('alice', earlier.revision, workspace());
  expect(readWorkspaceCache('alice')?.pending).toBe(true);
  expect(restoreWorkspace('alice', {}, ['a', 'b', 'c'])).toEqual(latest);
});
it('accepts saved remote state after acknowledgement and keeps accounts isolated', () => {
  const click = rememberWorkspace('alice', workspace());
  acknowledgeWorkspace('alice', click.revision, workspace());
  expect(readWorkspaceCache('alice')?.pending).toBe(false);
  expect(restoreWorkspace('alice', {opened: ['a'], active: 'a'}, ['a', 'b', 'c']).split).toBeNull();
  expect(restoreWorkspace('bob', {}, ['a', 'b', 'c'], 'a')).toEqual({opened: ['a'], active: 'a', split: null});
});
it('checks permissions even for a pending local layout and preserves maximization independently', () => {
  rememberMaximized('alice', true);
  rememberWorkspace('alice', workspace());
  expect(restoreWorkspace('alice', {}, ['a', 'b'])).toEqual({opened: ['a', 'b'], active: 'b', split: null});
  expect(readLayout('alice')?.maximized).toBe(true);
  expect(readWorkspaceCache('alice')?.pending).toBe(true);
});
it('ignores malformed cached workspace values and accepts versioned server preferences', () => {
  localStorage.setItem('gotty-hub:workspace:alice', JSON.stringify({revision: 'old', pending: true, workspace: {opened: [1]}}));
  expect(restoreWorkspace('alice', {workspace: saveWorkspace(workspace())}, ['a', 'b', 'c'])).toEqual(workspace());
});

import {expect, it} from 'vitest';
import {decodeWorkspace, emptyWorkspace, normalizeWorkspace, saveWorkspace, workspaceFromPreferences, workspaceReducer, type Workspace} from './state';

const initial = (): Workspace => ({opened: ['a', 'b', 'c'], active: 'b', split: null});
const paired = () => workspaceReducer(initial(), {type: 'start', id: 'c'});

it('pairs any two instances independently of the first opened tab', () => {
  expect(paired()).toMatchObject({active: 'b', opened: ['a', 'b', 'c'], split: {left: 'b', right: 'c', focused: 'left'}});
});
it('focuses either existing pane without replacing or moving its peer', () => {
  const right = workspaceReducer(paired(), {type: 'focus', id: 'c'});
  expect(right).toMatchObject({active: 'c', split: {left: 'b', right: 'c', focused: 'right'}});
  expect(workspaceReducer(right, {type: 'select', id: 'b', inSplit: true})).toMatchObject({active: 'b', split: {left: 'b', right: 'c', focused: 'left'}});
});
it('replaces only the focused pane when a third tab is selected', () => {
  const right = workspaceReducer(paired(), {type: 'focus', id: 'c'});
  expect(workspaceReducer(right, {type: 'select', id: 'a', inSplit: true})).toMatchObject({active: 'a', split: {left: 'b', right: 'a', focused: 'right'}});
});
it('navigation ordering and repeated instance snapshots cannot change the pair', () => {
  const state = paired();
  expect(workspaceReducer(state, {type: 'reconcile', available: ['c', 'a', 'b']})).toBe(state);
});
it('can choose an unopened instance without closing the replaced session', () => {
  const state = workspaceReducer(paired(), {type: 'replace', pane: 'left', id: 'd'});
  expect(state.opened).toEqual(['a', 'b', 'c', 'd']);
  expect(state.split).toMatchObject({left: 'd', right: 'c', focused: 'left'});
  expect(workspaceReducer(state, {type: 'replace', pane: 'left', id: 'c'}).split).toMatchObject({left: 'd', right: 'c', focused: 'right'});
});
it('swaps positions while focus follows the same instance', () => {
  expect(workspaceReducer(paired(), {type: 'swap'})).toMatchObject({active: 'b', split: {left: 'c', right: 'b', focused: 'right'}});
});
it('closing a paired terminal collapses to its survivor and does not pick a random replacement', () => {
  const state = workspaceReducer(paired(), {type: 'close', id: 'b'});
  expect(state).toEqual({opened: ['a', 'c'], active: 'c', split: null});
  expect(workspaceReducer(state, {type: 'select', id: 'd', inSplit: false}).split).toBeNull();
  expect(workspaceReducer(paired(), {type: 'close', id: 'a'}).split).toEqual(paired().split);
});
it('exiting keeps both sessions open and shows the last active instance', () => {
  expect(workspaceReducer(paired(), {type: 'exit', active: 'c'})).toEqual({opened: ['a', 'b', 'c'], active: 'c', split: null});
});
it('narrow-screen session selection preserves the desktop pair and ratio', () => {
  const state = workspaceReducer(paired(), {type: 'resize', ratio: 0.63});
  const narrow = workspaceReducer(state, {type: 'select', id: 'a', inSplit: false});
  expect(narrow.active).toBe('a');
  expect(narrow.split).toEqual(state.split);
});
it('removes revoked IDs and collapses to the permitted survivor', () => {
  expect(normalizeWorkspace(paired(), ['a', 'c'])).toEqual({opened: ['a', 'c'], active: 'c', split: null});
  expect(normalizeWorkspace(paired(), [])).toEqual(emptyWorkspace());
});
it('migrates the exact old left/right positions once and round-trips the new format', () => {
  const migrated = workspaceFromPreferences({opened: ['a', 'b', 'c'], active: 'c', instanceOrder: ['b', 'c', 'a'], split: true}, ['a', 'b', 'c']);
  expect(migrated.split).toEqual({left: 'b', right: 'c', focused: 'right', ratio: 0.5});
  expect(workspaceFromPreferences({workspace: saveWorkspace(migrated), instanceOrder: ['a', 'b', 'c']}, ['c', 'b', 'a'])).toEqual(migrated);
});
it('rejects malformed saved state and normalizes duplicates, invalid IDs and ratios', () => {
  expect(decodeWorkspace({schemaVersion: 1, opened: ['a'], active: 'a', split: {left: 'a', right: 'a', focused: 'middle', ratio: 0.5}})).toBeUndefined();
  expect(workspaceFromPreferences({opened: ['a', 'a', 12, 'unknown'], active: 'unknown', split: true}, ['a'])).toEqual({opened: ['a'], active: 'a', split: null});
  expect(decodeWorkspace({...saveWorkspace(paired()), split: {...paired().split!, ratio: 10}})?.split?.ratio).toBe(0.9);
  expect(workspaceReducer(paired(), {type: 'resize', ratio: NaN}).split?.ratio).toBe(0.5);
});

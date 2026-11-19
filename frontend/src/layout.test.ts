import {beforeEach, expect, it} from 'vitest';
import {
  currentPreferences, forgetChromeSettings, legacyWorkspaceDraft, readCompactOrder, readWorkspaceDraft,
  rememberCompactOrder, rememberWorkspaceDraft,
} from './layout';
import {emptyView} from './workspace/state';

beforeEach(() => {localStorage.clear(); sessionStorage.clear();});

it('retires old chrome choices and preserves preference data for older clients', () => {
  localStorage.setItem('gotty-hub.theme','dark');
  localStorage.setItem('gotty-hub:layout:alice','old');
  forgetChromeSettings('alice');
  expect(localStorage.getItem('gotty-hub.theme')).toBeNull();
  expect(localStorage.getItem('gotty-hub:layout:alice')).toBeNull();
  expect(currentPreferences({dark:true,toolbarPinned:false,locale:'zh-CN',workspace:{schemaVersion:3}}))
    .toEqual({locale:'zh-CN',workspace:{schemaVersion:3}});
});

it('keeps focus, paging and the pending edit journal scoped to the account', () => {
  const draft = {view:{...emptyView(),active:'a',pagedGroups:['split']},
    edits:[{writeId:'a'.repeat(32),action:{type:'join' as const,id:'a',group:'split'}}]};
  rememberWorkspaceDraft('alice',draft);
  expect(readWorkspaceDraft('alice')).toEqual(draft);
  expect(readWorkspaceDraft('bob')).toBeUndefined();
});

it('stores the compact order across tabs without storing their focus or pending edits with it', () => {
  rememberCompactOrder('alice',['b','a']);
  sessionStorage.clear();
  expect(readCompactOrder('alice')).toEqual(['b','a']);
  expect(readCompactOrder('bob')).toBeUndefined();
  expect(readWorkspaceDraft('alice')).toBeUndefined();
});

it('reads only pending legacy cache and tolerates an invalid cache', () => {
  localStorage.setItem('gotty-hub:workspace:alice','{');
  expect(legacyWorkspaceDraft('alice')).toBeUndefined();
  const workspace = {schemaVersion:1,opened:['a','b'],active:'b',split:{left:'a',right:'b',focused:'right'}};
  localStorage.setItem('gotty-hub:workspace:alice',JSON.stringify({pending:true,workspace}));
  expect(legacyWorkspaceDraft('alice')).toEqual(workspace);
  expect(legacyWorkspaceDraft('bob')).toBeUndefined();
});

import {beforeEach, expect, it} from 'vitest';
import {currentPreferences, forgetChromeSettings, acknowledgeWorkspace, readWorkspaceCache, rememberWorkspace, restoreWorkspace} from './layout';
import {saveWorkspace, workspaceReducer, type Workspace} from './workspace/state';
beforeEach(()=>localStorage.clear());
const workspace=():Workspace=>({opened:['a','b','c'],order:['b','c','a'],active:'c',groups:[{left:'b',right:'c',focused:'right',ratio:.64}]});
it('retires pin and application theme choices without dropping other preferences',()=>{
  localStorage.setItem('gotty-hub.theme','dark');
  localStorage.setItem('gotty-hub:layout:alice','old');
  forgetChromeSettings('alice');
  expect(localStorage.getItem('gotty-hub.theme')).toBeNull();
  expect(localStorage.getItem('gotty-hub:layout:alice')).toBeNull();
  expect(currentPreferences({dark:true,toolbarPinned:false,maximized:true,sidebarCollapsed:false,navbarCollapsed:true,locale:'zh-CN',workspace:saveWorkspace(workspace())})).toEqual({locale:'zh-CN',workspace:saveWorkspace(workspace())});
});
it('retains complete order and groups before server acknowledgement',()=>{
  rememberWorkspace('alice',workspace());
  expect(restoreWorkspace('alice',{opened:['a'],active:'a'},['a','b','c'])).toEqual(workspace());
  const earlier=readWorkspaceCache('alice')!;
  const moved=workspaceReducer(workspace(),{type:'move',id:'b',direction:1});rememberWorkspace('alice',moved);
  acknowledgeWorkspace('alice',earlier.revision,workspace());
  expect(readWorkspaceCache('alice')?.pending).toBe(true);expect(restoreWorkspace('alice',{},['a','b','c'])).toEqual(moved);
});
it('accepts server state after acknowledgement without leaking between accounts',()=>{
  const click=rememberWorkspace('alice',workspace());acknowledgeWorkspace('alice',click.revision,workspace());
  expect(readWorkspaceCache('alice')?.pending).toBe(false);
  expect(restoreWorkspace('alice',{opened:['a'],active:'a'},['a','b','c']).groups).toEqual([]);
  expect(restoreWorkspace('bob',{},['a','b','c'],'a').active).toBe('a');
});
it('filters revoked IDs even in pending cache',()=>{
  rememberWorkspace('alice',workspace());
  const restored=restoreWorkspace('alice',{},['a','b']);
  expect(restored.active).toBe('b');expect(restored.groups).toEqual([]);expect(restored.order).toEqual(['b','a']);
  expect(readWorkspaceCache('alice')?.pending).toBe(true);
});
it('ignores malformed cache and reads the current versioned server preference',()=>{
  localStorage.setItem('gotty-hub:workspace:alice','null');
  expect(restoreWorkspace('alice',{workspace:saveWorkspace(workspace())},['a','b','c'])).toEqual(workspace());
});
it('migrates pending v1 cache with the separately saved order and acknowledges the new snapshot',()=>{
  localStorage.setItem('gotty-hub:workspace:alice',JSON.stringify({revision:'legacy',pending:true,workspace:{schemaVersion:1,opened:['a','b','c'],active:'c',split:{left:'a',right:'c',focused:'right',ratio:.6}}}));
  const restored=restoreWorkspace('alice',{instanceOrder:['c','b','a']},['a','b','c']);
  expect(restored.order).toEqual(['b','a','c']);expect(restored.active).toBe('c');
  const migrated=readWorkspaceCache('alice')!;
  expect(migrated.workspace.schemaVersion).toBe(3);expect(migrated.revision).not.toBe('legacy');
  acknowledgeWorkspace('alice',migrated.revision,restored);
  expect(readWorkspaceCache('alice')?.pending).toBe(false);
});

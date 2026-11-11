import {beforeEach, expect, it} from 'vitest';
import {acknowledgeLayout, readLayout, rememberPinned, restorePinned, acknowledgeWorkspace, readWorkspaceCache, rememberWorkspace, restoreWorkspace} from './layout';
import {saveWorkspace, workspaceReducer, type Workspace} from './workspace/state';
beforeEach(()=>localStorage.clear());
const workspace=():Workspace=>({opened:['a','b','c'],order:['b','c','a'],active:'c',groups:[{left:'b',right:'c',focused:'right',ratio:.64}]});
it('retains unpin across immediate reload and ignores older acknowledgements',()=>{
  const earlier=rememberPinned('alice',true);rememberPinned('alice',false);
  acknowledgeLayout('alice',earlier.revision,true);
  expect(restorePinned('alice',true)).toBe(false);expect(readLayout('alice')?.pending).toBe(true);
  const latest=readLayout('alice')!;acknowledgeLayout('alice',latest.revision,false);
  expect(readLayout('alice')?.pending).toBe(false);expect(restorePinned('alice',true)).toBe(true);
});
it('migrates legacy maximization, prioritizes pending local choice and isolates accounts',()=>{
  localStorage.setItem('gotty-hub:layout:alice',JSON.stringify({maximized:true,revision:'old',pending:true}));
  expect(restorePinned('alice',true,false)).toBe(false);
  expect(restorePinned('bob',undefined,true)).toBe(false);
  expect(restorePinned('carol',undefined)).toBe(true);
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
it('filters revoked IDs even in pending cache while preserving pin separately',()=>{
  rememberPinned('alice',false);rememberWorkspace('alice',workspace());
  const restored=restoreWorkspace('alice',{},['a','b']);
  expect(restored.active).toBe('b');expect(restored.groups).toEqual([]);expect(restored.order).toEqual(['b','a']);
  expect(readLayout('alice')?.pinned).toBe(false);expect(readWorkspaceCache('alice')?.pending).toBe(true);
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
  expect(migrated.workspace.schemaVersion).toBe(2);expect(migrated.revision).not.toBe('legacy');
  acknowledgeWorkspace('alice',migrated.revision,restored);
  expect(readWorkspaceCache('alice')?.pending).toBe(false);
});

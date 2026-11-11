import {expect, it} from 'vitest';
import {activeSplit, decodeWorkspace, groupFor, navigationUnits, normalizeWorkspace, openedOrder, saveWorkspace, workspaceFromPreferences, workspaceReducer, type Workspace} from './state';
const initial = (): Workspace => ({opened:['a','b','c','d','e'],order:['a','b','c','d','e'],active:'a',groups:[]});
const paired = () => workspaceReducer(initial(), {type:'start',id:'b',right:'c'});
it('only creates a group with the immediate right opened tab',()=>{
  expect(workspaceReducer(initial(),{type:'start',id:'a',right:'c'}).groups).toEqual([]);
  expect(workspaceReducer(initial(),{type:'start',id:'e',right:'a'}).groups).toEqual([]);
  expect(paired().groups).toEqual([{left:'b',right:'c',focused:'left',ratio:.5}]);
  expect(workspaceReducer(paired(),{type:'start',id:'a',right:'b'}).groups).toHaveLength(1);
});
it('keeps independent groups while selecting unrelated terminals',()=>{
  const state=workspaceReducer(paired(),{type:'start',id:'d',right:'e'});
  const single=workspaceReducer(state,{type:'select',id:'a'});
  expect(single.groups).toEqual(state.groups);expect(activeSplit(single)).toBeUndefined();
  const back=workspaceReducer(single,{type:'select',id:'c'});
  expect(activeSplit(back)).toMatchObject({left:'b',right:'c',focused:'right'});
  expect(back.groups).toHaveLength(2);
});
it('moves either member as a unit and never inserts another tab inside it',()=>{
  expect(workspaceReducer(paired(),{type:'reorder',id:'c',target:'e'}).order).toEqual(['a','d','e','b','c']);
  expect(workspaceReducer(paired(),{type:'reorder',id:'e',target:'c'}).order).toEqual(['a','e','b','c','d']);
  expect(workspaceReducer(paired(),{type:'move',id:'c',direction:-1}).order).toEqual(['b','c','a','d','e']);
});
it('keeps previously unopened instances outside a newly formed pair',()=>{
  const state=workspaceReducer({...initial(),opened:['a','c']},{type:'start',id:'a',right:'c'});
  expect(state.order).toEqual(['a','c','b','d','e']);
  const opened=workspaceReducer(state,{type:'select',id:'b'});
  expect(openedOrder(opened)).toEqual(['a','c','b']);
});
it('swaps both tab and pane positions while retaining the focused instance',()=>{
  const state=workspaceReducer(paired(),{type:'swap',id:'c'});
  expect(state.active).toBe('b');expect(state.order).toEqual(['a','c','b','d','e']);
  expect(activeSplit(state)).toMatchObject({left:'c',right:'b',focused:'right'});
});
it('closing or revoking one member retains its survivor without selecting another pair',()=>{
  const closed=workspaceReducer(paired(),{type:'close',id:'b'});
  expect(closed.active).toBe('c');expect(closed.groups).toEqual([]);
  expect(normalizeWorkspace(paired(),['a','c','d']).active).toBe('c');
  const away=workspaceReducer(paired(),{type:'select',id:'e'});
  expect(workspaceReducer(away,{type:'close',id:'b'}).active).toBe('e');
});
it('exiting removes only the selected group and preserves opened terminals',()=>{
  const state=workspaceReducer(paired(),{type:'start',id:'d',right:'e'});
  const next=workspaceReducer(state,{type:'exit',id:'b'});
  expect(next.opened).toEqual(state.opened);expect(next.groups).toEqual([state.groups[1]]);
});
it('reconciles repeated snapshots without changing groups or saved order',()=>{
  const state=paired();expect(workspaceReducer(state,{type:'reconcile',available:['e','d','c','b','a']})).toBe(state);
});
it('migrates nonadjacent v1 pairs without changing other relative positions',()=>{
  const state=workspaceFromPreferences({instanceOrder:['a','b','c','d','e'],workspace:{schemaVersion:1,opened:['a','b','c','d','e'],active:'d',split:{left:'b',right:'d',focused:'right',ratio:.62}}},initial().order);
  expect(state.order).toEqual(['a','b','d','c','e']);expect(activeSplit(state)?.ratio).toBe(.62);
  expect(decodeWorkspace(saveWorkspace(state))).toEqual(state);
});
it('migrates legacy boolean splits using the original visible order',()=>{
  const state=workspaceFromPreferences({opened:['a','b','c'],instanceOrder:['b','c','a'],active:'c',split:true},['a','b','c']);
  expect(activeSplit(state)).toMatchObject({left:'b',right:'c',focused:'right'});
});
it('rejects invalid schemas and normalizes duplicate memberships and ratios',()=>{
  expect(decodeWorkspace({...saveWorkspace(paired()),groups:[{left:'b',right:'c',focused:'invalid',ratio:.5}]})).toBeUndefined();
  const state=normalizeWorkspace({...paired(),groups:[...paired().groups,{left:'c',right:'d',focused:'left',ratio:.5}]},initial().order);
  expect(state.groups).toHaveLength(1);
  expect(groupFor(workspaceReducer(state,{type:'resize',id:'c',ratio:NaN}),'b')?.ratio).toBe(.5);
});
it('maintains adjacency, disjoint membership and valid active IDs through mixed operations',()=>{
  let state=initial();
  for(let i=0;i<60;i++){
    const ids=openedOrder(state);const id=ids[i%ids.length];
    if(i%4===0&&ids[ids.indexOf(id)+1])state=workspaceReducer(state,{type:'start',id,right:ids[ids.indexOf(id)+1]});
    else if(i%4===1)state=workspaceReducer(state,{type:'reorder',id,target:ids[(i+2)%ids.length]});
    else if(i%4===2)state=workspaceReducer(state,{type:'swap',id});
    else state=workspaceReducer(state,{type:'select',id});
    const members=state.groups.flatMap(g=>[g.left,g.right]);expect(new Set(members).size).toBe(members.length);
    for(const g of state.groups)expect(state.order[state.order.indexOf(g.left)+1]).toBe(g.right);
    expect(navigationUnits(state).flat()).toEqual(state.order);expect(state.opened).toContain(state.active);
  }
});

it('opens every existing instance on migration and only new IDs afterwards',()=>{
  const migrated=workspaceFromPreferences({workspace:{schemaVersion:2,...initial(),opened:['a']}},initial().order);
  expect(migrated.opened).toEqual(initial().opened);
  const closed=workspaceReducer(migrated,{type:'close',id:'b'});
  expect(workspaceFromPreferences({workspace:saveWorkspace(closed)},initial().order)).toEqual(closed);
  const added=workspaceReducer(closed,{type:'reconcile',available:[...initial().order,'f']});
  expect(added.opened).toEqual(['a','c','d','e','f']);expect(added.active).toBe('a');
  expect(workspaceReducer(added,{type:'reconcile',available:[...initial().order,'f']})).toBe(added);
});
it('opens new accounts and arrivals into an empty workspace without requiring a directory',()=>{
  expect(workspaceFromPreferences({},['offline','online'],'online')).toMatchObject({opened:['online','offline'],active:'online'});
  expect(workspaceReducer({opened:[],order:[],active:'',groups:[]},{type:'reconcile',available:['one']})).toMatchObject({opened:['one'],active:'one'});
});

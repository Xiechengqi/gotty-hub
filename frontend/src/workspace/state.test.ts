import {expect,it} from 'vitest';
import {applyLayout, displayView, emptyView, migrateWorkspace, navigationUnits, reconcileUnits, rememberedMember, selectInstance, type Unit} from './state';

const tabs = () => ['a','b','c','d','e'].map(id => ({id}));
const create = {type:'create', id:'d', group:'split-1', members:['e','b']} as const;
const group = {id:'split-1', members:['d','b','e']};
const grouped = () => applyLayout(tabs(), {...create, members:[...create.members]})!;

it('combines nonadjacent members at the source tab and keeps one ordered sorting unit', () => {
  expect(grouped()).toEqual([{id:'a'},{id:'c'},group]);
  const moved = applyLayout(grouped(), {type:'reorder',id:group.id,target:'a',after:false})!;
  expect(moved).toEqual([group,{id:'a'},{id:'c'}]);
  expect(applyLayout(moved, {type:'reorder',id:group.id,target:'a',after:false})).toBe(moved);
  expect(applyLayout(grouped(), {type:'create',id:'a',group:'split-2',members:['d']})).toBeUndefined();
});

it('joins at the end, removes next to the group, and expands a dissolved group at its position', () => {
  const units = applyLayout(grouped(), {type:'join', id:'a',group:group.id})!;
  expect(units).toEqual([{id:'c'},{...group,members:['d','b','e','a']}]);
  const removed = applyLayout(units, {type:'remove',id:'b',group:group.id})!;
  expect(removed).toEqual([{id:'c'},{...group,members:['d','e','a']},{id:'b'}]);
  expect(applyLayout(removed, {type:'dissolve',group:group.id})).toEqual(['c','d','e','a','b'].map(id=>({id})));
  expect(applyLayout(removed, {type:'join',id:'a',group:'missing'})).toBeUndefined();
});

it('filters revoked members, preserves the current group survivor, and keeps hidden tabs', () => {
  const state = {units:[...grouped(),{id:'hidden',hidden:true}],view:{...emptyView(),active:'d'}};
  const units = reconcileUnits(state.units,['a','c','e','hidden','new']);
  expect(units).toEqual([{id:'a'},{id:'c'},{id:'e'},{id:'hidden',hidden:true},{id:'new'}]);
  expect(displayView(state,units).active).toBe('e');
  expect(reconcileUnits(units,['new','hidden','e','c','a'])).toBe(units);
});

it('flattens the view on small screens and preserves the wide workspace and remembered member', () => {
  const initial = {units:grouped(),view:{...emptyView(),active:'a', compactOrder:['e','a']}};
  const wide = selectInstance(initial,'b',true);
  const compact = selectInstance(wide,'e',false);
  expect(navigationUnits(compact,true)).toEqual(grouped());
  expect(navigationUnits(compact,false).map(u=>u.id)).toEqual(['e','a','c','d','b']);
  expect(rememberedMember(group,compact.view)).toBe('b');
  expect(compact.view.active).toBe('e');
});

it('imports a legacy boolean split and v1 saved pairs in their original pane order', () => {
  const prefs = {opened:['a','b','c'],active:'c',instanceOrder:['b','c','a'],split:true};
  const imported = migrateWorkspace(prefs,['a','b','c'],'a');
  expect(imported.units).toEqual([{id:'split-b', members:['b','c']},{id:'a'}]);
  expect(imported.view).toMatchObject({active:'c',focused:{'split-b':'c'}});
  const v1 = {schemaVersion:1,opened:prefs.opened,active:'a',split:{left:'a',right:'c',focused:'right',ratio:.71}};
  expect(migrateWorkspace(prefs,['a','b','c'],'b',v1).units).toEqual([{id:'b'},{id:'split-a',members:['a','c']}]);
});

it('keeps v3 hidden tabs and opens new devices automatically', () => {
  const old = {schemaVersion:3, order:['a','b','c'],opened:['a','b'],active:'b',groups:[{left:'a',right:'b',focused:'right',ratio:.6}]};
  const imported = migrateWorkspace({workspace:old},['a','b','c','new'],'new');
  expect(imported.units).toEqual([{id:'split-a',members:['a','b']},{id:'c',hidden:true},{id:'new'}]);
  const units = applyLayout(imported.units, {type:'open',id:'c'});
  expect(units?.[1]).toEqual({id:'c'});
});

it('keeps the compact order when the account layout is regrouped, adding and dropping only changed access', () => {
  const initial = {units:tabs(),view:{...emptyView(),active:'c',compactOrder:['e','b','c','d','a']}};
  const updated = reconcileUnits(grouped(), ['a','b','c','e','new']);
  const view = displayView(initial, updated);
  expect(view.active).toBe('c');
  expect(view.compactOrder).toEqual(['e','b','c','a','new']);
  expect(navigationUnits({units:updated,view},false).map(unit=>unit.id)).toEqual(view.compactOrder);
});

it('uses a valid saved layout when a pending legacy draft is malformed', () => {
  const saved = {schemaVersion:2,order:['b','c','a'],opened:['b','c'],active:'c',groups:[{left:'b',right:'c',focused:'right'}]};
  const restored = migrateWorkspace({workspace:saved},['a','b','c','new'],'new',{schemaVersion:3,order:[]});
  expect(restored.view.active).toBe('c');
  expect(restored.units).toEqual([{id:'split-b',members:['b','c']},{id:'a',hidden:true},{id:'new'}]);
});

it('groups hundreds of members without duplicating or dropping IDs', () => {
  const units:Unit[] = Array.from({length:600},(_,i)=>({id:String(i)}));
  const layout = applyLayout(units, {type:'create',id:'0',group:'split-1',members:units.slice(1).map(unit=>unit.id)});
  expect(layout).toEqual([{id:'split-1',members:units.map(unit=>unit.id)}]);
});

import {normalizeOrder} from '../instances/order';

export type Pane = 'left' | 'right';
export type Split = {left: string; right: string; focused: Pane; ratio: number};
export type Workspace = {opened: string[]; order: string[]; active: string; groups: Split[]};
export type SavedWorkspace = Workspace & {schemaVersion: 2};
export const MIN_PANE_WIDTH = 360;
export const DIVIDER_WIDTH = 8;
export const emptyWorkspace = (): Workspace => ({opened: [], order: [], active: '', groups: []});
export const groupFor = (state: Workspace, id: string) => state.groups.find(g => g.left === id || g.right === id);
export const activeSplit = (state: Workspace) => groupFor(state, state.active);
export const openedOrder = (state: Workspace) => state.order.filter(id => state.opened.includes(id));
export function clampRatio(value: number, minimum = 0.1): number {
  return Math.min(1 - minimum, Math.max(minimum, Number.isFinite(value) ? value : 0.5));
}
export function sameWorkspace(a: Workspace, b: Workspace): boolean {
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((id, i) => id === y[i]);
  return a.active === b.active && same(a.opened, b.opened) && same(a.order, b.order) && a.groups.length === b.groups.length && a.groups.every((g, i) => {const h = b.groups[i]; return g.left === h.left && g.right === h.right && g.focused === h.focused && g.ratio === h.ratio;});
}

// A pair is one sorting unit, including in the all-instances directory. This
// prevents opening a previously closed instance from inserting it into a pair.
export function navigationUnits(state: Workspace, openedOnly = false): string[][] {
  const ids = openedOnly ? openedOrder(state) : state.order;
  return ids.filter(id => !state.groups.some(g => g.right === id)).map(id => {
    const group = state.groups.find(g => g.left === id);
    return group ? [group.left, group.right] : [id];
  });
}
export function normalizeWorkspace(value: Workspace, available: readonly string[]): Workspace {
  const allowed = new Set(available);
  const opened = [...new Set(value.opened.filter(id => allowed.has(id)))];
  let active = opened.includes(value.active) ? value.active : opened[0] || '';
  const used = new Set<string>();
  const groups: Split[] = [];
  for (const group of value.groups) {
    if (group.left !== group.right && opened.includes(group.left) && opened.includes(group.right) && !used.has(group.left) && !used.has(group.right)) {
      groups.push({...group, ratio: clampRatio(group.ratio)}); used.add(group.left); used.add(group.right);
    } else if ((value.active === group.left || value.active === group.right) && !opened.includes(value.active)) {
      active = opened.includes(group.left) ? group.left : opened.includes(group.right) ? group.right : active;
    }
  }
  const order = normalizeOrder(value.order, available);
  for (const group of groups) {
    order.splice(order.indexOf(group.right), 1);
    order.splice(order.indexOf(group.left) + 1, 0, group.right);
  }
  const next = {opened, order, active, groups};
  return sameWorkspace(value, next) ? value : next;
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string');
const validGroup = (value: unknown): value is Split => {
  if (!value || typeof value !== 'object') return false;
  const g = value as Split;
  return typeof g.left === 'string' && typeof g.right === 'string' && ['left', 'right'].includes(g.focused) && typeof g.ratio === 'number' && Number.isFinite(g.ratio);
};
export function decodeWorkspace(value: unknown, legacyOrder?: unknown): Workspace | undefined {
  if (!value || typeof value !== 'object') return;
  const saved = value as Record<string, unknown>;
  if (!strings(saved.opened) || typeof saved.active !== 'string') return;
  let order: string[], groups: Split[];
  if (saved.schemaVersion === 2) {
    if (!strings(saved.order) || !Array.isArray(saved.groups) || !saved.groups.every(validGroup)) return;
    order = saved.order; groups = saved.groups;
  } else if (saved.schemaVersion === 1) {
    if (saved.split !== null && !validGroup(saved.split)) return;
    order = strings(legacyOrder) ? legacyOrder : saved.opened;
    groups = saved.split ? [saved.split as Split] : [];
  } else return;
  return normalizeWorkspace({opened: saved.opened, active: saved.active, order, groups}, [...new Set([...order, ...saved.opened])]);
}
export function saveWorkspace(value: Workspace): SavedWorkspace {return {schemaVersion: 2, ...value};}
export function workspaceFromPreferences(prefs: Record<string, unknown>, available: readonly string[], firstOnline = ''): Workspace {
  const saved = decodeWorkspace(prefs.workspace, prefs.instanceOrder);
  if (saved) return normalizeWorkspace(saved, available);
  const opened = Array.isArray(prefs.opened) ? prefs.opened.filter((id): id is string => typeof id === 'string') : firstOnline ? [firstOnline] : [];
  let state = normalizeWorkspace({opened, active: typeof prefs.active === 'string' ? prefs.active : '', order: normalizeOrder(prefs.instanceOrder, available), groups: []}, available);
  if (prefs.split === true && state.opened.length > 1) {
    const ordered = openedOrder(state);
    const other = ordered.find(id => id !== state.active)!;
    const pair = ordered.filter(id => id === state.active || id === other);
    state = normalizeWorkspace({...state, groups: [{left: pair[0], right: pair[1], focused: state.active === pair[0] ? 'left' : 'right', ratio: 0.5}]}, available);
  }
  return state;
}
export type WorkspaceAction =
  | {type: 'restore'; value: Workspace}
  | {type: 'reconcile'; available: string[]}
  | {type: 'select' | 'focus'; id: string}
  | {type: 'start'; id: string; right: string}
  | {type: 'close' | 'exit' | 'swap'; id: string}
  | {type: 'resize'; id: string; ratio: number}
  | {type: 'reorder'; id: string; target: string}
  | {type: 'move'; id: string; direction: -1 | 1};
export function workspaceReducer(state: Workspace, action: WorkspaceAction): Workspace {
  if (action.type === 'restore') return action.value;
  if (action.type === 'reconcile') return normalizeWorkspace(state, action.available);
  const group = groupFor(state, action.id);
  let next = state;
  switch (action.type) {
    case 'select': case 'focus': {
      if (!state.order.includes(action.id) || (action.type === 'focus' && !state.opened.includes(action.id))) return state;
      const opened = state.opened.includes(action.id) ? state.opened : [...state.opened, action.id];
      next = {...state, opened, active: action.id, groups: state.groups.map(g => g === group ? {...g, focused: action.id === g.left ? 'left' : 'right'} : g)};
      break;
    }
    case 'start': {
      const ordered = openedOrder(state);
      if (group || groupFor(state, action.right) || !state.opened.includes(action.id) || ordered[ordered.indexOf(action.id) + 1] !== action.right) return state;
      next = {...state, active: action.id, groups: [...state.groups, {left: action.id, right: action.right, focused: 'left', ratio: 0.5}]};
      break;
    }
    case 'close': {
      const activeGroup = activeSplit(state);
      const active = state.active === action.id || group && group === activeGroup ? (group ? group.left === action.id ? group.right : group.left : state.opened.find(id => id !== action.id) || '') : state.active;
      next = {...state, opened: state.opened.filter(id => id !== action.id), active, groups: state.groups.filter(g => g !== group)};
      break;
    }
    case 'exit': next = {...state, groups: state.groups.filter(g => g !== group)}; break;
    case 'swap':
      if (group) next = {...state, order: state.order.map(id => id === group.left ? group.right : id === group.right ? group.left : id), groups: state.groups.map(g => g === group ? {...g, left: g.right, right: g.left, focused: g.focused === 'left' ? 'right' : 'left'} : g)};
      break;
    case 'resize':
      if (group) next = {...state, groups: state.groups.map(g => g === group ? {...g, ratio: clampRatio(action.ratio)} : g)};
      break;
    case 'move': {
      const units = navigationUnits(state, state.opened.includes(action.id));
      const index = units.findIndex(ids => ids.includes(action.id));
      const target = units[index + action.direction]?.[0];
      return target ? workspaceReducer(state, {type: 'reorder', id: action.id, target}) : state;
    }
    case 'reorder': {
      const units = navigationUnits(state);
      const from = units.findIndex(ids => ids.includes(action.id)), to = units.findIndex(ids => ids.includes(action.target));
      if (from < 0 || to < 0 || from === to) return state;
      const [moving] = units.splice(from, 1); units.splice(to, 0, moving);
      next = {...state, order: units.flat()};
      break;
    }
  }
  const normalized = normalizeWorkspace(next, state.order);
  return sameWorkspace(state, normalized) ? state : normalized;
}

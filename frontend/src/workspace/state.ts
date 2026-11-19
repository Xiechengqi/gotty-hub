export type Tab = {id: string; hidden?: boolean};
export type SplitGroup = {id: string; members: string[]};
export type Unit = Tab | SplitGroup;

export type WorkspaceView = {active: string; focused: Record<string, string>; compactOrder: string[] | null; pagedGroups: string[]};
export type Workspace = {units: Unit[]; view: WorkspaceView};
export type LayoutAction =
  | {type: 'create'; id: string; group: string; members: string[]}
  | {type: 'join' | 'remove'; id: string; group: string}
  | {type: 'dissolve'; group: string}
  | {type: 'open'; id: string}
  | {type: 'reorder'; id: string; target: string; after: boolean};

export const emptyView = (): WorkspaceView => ({active: '', focused: {}, compactOrder: null, pagedGroups: []});
export const emptyWorkspace = (): Workspace => ({units: [], view: emptyView()});
export const isGroup = (unit: Unit): unit is SplitGroup => 'members' in unit;
export const tabIds = (unit: Unit): string[] => isGroup(unit) ? unit.members : [unit.id];
export const openedUnits = (units: Unit[]) => units.filter(unit => isGroup(unit) || !unit.hidden);
export const groupFor = (units: Unit[], id: string): SplitGroup | undefined =>
  units.find((unit): unit is SplitGroup => isGroup(unit) && unit.members.includes(id));

export function orderedIds(saved: string[], available: readonly string[]): string[] {
  const allowed = new Set(available);
  const order = [...new Set([...saved.filter(id => allowed.has(id)), ...available])];
  return order.length === saved.length && order.every((id, i) => id === saved[i]) ? saved : order;
}

export function navigationUnits(state: Workspace, wide: boolean): Unit[] {
  const units = openedUnits(state.units);
  return wide ? units : orderedIds(state.view.compactOrder ?? [], units.flatMap(tabIds)).map(id => ({id}));
}

export function rememberedMember(unit: Unit, view: WorkspaceView): string {
  if (!isGroup(unit)) return unit.id;
  const remembered = view.focused[unit.id];
  return unit.members.includes(remembered) ? remembered : unit.members[0];
}

export function displayView(previous: Workspace, units: Unit[], preferred = ''): WorkspaceView {
  const {view} = previous;
  const ids = openedUnits(units).flatMap(tabIds);
  const opened = new Set(ids);
  const formerGroup = groupFor(previous.units, view.active);
  const active = opened.has(view.active) ? view.active
    : formerGroup?.members.find(id => opened.has(id)) || (opened.has(preferred) ? preferred : ids[0]) || '';
  const compactOrder = view.compactOrder && orderedIds(view.compactOrder, ids);
  return {...view, active, compactOrder};
}

export function selectInstance(state: Workspace, id: string, wide: boolean): Workspace {
  if (!openedUnits(state.units).some(unit => tabIds(unit).includes(id))) return state;
  const group = wide ? groupFor(state.units, id) : undefined;
  const {view} = state;
  if (view.active === id && (!group || view.focused[group.id] === id)) return state;
  const focused = group ? {...view.focused, [group.id]: id} : view.focused;
  return {...state, view: {...view, active: id, focused}};
}

export function reconcileUnits(units: Unit[], available: string[]): Unit[] {
  const allowed = new Set(available), used = new Set<string>();
  const result: Unit[] = [];
  for (const unit of units) {
    if (isGroup(unit)) {
      const members = unit.members.filter(id => {
        if (!allowed.has(id) || used.has(id)) return false;
        used.add(id);
        return true;
      });
      if (members.length > 1) result.push(members.length === unit.members.length ? unit : {...unit, members});
      else if (members.length) result.push({id: members[0]});
    } else if (allowed.has(unit.id) && !used.has(unit.id)) {
      result.push(unit);
      used.add(unit.id);
    }
  }
  for (const id of available) if (!used.has(id)) result.push({id});
  return result.length === units.length && result.every((unit, i) => unit === units[i]) ? units : result;
}

export function reorder<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from === to) return items;
  const next = items.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

// A stale or invalid intent returns undefined. An already applied intent is a no-op.
export function applyLayout(units: Unit[], action: LayoutAction): Unit[] | undefined {
  if (action.type === 'reorder') {
    const from = units.findIndex(unit => unit.id === action.id), to = units.findIndex(unit => unit.id === action.target);
    if (from < 0 || to < 0) return;
    if (from === to) return units;
    return reorder(units, from, to + Number(action.after) - Number(from < to));
  }
  if (action.type === 'open') {
    const tab = units.find(unit => unit.id === action.id);
    if (!tab) return groupFor(units, action.id) ? units : undefined;
    return !isGroup(tab) && tab.hidden ? units.map(unit => unit === tab ? {id: tab.id} : unit) : units;
  }
  const target = units.find(unit => unit.id === action.group);
  const group = target && isGroup(target) ? target : undefined;
  if (action.type === 'create') {
    const ids = new Set([action.id, ...action.members]);
    if (ids.size < 2 || ids.size !== action.members.length + 1) return;
    if (group && [...ids].every(id => group.members.includes(id))) return units;
    const singles = units.filter(unit => !isGroup(unit) && ids.has(unit.id));
    if (target || singles.length !== ids.size) return;
    const replacement = {id: action.group, members: [action.id, ...singles.map(unit => unit.id).filter(id => id !== action.id)]};
    return units.flatMap(unit => unit.id === action.id ? [replacement] : ids.has(unit.id) ? [] : [unit]);
  }
  if (action.type === 'dissolve') {
    return group ? units.flatMap(unit => unit === group ? group.members.map(id => ({id})) : [unit]) : units;
  }
  if (action.type === 'join') {
    if (group?.members.includes(action.id)) return units;
    if (!group || !units.some(unit => !isGroup(unit) && unit.id === action.id)) return;
    return units.flatMap(unit => unit === group ? [{...group, members: [...group.members, action.id]}] : unit.id === action.id ? [] : [unit]);
  }
  if (!group?.members.includes(action.id)) return units;
  const members = group.members.filter(id => id !== action.id);
  const remainder = members.length > 1 ? {...group, members} : {id: members[0]};
  return units.flatMap(unit => unit === group ? [remainder, {id: action.id}] : [unit]);
}

export const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string');

type OldPair = {left: string; right: string; focused: 'left' | 'right'};
function oldPair(value: unknown): value is OldPair {
  if (!value || typeof value !== 'object') return false;
  const pair = value as OldPair;
  return typeof pair.left === 'string' && typeof pair.right === 'string' && (pair.focused === 'left' || pair.focused === 'right');
}

export function migrateWorkspace(prefs: Record<string, unknown>, available: string[], preferred: string, pending?: unknown): Workspace {
  const legacy = legacyLayout(pending) ?? legacyLayout(prefs.workspace);
  const version = legacy?.schemaVersion;
  const savedOrder = strings(legacy?.order) ? legacy.order : strings(prefs.instanceOrder) ? prefs.instanceOrder : [];
  const order = orderedIds(savedOrder, available);
  const savedOpened = legacy?.opened ?? prefs.opened;
  const opened = new Set(strings(savedOpened) ? savedOpened : available);
  const active = legacy?.active ?? prefs.active;
  const view = {...emptyView(), active: typeof active === 'string' ? active : preferred};
  const rawPairs = legacy ? version === 1 ? [legacy.split] : legacy.groups : [];
  const pairs = Array.isArray(rawPairs) ? rawPairs.filter(oldPair) : [];
  if (!legacy && prefs.split === true) {
    const other = order.find(id => id !== view.active && opened.has(id));
    const valid = order.includes(view.active) && opened.has(view.active);
    if (other && valid) pairs.push(order.indexOf(other) < order.indexOf(view.active)
      ? {left: other, right: view.active, focused: 'right'}
      : {left: view.active, right: other, focused: 'left'});
  }

  const known = new Set(order), consumed = new Set<string>();
  const byLeft = new Map<string, SplitGroup>();
  for (const pair of pairs) {
    const members = [pair.left, pair.right].filter(id => known.has(id) && opened.has(id) && !consumed.has(id));
    if (members.length === 2 && members[0] !== members[1]) {
      const group = {id: 'split-' + pair.left, members};
      byLeft.set(pair.left, group);
      for (const id of members) consumed.add(id);
      view.focused[group.id] = pair[pair.focused];
    } else if (members.length === 1 && (pair.left === view.active || pair.right === view.active) && !known.has(view.active)) {
      view.active = members[0];
    }
  }
  const oldOrder = new Set(savedOrder);
  const units: Unit[] = [];
  for (const id of order) {
    const group = byLeft.get(id);
    if (group) units.push(group);
    else if (!consumed.has(id)) units.push(oldOrder.has(id) && !opened.has(id) ? {id, hidden: true} : {id});
  }
  return {units, view: displayView({units, view}, units, preferred)};
}

function legacyLayout(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return;
  const layout = value as Record<string, unknown>;
  const version = layout.schemaVersion;
  if (typeof layout.active !== 'string' || !strings(layout.opened)) return;
  if (version === 1 && (layout.split === null || oldPair(layout.split))) return layout;
  if ((version === 2 || version === 3) && strings(layout.order) && Array.isArray(layout.groups)) return layout;
}

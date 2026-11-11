export type Pane = 'left' | 'right';
export type Split = {left: string; right: string; focused: Pane; ratio: number};
export type Workspace = {opened: string[]; active: string; split: Split | null};
export type SavedWorkspace = Workspace & {schemaVersion: 1};
export const MIN_PANE_WIDTH = 360;
export const DIVIDER_WIDTH = 8;
export const emptyWorkspace = (): Workspace => ({opened: [], active: '', split: null});

export function clampRatio(value: number, minimum = 0.1): number {
  return Math.min(1 - minimum, Math.max(minimum, Number.isFinite(value) ? value : 0.5));
}

export function sameWorkspace(a: Workspace, b: Workspace): boolean {
  return a.active === b.active && a.opened.length === b.opened.length && a.opened.every((id, index) => id === b.opened[index]) &&
    (a.split === b.split || !!a.split && !!b.split && a.split.left === b.split.left && a.split.right === b.split.right && a.split.focused === b.split.focused && a.split.ratio === b.split.ratio);
}

export function normalizeWorkspace(value: Workspace, available: readonly string[]): Workspace {
  const allowed = new Set(available);
  const opened = [...new Set(value.opened.filter(id => typeof id === 'string' && allowed.has(id)))];
  const contains = (id: string) => opened.includes(id);
  let active = contains(value.active) ? value.active : opened[0] || '';
  let split: Split | null = null;
  if (value.split) {
    const {left, right, focused, ratio} = value.split;
    if (left !== right && contains(left) && contains(right)) split = {left, right, focused, ratio: clampRatio(ratio)};
    else if (contains(left) || contains(right)) active = contains(left) ? left : right;
  }
  const next = {opened, active, split};
  return sameWorkspace(value, next) ? value : next;
}

export function decodeWorkspace(value: unknown): Workspace | undefined {
  if (!value || typeof value !== 'object') return;
  const saved = value as Partial<SavedWorkspace>;
  if (saved.schemaVersion !== 1 || !Array.isArray(saved.opened) || saved.opened.some(id => typeof id !== 'string') || typeof saved.active !== 'string') return;
  const split = saved.split;
  if (split !== null && (!split || typeof split.left !== 'string' || typeof split.right !== 'string' || !['left', 'right'].includes(split.focused) || typeof split.ratio !== 'number' || !Number.isFinite(split.ratio))) return;
  return normalizeWorkspace({opened: saved.opened, active: saved.active, split}, saved.opened);
}

export function saveWorkspace(value: Workspace): SavedWorkspace {
  return {schemaVersion: 1, ...value};
}

// Infer the old visible pair once. Navigation order never recomputes a new pair.
export function workspaceFromPreferences(prefs: Record<string, unknown>, available: readonly string[], firstOnline = ''): Workspace {
  const saved = decodeWorkspace(prefs.workspace);
  if (saved) return normalizeWorkspace(saved, available);
  const opened = Array.isArray(prefs.opened) ? prefs.opened.filter((id): id is string => typeof id === 'string') : firstOnline ? [firstOnline] : [];
  let state = normalizeWorkspace({opened, active: typeof prefs.active === 'string' ? prefs.active : '', split: null}, available);
  if (prefs.split === true && state.opened.length > 1) {
    const order = [...new Set([...(Array.isArray(prefs.instanceOrder) ? prefs.instanceOrder : []), ...available])].filter((id): id is string => typeof id === 'string' && state.opened.includes(id));
    const other = order.find(id => id !== state.active)!;
    const pair = order.filter(id => id === state.active || id === other);
    state = {...state, split: {left: pair[0], right: pair[1], focused: state.active === pair[0] ? 'left' : 'right', ratio: 0.5}};
  }
  return state;
}

export type WorkspaceAction =
  | {type: 'restore'; value: Workspace}
  | {type: 'reconcile'; available: string[]}
  | {type: 'select'; id: string; inSplit: boolean}
  | {type: 'focus'; id: string}
  | {type: 'start'; id: string}
  | {type: 'replace'; pane: Pane; id: string}
  | {type: 'close'; id: string}
  | {type: 'exit'; active: string}
  | {type: 'swap'}
  | {type: 'resize'; ratio: number};

export function workspaceReducer(state: Workspace, action: WorkspaceAction): Workspace {
  let next = state;
  const split = state.split;
  const open = (id: string) => state.opened.includes(id) ? state.opened : [...state.opened, id];
  switch (action.type) {
    case 'restore': next = action.value; break;
    case 'reconcile': return normalizeWorkspace(state, action.available);
    case 'select': {
      if (!action.id) return state;
      next = {...state, opened: open(action.id), active: action.id};
      if (split && action.inSplit) {
        const pane = action.id === split.left ? 'left' : action.id === split.right ? 'right' : split.focused;
        next.split = {...split, [pane]: action.id, focused: pane};
      }
      break;
    }
    case 'focus': {
      if (!state.opened.includes(action.id)) return state;
      const pane = split && (action.id === split.left ? 'left' : action.id === split.right ? 'right' : null);
      next = {...state, active: action.id, split: pane ? {...split!, focused: pane} : split};
      break;
    }
    case 'start':
      if (!state.active || !action.id || action.id === state.active) return state;
      next = {...state, opened: open(action.id), split: {left: state.active, right: action.id, focused: 'left', ratio: 0.5}};
      break;
    case 'replace': {
      if (!split || !action.id) return state;
      if (action.id === split.left || action.id === split.right) return workspaceReducer(state, {type: 'focus', id: action.id});
      next = {...state, opened: open(action.id), active: action.id, split: {...split, [action.pane]: action.id, focused: action.pane}};
      break;
    }
    case 'close': {
      const opened = state.opened.filter(id => id !== action.id);
      const paired = split && (split.left === action.id || split.right === action.id);
      const active = paired ? (split.left === action.id ? split.right : split.left) : state.active === action.id ? opened[0] || '' : state.active;
      next = {opened, active, split: paired ? null : split};
      break;
    }
    case 'exit': next = {...state, active: state.opened.includes(action.active) ? action.active : state.active, split: null}; break;
    case 'swap':
      if (split) next = {...state, active: split[split.focused], split: {...split, left: split.right, right: split.left, focused: split.focused === 'left' ? 'right' : 'left'}};
      break;
    case 'resize': if (split) next = {...state, split: {...split, ratio: clampRatio(action.ratio)}}; break;
  }
  return sameWorkspace(state, next) ? state : next;
}

import {strings, type LayoutAction, type WorkspaceView} from './workspace/state';

export function currentPreferences(value: Record<string, unknown>): Record<string, unknown> {
  const retired = new Set(['dark', 'toolbarPinned', 'maximized', 'sidebarCollapsed', 'navbarCollapsed']);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !retired.has(key)));
}
export function forgetChromeSettings(account: string) {
  try {
    localStorage.removeItem('gotty-hub.theme');
    localStorage.removeItem(`gotty-hub:layout:${encodeURIComponent(account)}`);
  } catch { /* Storage may be disabled. */ }
}

export type LayoutEdit = {writeId: string; action: LayoutAction};
type Draft = {view: WorkspaceView; edits: LayoutEdit[]};
const draftKey = (account: string) => `gotty-hub:workspace-view:${encodeURIComponent(account)}`;
const compactOrderKey = (account: string) => `gotty-hub:compact-tab-order:${encodeURIComponent(account)}`;

function validEdit(edit: LayoutEdit): boolean {
  if (!edit?.action || typeof edit.writeId !== 'string' || !/^[a-f0-9]{32}$/.test(edit.writeId)) return false;
  const action = edit.action;
  switch (action.type) {
    case 'create': return typeof action.id === 'string' && typeof action.group === 'string' && strings(action.members);
    case 'join':
    case 'remove': return typeof action.id === 'string' && typeof action.group === 'string';
    case 'dissolve': return typeof action.group === 'string';
    case 'open': return typeof action.id === 'string';
    case 'reorder': return typeof action.id === 'string' && typeof action.target === 'string' && typeof action.after === 'boolean';
    default: return false;
  }
}

export function readWorkspaceDraft(account: string): Draft | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(account)) ?? 'null') as Draft | null;
    if (value && typeof value.view?.active === 'string' && (value.view.compactOrder === null || strings(value.view.compactOrder))
      && value.view.focused && typeof value.view.focused === 'object' && !Array.isArray(value.view.focused)
      && Object.values(value.view.focused).every(id => typeof id === 'string') && strings(value.view.pagedGroups)
      && Array.isArray(value.edits)) return {...value, edits: value.edits.filter(validEdit)};
  } catch { /* Storage may be disabled. */ }
}

export function rememberWorkspaceDraft(account: string, value: Draft) {
  try {sessionStorage.setItem(draftKey(account), JSON.stringify(value));} catch { /* Best effort. */ }
}

export function readCompactOrder(account: string): string[] | undefined {
  try {
    const order: unknown = JSON.parse(localStorage.getItem(compactOrderKey(account)) ?? 'null');
    if (strings(order)) return order;
  } catch { /* The view can still keep its order in memory. */ }
}

export function rememberCompactOrder(account: string, order: string[]) {
  try {localStorage.setItem(compactOrderKey(account), JSON.stringify(order));} catch { /* Best effort. */ }
}

export function legacyWorkspaceDraft(account: string): unknown {
  try {
    const key = `gotty-hub:workspace:${encodeURIComponent(account)}`;
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved?.pending === true) return saved.workspace;
  } catch { /* Server preferences remain usable. */ }
}

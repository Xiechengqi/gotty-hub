import {randomId} from './random';
import {decodeWorkspace, reconcileWorkspace, sameWorkspace, saveWorkspace, workspaceFromPreferences, type SavedWorkspace, type Workspace} from './workspace/state';
// Retired chrome choices must not survive the generic preference merge.
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

type WorkspaceCache = {workspace: SavedWorkspace; revision: string; pending: boolean};
const workspaceKey = (account: string) => `gotty-hub:workspace:${encodeURIComponent(account)}`;

export function readWorkspaceCache(account: string): WorkspaceCache | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(workspaceKey(account)) ?? 'null');
    if (value && typeof value.revision === 'string' && typeof value.pending === 'boolean' && decodeWorkspace(value.workspace)) return value;
  } catch { /* Server preferences remain usable when local storage is unavailable. */ }
}

export function rememberWorkspace(account: string, workspace: Workspace, pending = true): WorkspaceCache {
  const value = {workspace: saveWorkspace(workspace), revision: randomId(), pending};
  try {localStorage.setItem(workspaceKey(account), JSON.stringify(value));} catch { /* Best effort. */ }
  return value;
}

export function restoreWorkspace(account: string, prefs: Record<string, unknown>, available: string[], firstOnline = ''): Workspace {
  const local = readWorkspaceCache(account);
  const pending = local?.pending ? decodeWorkspace(local.workspace, prefs.instanceOrder) : undefined;
  const restored = pending ? reconcileWorkspace(pending, available, local?.workspace.schemaVersion !== 3) : workspaceFromPreferences(prefs, available, firstOnline);
  if (!pending || local?.workspace.schemaVersion !== 3 || !sameWorkspace(pending, restored)) rememberWorkspace(account, restored, !!pending);
  return restored;
}

export function acknowledgeWorkspace(account: string, revision: string | undefined, workspace: Workspace) {
  const value = readWorkspaceCache(account);
  const saved = value && decodeWorkspace(value.workspace);
  if (value && saved && value.revision === revision && sameWorkspace(saved, workspace)) {
    try {localStorage.setItem(workspaceKey(account), JSON.stringify({...value, pending: false}));} catch { /* Best effort. */ }
  }
}

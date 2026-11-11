import {randomId} from './random';
import {decodeWorkspace, normalizeWorkspace, sameWorkspace, saveWorkspace, workspaceFromPreferences, type SavedWorkspace, type Workspace} from './workspace/state';
type Layout = {maximized: boolean; revision: string; pending: boolean};
const key = (account: string) => `gotty-hub:layout:${encodeURIComponent(account)}`;

export function readLayout(account: string): Layout | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key(account)) ?? 'null');
    if (value && typeof value.maximized === 'boolean' && typeof value.revision === 'string' && typeof value.pending === 'boolean') return value;
  } catch { /* Storage can be disabled or contain old/corrupt data. */ }
}

export function rememberMaximized(account: string, maximized: boolean, pending = true): Layout {
  const value = {maximized, revision: randomId(), pending};
  try {localStorage.setItem(key(account), JSON.stringify(value));} catch { /* Server persistence still works. */ }
  return value;
}

export function restoreMaximized(account: string, remote: unknown): boolean {
  const local = readLayout(account);
  // A reload before the save was acknowledged must retain the user's click.
  if (local?.pending) return local.maximized;
  const value = typeof remote === 'boolean' ? remote : local?.maximized ?? false;
  rememberMaximized(account, value, false);
  return value;
}

export function acknowledgeLayout(account: string, revision: string | undefined, maximized: boolean) {
  const value = readLayout(account);
  // An earlier request finishing must not acknowledge a newer unsaved choice.
  if (value && value.revision === revision && value.maximized === maximized) {
    try {localStorage.setItem(key(account), JSON.stringify({...value, pending: false}));} catch { /* Best effort. */ }
  }
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
  const pending = local?.pending ? decodeWorkspace(local.workspace) : undefined;
  const restored = pending ? normalizeWorkspace(pending, available) : workspaceFromPreferences(prefs, available, firstOnline);
  if (!pending || !sameWorkspace(pending, restored)) rememberWorkspace(account, restored, !!pending);
  return restored;
}

export function acknowledgeWorkspace(account: string, revision: string | undefined, workspace: Workspace) {
  const value = readWorkspaceCache(account);
  const saved = value && decodeWorkspace(value.workspace);
  if (value && saved && value.revision === revision && sameWorkspace(saved, workspace)) {
    try {localStorage.setItem(workspaceKey(account), JSON.stringify({...value, pending: false}));} catch { /* Best effort. */ }
  }
}

import {randomId} from './random';
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

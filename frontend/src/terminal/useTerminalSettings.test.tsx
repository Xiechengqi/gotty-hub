import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {api, APIError} from '../api';
import {cachedSettings, DEFAULT_SETTINGS, type SettingsSnapshot} from './settings';
import {useTerminalSettings} from './useTerminalSettings';

vi.mock('../api', async original => ({...await original<typeof import('../api')>(), api: vi.fn()}));
let node: HTMLDivElement, root: Root, current: ReturnType<typeof useTerminalSettings>;
function Probe({account}: {account: string}) {current = useTerminalSettings(account); return null;}
const snapshot = (revision: number, fontSize: number): SettingsSnapshot => ({revision, settings: {...DEFAULT_SETTINGS, fontSize}});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
beforeEach(() => {
  localStorage.clear(); vi.mocked(api).mockReset();
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
});
afterEach(async () => {await act(async () => root.unmount()); node.remove();});

it('discards a stale focus response that arrives after a successful save', async () => {
  vi.mocked(api).mockResolvedValueOnce(snapshot(1, 14));
  await act(async () => root.render(<Probe account="first"/>));
  const stale = deferred<SettingsSnapshot>();
  vi.mocked(api).mockReturnValueOnce(stale.promise);
  await act(async () => window.dispatchEvent(new Event('focus')));
  vi.mocked(api).mockResolvedValueOnce(snapshot(2, 20));
  await act(async () => current.save({...DEFAULT_SETTINGS, fontSize: 20}, 1));
  await act(async () => stale.resolve(snapshot(1, 14)));
  expect(current.snapshot).toEqual(snapshot(2, 20));
  expect(cachedSettings('first')).toEqual(snapshot(2, 20));
});

it('never applies an old account save response after switching accounts', async () => {
  vi.mocked(api).mockResolvedValueOnce(snapshot(1, 14));
  await act(async () => root.render(<Probe account="first"/>));
  const pending = deferred<SettingsSnapshot>();
  vi.mocked(api).mockReturnValueOnce(pending.promise);
  const result = current.save({...DEFAULT_SETTINGS, fontSize: 20}, 1).catch(error => error.message);
  vi.mocked(api).mockResolvedValueOnce(snapshot(4, 24));
  await act(async () => root.render(<Probe account="second"/>));
  await act(async () => pending.resolve(snapshot(2, 20)));
  expect(await result).toBe('authentication_required');
  expect(current.snapshot).toEqual(snapshot(4, 24));
  expect(cachedSettings('second')).toEqual(snapshot(4, 24));
  expect(cachedSettings('first')).toEqual(snapshot(1, 14));
});

it('refreshes the server snapshot on conflict without overwriting newer settings', async () => {
  vi.mocked(api).mockResolvedValueOnce(snapshot(1, 14));
  await act(async () => root.render(<Probe account="first"/>));
  vi.mocked(api).mockRejectedValueOnce(new APIError(409, 'terminal_settings_conflict')).mockResolvedValueOnce(snapshot(2, 22));
  await act(async () => {
    await expect(current.save({...DEFAULT_SETTINGS, fontSize: 18}, 1)).rejects.toThrow('terminal_settings_conflict');
  });
  expect(current.snapshot).toEqual(snapshot(2, 22));
  expect(cachedSettings('first')).toEqual(snapshot(2, 22));
});

it('does not let an old account conflict invalidate the new account initial load', async () => {
  vi.mocked(api).mockResolvedValueOnce(snapshot(1, 14));
  await act(async () => root.render(<Probe account="first"/>));
  const pending = deferred<SettingsSnapshot>(), nextAccount = deferred<SettingsSnapshot>();
  vi.mocked(api).mockReturnValueOnce(pending.promise);
  const result = current.save({...DEFAULT_SETTINGS, fontSize: 20}, 1).catch(error => error.message);
  vi.mocked(api).mockReturnValueOnce(nextAccount.promise);
  await act(async () => root.render(<Probe account="second"/>));
  await act(async () => pending.reject(new APIError(409, 'terminal_settings_conflict')));
  expect(await result).toBe('authentication_required');
  await act(async () => nextAccount.resolve(snapshot(4, 24)));
  expect(current.loading).toBe(false);
  expect(current.snapshot).toEqual(snapshot(4, 24));
});

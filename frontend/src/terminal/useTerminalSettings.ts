import {useEffect, useRef, useState} from 'react';
import {api, APIError} from '../api';
import {cachedSettings, parseSnapshot, rememberSettings, settingsKey, type SettingsSnapshot, type TerminalSettings} from './settings';

export function useTerminalSettings(account?: string) {
  const active = useRef(account); active.current = account;
  const epoch = useRef(0);
  const identity = useRef(0);
  const [state, setState] = useState<{account?: string; snapshot: SettingsSnapshot; loading: boolean; error: string}>({snapshot: {revision: 0, settings: null}, loading: !!account, error: ''});
  useEffect(() => {
    ++identity.current;
    const controller = new AbortController();
    if (!account) {setState({snapshot: {revision: 0, settings: null}, loading: false, error: ''}); return;}
    setState({account, snapshot: cachedSettings(account), loading: true, error: ''});
    const load = async () => {
      const revision = ++epoch.current;
      try {
        const snapshot = parseSnapshot(await api('/me/terminal-settings', undefined, undefined, controller.signal));
        if (!controller.signal.aborted && revision === epoch.current) {
          rememberSettings(account, snapshot); setState({account, snapshot, loading: false, error: ''});
        }
      } catch (error) {
        if (!controller.signal.aborted && revision === epoch.current) setState(previous => ({...previous, loading: false, error: error instanceof Error ? error.message : String(error)}));
      }
    };
    const focus = () => {if (document.visibilityState === 'visible') void load();};
    const storage = (event: StorageEvent) => {if (event.key === settingsKey(account)) void load();};
    void load(); window.addEventListener('focus', focus); window.addEventListener('storage', storage);
    return () => {controller.abort(); ++identity.current; ++epoch.current; window.removeEventListener('focus', focus); window.removeEventListener('storage', storage);};
  }, [account]);
  const save = async (settings: TerminalSettings, revision: number) => {
    if (!account) throw Error('authentication_required');
    const owner = identity.current;
    ++epoch.current;
    let snapshot: SettingsSnapshot;
    try {snapshot = parseSnapshot(await api('/me/terminal-settings', {revision, settings}, 'PUT'));}
    catch (error) {
      if (active.current !== account || identity.current !== owner) throw Error('authentication_required');
      // Another browser may save without producing a local storage event.
      // Refresh the base snapshot so reopening the dialog can resolve a 409.
      if (error instanceof APIError && error.status === 409) {
        const request = ++epoch.current;
        try {
          const current = parseSnapshot(await api('/me/terminal-settings'));
          if (active.current === account && identity.current === owner && epoch.current === request) {
            rememberSettings(account, current); setState({account, snapshot: current, loading: false, error: ''});
          }
        } catch { /* Keep the draft and report the original conflict. */ }
      }
      throw error;
    }
    if (active.current !== account || identity.current !== owner) throw Error('authentication_required');
    ++epoch.current;
    rememberSettings(account, snapshot); setState({account, snapshot, loading: false, error: ''});
  };
  return {snapshot: state.account === account ? state.snapshot : account ? cachedSettings(account) : {revision: 0, settings: null},
    loading: !!account && (state.account !== account || state.loading), error: state.account === account ? state.error : '', save};
}

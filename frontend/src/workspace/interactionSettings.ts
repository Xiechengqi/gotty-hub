import {useEffect, useRef, useState} from 'react';

export const interactionSettingsKey = (account: string) => `gotty-hub:interaction:${encodeURIComponent(account)}`;
export function defaultTabSwipe(device: Pick<Navigator, 'platform' | 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  return /Mac/.test(device.platform + ' ' + device.userAgent)
    && !/iPad|iPhone|iPod/.test(device.userAgent)
    && !(device.platform === 'MacIntel' && device.maxTouchPoints > 1);
}
export function readTabSwipe(account: string | undefined): boolean {
  try {
    const saved = account && JSON.parse(localStorage.getItem(interactionSettingsKey(account)) || 'null');
    if (saved?.schemaVersion === 1 && typeof saved.tabSwipe === 'boolean') return saved.tabSwipe;
  } catch { /* Use the device default if storage is blocked or invalid. */ }
  return defaultTabSwipe();
}

// Hardware-dependent choices stay in this browser, outside account appearance.
export function useInteractionSettings(account?: string) {
  const owner = useRef(account); owner.current = account;
  const [state, setState] = useState(() => ({account, tabSwipe: readTabSwipe(account)}));
  useEffect(() => {
    const refresh = () => setState({account, tabSwipe: readTabSwipe(account)});
    const storage = (event: StorageEvent) => {
      if (event.key === null || account && event.key === interactionSettingsKey(account)) refresh();
    };
    refresh(); window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, [account]);
  return {
    tabSwipe: state.account === account ? state.tabSwipe : readTabSwipe(account),
    defaultTabSwipe: defaultTabSwipe(),
    saveTabSwipe: (tabSwipe: boolean) => {
      if (!account || owner.current !== account) throw Error('authentication_required');
      try {localStorage.setItem(interactionSettingsKey(account), JSON.stringify({schemaVersion: 1, tabSwipe}));}
      catch { /* Keep the setting for this session when storage is blocked. */ }
      setState({account, tabSwipe});
    },
  };
}

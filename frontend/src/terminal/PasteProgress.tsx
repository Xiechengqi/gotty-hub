import {useEffect, useState, useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {pasteBytes, pasteText, type PasteState} from '@gotty/terminal-core/paste';
import {Button} from '@/components/base/buttons/button';
import {useDirection} from '@/components/foundations/direction/direction';

type Entry = {instance: string; name: string; state: PasteState; cancel: () => void; dismiss: () => void};
let entries: Entry[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};};
const snapshot = () => entries;

export function reportPaste(instance: string, name: string, state: PasteState | undefined, cancel = () => {}, dismiss = () => {}) {
  const index = entries.findIndex(entry => entry.instance === instance);
  if (!state?.visible && index < 0) return;
  entries = [...entries];
  if (!state?.visible) entries.splice(index, 1);
  else if (index >= 0) entries[index] = {instance, name, state, cancel, dismiss};
  else entries.push({instance, name, state, cancel, dismiss});
  for (const listener of listeners) listener();
}

// One page-level layer also covers hidden tabs/split panes. No modal, backdrop,
// focus trap or terminal layout changes; concurrent tasks form a single stack.
export function PasteProgress({locale}: {locale: string}) {
  const tasks = useSyncExternalStore(subscribe, snapshot);
  const direction = useDirection();
  const [viewport, setViewport] = useState({left: 0, top: 0, width: window.innerWidth, height: window.innerHeight});
  useEffect(() => {
    const measure = () => {const v = window.visualViewport; setViewport({left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? window.innerWidth, height: v?.height ?? window.innerHeight});};
    measure(); window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure); window.visualViewport?.addEventListener('scroll', measure);
    return () => {window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('scroll', measure);};
  }, []);
  const zh = locale === 'zh-CN';
  if (!tasks.length) return null;
  return createPortal(<div className="terminal-paste-layer" dir={direction} lang={locale} style={viewport}>
    {tasks.map(({instance, name, state, cancel, dismiss}) => {
      const active = state.status === 'running' || state.status === 'stopping';
      const percent = Math.floor(state.loaded * 100 / state.total);
      return <section key={instance} className="terminal-paste-card rounded-3xl border border-border-button-default bg-background-primary-default p-4 text-text-primary" data-instance-id={instance} data-paste-status={state.status} aria-label={zh ? '粘贴进度' : 'Paste progress'}>
        <div className="flex items-center justify-between gap-4"><bdi className="min-w-0 truncate text-body-medium">{name}</bdi><Button variant="secondary" size="small" onMouseDown={event => event.preventDefault()} disabled={state.status === 'stopping'} onClick={active ? cancel : dismiss}>{active ? (zh ? '停止' : 'Stop') : (zh ? '关闭' : 'Close')}</Button></div>
        <progress className="terminal-upload-progress" aria-label={(zh ? '粘贴进度 · ' : 'Paste progress · ') + name} value={state.loaded} max={state.total}/>
        <p className="text-body-2-regular text-text-secondary" dir="ltr">{percent}% · {pasteBytes(state.loaded)} / {pasteBytes(state.total)}</p>
        <p className="text-body-2-regular" role={state.status === 'error' ? 'alert' : 'status'}>{pasteText(state, zh)}</p>
      </section>;
    })}
  </div>, document.body);
}

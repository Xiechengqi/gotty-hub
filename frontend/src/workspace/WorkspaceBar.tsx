import {useEffect, useRef, useState} from 'react';
import {RiArrowDownSLine, RiCloseLine, RiMoreLine, RiPushpinLine, RiUnpinLine, RiRefreshLine, RiSunLine, RiMoonLine, RiTranslate2, RiAddLine} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import {Drawer, DrawerHeader, DrawerBody} from '@/components/base/drawer/drawer';
import {cx} from '@/utils/cx';
import {SettingsMenu, type SettingsAction} from '../SettingsMenu';
import type {TerminalActions} from '../terminal/Terminal';
import {WorkspaceSortProvider, WorkspaceSortList, SortableWorkspaceUnit} from '../instances/SortableInstances';
import {translate, type Locale} from '../i18n';
import {groupFor, navigationUnits, openedOrder, type Workspace, type WorkspaceAction} from './state';
import type {PaneInstance} from './WorkspaceControls';
import {TabActionsMenu} from './TabActionsMenu';
import {useWorkspaceChrome} from './useWorkspaceChrome';

type Props = {
  workspace: Workspace; instances: PaneInstance[]; actions: Record<string, TerminalActions>; locale: Locale; mobile: boolean;
  pinned: boolean; onPin: (value: boolean) => void; canSplit: boolean; locked: boolean; dark: boolean; onDark: () => void; onLocale: () => void;
  accountName?: string; admin: boolean; authenticated: boolean; onLogin: () => void; onSettings: (action: SettingsAction) => void;
  onSelect: (id: string, focus?: boolean) => void; onBrowseSelect: (id: string) => void; onManage: (id: string) => void; onConnect: () => void;
  onChange: (action: WorkspaceAction) => void; onClose: (id: string) => void; onFocus: () => void;
};
export function WorkspaceBar(props: Props) {
  const {workspace, instances, locale, mobile, pinned, canSplit} = props;
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const [browse, setBrowse] = useState(false), [onlyOpened, setOnlyOpened] = useState(false), [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{key: string; right?: string} | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false), [dragging, setDragging] = useState(false);
  const bar = useRef<HTMLElement>(null), strip = useRef<HTMLDivElement>(null);
  const chrome = useWorkspaceChrome(pinned, !workspace.opened.length || !props.authenticated, props.locked || browse || !!menu || settingsOpen || dragging);
  const opened = openedOrder(workspace), units = navigationUnits(workspace, true);
  const byId = (id: string) => instances.find(i => i.id === id);
  const current = byId(workspace.active);
  const openBrowser = (openedOnly: boolean) => {setOnlyOpened(openedOnly); setQuery(''); setBrowse(true);};
  useEffect(() => {if (!browse) setMenu(value => value?.key.startsWith('directory:') ? null : value);}, [browse]);
  useEffect(() => {if (menu && !instances.some(i => menu.key.endsWith(':' + i.id))) setMenu(null);}, [instances, menu]);
  useEffect(() => {
    if (mobile || menu || dragging) return;
    const frame = requestAnimationFrame(() => {
      if (strip.current?.contains(document.activeElement)) return;
      const unit = strip.current?.querySelector<HTMLElement>('[data-tab-id="' + CSS.escape(workspace.active) + '"]')?.closest<HTMLElement>('.workspace-tab-unit');
      if (!unit || !strip.current) return;
      const bounds = unit.getBoundingClientRect(), viewport = strip.current.getBoundingClientRect();
      // Do not move a visible tab under the pointer when right-dragging it.
      if (bounds.left < viewport.left) strip.current.scrollLeft += bounds.left - viewport.left;
      else if (bounds.right > viewport.right) strip.current.scrollLeft += bounds.right - viewport.right;
    });
    return () => cancelAnimationFrame(frame);
  }, [workspace.active, workspace.order, mobile, menu, dragging]);
  const menuFor = (instance: PaneInstance, scope: 'tabs' | 'directory') => {
    const key = scope + ':' + instance.id, pair = groupFor(workspace, instance.id);
    const menuOrder = workspace.opened.includes(instance.id) ? opened : workspace.order.filter(id => workspace.opened.includes(id) || id === instance.id);
    const next = menuOrder[menuOrder.indexOf(instance.id) + 1];
    const neighborId = menu?.key === key ? menu.right : next;
    const right = neighborId ? byId(neighborId) : undefined;
    const reason = !workspace.opened.includes(instance.id) || !right ? t('noRightTab') : next !== neighborId ? t('splitOrderChanged') : groupFor(workspace, right.id) ? t('neighborGrouped') : !instance.online || !right.online ? t('offline') : !canSplit ? t('splitWidthHint') : undefined;
    return <TabActionsMenu instance={instance} locale={locale} actions={props.actions[instance.id]} paired={!!pair} right={right} splitReason={reason} open={menu?.key === key}
      onOpenChange={value => setMenu(current => value ? {key, right: next} : current?.key === key ? null : current)} onSelect={() => props.onSelect(instance.id, false)} compact={scope === 'directory'} onExecute={() => setBrowse(false)}
      onFocus={props.onFocus} onAction={(action, neighbor) => {
        if (action === 'manage') props.onManage(instance.id);
        else if (action === 'close') props.onClose(instance.id);
        else if (action === 'left' || action === 'right') props.onChange({type: 'move', id: instance.id, direction: action === 'left' ? -1 : 1});
        else if (action === 'split') {if (!reason && neighbor) props.onChange({type: 'start', id: instance.id, right: neighbor});}
        else props.onChange({type: action, id: instance.id});
        if (action !== 'manage') props.onFocus();
      }}>
      {scope === 'directory' ? <RiMoreLine aria-hidden="true"/> : <span className="session-label">{instance.icon}<span className="session-name text-body-2-medium" dir="auto">{instance.label}</span>{pair && <span className="pane-tab-label text-caption-1-semibold">{t(pair.left === instance.id ? 'leftPane' : 'rightPane')}</span>}{!instance.writable && <span className="tab-readonly text-caption-1-regular">{t('readOnly')}</span>}</span>}
    </TabActionsMenu>;
  };
  const rightPress = (event: React.MouseEvent) => {
    if (event.button !== 2 || (event.target as Element).closest('[data-no-drag]')) return;
    const id = (event.target as Element).closest<HTMLElement>('[data-tab-id]')?.dataset.tabId;
    if (id) {setMenu(null); props.onSelect(id, false);}
  };
  const rightRelease = (event: React.MouseEvent) => {
    if (event.button === 2 && !dragging && !(event.target as Element).closest('[data-no-drag]')) props.onFocus();
  };
  const directoryUnits = navigationUnits(workspace, onlyOpened).filter(unit => unit.some(id => {
    const instance = byId(id); return instance && (instance.name + ' ' + instance.id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }));
  return <WorkspaceSortProvider onReorder={(id, target) => props.onChange({type: 'reorder', id, target})} onDragging={setDragging} onFinish={props.onFocus}>
    <Button className={cx('quiet-button workspace-reveal', chrome.visible && 'workspace-reveal-hidden')} variant="ghost" iconOnly leadingIcon={RiArrowDownSLine} aria-label={t('showBar')} onClick={() => {chrome.reveal(); requestAnimationFrame(() => bar.current?.querySelector<HTMLButtonElement>('button')?.focus());}}/>
    <header ref={bar} className={cx('workspace-bar', !chrome.visible && 'workspace-bar-hidden')} inert={!chrome.visible} aria-hidden={!chrome.visible} onPointerEnter={() => chrome.setHovered(true)} onPointerLeave={() => chrome.setHovered(false)} onFocusCapture={() => chrome.setFocused(true)} onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget as Node)) chrome.setFocused(false);}}>
      <Button className={cx('quiet-button browse-instances', mobile && 'session-switcher-trigger')} variant="ghost" trailingIcon={RiArrowDownSLine} title={t('browseInstances')} aria-label={mobile ? t('switchInstance') : t('browseInstances')} onClick={() => openBrowser(false)}>
        {mobile ? <span className="session-label">{current?.icon}<span className="session-name text-body-2-medium">{current?.label || t('browseInstances')}</span></span> : t('browseInstances')}
      </Button>
      <div ref={strip} className="session-tabs-scroll" title={t('tabGestureHint')} onMouseDownCapture={rightPress} onMouseUp={rightRelease}>
        <WorkspaceSortList scope="tabs" units={units}>{units.map(unit => <SortableWorkspaceUnit key={unit[0]} scope="tabs" id={unit[0]} className={cx('workspace-tab-unit', unit.length === 2 && 'workspace-tab-pair')}>
          {unit.map(id => {const instance = byId(id); return instance && <div key={id} className={cx('session-tab', workspace.active === id && 'selected')} data-instance-id={id} data-tab-id={id} title={instance.name + ' · ' + id}>
            {menuFor(instance, 'tabs')}
            <Button className="quiet-button tab-close" variant="ghost" size="xs" iconOnly leadingIcon={RiCloseLine} aria-label={t('closeTab') + ' ' + instance.label} data-no-drag onClick={() => props.onClose(id)}/>
          </div>;})}
        </SortableWorkspaceUnit>)}</WorkspaceSortList>
      </div>
      {!mobile && <Button className="quiet-button more-tabs" variant="ghost" iconOnly leadingIcon={RiArrowDownSLine} aria-label={t('moreTabs')} title={t('moreTabs')} onClick={() => openBrowser(true)}/>}
      <div className="workspace-bar-actions">
        <Button className="quiet-button page-refresh" variant="ghost" iconOnly leadingIcon={RiRefreshLine} aria-label={t('refreshPage')} title={t('refreshPage')} onClick={() => location.reload()}/>
        {props.authenticated ? <SettingsMenu labels={{settings: t('settings'), terminalSettings: t('terminalSettings'), console: t('console'), password: t('changePassword'), logout: t('logout')}} admin={props.admin} accountName={props.accountName} onSelect={props.onSettings} onOpenChange={setSettingsOpen} extras={[{label: t('language'), icon: RiTranslate2, onSelect: props.onLocale}, {label: t('theme'), icon: props.dark ? RiSunLine : RiMoonLine, onSelect: props.onDark}]}/> : <Button className="quiet-button" variant="ghost" onClick={props.onLogin}>{t('login')}</Button>}
        <Button className="quiet-button pin-toolbar" variant="ghost" iconOnly leadingIcon={pinned ? RiUnpinLine : RiPushpinLine} aria-pressed={pinned} aria-label={t(pinned ? 'unpinBar' : 'pinBar')} title={t(pinned ? 'unpinBar' : 'pinBar')} onClick={() => {chrome.reveal(); props.onPin(!pinned); props.onFocus();}}/>
      </div>
    </header>
    <Drawer isOpen={browse} onOpenChange={setBrowse} placement={mobile ? 'bottom' : 'start'} aria-label={t('browseInstances')}>
      <DrawerHeader title={t('browseInstances')} closeLabel={t('close')}/>
      <div className="px-6 pb-4"><Input aria-label={t('search')} placeholder={t('search')} value={query} onChange={setQuery}/><div className="instance-browser-filters"><Button className="quiet-button" variant="ghost" aria-pressed={!onlyOpened} onClick={() => setOnlyOpened(false)}>{t('all')}</Button><Button className="quiet-button" variant="ghost" aria-pressed={onlyOpened} onClick={() => setOnlyOpened(true)}>{t('opened')}</Button></div></div>
      <DrawerBody><div className="instance-browser-list" onMouseDownCapture={rightPress} onMouseUp={rightRelease}>
        <WorkspaceSortList scope="directory" units={directoryUnits}>{directoryUnits.map(unit => <SortableWorkspaceUnit key={unit[0]} scope="directory" id={unit[0]} className={cx('instance-browser-unit', unit.length === 2 && 'instance-browser-pair')}>
          {unit.map(id => {const instance = byId(id); return instance && <div key={id} className="instance-browser-row" data-tab-id={id} title={instance.name + ' · ' + id}>
            <Button className="quiet-button instance-browser-select" variant="ghost" aria-current={workspace.active === id ? 'page' : undefined} title={instance.name + ' · ' + id} onClick={() => {setBrowse(false); props.onBrowseSelect(id);}}><span className="session-label">{instance.icon}<span className="session-name text-body-2-medium" dir="auto">{instance.label}</span></span><span className="text-caption-1-regular">{t(!instance.online ? 'offline' : workspace.opened.includes(id) ? 'opened' : 'online')}</span></Button>
            {menuFor(instance, 'directory')}
          </div>;})}
        </SortableWorkspaceUnit>)}</WorkspaceSortList>
        {!directoryUnits.length && <p className="text-body-regular text-text-secondary">{t('noResults')}</p>}
      </div></DrawerBody>
      <div className="px-6 py-4"><Button variant="secondary" leadingIcon={RiAddLine} onClick={() => {setBrowse(false); props.onConnect();}}>{t('connect')}</Button></div>
    </Drawer>
  </WorkspaceSortProvider>;
}

import {useEffect, useState, type CSSProperties} from 'react';
import {RiAddLine, RiSettings3Line} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {cx} from '@/utils/cx';
import {SettingsMenu, type SettingsAction} from '../SettingsMenu';
import type {TerminalActions} from '../terminal/Terminal';
import {WorkspaceSortProvider, WorkspaceSortList, SortableWorkspaceUnit} from '../instances/SortableInstances';
import {translate, type Locale} from '../i18n';
import {groupFor, navigationUnits, openedOrder, type Workspace, type WorkspaceAction} from './state';
import type {PaneInstance} from './WorkspaceControls';
import {TabActionsMenu} from './TabActionsMenu';

type Props = {
  workspace: Workspace; instances: PaneInstance[]; actions: Record<string, TerminalActions>; locale: Locale;
  canSplit: boolean; transparency: number; lightTerminal: boolean; onLocale: () => void;
  accountName?: string; admin: boolean; authenticated: boolean; onLogin: () => void; onSettings: (action: SettingsAction) => void;
  onSelect: (id: string, focus?: boolean) => void; onManage: (id: string) => void; onConnect: () => void;
  onChange: (action: WorkspaceAction) => void; onClose: (id: string) => void; onFocus: () => void;
};
export function WorkspaceBar(props: Props) {
  const {workspace, instances, locale, canSplit} = props;
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const [menu, setMenu] = useState<{id: string; right?: string} | null>(null);
  const [dragging, setDragging] = useState(false);
  const opened = openedOrder(workspace), units = navigationUnits(workspace, true);
  const byId = (id: string) => instances.find(i => i.id === id);
  useEffect(() => {if (menu && !workspace.opened.includes(menu.id)) setMenu(null);}, [workspace.opened, menu]);
  const menuFor = (instance: PaneInstance) => {
    const pair = groupFor(workspace, instance.id);
    const next = opened[opened.indexOf(instance.id) + 1];
    const neighborId = menu?.id === instance.id ? menu.right : next;
    const right = neighborId ? byId(neighborId) : undefined;
    const reason = !right ? t('noRightTab') : next !== neighborId ? t('splitOrderChanged') : groupFor(workspace, right.id) ? t('neighborGrouped') : !instance.online || !right.online ? t('offline') : !canSplit ? t('splitWidthHint') : undefined;
    return <TabActionsMenu instance={instance} locale={locale} actions={props.actions[instance.id]} paired={!!pair} right={right} splitReason={reason} open={menu?.id === instance.id}
      onOpenChange={value => setMenu(current => value ? {id: instance.id, right: next} : current?.id === instance.id ? null : current)} onSelect={() => props.onSelect(instance.id, false)}
      onFocus={props.onFocus} onAction={(action, neighbor) => {
        if (action === 'manage') props.onManage(instance.id);
        else if (action === 'close') props.onClose(instance.id);
        else if (action === 'left' || action === 'right') props.onChange({type: 'move', id: instance.id, direction: action === 'left' ? -1 : 1});
        else if (action === 'split') {if (!reason && neighbor) props.onChange({type: 'start', id: instance.id, right: neighbor});}
        else props.onChange({type: action, id: instance.id});
        if (action !== 'manage') props.onFocus();
      }}>
      <span className="session-label">{instance.icon}<span className="session-name text-body-2-medium" dir="auto">{instance.label}</span><span className="session-number text-caption-1-semibold" aria-hidden="true">{opened.indexOf(instance.id) + 1}</span>{pair && <span className="pane-tab-label text-caption-1-semibold">{t(pair.left === instance.id ? 'leftPane' : 'rightPane')}</span>}{!instance.writable && <span className="tab-readonly text-caption-1-regular">{t('readOnly')}</span>}</span>
    </TabActionsMenu>;
  };
  const rightPress = (event: React.MouseEvent) => {
    if (event.button !== 2 || (event.target as Element).closest('[data-no-drag]')) return;
    const id = (event.target as Element).closest<HTMLElement>('[data-tab-id]')?.dataset.tabId;
    if (id) {setMenu(null); props.onSelect(id, false);}
  };
  return <WorkspaceSortProvider onReorder={(id, target) => props.onChange({type: 'reorder', id, target})} onDragging={setDragging} onFinish={props.onFocus}>
    <header className="workspace-bar" data-light-terminal={props.lightTerminal} style={{'--hub-bar-opacity': (100 - props.transparency) / 100} as CSSProperties}>
      <div className="session-tabs-scroll" title={t('tabGestureHint')} onMouseDownCapture={rightPress} onMouseUp={event => {if (event.button === 2 && !dragging) props.onFocus();}}>
        <WorkspaceSortList scope="tabs" units={units}>{units.map(unit => <SortableWorkspaceUnit key={unit[0]} scope="tabs" id={unit[0]} weight={unit.length} className={cx('workspace-tab-unit', unit.length === 2 && 'workspace-tab-pair')}>
          {unit.map(id => {const instance = byId(id); return instance && <div key={id} className={cx('session-tab', workspace.active === id && 'selected')} data-instance-id={id} data-tab-id={id} title={instance.name + ' · ' + id}>
            {menuFor(instance)}
          </div>;})}
        </SortableWorkspaceUnit>)}</WorkspaceSortList>
      </div>
      <div className="workspace-bar-actions">
        <Button className="quiet-button add-instance" variant="ghost" iconOnly leadingIcon={RiAddLine} aria-label={t('connect')} title={t('connect')} onClick={props.authenticated ? props.onConnect : props.onLogin}/>
        {props.authenticated ? <SettingsMenu labels={{settings: t('settings'), terminalSettings: t('terminalSettings'), console: t('console'), password: t('changePassword'), logout: t('logout')}} admin={props.admin} accountName={props.accountName} onSelect={props.onSettings} locale={locale} onLocale={props.onLocale}/> : <Button className="quiet-button settings-trigger" variant="ghost" iconOnly leadingIcon={RiSettings3Line} aria-label={t('settings')} onClick={props.onLogin}/>}
      </div>
    </header>
  </WorkspaceSortProvider>;
}

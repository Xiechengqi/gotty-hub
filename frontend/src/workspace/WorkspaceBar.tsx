import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {RiAddLine, RiArrowGoBackLine, RiDoorOpenLine, RiLayoutGridLine, RiMoreLine, RiSettings3Line} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {cx} from '@/utils/cx';
import {SettingsMenu, type SettingsAction} from '../SettingsMenu';
import type {TerminalActions} from '../terminal/Terminal';
import {WorkspaceSortProvider, WorkspaceSortList, SortableWorkspaceUnit} from '../instances/SortableInstances';
import {translate, type Locale} from '../i18n';
import {isGroup, navigationUnits, rememberedMember, type LayoutAction, type SplitGroup, type Unit, type Workspace} from './state';
import type {PaneInstance} from './WorkspaceControls';
import {InstanceActions, TabActionsMenu} from './TabActionsMenu';
import {SplitDialog, type SplitRequest} from './SplitDialog';
import {randomId} from '../random';

type Props = {
  workspace: Workspace; instances: Map<string, PaneInstance>; actions: Record<string, TerminalActions>; locale: Locale;
  wide: boolean; blocked?: boolean; transparency: number; lightTerminal: boolean; onLocale: () => void;
  accountName?: string; admin: boolean; authenticated: boolean; onLogin: () => void; onSettings: (action: SettingsAction) => void;
  onSelect: (id: string, focus?: boolean) => void; onDelete: (id: string) => void; onConnect: () => void;
  onEdit: (action: LayoutAction, selected?: string) => boolean; onReorder: (id: string, target: string) => void;
  onPageMode: (group: string, paged: boolean) => void; onFocus: () => void;
};
export function WorkspaceBar(props: Props) {
  const {workspace, locale, wide, instances, onSelect, onFocus} = props;
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const [menu, setMenu] = useState<string | null>(null);
  const [memberActions, setMemberActions] = useState<string | null>(null);
  const [dialog, setDialog] = useState<SplitRequest | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragMode = useRef<boolean | null>(null);
  const surfaceStyle = {'--hub-bar-opacity': (100 - props.transparency) / 100,
    '--bar-ink': `var(--color-workspace-bar-${props.lightTerminal ? 'ink' : 'inverse-ink'})`} as CSSProperties;
  const units = navigationUnits(workspace, wide);
  const groups = wide ? workspace.units.filter(isGroup) : [];
  const candidates = wide ? workspace.units.flatMap(unit => {
    const instance = !isGroup(unit) && instances.get(unit.id);
    return instance ? [instance] : [];
  }) : [];
  useEffect(() => {
    dragMode.current = null;
    if (!wide) {setDialog(null); setMemberActions(null);}
  }, [wide]);
  useEffect(() => {
    const valid = new Set(navigationUnits(workspace, wide).map(unit => unit.id));
    setMenu(current => current && !valid.has(current) ? null : current);
  }, [workspace.units, wide]);
  const label = (group: SplitGroup) => (instances.get(group.members[0])?.label ?? group.members[0]) + ' · ' + group.members.length;
  const join = (id: string, group: string) => wide && props.onEdit({type: 'join', id, group}, id);

  const unitControls = (unit: Unit, run: (action: () => void) => void) => {
    const doEdit = (action: LayoutAction) => run(() => {props.onEdit(action); onFocus();});
    if (isGroup(unit)) {
      const paged = workspace.view.pagedGroups.includes(unit.id);
      const member = memberActions && unit.members.includes(memberActions) ? instances.get(memberActions) : undefined;
      if (member) return <>
        <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiArrowGoBackLine} autoFocus onClick={() => setMemberActions(null)}>{t('splitMembers')}</Button>
        <div className="tab-menu-heading text-body-2-semibold"><bdi>{member.label}</bdi></div>
        <InstanceActions instance={member} locale={locale} actions={props.actions[member.id]} run={run}
          onFocus={() => onSelect(member.id)} onDelete={() => props.onDelete(member.id)}>
          <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiDoorOpenLine}
            onClick={() => doEdit({type: 'remove', id: member.id, group: unit.id})}>{t('removeFromSplit')}</Button>
        </InstanceActions>
      </>;
      return <>
        <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiLayoutGridLine} onClick={() => run(() => {
          props.onPageMode(unit.id, !paged); onFocus();
        })}>{t(paged ? 'splitShowAll' : 'splitShowPages')}</Button>
        <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiDoorOpenLine}
          onClick={() => doEdit({type: 'dissolve', group: unit.id})}>{t('dissolveSplit')}</Button>
        <div className="tab-menu-heading text-caption-1-semibold">{t('splitMembers')}</div>
        {unit.members.map(id => {
          const instance = instances.get(id);
          return instance && <div key={id} className="split-member-row">
            <Button className="quiet-button tab-menu-item split-member-select" variant="ghost" aria-current={workspace.view.active === id ? 'true' : undefined}
              onClick={() => run(() => onSelect(id))}>{instance.icon}<bdi>{instance.label}</bdi></Button>
            <Button className="quiet-button split-member-actions" variant="ghost" iconOnly leadingIcon={RiMoreLine}
              aria-label={t('terminalActions') + ' · ' + instance.label} onClick={() => setMemberActions(id)}/>
          </div>;
        })}
      </>;
    }
    const instance = instances.get(unit.id);
    if (!instance) return;
    return <InstanceActions instance={instance} locale={locale} actions={props.actions[instance.id]} run={run}
      onFocus={onFocus} onDelete={() => props.onDelete(instance.id)}>
      {wide && <>
        <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiLayoutGridLine}
          disabled={!groups.length} title={!groups.length ? t('noSplitToJoin') : undefined} onClick={() => run(() => {
            if (groups.length === 1) {if (join(instance.id, groups[0].id)) onFocus();}
            else setDialog({kind: 'join', id: instance.id});
          })}>{t('joinSplit')}{groups.length === 1 && <bdi> · {label(groups[0])}</bdi>}</Button>
        <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiLayoutGridLine}
          disabled={!candidates.some(candidate => candidate.id !== instance.id)} onClick={() => run(() => setDialog({kind: 'create', id: instance.id}))}>
          {t('newSplit')}</Button>
      </>}
    </InstanceActions>;
  };

  const leftPress = (event: React.MouseEvent) => {
    const target = event.target as Element;
    if (event.button !== 0 || target.closest('[data-no-drag]')) return;
    const tab = target.closest<HTMLElement>('[data-tab-id]');
    if (tab && event.currentTarget.contains(tab)) {
      const unit = units.find(item => item.id === tab.dataset.tabId);
      if (unit) {setMenu(null); onSelect(rememberedMember(unit, workspace.view), false);}
    }
  };
  const closeDialog = () => {setDialog(null); onFocus();};
  return <>
    <WorkspaceSortProvider onReorder={(id, target) => {if (dragMode.current === wide) props.onReorder(id, target);}} onDragging={value => {
      setDragging(value);
      if (value) {dragMode.current = wide; setMenu(null);}
    }} onFinish={onFocus}>
      <header className="workspace-bar workspace-surface" data-light-terminal={props.lightTerminal} style={surfaceStyle} inert={props.blocked}>
        <div className="session-tabs-scroll" title={t('tabGestureHint')} onMouseDownCapture={leftPress}>
          <WorkspaceSortList scope="tabs" units={units.map(unit => [unit.id])}>{units.map((unit, i) => {
            const group = isGroup(unit) ? unit : null;
            const instance = !group ? instances.get(unit.id) : undefined;
            const target = rememberedMember(unit, workspace.view);
            const selected = group ? group.members.includes(workspace.view.active) : workspace.view.active === unit.id;
            const title = group ? label(group) : instance?.label ?? unit.id;
            return <SortableWorkspaceUnit key={unit.id} scope="tabs" id={unit.id} className="workspace-tab-unit">
              <div className={cx('session-tab', selected && 'selected', !!group && 'session-group-tab')}
                data-instance-id={instance?.id} data-tab-id={unit.id} data-group-size={group?.members.length} title={title}>
                <TabActionsMenu label={title} controls={'terminal-pane-' + (selected && group ? workspace.view.active : target)}
                  locale={locale} open={menu === unit.id} selected={selected} dragging={dragging} surfaceStyle={surfaceStyle}
                  onOpenChange={value => {
                    setMenu(current => value ? unit.id : current === unit.id ? null : current);
                    if (value) setMemberActions(null);
                  }} onSelect={focus => onSelect(target, focus)} content={run => unitControls(unit, run)}>
                  <span className="session-label">
                    {group ? <RiLayoutGridLine className="session-group-icon" aria-hidden="true"/> : instance?.icon}
                    <span className="session-name text-caption-1-medium" dir="auto">{group ? instances.get(group.members[0])?.label : instance?.label}</span>
                    {group ? <span className="session-group-count text-caption-1-semibold">{group.members.length}</span>
                      : <span className="session-number text-caption-1-semibold" aria-hidden="true">{i + 1}</span>}
                    {instance && !instance.writable && <span className="tab-readonly text-caption-1-regular">{t('readOnly')}</span>}
                  </span>
                </TabActionsMenu>
              </div>
            </SortableWorkspaceUnit>;
          })}</WorkspaceSortList>
        </div>
        <div className="workspace-bar-actions">
          <Button className="quiet-button add-instance" variant="ghost" iconOnly leadingIcon={RiAddLine} aria-label={t('connect')} title={t('connect')} onClick={props.authenticated ? props.onConnect : props.onLogin}/>
          {props.authenticated ? <SettingsMenu labels={{settings: t('settings'), terminalSettings: t('terminalSettings'), console: t('console'), password: t('changePassword'), logout: t('logout')}} admin={props.admin} accountName={props.accountName} onSelect={props.onSettings} locale={locale} onLocale={props.onLocale}/> : <Button className="quiet-button settings-trigger" variant="ghost" iconOnly leadingIcon={RiSettings3Line} aria-label={t('settings')} onClick={props.onLogin}/>}
        </div>
      </header>
    </WorkspaceSortProvider>
    {wide && dialog && <SplitDialog key={dialog.kind + dialog.id} request={dialog} groups={groups} candidates={candidates}
      instances={instances} locale={locale} onClose={closeDialog}
      onCreate={members => {
        if (!props.onEdit({type: 'create', id: dialog.id, members, group: 'split-' + randomId()}, dialog.id)) return false;
        closeDialog();
        return true;
      }} onJoin={group => {
        if (!join(dialog.id, group)) return false;
        closeDialog();
        return true;
      }}/>}
  </>;
}

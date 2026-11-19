import {useEffect, useRef, type CSSProperties, type ReactNode} from 'react';
import {RiRefreshLine, RiShutDownLine, RiDeleteBinLine} from '@remixicon/react';
import {Dropdown, DropdownPopover, DropdownTrigger} from '@/components/base/dropdown/dropdown';
import {Button} from '@/components/base/buttons/button';
import {ScrollFade, useScrollFade} from '@/components/foundations/scroll-fade/scroll-fade';
import type {TerminalActions} from '../terminal/Terminal';
import {translate, type Locale} from '../i18n';
import type {PaneInstance} from './WorkspaceControls';

export function TabActionsMenu({label, controls, locale, open, selected, dragging, surfaceStyle, onOpenChange, onSelect, children, content}: {
  label: string; controls: string; locale: Locale; open: boolean; selected: boolean; dragging: boolean; surfaceStyle: CSSProperties;
  onOpenChange: (value: boolean) => void; onSelect: (focus: boolean) => void; children: ReactNode;
  content: (run: (action: () => void) => void) => ReactNode;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const fade = useScrollFade();
  const selectedAtTouchStart = useRef(false);
  useEffect(() => {if (open) fade.reset();}, [open, fade.reset]);
  const run = (action: () => void) => {onOpenChange(false); action();};
  const showMenu = () => {if (!dragging) {onSelect(false); onOpenChange(true);}};
  return <Dropdown isOpen={open} onOpenChange={value => {if (!value) onOpenChange(false);}}>
    <DropdownTrigger className="quiet-button tab-trigger" aria-label={t('switchInstance') + ' · ' + label}
      aria-description={t('tabGestureHint')} aria-current={selected ? 'page' : undefined}
      aria-controls={controls} aria-keyshortcuts="Shift+F10"
      onPressStart={event => {if (event.pointerType === 'touch') selectedAtTouchStart.current = selected;}}
      onPress={event => {
        if (dragging) return;
        if (event.pointerType === 'touch' && selectedAtTouchStart.current) showMenu();
        else {onOpenChange(false); onSelect(true);}
      }}
      onContextMenu={event => {event.preventDefault(); if (!dragging) event.currentTarget.focus({preventScroll: true}); showMenu();}}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey || event.key === 'ArrowDown') {
          event.preventDefault();
          showMenu();
        }
      }}>
      {children}
    </DropdownTrigger>
    <DropdownPopover aria-label={t('terminalActions') + ' · ' + label} className="tab-actions-menu workspace-surface" style={surfaceStyle} placement="bottom start">
      <div className="tab-menu-heading text-body-2-semibold" dir="auto">{label}</div>
      <div className="relative min-h-0">
        <div className="tab-menu-scroll" onScroll={fade.onScroll}>{open && content(run)}</div>
        <ScrollFade progress={fade.progress}/>
      </div>
    </DropdownPopover>
  </Dropdown>;
}

export function InstanceActions({instance, locale, actions, run, onFocus, onDelete, children}: {
  instance: PaneInstance; locale: Locale; actions?: TerminalActions; run: (action: () => void) => void;
  onFocus: () => void; onDelete: () => void; children?: ReactNode;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  return <>
    <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiRefreshLine} disabled={!actions}
      onClick={() => run(() => {actions?.refresh(); onFocus();})}>{t('refreshTerminal')}</Button>
    {children}
    {actions?.restartAvailable && <Button className="quiet-button tab-menu-item tab-menu-danger" variant="ghost" leadingIcon={RiShutDownLine}
      disabled={!actions.canRestart} onClick={() => run(() => actions.restart())}>{t('restartTerminal')}</Button>}
    {instance.owner && <Button className="quiet-button tab-menu-item tab-menu-danger" variant="ghost" leadingIcon={RiDeleteBinLine}
      onClick={() => run(onDelete)}>{t('deleteInstance')}</Button>}
  </>;
}

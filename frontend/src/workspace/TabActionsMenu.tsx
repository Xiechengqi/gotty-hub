import {useEffect, useRef, type CSSProperties, type ReactNode} from 'react';
import {RiRefreshLine, RiLayoutColumnLine, RiShutDownLine, RiArrowLeftRightLine, RiDeleteBinLine} from '@remixicon/react';
import {Dropdown, DropdownPopover, DropdownTrigger} from '@/components/base/dropdown/dropdown';
import {Button} from '@/components/base/buttons/button';
import {ScrollFade, useScrollFade} from '@/components/foundations/scroll-fade/scroll-fade';
import type {TerminalActions} from '../terminal/Terminal';
import {translate, type Locale} from '../i18n';
import type {PaneInstance} from './WorkspaceControls';

export function TabActionsMenu({instance, locale, actions, paired, right, splitReason, open, selected, dragging, surfaceStyle, onOpenChange, onSelect, onAction, onFocus, children}: {
  instance: PaneInstance; locale: Locale; actions?: TerminalActions; paired: boolean; right?: PaneInstance; splitReason?: string;
  open: boolean; selected: boolean; dragging: boolean; surfaceStyle: CSSProperties;
  onOpenChange: (value: boolean) => void; onSelect: (focus?: boolean) => void;
  onAction: (action: 'split' | 'exit' | 'swap' | 'delete', neighbor?: string) => void;
  onFocus: () => void;
  children: ReactNode;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const fade = useScrollFade();
  const selectedAtTouchStart = useRef(false);
  useEffect(() => {if (open) fade.reset();}, [open, fade.reset]);
  const run = (action: () => void) => {onOpenChange(false); action();};
  const showMenu = () => {if (!dragging) {onSelect(false); onOpenChange(true);}};
  // DialogTrigger's normal primary press must select, not open the menu.
  // Context-menu keys and secondary clicks explicitly open the controlled menu.
  return <Dropdown isOpen={open} onOpenChange={value => {if (!value) onOpenChange(false);}}>
    <DropdownTrigger className="quiet-button tab-trigger" aria-label={t('switchInstance') + ' · ' + instance.label} aria-description={t('tabGestureHint')} aria-current={selected ? 'page' : undefined} aria-controls={'terminal-pane-' + instance.id} aria-keyshortcuts="Shift+F10"
      onPressStart={event => {if (event.pointerType === 'touch') selectedAtTouchStart.current = selected;}}
      onPress={event => {
        if (dragging) return;
        // Touch generates a compatibility mousedown before press completion;
        // use the selection at touch start, before that mouse event selects it.
        if (event.pointerType === 'touch' && selectedAtTouchStart.current) showMenu();
        else {onOpenChange(false); onSelect(true);}
      }}
      onContextMenu={event => {event.preventDefault(); if (!dragging) event.currentTarget.focus({preventScroll: true}); showMenu();}}
      onKeyDown={event => {if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey || event.key === 'ArrowDown') {event.preventDefault(); showMenu();}}}>
      {children}
    </DropdownTrigger>
    <DropdownPopover aria-label={t('terminalActions') + ' · ' + instance.label} className="tab-actions-menu workspace-surface" style={surfaceStyle} placement="bottom start">
      <div className="tab-menu-heading text-body-2-semibold" dir="auto">{instance.label}</div>
      <div className="relative min-h-0"><div className="tab-menu-scroll" onScroll={fade.onScroll}>
      <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiRefreshLine} disabled={!actions} onClick={() => run(() => {actions?.refresh(); onFocus();})}>{t('refreshTerminal')}</Button>
      {paired ? <>
        <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiLayoutColumnLine} onClick={() => run(() => onAction('exit'))}>{t('exitSplit')}</Button>
        <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiArrowLeftRightLine} onClick={() => run(() => onAction('swap'))}>{t('swapPanes')}</Button>
      </> : <><Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiLayoutColumnLine} disabled={!!splitReason} onClick={() => run(() => onAction('split', right?.id))}>{t('splitWithRight')}{right && <span dir="auto"> · {right.label}</span>}</Button>{splitReason && <p className="tab-menu-reason text-caption-1-regular">{splitReason}</p>}</>}
      {actions?.restartAvailable && <Button className="quiet-button tab-menu-item tab-menu-danger" variant="ghost" leadingIcon={RiShutDownLine} disabled={!actions.canRestart} onClick={() => run(() => actions.restart())}>{t('restartTerminal')}</Button>}
      {instance.owner && <Button className="quiet-button tab-menu-item tab-menu-danger" variant="ghost" leadingIcon={RiDeleteBinLine} onClick={() => run(() => onAction('delete'))}>{t('deleteInstance')}</Button>}
      </div><ScrollFade progress={fade.progress}/></div>
    </DropdownPopover>
  </Dropdown>;
}

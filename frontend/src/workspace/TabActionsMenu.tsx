import {useEffect, type ReactNode} from 'react';
import {RiRefreshLine, RiSettings3Line, RiLayoutColumnLine, RiCloseLine, RiShutDownLine, RiArrowLeftRightLine, RiArrowLeftLine, RiArrowRightLine, RiExpandWidthLine} from '@remixicon/react';
import {Dropdown, DropdownDivider, DropdownPopover, DropdownTrigger} from '@/components/base/dropdown/dropdown';
import {Button} from '@/components/base/buttons/button';
import {ScrollFade, useScrollFade} from '@/components/foundations/scroll-fade/scroll-fade';
import type {TerminalActions} from '../terminal/Terminal';
import {translate, type Locale} from '../i18n';
import type {PaneInstance} from './WorkspaceControls';

export function TabActionsMenu({instance, locale, actions, paired, right, splitReason, open, onOpenChange, onSelect, onAction, onFocus, children}: {
  instance: PaneInstance; locale: Locale; actions?: TerminalActions; paired: boolean; right?: PaneInstance; splitReason?: string;
  open: boolean; onOpenChange: (value: boolean) => void; onSelect: () => void;
  onAction: (action: 'split' | 'exit' | 'swap' | 'close' | 'manage' | 'left' | 'right', neighbor?: string) => void;
  onFocus: () => void;
  children: ReactNode;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const fade = useScrollFade();
  useEffect(() => {if (open) fade.reset();}, [open, fade.reset]);
  const run = (action: () => void) => {onOpenChange(false); action();};
  return <Dropdown isOpen={open} onOpenChange={value => {if (value) onSelect(); onOpenChange(value);}}>
    <DropdownTrigger className="quiet-button tab-trigger" aria-label={t('terminalActions') + ' · ' + instance.label} aria-controls={'terminal-pane-' + instance.id}>{children}</DropdownTrigger>
    <DropdownPopover aria-label={t('terminalActions') + ' · ' + instance.label} className="tab-actions-menu" placement="bottom start">
      <div className="tab-menu-heading text-body-2-semibold" dir="auto">{instance.label}</div>
      <div className="relative min-h-0"><div className="tab-menu-scroll" onScroll={fade.onScroll}>
      <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiRefreshLine} disabled={!actions} onClick={() => run(() => {actions?.refresh(); onFocus();})}>{t('refreshTerminal')}</Button>
      {instance.writable && actions?.takeSizeControl && <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiExpandWidthLine} disabled={!actions.canTakeSizeControl} onClick={() => run(() => {actions.takeSizeControl?.(); onFocus();})}>{locale === 'zh-CN' ? '接管终端尺寸' : 'Take size control'}</Button>}
      <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiSettings3Line} onClick={() => run(() => onAction('manage'))}>{t('instanceSettings')}</Button>
      {paired ? <>
        <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiLayoutColumnLine} onClick={() => run(() => onAction('exit'))}>{t('exitSplit')}</Button>
        <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiArrowLeftRightLine} onClick={() => run(() => onAction('swap'))}>{t('swapPanes')}</Button>
      </> : <><Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiLayoutColumnLine} disabled={!!splitReason} onClick={() => run(() => onAction('split', right?.id))}>{t('splitWithRight')}{right && <span dir="auto"> · {right.label}</span>}</Button>{splitReason && <p className="tab-menu-reason text-caption-1-regular">{splitReason}</p>}</>}
      <DropdownDivider/>
      <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiArrowLeftLine} onClick={() => run(() => onAction('left'))}>{t('moveTabLeft')}</Button>
      <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiArrowRightLine} onClick={() => run(() => onAction('right'))}>{t('moveTabRight')}</Button>
      <Button className="quiet-button tab-menu-item" variant="ghost" leadingIcon={RiCloseLine} onClick={() => run(() => onAction('close'))}>{t('closeTab')}</Button>
      {actions?.restartAvailable && <><DropdownDivider/><Button className="quiet-button tab-menu-item tab-menu-danger" variant="ghost" leadingIcon={RiShutDownLine} disabled={!actions.canRestart} onClick={() => run(() => actions.restart())}>{t('restartTerminal')}</Button></>}
      </div><ScrollFade progress={fade.progress}/></div>
    </DropdownPopover>
  </Dropdown>;
}

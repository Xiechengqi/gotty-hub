import {useEffect, useRef, useState, type ReactNode, type RefObject, type PointerEvent} from 'react';
import {RiArrowDownSLine, RiCloseLine} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import {Modal, ModalBody, ModalHeader} from '@/components/base/modal/modal';
import {cx} from '@/utils/cx';
import {translate, type Locale} from '../i18n';
import {clampRatio, DIVIDER_WIDTH, type Pane} from './state';

export type PaneInstance = {id: string; name: string; label: string; online: boolean; writable: boolean; icon: ReactNode};

export function PaneHeading({instance, pane, focused, locale, onChoose, onClose}: {
  instance: PaneInstance; pane?: Pane; focused: boolean; locale: Locale; onChoose: () => void; onClose: () => void;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  return <header className="terminal-pane-heading">
    <Button className="quiet-button pane-instance-trigger" variant="ghost" trailingIcon={RiArrowDownSLine} aria-label={t('replacePane') + ': ' + instance.label} title={instance.name + ' · ' + instance.id} onClick={onChoose}>
      {pane && <span className="pane-position text-caption-1-semibold">{t(pane === 'left' ? 'leftPane' : 'rightPane')}</span>}
      <span className="session-label">{instance.icon}<span className="session-name text-body-2-medium" dir="auto">{instance.label}</span></span>
    </Button>
    <div className="pane-heading-meta text-caption-1-regular">
      {pane && focused && <span className="pane-active-label">{t('activePane')}</span>}
      {!instance.online ? <span>{t('offline')}</span> : !instance.writable && <span>{t('readOnly')}</span>}
      <Button className="quiet-button pane-close" variant="ghost" size="xs" iconOnly leadingIcon={RiCloseLine} aria-label={t('closeTab') + ' ' + instance.label} title={t('closeTab') + ' ' + instance.label} onClick={onClose}/>
    </div>
  </header>;
}

export function InstancePicker({open, title, instances, opened, other, current, locale, onClose, onSelect}: {
  open: boolean; title: string; instances: PaneInstance[]; opened: string[]; other?: string; current?: string; locale: Locale; onClose: () => void; onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => {if (open) setQuery('');}, [open, title, current]);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const shown = instances.filter(instance => (instance.name + ' ' + instance.id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Modal isOpen={open} onOpenChange={value => {if (!value) onClose();}} size="md" className="split-instance-picker">
    <ModalHeader title={title} closeLabel={t('close')}/>
    <div className="px-6"><Input aria-label={t('search')} placeholder={t('search')} value={query} onChange={setQuery}/></div>
    <ModalBody><ul className="split-instance-list">
      {shown.map(instance => {
        const reason = !instance.online ? t('offline') : instance.id === other ? t('alreadyInOtherPane') : undefined;
        return <li key={instance.id}><Button className="quiet-button split-instance-option" variant="ghost" disabled={!!reason} aria-label={t('chooseInstance') + ' ' + instance.label} aria-pressed={instance.id === current} title={reason || instance.name + ' · ' + instance.id} onClick={() => onSelect(instance.id)}>
          <span className="session-label">{instance.icon}<span className="split-instance-name text-body-medium" dir="auto">{instance.label}</span></span>
          <span className="text-caption-1-regular">{reason || (opened.includes(instance.id) ? t('opened') : t('online'))}</span>
        </Button></li>;
      })}
    </ul>{!shown.length && <p className="text-body-regular text-text-secondary" role="status">{t('noResults')}</p>}</ModalBody>
  </Modal>;
}

// This is a layout separator, not a second terminal host. Its siblings retain
// their keyed React identity when a pane moves between grid columns.
export function SplitDivider({container, ratio, minimum, locale, onResize}: {
  container: RefObject<HTMLDivElement | null>; ratio: number; minimum: number; locale: Locale; onResize: (ratio: number) => void;
}) {
  const frame = useRef(0);
  const pending = useRef(ratio);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const change = (value: number) => onResize(clampRatio(value, minimum));
  const move = (event: PointerEvent<HTMLDivElement>, immediate = false) => {
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    pending.current = (event.clientX - bounds.left - DIVIDER_WIDTH / 2) / (bounds.width - DIVIDER_WIDTH);
    cancelAnimationFrame(frame.current);
    if (immediate) change(pending.current);
    else frame.current = requestAnimationFrame(() => change(pending.current));
  };
  const left = Math.round(ratio * 100);
  return <div className={cx('split-divider', dragging && 'split-divider-dragging')} role="separator" aria-orientation="vertical" aria-label={t('splitDivider')} aria-valuemin={Math.round(minimum * 100)} aria-valuemax={100 - Math.round(minimum * 100)} aria-valuenow={left} aria-valuetext={t('leftWidth') + ' ' + left + '%, ' + t('rightWidth') + ' ' + (100 - left) + '%'} title={t('splitDividerHint')} tabIndex={0}
    onDoubleClick={() => change(0.5)}
    onKeyDown={event => {
      const step = event.shiftKey ? 0.1 : 0.02;
      const value = event.key === 'ArrowLeft' ? ratio - step : event.key === 'ArrowRight' ? ratio + step : event.key === 'Home' ? minimum : event.key === 'End' ? 1 - minimum : event.key === 'Enter' ? 0.5 : undefined;
      if (value !== undefined) {event.preventDefault(); change(value);}
    }}
    onPointerDown={event => {if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);}}
    onPointerMove={event => {if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event);}}
    onPointerUp={event => {if (event.currentTarget.hasPointerCapture(event.pointerId)) {move(event, true); event.currentTarget.releasePointerCapture(event.pointerId);} setDragging(false);}}
    onPointerCancel={() => {cancelAnimationFrame(frame.current); setDragging(false);}}
    onLostPointerCapture={() => setDragging(false)}
  ><span aria-hidden="true"/></div>;
}

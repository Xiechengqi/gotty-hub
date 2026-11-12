import {useEffect, useRef, useState, type ReactNode, type RefObject, type PointerEvent} from 'react';
import {cx} from '@/utils/cx';
import {translate, type Locale} from '../i18n';
import {clampRatio, DIVIDER_WIDTH} from './state';

export type PaneInstance = {id: string; name: string; label: string; online: boolean; writable: boolean; owner: boolean; icon: ReactNode};

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

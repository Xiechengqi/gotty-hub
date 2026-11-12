import {useEffect, useRef, useState, type RefObject} from 'react';
import {groupFor, type Workspace} from './state';
import {adjacentSwipeTarget, TabSwipeGesture} from './swipe';

type SwipeState = {account?: string; enabled: boolean; workspace: Workspace; expandedSplits: boolean};
type Options = SwipeState & {onSelect: (id: string) => void};

function hasHorizontalOverflow(target: Element, host: Element): boolean {
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 2 && /^(auto|scroll)$/.test(getComputedStyle(node).overflowX)) return true;
    if (node === host) break;
  }
  return false;
}

// Capture above xterm's scrollbar and mouse-reporting handlers. A bubble
// listener or only attachCustomWheelEventHandler runs too late for both paths.
export function bindTabSwipe(root: HTMLElement, snapshot: () => SwipeState, select: (id: string) => void): () => void {
  const gesture = new TabSwipeGesture();
  const pointers = new Set<number>();
  let composing = false, dragging = false, pinching = false;
  const wheel = (event: WheelEvent) => {
    const at = performance.now();
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || pinching) {
      gesture.release(at); return;
    }
    const state = snapshot();
    const target = event.target instanceof Element ? event.target : null;
    const tabs = target?.closest('.session-tabs-scroll');
    const host = target?.closest('.xterm-host, .terminal-output, .terminal-empty');
    const slot = host?.closest('.terminal-slot:not([hidden])');
    const blocked = composing || dragging || pointers.size > 0 || event.buttons !== 0
      || !!document.querySelector('[role=dialog], [role=alertdialog], [role=listbox]')
      || !!root.querySelector('[data-dragging=true], .split-divider-dragging, .terminal-drop-overlay');
    const eligible = state.enabled && !blocked && !event.defaultPrevented
      && (!!tabs || !!slot && !!host && !hasHorizontalOverflow(target!, host));
    const scale = event.deltaMode === 1 ? parseFloat(host ? getComputedStyle(host).lineHeight : '') || 16 : 1;
    const x = event.deltaX * (event.deltaMode === 2 ? root.clientWidth || window.innerWidth : scale);
    const y = event.deltaY * (event.deltaMode === 2 ? root.clientHeight || window.innerHeight : scale);
    const context = JSON.stringify([state.account, state.expandedSplits, state.workspace.active,
      state.workspace.order, state.workspace.opened, state.workspace.groups]);
    const decision = gesture.push({x, y, at, eligible, cancelable: event.cancelable, context});
    if (!decision.consume) return;
    event.preventDefault(); event.stopPropagation();
    if (decision.direction) {
      const id = adjacentSwipeTarget(state.workspace, decision.direction, state.expandedSplits);
      if (id) select(id);
    }
  };
  const pointerDown = (event: PointerEvent) => {pointers.add(event.pointerId); gesture.cancel();};
  const pointerUp = (event: PointerEvent) => {pointers.delete(event.pointerId);};
  const compositionStart = () => {composing = true; gesture.cancel();};
  const compositionEnd = () => {composing = false; gesture.cancel();};
  const dragStart = () => {dragging = true; gesture.cancel();};
  const dragEnd = () => {dragging = false;};
  const dragLeave = (event: DragEvent) => {if (!event.relatedTarget) dragging = false;};
  const pinchStart = () => {pinching = true; gesture.cancel();};
  const pinchEnd = () => {pinching = false;};
  const blur = () => {pointers.clear(); composing = dragging = pinching = false; gesture.cancel();};
  root.addEventListener('wheel', wheel, {capture: true, passive: false});
  root.addEventListener('pointerdown', pointerDown, true);
  root.addEventListener('compositionstart', compositionStart, true);
  root.addEventListener('compositionend', compositionEnd, true);
  root.addEventListener('dragenter', dragStart, true);
  root.addEventListener('dragstart', dragStart, true);
  // Safari also exposes pinch through GestureEvent, without a standard ctrlKey.
  root.addEventListener('gesturestart', pinchStart, true);
  document.addEventListener('gestureend', pinchEnd, true);
  document.addEventListener('pointerup', pointerUp, true);
  document.addEventListener('pointercancel', pointerUp, true);
  document.addEventListener('drop', dragEnd, true);
  document.addEventListener('dragend', dragEnd, true);
  document.addEventListener('dragleave', dragLeave, true);
  document.addEventListener('visibilitychange', blur);
  window.addEventListener('blur', blur);
  return () => {
    root.removeEventListener('wheel', wheel, true);
    root.removeEventListener('pointerdown', pointerDown, true);
    root.removeEventListener('compositionstart', compositionStart, true);
    root.removeEventListener('compositionend', compositionEnd, true);
    root.removeEventListener('dragenter', dragStart, true);
    root.removeEventListener('dragstart', dragStart, true);
    root.removeEventListener('gesturestart', pinchStart, true);
    document.removeEventListener('gestureend', pinchEnd, true);
    document.removeEventListener('pointerup', pointerUp, true);
    document.removeEventListener('pointercancel', pointerUp, true);
    document.removeEventListener('drop', dragEnd, true);
    document.removeEventListener('dragend', dragEnd, true);
    document.removeEventListener('dragleave', dragLeave, true);
    document.removeEventListener('visibilitychange', blur);
    window.removeEventListener('blur', blur);
  };
}

export function useTabSwipe(root: RefObject<HTMLElement | null>, options: Options): string[] | undefined {
  const latest = useRef(options); latest.current = options;
  const [hint, setHint] = useState<{account?: string; ids: string[]}>();
  useEffect(() => {
    if (!root.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = bindTabSwipe(root.current, () => latest.current, id => {
      const current = latest.current;
      current.onSelect(id);
      const group = current.expandedSplits && groupFor(current.workspace, id);
      setHint({account: current.account, ids: group ? [group.left, group.right] : [id]});
      clearTimeout(timer); timer = setTimeout(() => setHint(undefined), 1000);
    });
    return () => {stop(); clearTimeout(timer);};
  }, [root]);
  useEffect(() => {
    if (!options.enabled) return;
    const html = document.documentElement;
    const previous = html.getAttribute('data-hub-tab-swipe');
    html.setAttribute('data-hub-tab-swipe', 'true');
    return () => {
      if (previous === null) html.removeAttribute('data-hub-tab-swipe');
      else html.setAttribute('data-hub-tab-swipe', previous);
    };
  }, [options.enabled]);
  return options.enabled && hint?.account === options.account ? hint?.ids : undefined;
}

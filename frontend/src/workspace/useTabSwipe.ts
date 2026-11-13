import {useEffect, useRef, useState, type RefObject} from 'react';
import {groupFor, type Workspace} from './state';
import {adjacentSwipeTarget, TabSwipeGesture} from './swipe';
import {TouchTabSwipeGesture} from './touchSwipe';

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
  const touch = new TouchTabSwipeGesture();
  const pointers = new Set<number>();
  let composing = false, dragging = false, pinching = false;
  let touchId: number | undefined, touchTarget: Element | null = null;
  let touchPointer: number | undefined, touchClaimed = false;
  let touchBlockedAtStart = false;
  const context = (state: SwipeState) => JSON.stringify([state.account, state.expandedSplits, state.workspace.active,
    state.workspace.order, state.workspace.opened, state.workspace.groups]);
  const blocked = () => composing || dragging || pinching
    || !!document.querySelector('[role=dialog], [role=alertdialog], [role=listbox]')
    || !!root.querySelector('[data-dragging=true], .split-divider-dragging, .terminal-drop-overlay');
  const area = (target: Element | null) => {
    const tabs = target?.closest('.session-tabs-scroll');
    const host = target?.closest('.xterm-host, .terminal-output, .terminal-empty');
    return !!tabs || !!host?.closest('.terminal-slot:not([hidden])') && !hasHorizontalOverflow(target!, host!);
  };
  const navigate = (state: SwipeState, direction: -1 | 1) => {
    const id = adjacentSwipeTarget(state.workspace, direction, state.expandedSplits);
    if (id) select(id);
  };
  const wheel = (event: WheelEvent) => {
    const at = performance.now();
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || pinching) {
      gesture.release(at); return;
    }
    const state = snapshot();
    const target = event.target instanceof Element ? event.target : null;
    const host = target?.closest('.xterm-host, .terminal-output, .terminal-empty');
    const eligible = state.enabled && !blocked() && pointers.size === 0 && touchId === undefined && event.buttons === 0
      && !event.defaultPrevented && area(target);
    const scale = event.deltaMode === 1 ? parseFloat(host ? getComputedStyle(host).lineHeight : '') || 16 : 1;
    const x = event.deltaX * (event.deltaMode === 2 ? root.clientWidth || window.innerWidth : scale);
    const y = event.deltaY * (event.deltaMode === 2 ? root.clientHeight || window.innerHeight : scale);
    const decision = gesture.push({x, y, at, eligible, cancelable: event.cancelable, context: context(state)});
    if (!decision.consume) return;
    event.preventDefault(); event.stopPropagation();
    if (decision.direction) navigate(state, decision.direction);
  };
  const touchPoint = (point: Touch, state: SwipeState, event: TouchEvent) => ({
    x: point.clientX, y: point.clientY, at: performance.now(), context: context(state),
    eligible: state.enabled && !touchBlockedAtStart && !blocked() && !event.defaultPrevented && area(touchTarget)
      && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && !document.getSelection()?.toString() && !touchTarget?.closest('.terminal-slot')?.querySelector('.xterm-selection div'),
  });
  const resetTouch = () => {touch.reset(); touchId = touchPointer = undefined; touchTarget = null; touchClaimed = false;};
  const touchStart = (event: TouchEvent) => {
    gesture.cancel();
    if (event.touches.length !== 1) {resetTouch(); return;}
    touchClaimed = false;
    touchTarget = event.target instanceof Element ? event.target : null;
    if (touchTarget?.closest('button, input, textarea, select, a, [contenteditable=true]')
      && !touchTarget.closest('.tab-trigger, .xterm-helper-textarea')) {resetTouch(); return;}
    const point = event.touches[0]; touchId = point.identifier;
    touch.start(touchPoint(point, snapshot(), event));
  };
  const multiTouch = (event: TouchEvent) => {if (event.touches.length > 1) resetTouch();};
  const touchMove = (event: TouchEvent) => {
    if (touchId === undefined) return;
    if (event.touches.length !== 1) {resetTouch(); return;}
    const point = Array.from(event.touches).find(value => value.identifier === touchId);
    if (!point) return;
    const decision = touch.move(touchPoint(point, snapshot(), event), event.cancelable);
    if (!decision.consume) return;
    if (event.cancelable) event.preventDefault();
    if (!touchClaimed) {
      touchClaimed = true;
      // Cancel React Aria's pending press just as native touch scrolling does.
      // Otherwise its delayed synthetic click can open a menu after a swipe
      // that ends inside the original (wide) tab.
      if (touchPointer !== undefined) touchTarget?.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true, pointerType: 'touch', pointerId: touchPointer,
      }));
    }
    // Let dnd-kit's pending long-press sensor see the movement and abort at its
    // 8px tolerance. Terminal handlers must never receive claimed motion.
    if (!touchTarget?.closest('.session-tabs-scroll')) event.stopPropagation();
  };
  const touchEnd = (event: TouchEvent) => {
    const point = Array.from(event.changedTouches).find(value => value.identifier === touchId);
    if (!point) return;
    if (event.touches.length) {resetTouch(); return;}
    const state = snapshot(), decision = touch.end(touchPoint(point, state, event));
    resetTouch();
    if (!decision.consume) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation(); // Suppress compatibility clicks/menu activation.
    if (decision.direction) navigate(state, decision.direction);
  };
  const cancel = () => {gesture.cancel(); touch.cancel();};
  const pointerDown = (event: PointerEvent) => {
    // Record before an outside press dismisses a portalled menu/dialog.
    if (event.pointerType === 'touch') touchBlockedAtStart = blocked();
    if (!(event.target instanceof Node) || !root.contains(event.target)) {cancel(); return;}
    pointers.add(event.pointerId); gesture.cancel();
    if (event.pointerType === 'touch') touchPointer = event.pointerId;
    else touch.cancel();
  };
  const pointerUp = (event: PointerEvent) => {pointers.delete(event.pointerId);};
  const compositionStart = () => {composing = true; cancel();};
  const compositionEnd = () => {composing = false; cancel();};
  const dragStart = () => {dragging = true; cancel();};
  const dragEnd = () => {dragging = false;};
  const dragLeave = (event: DragEvent) => {if (!event.relatedTarget) dragging = false;};
  const pinchStart = () => {pinching = true; gesture.cancel(); resetTouch();};
  const pinchEnd = () => {pinching = false;};
  const blur = () => {pointers.clear(); composing = dragging = pinching = false; cancel();};
  root.addEventListener('wheel', wheel, {capture: true, passive: false});
  root.addEventListener('touchstart', touchStart, {capture: true, passive: true});
  root.addEventListener('touchmove', touchMove, {capture: true, passive: false});
  document.addEventListener('touchstart', multiTouch, {capture: true, passive: true});
  document.addEventListener('touchend', touchEnd, {capture: true, passive: false});
  document.addEventListener('touchcancel', resetTouch, true);
  document.addEventListener('pointerdown', pointerDown, true);
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
    root.removeEventListener('touchstart', touchStart, true);
    root.removeEventListener('touchmove', touchMove, true);
    document.removeEventListener('touchstart', multiTouch, true);
    document.removeEventListener('touchend', touchEnd, true);
    document.removeEventListener('touchcancel', resetTouch, true);
    document.removeEventListener('pointerdown', pointerDown, true);
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

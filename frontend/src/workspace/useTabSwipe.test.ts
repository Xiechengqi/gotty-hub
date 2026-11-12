import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {bindTabSwipe} from './useTabSwipe';
import type {Workspace} from './state';

let root: HTMLElement, host: HTMLElement, screen: HTMLElement, tabs: HTMLElement;
let stop: () => void, now: number, enabled: boolean, workspace: Workspace;
const select = vi.fn(), terminalWheel = vi.fn();
beforeEach(() => {
  now = 0; enabled = true; select.mockClear(); terminalWheel.mockClear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  workspace = {opened: ['a', 'b', 'c'], order: ['a', 'b', 'c'], active: 'a', groups: []};
  root = document.createElement('main');
  root.innerHTML = '<div class="session-tabs-scroll"><button>tab</button></div><div class="terminal-slot"><div class="xterm-host" style="overflow-x:auto"><div class="xterm-screen"></div></div></div>';
  document.body.append(root);
  host = root.querySelector('.xterm-host')!; screen = root.querySelector('.xterm-screen')!; tabs = root.querySelector('.session-tabs-scroll')!;
  screen.addEventListener('wheel', event => {terminalWheel(); event.stopPropagation();});
  stop = bindTabSwipe(root, () => ({account: 'user', enabled, workspace, expandedSplits: true}), select);
});
afterEach(() => {stop(); root.remove(); document.body.replaceChildren(); vi.restoreAllMocks();});
function wheel(x: number, y = 0, target: Element = screen, extra: WheelEventInit = {}) {
  now += 16;
  const event = new WheelEvent('wheel', {bubbles: true, cancelable: true, deltaX: x, deltaY: y, ...extra});
  target.dispatchEvent(event); return event;
}

it('captures horizontal events before xterm, and passes vertical events through unchanged', () => {
  expect(wheel(30, 2).defaultPrevented).toBe(true);
  expect(wheel(60, 2).defaultPrevented).toBe(true);
  expect(select).toHaveBeenCalledExactlyOnceWith('b'); expect(terminalWheel).not.toHaveBeenCalled();
  workspace = {...workspace, active: 'b'};
  wheel(160); expect(select).toHaveBeenCalledTimes(1); expect(terminalWheel).not.toHaveBeenCalled();
  now += 300; expect(wheel(2, 120).defaultPrevented).toBe(false);
  expect(terminalWheel).toHaveBeenCalledOnce();
});

it('preserves horizontal terminal scrolling for the entire burst, including at its boundary', () => {
  Object.defineProperties(host, {scrollWidth: {value: 1200}, clientWidth: {value: 500}});
  expect(wheel(200).defaultPrevented).toBe(false);
  host.scrollLeft = 700; wheel(200);
  expect(select).not.toHaveBeenCalled(); expect(terminalWheel).toHaveBeenCalledTimes(2);
  now += 300; expect(wheel(100, 0, tabs).defaultPrevented).toBe(true);
  expect(select).toHaveBeenCalledExactlyOnceWith('b');
});

it('normalizes line and page deltas and consumes the edge without wrapping', () => {
  wheel(5, 0, tabs, {deltaMode: 1}); expect(select).toHaveBeenCalledExactlyOnceWith('b');
  now += 300; workspace = {...workspace, active: 'c'};
  expect(wheel(1, 0, tabs, {deltaMode: 2}).defaultPrevented).toBe(true);
  expect(select).toHaveBeenCalledTimes(1);
});

it('preserves modifiers, disabled settings and events the browser cannot cancel', () => {
  for (const extra of [{ctrlKey: true}, {metaKey: true}, {shiftKey: true}, {altKey: true}, {cancelable: false}]) {
    now += 300; expect(wheel(200, 0, screen, extra).defaultPrevented).toBe(false);
  }
  now += 300; enabled = false; expect(wheel(200).defaultPrevented).toBe(false);
  expect(select).not.toHaveBeenCalled();
});

it('pauses for dialogs and input composition, without resuming halfway through their burst', () => {
  const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog);
  expect(wheel(200).defaultPrevented).toBe(false); dialog.remove(); wheel(200);
  expect(select).not.toHaveBeenCalled();
  now += 300; screen.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
  wheel(200); screen.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true})); wheel(200);
  expect(select).not.toHaveBeenCalled();
  now += 300; wheel(90); expect(select).toHaveBeenCalledOnce();
});

it('does not switch while dragging a tab, divider, file or held selection', () => {
  for (const markup of ['<div data-dragging="true"></div>', '<div class="split-divider-dragging"></div>', '<div class="terminal-drop-overlay"></div>']) {
    now += 300; const blocker = document.createElement('div'); blocker.innerHTML = markup; root.append(blocker);
    wheel(200); blocker.remove(); expect(select).not.toHaveBeenCalled();
  }
  now += 300; wheel(200, 0, screen, {buttons: 1}); expect(select).not.toHaveBeenCalled();
  now += 300; screen.dispatchEvent(new Event('dragenter', {bubbles: true})); wheel(200);
  screen.dispatchEvent(new Event('drop', {bubbles: true})); expect(select).not.toHaveBeenCalled();
});

it('cancels on changed order, deleted instance or window blur without sending the tail to xterm', () => {
  wheel(30); workspace = {...workspace, order: ['a', 'c', 'b']}; wheel(70);
  expect(select).not.toHaveBeenCalled();
  now += 300; wheel(30); workspace = {...workspace, opened: ['a', 'c'], order: ['a', 'c']}; wheel(70);
  expect(select).not.toHaveBeenCalled();
  now += 300; wheel(30); window.dispatchEvent(new Event('blur')); wheel(70);
  expect(select).not.toHaveBeenCalled(); expect(terminalWheel).not.toHaveBeenCalled();
});

it('drains a claimed burst even if switching is disabled before the threshold', () => {
  wheel(30); enabled = false;
  expect(wheel(100).defaultPrevented).toBe(true);
  expect(select).not.toHaveBeenCalled(); expect(terminalWheel).not.toHaveBeenCalled();
  now += 300; expect(wheel(100).defaultPrevented).toBe(false);
});

it('ignores Safari pinch gestures and removes the listener on disposal', () => {
  screen.dispatchEvent(new Event('gesturestart', {bubbles: true}));
  expect(wheel(200).defaultPrevented).toBe(false);
  screen.dispatchEvent(new Event('gestureend', {bubbles: true}));
  now += 300; stop(); expect(wheel(200).defaultPrevented).toBe(false); expect(select).not.toHaveBeenCalled();
});

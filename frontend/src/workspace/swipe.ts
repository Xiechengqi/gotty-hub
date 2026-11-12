import {groupFor, navigationUnits, openedOrder, type Workspace} from './state';

export type SwipeDirection = -1 | 1;
export const SWIPE_DISTANCE = 80;
export const SWIPE_IDLE_MS = 220;
const AXIS_RATIO = 2;
type Sample = {x: number; y: number; at: number; eligible: boolean; cancelable: boolean; context: string};
type Decision = {consume: boolean; direction?: SwipeDirection};

// WheelEvent exposes neither finger count nor a gesture-end/momentum phase.
// Lock ownership at the start, then drain the entire burst after one switch.
export class TabSwipeGesture {
  private phase: 'idle' | 'native' | 'tracking' | 'draining' = 'idle';
  private lastAt = -Infinity;
  private context = '';
  private direction: SwipeDirection = 1;
  private distance = 0;

  push(sample: Sample): Decision {
    const {x, y, at, eligible, cancelable, context} = sample;
    if (![x, y, at].every(Number.isFinite)) return {consume: false};
    if (at - this.lastAt >= SWIPE_IDLE_MS || at < this.lastAt) this.phase = 'idle';
    this.lastAt = at;
    const horizontal = Math.abs(x) > 0 && Math.abs(x) >= AXIS_RATIO * Math.abs(y);
    if (this.phase === 'idle') {
      if (!eligible || !cancelable || !horizontal) {
        this.phase = 'native';
        return {consume: false};
      }
      this.phase = 'tracking';
      this.context = context;
      this.direction = x > 0 ? 1 : -1;
      this.distance = 0;
    }
    if (this.phase === 'native') return {consume: false};
    if (this.phase === 'draining') return {consume: true};
    if (!eligible || context !== this.context || !horizontal || x * this.direction <= 0) {
      this.phase = 'draining';
      return {consume: true};
    }
    this.distance += Math.abs(x);
    if (this.distance < SWIPE_DISTANCE) return {consume: true};
    this.phase = 'draining';
    return {consume: true, direction: this.direction};
  }

  cancel() {
    if (this.phase === 'tracking') this.phase = 'draining';
  }

  // Modified wheel gestures (notably pinch-to-zoom) always belong to the browser.
  release(at: number) {
    this.phase = 'native';
    this.lastAt = at;
  }
}

export function adjacentSwipeTarget(state: Workspace, direction: SwipeDirection, expandedSplits: boolean): string | undefined {
  const units = expandedSplits ? navigationUnits(state, true) : openedOrder(state).map(id => [id]);
  const index = units.findIndex(unit => unit.includes(state.active));
  if (index < 0) return;
  const next = units[index + direction];
  if (!next) return;
  const group = expandedSplits && groupFor(state, next[0]);
  return group ? group[group.focused] : next[0];
}

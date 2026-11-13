import {groupFor, navigationUnits, openedOrder, type Workspace} from './state';

export type SwipeDirection = -1 | 1;
export const SWIPE_DISTANCE = 80;
export const SWIPE_IDLE_MS = 220;
const REARM_MS = 160;
const RESTART_DELTA = 8;
const AXIS_RATIO = 2;
type Sample = {x: number; y: number; at: number; eligible: boolean; cancelable: boolean; context: string};
type Decision = {consume: boolean; direction?: SwipeDirection};

// WheelEvent exposes neither finger count nor a gesture-end/momentum phase.
// Keep momentum owned, but allow a deliberate reversal or renewed acceleration
// after it has decayed. Waiting for complete silence can lock out repeated Mac
// trackpad swipes for seconds. A cooldown alone would instead repeat on inertia.
export class TabSwipeGesture {
  private phase: 'idle' | 'native' | 'tracking' | 'draining' = 'idle';
  private lastAt = -Infinity;
  private context = '';
  private direction: SwipeDirection = 1;
  private distance = 0;
  private magnitude = 0;
  private peak = 0;
  private drainedAt = 0;
  private canRestart = false;

  push(sample: Sample): Decision {
    const {x, y, at, eligible, cancelable, context} = sample;
    if (![x, y, at].every(Number.isFinite)) return {consume: false};
    if (at - this.lastAt >= SWIPE_IDLE_MS || at < this.lastAt) this.phase = 'idle';
    this.lastAt = at;
    const horizontal = Math.abs(x) > 0 && Math.abs(x) >= AXIS_RATIO * Math.abs(y);
    const previous = this.magnitude;
    this.magnitude = Math.abs(x);
    if (this.phase === 'draining' && this.canRestart && at - this.drainedAt >= REARM_MS
      && eligible && cancelable && horizontal && this.magnitude >= RESTART_DELTA
      && (x * this.direction < 0 || previous <= this.peak / 2
        && this.magnitude >= Math.max(previous * 1.8, previous + RESTART_DELTA))) {
      this.phase = 'idle';
    }
    if (this.phase === 'idle') {
      if (!eligible || !cancelable || !horizontal) {
        this.phase = 'native';
        return {consume: false};
      }
      this.phase = 'tracking';
      this.context = context;
      this.direction = x > 0 ? 1 : -1;
      this.distance = 0;
      this.peak = 0;
      this.canRestart = false;
    }
    if (this.phase === 'native') return {consume: false};
    if (this.phase === 'draining') return {consume: true};
    if (!eligible || context !== this.context || !horizontal || x * this.direction <= 0) {
      this.phase = 'draining';
      return {consume: true};
    }
    this.distance += Math.abs(x);
    this.peak = Math.max(this.peak, this.magnitude);
    if (this.distance < SWIPE_DISTANCE) return {consume: true};
    this.phase = 'draining';
    this.drainedAt = at;
    this.canRestart = true;
    return {consume: true, direction: this.direction};
  }

  cancel() {
    if (this.phase === 'tracking') this.phase = 'draining';
    this.canRestart = false;
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

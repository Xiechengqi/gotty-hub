import {SWIPE_DISTANCE, type SwipeDirection} from './swipe';

const INTENT_DISTANCE = 12;
const HOLD_MS = 250; // Match the tab sorter's long-press delay.
type Point = {x: number; y: number; at: number; context: string; eligible: boolean};
type Decision = {consume: boolean; direction?: SwipeDirection};

// Touch has an explicit lifetime. Claim only early, clearly horizontal motion;
// commit on lift so the old terminal stays mounted under the entire gesture.
export class TouchTabSwipeGesture {
  private phase: 'idle' | 'pending' | 'native' | 'tracking' | 'draining' = 'idle';
  private origin?: Point;
  private direction: SwipeDirection = 1;

  start(point: Point) {
    this.origin = point;
    this.phase = point.eligible ? 'pending' : 'native';
  }

  move(point: Point, cancelable: boolean): Decision {
    if (!this.origin || this.phase === 'idle' || this.phase === 'native') return {consume: false};
    if (!point.eligible || point.context !== this.origin.context || !cancelable) this.cancel();
    if (this.phase === 'draining') return {consume: true};
    const x = this.origin.x - point.x, y = this.origin.y - point.y;
    if (this.phase === 'pending') {
      if (point.at - this.origin.at >= HOLD_MS) {this.phase = 'native'; return {consume: false};}
      if (Math.max(Math.abs(x), Math.abs(y)) < INTENT_DISTANCE) return {consume: false};
      if (Math.abs(x) < 2 * Math.abs(y)) {this.phase = 'native'; return {consume: false};}
      this.phase = 'tracking'; this.direction = x > 0 ? 1 : -1;
    }
    if (this.phase !== 'tracking') return {consume: false};
    if (x * this.direction <= 0 || Math.abs(x) < 2 * Math.abs(y)) this.cancel();
    return {consume: true};
  }

  end(point: Point): Decision {
    const consume = this.phase === 'tracking' || this.phase === 'draining';
    const x = (this.origin?.x ?? point.x) - point.x, y = (this.origin?.y ?? point.y) - point.y;
    const direction = this.phase === 'tracking' && point.eligible && point.context === this.origin?.context
      && x * this.direction >= SWIPE_DISTANCE && Math.abs(x) >= 2 * Math.abs(y) ? this.direction : undefined;
    this.reset();
    return direction ? {consume, direction} : {consume};
  }

  cancel() {
    if (this.phase === 'tracking') this.phase = 'draining';
    else if (this.phase === 'pending') this.phase = 'native';
  }

  reset() {this.phase = 'idle'; this.origin = undefined;}
}

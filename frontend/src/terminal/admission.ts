type Waiter = {
  priority: () => number;
  signal: AbortSignal;
  start: (release: () => void) => void;
  cancel: () => void;
};
const WINDOW_MS = 300_000;
const START_BUDGET = 115;
const MAX_OPENING = 4;

// The gateway budgets both tickets and upgrades per session. Leave room for
// other tabs while limiting only starts, so established terminals stay live.
export class TerminalAdmission {
  private queue: Waiter[] = [];
  private starts: number[] = [];
  private opening = 0;
  private pausedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  acquire(signal: AbortSignal, priority: () => number) {
    return new Promise<() => void>((resolve, reject) => {
      if (signal.aborted) {reject(signal.reason); return;}
      const waiter: Waiter = {
        priority, signal, start: resolve,
        cancel: () => {
          this.queue = this.queue.filter(item => item !== waiter);
          reject(signal.reason);
          this.wake();
        },
      };
      this.queue.push(waiter);
      signal.addEventListener('abort', waiter.cancel, {once: true});
      this.wake();
    });
  }

  pause(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
    this.wake();
  }

  private wake() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.queue.length || this.opening >= MAX_OPENING) return;
    const now = Date.now();
    this.starts = this.starts.filter(start => now - start < WINDOW_MS);
    const budget = this.starts.length >= START_BUDGET ? this.starts[0] + WINDOW_MS : 0;
    const delay = Math.max(0, this.pausedUntil - now, budget - now);
    this.timer = setTimeout(() => this.drain(), delay);
  }

  private drain() {
    const now = Date.now();
    this.starts = this.starts.filter(start => now - start < WINDOW_MS);
    while (this.queue.length && this.opening < MAX_OPENING && this.starts.length < START_BUDGET && Date.now() >= this.pausedUntil) {
      const next = this.queue.reduce((best, waiter) => waiter.priority() > best.priority() ? waiter : best);
      this.queue.splice(this.queue.indexOf(next), 1);
      next.signal.removeEventListener('abort', next.cancel);
      this.starts.push(Date.now());
      this.opening++;
      let released = false;
      next.start(() => {
        if (released) return;
        released = true;
        this.opening--;
        this.wake();
      });
    }
    this.wake();
  }
}

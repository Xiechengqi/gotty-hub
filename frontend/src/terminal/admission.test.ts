import {afterEach, expect, it, vi} from 'vitest';
import {TerminalAdmission} from './admission';

afterEach(() => vi.useRealTimers());

it('prioritizes the selected terminal and admits more terminals as handshakes finish', async () => {
  vi.useFakeTimers();
  const queue = new TerminalAdmission(), admitted: number[] = [];
  const abort = new AbortController(), cancelled = new AbortController();
  let selected = 0;
  const pending = Array.from({length:7},(_,i) => queue.acquire(abort.signal, () => i === selected ? 2 : 1)
    .then(release => {admitted.push(i); return release;}));
  const abandon = queue.acquire(cancelled.signal, () => 3);
  const expected = expect(abandon).rejects.toMatchObject({name:'AbortError'});
  cancelled.abort();
  await expected;
  selected = 6;
  await vi.advanceTimersByTimeAsync(1);
  expect(admitted).toEqual([6,0,1,2]);
  (await pending[6])();
  await vi.advanceTimersByTimeAsync(1);
  expect(admitted).toEqual([6,0,1,2,3]);
  abort.abort();
  await Promise.allSettled(pending);
});

it('resumes after the request budget opens and honors a server cooldown', async () => {
  vi.useFakeTimers();
  const queue = new TerminalAdmission(), signal = new AbortController().signal;
  let started = 0;
  const pending = Array.from({length:116},() => queue.acquire(signal,()=>1).then(release=>{started++;release();}));
  await vi.advanceTimersByTimeAsync(1000);
  expect(started).toBe(115);
  queue.pause(310_000);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(started).toBe(115);
  await vi.advanceTimersByTimeAsync(10_000);
  await Promise.all(pending);
  expect(started).toBe(116);
});

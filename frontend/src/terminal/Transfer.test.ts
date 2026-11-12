import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {InputSender} from '@gotty/terminal-core/paste';
import {createTransfer, type Transfer} from './Transfer';

const cleanup: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup.splice(0).forEach(dispose => dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
});

function fixture() {
  const frames: string[] = [], offers: Transfer[] = [];
  const output = vi.fn(), setStdin = vi.fn();
  const sender = new InputSender({
    send: frame => {frames.push(frame); return true;}, buffered: () => 0,
    chunkSize: () => 12285, changed: () => {}, message: () => {},
  });
  const transfer = createTransfer(output, bytes => sender.input(bytes), value => {if (value) offers.push(value);}, setStdin);
  cleanup.push(() => {transfer.dispose(); sender.dispose();});
  return {transfer, output, frames, offers, setStdin};
}

it('preserves binary terminal output from the real Sentry as Uint8Array', () => {
  const f = fixture(), bytes = new Uint8Array([0, 127, 128, 255, 13, 10]);
  f.transfer.consume(bytes);
  expect(f.output).toHaveBeenCalledWith(bytes);
  expect(f.output.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
});

it('sends the real sz handshake through the shared input queue', () => {
  const f = fixture();
  f.transfer.consume(new TextEncoder().encode('**\x18B00000000000000\r\n\x11'));
  expect(f.frames).toHaveLength(1);
  expect(f.frames[0][0]).toBe('1');
  expect(atob(f.frames[0].slice(1))).toMatch(/^\*\*\x18B01/);
  expect(f.setStdin).toHaveBeenLastCalledWith(false);
});

it('delivers the real rz abort bytes and restores keyboard input', () => {
  const f = fixture();
  f.transfer.consume(new TextEncoder().encode('**\x18B0100000023be50\r\n\x11'));
  expect(f.offers).toHaveLength(1);
  expect(f.setStdin).toHaveBeenLastCalledWith(false);
  f.offers[0].session.abort();
  expect(f.frames.map(frame => atob(frame.slice(1))).join('')).toBe('\x18'.repeat(5) + '\x08'.repeat(5));
  expect(f.setStdin).toHaveBeenLastCalledWith(true);
});

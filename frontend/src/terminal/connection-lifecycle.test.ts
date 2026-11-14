import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {api, APIError} from '../api';
import {HubConnection} from './connection';

vi.mock('../api', async original => ({...await original<typeof import('../api')>(), api: vi.fn()}));
class Socket {
  readyState = 0; bufferedAmount = 0;
  onopen?: () => void; onclose?: (event: CloseEvent) => void; onmessage?: (event: MessageEvent) => void;
  send = vi.fn(); close = vi.fn(() => {this.readyState = 3; this.onclose?.(new CloseEvent('close'));});
  constructor() {sockets.push(this);}
}
let sockets: Socket[] = [];
const connections: HubConnection[] = [];
beforeEach(() => {sockets = []; vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket); vi.mocked(api).mockReset().mockResolvedValue({ticket: 'ticket'});});
afterEach(() => {connections.splice(0).forEach(value => value.close()); vi.useRealTimers(); vi.unstubAllGlobals();});
function connection() {
  const value = new HubConnection('instance', true, true, true, () => true, () => true);
  const closed = vi.fn(); value.onClose(closed); value.onOpen(() => value.send('{}')); connections.push(value);
  return {value, closed};
}
function violation(uri: string, disposition = 'enforce') {
  const event = new Event('securitypolicyviolation');
  Object.defineProperties(event, {blockedURI: {value: uri}, effectiveDirective: {value: 'connect-src'}, disposition: {value: disposition}});
  document.dispatchEvent(event);
}

it('fetches the ticket before allocating a socket and sends authentication immediately on open', async () => {
  let resolve!: (value: any) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(done => {resolve = done;}));
  const {value} = connection(), opening = value.open();
  expect(sockets).toHaveLength(0); expect(value.readyState()).toBe(0); expect(value.phase).toBe('ticket');
  resolve({ticket: 'fresh'}); await opening;
  expect(sockets).toHaveLength(1); expect(value.phase).toBe('connecting');
  sockets[0].readyState = 1; sockets[0].onopen!();
  expect(JSON.parse(sockets[0].send.mock.calls[0][0])).toMatchObject({ticket: 'fresh'});
  expect(value.phase).toBe('initializing');
  sockets[0].onmessage!({data: '4{}'} as MessageEvent);
  expect(value.phase).toBe('ready');
  await vi.advanceTimersByTimeAsync(30000); expect(value.closed).toBe(false);
});

it('aborts pending authorization and discards a late ticket after teardown', async () => {
  let resolve!: (value: any) => void;
  vi.mocked(api).mockReturnValueOnce(new Promise(done => {resolve = done;}));
  const {value, closed} = connection(), opening = value.open();
  const signal = vi.mocked(api).mock.calls[0][3]!;
  value.close(); resolve({ticket: 'late'}); await opening;
  expect(signal.aborted).toBe(true); expect(sockets).toHaveLength(0); expect(closed).toHaveBeenCalledOnce();
});

it.each(['ticket', 'connecting', 'initializing'])('bounds the %s phase and notifies once', async phase => {
  let resolve!: (value: any) => void;
  if (phase === 'ticket') vi.mocked(api).mockReturnValueOnce(new Promise(done => {resolve = done;}));
  const {value, closed} = connection(), opening = value.open();
  if (phase !== 'ticket') await opening;
  if (phase === 'initializing') {sockets[0].readyState = 1; sockets[0].onopen!();}
  await vi.advanceTimersByTimeAsync(10000);
  expect(closed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({code: 1013, reason: expect.stringContaining('timed out')}));
  expect(value.readyState()).toBe(3);
  if (phase === 'ticket') {resolve({ticket: 'late'}); await opening; expect(sockets).toHaveLength(0);}
});

it('distinguishes a synchronous browser security failure from an ordinary network failure', async () => {
  vi.stubGlobal('WebSocket', class {constructor() {throw new DOMException('blocked', 'SecurityError');}});
  const {value, closed} = connection(); await value.open();
  expect(closed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({code: 1008, retryable: false, reason: 'WebSocket blocked by browser security policy'}));
});

it('ignores unrelated and report-only violations and correlates an enforced socket violation', async () => {
  const {value, closed} = connection(); await value.open();
  const uri = 'ws://' + location.host + '/api/v1/terminal-connections/instance/ws';
  violation('ws://other.example/ws'); violation(uri, 'report'); expect(closed).not.toHaveBeenCalled();
  violation(uri);
  expect(closed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({retryable: false, reason: expect.stringContaining('security policy')}));
  expect(sockets[0].close).toHaveBeenCalledWith(4003);
});

it('recognizes a CSP event dispatched just after an abnormal WebKit close', async () => {
  const {value, closed} = connection(); await value.open();
  sockets[0].onclose!(new CloseEvent('close', {code: 1006}));
  violation('ws://' + location.host + '/api/v1/terminal-connections/instance/ws');
  await vi.advanceTimersByTimeAsync(1);
  expect(closed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({retryable: false}));
  expect(api).toHaveBeenCalledOnce();
});

it('accepts a redacted CSP WebSocket origin but ignores another terminal path', async () => {
  const {value, closed} = connection(); await value.open();
  violation('ws://' + location.host + '/other-terminal/ws'); expect(closed).not.toHaveBeenCalled();
  violation('ws://' + location.host);
  expect(closed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({retryable: false}));
});

it('keeps an established terminal alive when another socket has a redacted CSP violation', async () => {
  const {value, closed} = connection(); await value.open();
  sockets[0].readyState = 1; sockets[0].onopen!(); sockets[0].onmessage!({data:'4{}'} as MessageEvent);
  violation('ws://' + location.host);
  expect(closed).not.toHaveBeenCalled(); expect(value.phase).toBe('ready');
});

it('waits after API rate limiting without creating another WebSocket', async () => {
  vi.mocked(api).mockRejectedValueOnce(new APIError(429, 'rate_limit'));
  const {value, closed} = connection(); await value.open();
  expect(sockets).toHaveLength(0);
  expect(closed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({code: 1013, retryAfterMs: 60000}));
});

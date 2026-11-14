import {File as NodeFile} from 'node:buffer';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {HubConnection} from './connection';
import {FILE_LIMIT, uploadFile, type UploadChunk, type UploadReply} from './upload';

vi.mock('../api',()=>({api:vi.fn(async()=>({ticket:'ticket'})),APIError:class extends Error{}}));

class Socket {
  readyState = 1; bufferedAmount = 0; send = vi.fn();
  onmessage: any; onclose: any;
  close() {this.readyState = 3; this.onclose?.(new CloseEvent('close'));}
}
const connections: HubConnection[] = [];
beforeEach(() => {vi.stubGlobal('WebSocket', Socket);});
afterEach(() => {connections.splice(0).forEach(value => value.close()); vi.useRealTimers(); vi.unstubAllGlobals();});
async function connect(writable = true, initialize = true) {
  const value = new HubConnection('instance', writable, false, false, () => true, () => true);
  connections.push(value);
  await value.open();
  if (initialize) {value.send('{}');value.ws!.onmessage!({data:'4{}'} as MessageEvent);}
  vi.mocked(value.ws!.send).mockClear();
  return value;
}
const file = (size: number, name = '中文 file.bin') => new NodeFile([new Uint8Array(size).fill(255)], name) as unknown as File;
const chunks = (connection: HubConnection): UploadChunk[] => vi.mocked(connection.ws!.send).mock.calls.filter(([data]) => String(data)[0] === '7').map(([data]) => JSON.parse(String(data).slice(1)));
const reply = (connection: HubConnection, value: UploadReply) => connection.ws!.onmessage!({data: 'd' + JSON.stringify(value)} as MessageEvent);

it('waits for matching disk acknowledgments and respects UTF-8 frame limits', async () => {
  const connection = await connect(), progress = vi.fn(), selected = file(1500);
  const pending = uploadFile(selected, connection, 1024, true, new AbortController().signal, progress);
  let loaded = 0, count = 0;
  do {
    await vi.waitFor(() => expect(chunks(connection).length).toBe(count + 1));
    const message = chunks(connection)[count];
    const received = loaded + atob(message.data).length;
    const ack = {...message, received, done: message.chunk === message.totalChunks - 1};
    if (count === 0) {
      reply(connection, {...ack, uploadId: 'another-transfer'});
      await Promise.resolve();
      expect(progress).not.toHaveBeenCalled();
      expect(chunks(connection)).toHaveLength(1);
    }
    reply(connection, ack);
    loaded = received; count++;
    if (ack.done) break;
  } while (true);
  await expect(pending).resolves.toBe(true);
  expect(loaded).toBe(selected.size);
  expect(progress.mock.calls.at(-1)?.[0]).toEqual({loaded: 1500, progress: 99});
  expect(vi.mocked(connection.ws!.send).mock.calls.every(([data]) => new TextEncoder().encode(String(data)).length <= 1024)).toBe(true);
});

it.each(['timeout', 'abort', 'disconnect'] as const)('rejects %s while awaiting confirmation and releases the pending request', async mode => {
  vi.useFakeTimers();
  const connection = await connect(), abort = new AbortController();
  const message: UploadChunk = {uploadId: 'one', name: 'test', size: 1, chunk: 0, totalChunks: 1, data: '/w=='};
  const pending = connection.uploadChunk(message, abort.signal);
  const rejected = expect(pending).rejects.toThrow(mode === 'timeout' ? 'timed out' : mode === 'abort' ? 'cancelled' : 'disconnected');
  if (mode === 'timeout') await vi.advanceTimersByTimeAsync(30000);
  if (mode === 'abort') abort.abort();
  if (mode === 'disconnect') connection.close();
  await rejected;
  if (mode !== 'disconnect') {
    const retry = connection.uploadChunk({...message, uploadId: 'two'}, new AbortController().signal);
    reply(connection, {...message, uploadId: 'two', received: 1, done: true});
    await expect(retry).resolves.toMatchObject({done: true});
  }
});

it.each(['disk-error', 'bad-receipt', 'cancel'] as const)('cleans up a %s without reporting success', async mode => {
  const connection = await connect(), abort = new AbortController(), progress = vi.fn();
  const pending = uploadFile(file(100), connection, 16384, true, abort.signal, progress);
  const rejected = expect(pending).rejects.toThrow(mode === 'disk-error' ? 'Cannot write' : mode === 'bad-receipt' ? 'Invalid upload confirmation' : 'cancelled');
  await vi.waitFor(() => expect(chunks(connection)).toHaveLength(1));
  const message = chunks(connection)[0];
  if (mode === 'cancel') abort.abort();
  else reply(connection, {...message, received: mode === 'bad-receipt' ? 99 : 0, done: true, error: mode === 'disk-error' ? 'Cannot write upload file; check free space' : undefined});
  await rejected;
  expect(progress).not.toHaveBeenCalled();
  expect(chunks(connection).at(-1)).toEqual({uploadId: message.uploadId, cancel: true});
});

it('keeps legacy transfer unverified, including empty files, and drains buffered sends', async () => {
  const connection = await connect(), progress = vi.fn();
  Object.defineProperty(connection.ws, 'bufferedAmount', {value: 10, writable: true});
  const pending = uploadFile(file(0, 'empty'), connection, 1024, false, new AbortController().signal, progress);
  let finished = false; void pending.then(() => {finished = true;});
  await vi.waitFor(() => expect(chunks(connection)).toHaveLength(1));
  expect(chunks(connection)[0]).toEqual({name: 'empty', size: 0, chunk: 0, totalChunks: 1, data: ''});
  expect(finished).toBe(false);
  Object.defineProperty(connection.ws, 'bufferedAmount', {value: 0});
  await expect(pending).resolves.toBe(false);
});

it('sends cancellation immediately during a pending file read and never sends its late bytes', async () => {
  const connection = await connect(), abort = new AbortController();
  let finishRead!: (value: ArrayBuffer) => void;
  const reading = vi.fn(() => new Promise<ArrayBuffer>(resolve => {finishRead = resolve;}));
  const selected = {name: 'slow.txt', size: 1, slice: () => ({arrayBuffer: reading})} as unknown as File;
  const pending = uploadFile(selected, connection, 1024, true, abort.signal, vi.fn());
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
  abort.abort();
  expect(chunks(connection)).toHaveLength(1);
  expect(chunks(connection)[0]).toMatchObject({cancel: true});
  finishRead(new ArrayBuffer(1));
  await rejected;
  expect(chunks(connection)).toHaveLength(1);
});

it('rejects oversize, unsafe names, observers and uninitialized connections before sending data', async () => {
  for (const [connection, selected] of [[await connect(), {...file(0), size: FILE_LIMIT + 1}], [await connect(), file(1, '../bad')], [await connect(false), file(1)], [await connect(true, false), file(1)]] as [HubConnection, File][]) {
    await expect(uploadFile(selected, connection, 1024, true, new AbortController().signal, vi.fn())).rejects.toThrow();
    expect(connection.ws!.send).not.toHaveBeenCalled();
  }
});

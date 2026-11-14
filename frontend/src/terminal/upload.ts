import {randomId} from '../random';
import type {HubConnection} from './connection';

export const FILE_LIMIT = 64 * 1024 * 1024;
export type UploadChunk = {uploadId: string; name: string; size: number; chunk: number; totalChunks: number; data: string};
export type UploadReply = {uploadId: string; name: string; chunk: number; received: number; done: boolean; error?: string};
export type UploadProgress = {loaded: number; progress: number};

// Acknowledged uploads advance only after GoTTY has written each chunk. Older
// devices retain the original protocol, with a distinct, unverified outcome.
export async function uploadFile(file: File, connection: HubConnection, bufferSize: number, acknowledged: boolean, signal: AbortSignal, progress: (value: UploadProgress) => void): Promise<boolean> {
  if (file.size > FILE_LIMIT) throw Error('Maximum file size: 64 MiB');
  if (!file.name || /[/\\\0]/.test(file.name) || file.name.includes('..') || file.name === '.') throw Error('Invalid upload filename');
  const uploadId = acknowledged ? randomId() : undefined;
  const overhead = new TextEncoder().encode(JSON.stringify({uploadId, name: file.name, size: file.size, chunk: file.size, totalChunks: Math.max(1, file.size), data: ''})).length + 1;
  const chunkSize = Math.min(8192, Math.floor((bufferSize - overhead) / 4) * 3);
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw Error('Filename is too long');
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
  const check = () => {signal.throwIfAborted(); connection.assertUploadReady();};
  const drain = async (limit: number) => {
    const deadline = Date.now() + 30000;
    check();
    while (connection.bufferedAmount() > limit) {
      if (Date.now() > deadline) throw Error('Upload timed out; check the connection and retry');
      await new Promise(resolve => setTimeout(resolve, 10));
      check();
    }
  };
  const cancel = () => {
    if (uploadId) {
      try {connection.sendUpload('7' + JSON.stringify({uploadId, cancel: true}));} catch { /* A disconnected stream is cleaned up by GoTTY. */ }
    }
  };
  // File reads themselves cannot be aborted. Release the remote transfer
  // immediately, even if a read has not settled yet.
  signal.addEventListener('abort', cancel, {once: true});
  try {
    for (let chunk = 0; chunk < totalChunks; chunk++) {
      await drain(256 * 1024);
      const bytes = new Uint8Array(await file.slice(chunk * chunkSize, (chunk + 1) * chunkSize).arrayBuffer());
      check();
      const data = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
      const message = {uploadId, name: file.name, size: file.size, chunk, totalChunks, data};
      const loaded = Math.min(file.size, (chunk + 1) * chunkSize);
      if (acknowledged) {
        const result = await connection.uploadChunk(message as UploadChunk, signal);
        if (result.name !== file.name || result.received !== loaded || result.done !== (chunk + 1 === totalChunks)) throw Error('Invalid upload confirmation');
      } else {
        connection.sendUpload('7' + JSON.stringify(message));
      }
      progress({loaded, progress: Math.min(99, file.size ? Math.floor(loaded / file.size * 100) : 0)});
    }
    await drain(0);
    return acknowledged;
  } catch (error) {
    if (!signal.aborted) cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export function uploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

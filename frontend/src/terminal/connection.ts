import type {Connection, ConnectionCloseEvent} from '@gotty/terminal-core';
import {api,APIError} from '../api';
import {randomId} from '../random';
import type {Control} from './ShareManager';
import type {UploadChunk, UploadReply} from './upload';

export class HubConnection implements Connection {
  ws?: WebSocket; closed = false; ticket = '';
  phase: 'idle' | 'ticket' | 'connecting' | 'initializing' | 'ready' | 'closed' = 'idle';
  private opened=false; private stopped=false;
  private started=false; private delivered=false;
  private initialized=false;
  private failure?: Failure;
  private abort=new AbortController();
  private diagnosticAbort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private url: string;
  private uploadPending?: {id: string; chunk: number; finish: (error?: Error, reply?: UploadReply) => void};
  onopen = () => {}; onreceive = (_data: string) => {}; onclose = (_event: ConnectionCloseEvent) => {};
  pending = new Map<string, {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  constructor(private id: string, private writable: boolean, private owner: boolean, private controls: boolean, private viewing: () => boolean, private visible: () => boolean) {
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/terminal-connections/${id}/ws`;
  }
  async open() {
    if (this.started || this.closed) return;
    this.started = true;
    document.addEventListener('securitypolicyviolation', this.policyViolation);
    this.phase = 'ticket';
    this.deadline('Terminal authorization timed out');
    try {
      // Fetching a ticket must not consume the socket's five-second auth window.
      const value = await api(`/instances/${this.id}/terminal-tickets`, {}, undefined, this.abort.signal);
      if (this.closed) return;
      this.ticket = value.ticket;
      this.phase = 'connecting';
      this.deadline('WebSocket connection timed out');
      this.ws = new WebSocket(this.url);
      this.bindSocket(this.ws);
    } catch (error) {
      if (this.closed) return;
      this.fail(error instanceof DOMException && error.name === 'SecurityError'
        ? {code:1008,reason:'WebSocket blocked by browser security policy',retryable:false}
        : apiFailure(error) ?? {code:1013,reason:this.phase==='connecting'?'Unable to create terminal connection':'Terminal authorization temporarily unavailable'});
    }
  }
  private bindSocket(ws: WebSocket) {
    ws.onmessage = event => {
      if (this.closed) return;
      const text = String(event.data);
      if (/^[1-9abce]/.test(text)) {this.phase = 'ready'; clearTimeout(this.timer);}
      if (text[0] === 'd') {
        try {
          const reply = JSON.parse(text.slice(1)) as UploadReply;
          const pending = this.uploadPending;
          if (pending && reply.uploadId === pending.id && reply.chunk === pending.chunk) pending.finish(reply.error ? Error(reply.error) : undefined, reply);
        } catch { /* Malformed replies time out instead of claiming success. */ }
        return;
      }
      if (text.startsWith('{')) {
        try {
          const result = JSON.parse(text).control_result;
          const pending = this.pending.get(result?.id);
          if (pending) {clearTimeout(pending.timer); this.pending.delete(result.id); if (result.error) pending.reject(Error(result.error)); else pending.resolve(result.value);}
        } catch { /* Ignore malformed control replies. */ }
        return;
      }
      this.onreceive(text);
    };
    ws.onclose = event => this.finishClose(event);
    ws.onopen = () => {
      if (this.closed) return;
      this.opened=true;
      this.phase = 'initializing';
      this.deadline('Terminal initialization timed out');
      this.onopen();
    };
  }
  close() {
    this.stopped=true;
    this.diagnosticAbort?.abort();
    document.removeEventListener('securitypolicyviolation', this.policyViolation);
    this.finishClose(new CloseEvent('close',{code:1000,reason:'Terminal connection closed'}));
    try {this.ws?.close();} catch { /* A browser may reject close during setup. */ }
  }
  private deadline(reason: string) {
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>this.fail({code:1013,reason}),10000);
  }
  private policyViolation = (event: SecurityPolicyViolationEvent) => {
    if (this.delivered || this.opened || !this.ws || event.disposition === 'report' || event.effectiveDirective !== 'connect-src') return;
    try {
      const blocked=new URL(event.blockedURI), target=new URL(this.url);
      // CSP reports may strip a WebSocket path when treating its scheme as a
      // different origin. Match that redacted origin, never unrelated resources.
      if (blocked.href!==target.href && !(blocked.origin===target.origin && blocked.pathname==='/' && !blocked.search && !blocked.hash)) return;
    } catch {return;}
    this.fail({code:1008,reason:'WebSocket blocked by browser security policy',retryable:false});
  };
  private fail(failure: Failure) {
    this.failure=failure;
    if (this.closed) return;
    this.finishClose(new CloseEvent('close',{code:failure.code,reason:failure.reason}));
    // Browsers permit only 1000 and application codes 3000–4999 in close().
    try {this.ws?.close(failure.retryable === false ? 4003 : failure.code === 1008 ? 4001 : 4013);} catch { /* Already closing. */ }
  }
  private finishClose(event: CloseEvent) {
    if (this.closed) return;
    this.closed=true; this.phase='closed'; clearTimeout(this.timer);
    this.abort.abort(); this.rejectPending();
    void this.describeClose(event);
  }
  private async describeClose(event:CloseEvent){
    // WebKit can report the socket close before dispatching its CSP violation.
    if (event.code===1006) await new Promise(resolve=>setTimeout(resolve,0));
    let detail=this.failure;
    if(!detail&&event.code===1006&&!this.stopped){
      const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),2500);
      this.diagnosticAbort=abort;
      try{
        await api('/me',undefined,undefined,abort.signal);
        const rows=await api<{id:string;online:boolean}[]>('/instances',undefined,undefined,abort.signal);
        const instance=rows.find(row=>row.id===this.id);
        if(!instance)detail={code:1008,reason:'Authentication or instance access denied'};
        else if(!instance.online)detail={code:1013,reason:'Instance offline'};
      }catch(error){detail=apiFailure(error);}finally{clearTimeout(timeout);this.diagnosticAbort=undefined;}
      detail??={code:1006,reason:this.opened?'Network or proxy connection interrupted':'WebSocket handshake failed; check proxy Upgrade support and network'};
    }
    detail=this.failure??detail;
    document.removeEventListener('securitypolicyviolation', this.policyViolation);
    if (this.delivered) return;
    this.delivered=true;
    const close=detail?Object.assign(new CloseEvent('close',{code:detail.code,reason:detail.reason,wasClean:event.wasClean}),{retryable:detail.retryable,retryAfterMs:detail.retryAfterMs}):event;
    this.onclose(close);
  }
  private rejectPending() {for (const request of this.pending.values()) {clearTimeout(request.timer); request.reject(Error('Terminal is disconnected'));} this.pending.clear(); this.uploadPending?.finish(Error('Terminal is disconnected'));}
  assertUploadReady() {
    if (!this.writable) throw Error('File upload requires write permission');
    if (!this.initialized || this.closed || this.ws?.readyState !== 1) throw Error('Terminal is disconnected');
  }
  sendUpload(data: string) {this.assertUploadReady(); this.ws!.send(data);}
  uploadChunk(chunk: UploadChunk, signal: AbortSignal): Promise<UploadReply> {
    signal.throwIfAborted(); this.assertUploadReady();
    if (this.uploadPending) return Promise.reject(Error('Another upload is running'));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, reply?: UploadReply) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        this.uploadPending = undefined;
        if (error) reject(error); else resolve(reply!);
      };
      const abort = () => finish(Error('Upload cancelled'));
      const timer = setTimeout(() => finish(Error('Upload timed out; check the connection and retry')), 30000);
      this.uploadPending = {id: chunk.uploadId, chunk: chunk.chunk, finish};
      signal.addEventListener('abort', abort, {once: true});
      try {this.sendUpload('7' + JSON.stringify(chunk));} catch (error) {finish(error instanceof Error ? error : Error(String(error)));}
    });
  }
  isOpen() {return !this.closed && this.readyState() <= 1;} readyState() {return this.closed ? 3 : this.ws?.readyState ?? 0;}
  onOpen(callback: () => void) {this.onopen = callback;} onReceive(callback: (data: string) => void) {this.onreceive = callback;} onClose(callback: (event: ConnectionCloseEvent) => void) {this.onclose = callback;}
  send(data: string) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) return false;
    if (data.startsWith('{')) {const init = JSON.parse(data); this.ws.send(JSON.stringify({ticket: this.ticket, epoch: init.Epoch ?? '', offset: init.LastOffset ?? 0, client_key: init.ClientKey ?? '', replay_version: init.ReplayVersion ?? 0, sequence: init.LastSequence ?? 0})); this.initialized=true; this.reportView(); return true;}
    if (!this.initialized) return false;
    if (!this.writable && !['2', '4'].includes(data[0])) return false;
    if (data[0] === '3' && !this.visible()) {
      const size = JSON.parse(data.slice(1));
      this.ws.send('3' + JSON.stringify({...size, visible: false, paneVisible: false, takeControl: false})); return true;
    }
    this.ws.send(data);
    return true;
  }
  bufferedAmount() {return this.ws?.bufferedAmount ?? 0;}
  request: Control = (action, payload = {}) => {
    if (!this.owner || !this.controls || !this.initialized || this.closed || this.ws?.readyState !== 1 || !this.ticket) return Promise.reject(Error('Terminal management is unavailable'));
    if (this.pending.size) return Promise.reject(Error('Another terminal operation is running'));
    const requestId = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(requestId); reject(Error('Terminal operation timed out'));}, 60000);
      this.pending.set(requestId, {resolve, reject, timer});
      this.ws!.send(JSON.stringify({control: {id: requestId, action, payload}}));
    });
  };
  reportView() {if (this.initialized && this.ws?.readyState === 1 && this.ticket && !this.closed) this.ws.send(JSON.stringify({viewing: this.viewing()}));}
}

type Failure = {code:number;reason:string;retryable?:boolean;retryAfterMs?:number};
function apiFailure(error:unknown):Failure|undefined{
  if(!(error instanceof APIError))return;
  if(error.code==='origin_mismatch'||error.code==='invalid_proxy_headers')return {code:1008,reason:'Authentication origin validation failed'};
  if(error.status===401||error.status===403)return {code:1008,reason:'Authentication or instance access denied'};
  if(error.status===429)return {code:1013,reason:'Hub connection rate limit reached',retryAfterMs:60000};
  if(error.code==='instance_offline')return {code:1013,reason:'Instance offline'};
  if(error.code==='server_shutting_down')return {code:1012,reason:'Hub restarting or stopping'};
}

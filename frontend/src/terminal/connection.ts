import type {Connection} from '@gotty/terminal-core';
import {api,APIError} from '../api';
import {randomId} from '../random';
import type {Control} from './ShareManager';

export class HubConnection implements Connection {
  ws: WebSocket; closed = false; ticket = '';
  private opened=false; private stopped=false;
  private failure?: {code:number;reason:string};
  private abort=new AbortController();
  onopen = () => {}; onreceive = (_data: string) => {}; onclose = (_event: CloseEvent) => {};
  pending = new Map<string, {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  constructor(private id: string, private writable: boolean, private owner: boolean, private controls: boolean, private viewing: () => boolean, private visible: () => boolean) {
    this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/terminal-connections/${id}/ws`);
    this.ws.onmessage = event => {
      const text = String(event.data);
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
    this.ws.onclose = event => {this.closed = true; this.abort.abort(); this.rejectPending(); void this.describeClose(event);};
    this.ws.onopen = () => {
      this.opened=true;
      const timeout=setTimeout(()=>this.abort.abort(),4000);
      api(`/instances/${this.id}/terminal-tickets`, {},undefined,this.abort.signal)
        .then(value => {if (!this.closed) {this.ticket = value.ticket; this.onopen();}})
        .catch(error => {
          if(this.closed)return;
          this.failure=apiFailure(error)??{code:1013,reason:'Terminal authorization temporarily unavailable'};
          // Browsers may send only 1000 or application codes 3000–4999.
          this.ws.close(this.failure.code===1008?4001:4013);
        }).finally(()=>clearTimeout(timeout));
    };
  }
  open() {} close() {this.stopped=true;this.closed = true;this.abort.abort();this.rejectPending();this.ws.close();}
  private async describeClose(event:CloseEvent){
    let detail=this.failure;
    if(!detail&&event.code===1006&&!this.stopped){
      const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),2500);
      try{
        await api('/me',undefined,undefined,abort.signal);
        const rows=await api<{id:string;online:boolean}[]>('/instances',undefined,undefined,abort.signal);
        const instance=rows.find(row=>row.id===this.id);
        if(!instance)detail={code:1008,reason:'Authentication or instance access denied'};
        else if(!instance.online)detail={code:1013,reason:'Instance offline'};
      }catch(error){detail=apiFailure(error);}finally{clearTimeout(timeout);}
      detail??={code:1006,reason:this.opened?'Network or proxy connection interrupted':'WebSocket handshake failed; check proxy Upgrade support and network'};
    }
    this.onclose(detail?new CloseEvent('close',{...detail,wasClean:event.wasClean}):event);
  }
  private rejectPending() {for (const request of this.pending.values()) {clearTimeout(request.timer); request.reject(Error('Terminal is disconnected'));} this.pending.clear();}
  isOpen() {return !this.closed && this.ws.readyState <= 1;} readyState() {return this.ws.readyState;}
  onOpen(callback: () => void) {this.onopen = callback;} onReceive(callback: (data: string) => void) {this.onreceive = callback;} onClose(callback: (event: CloseEvent) => void) {this.onclose = callback;}
  send(data: string) {
    if (this.closed || this.ws.readyState !== 1) return;
    if (data.startsWith('{')) {const init = JSON.parse(data); this.ws.send(JSON.stringify({ticket: this.ticket, epoch: init.Epoch ?? '', offset: init.LastOffset ?? 0})); this.reportView(); return;}
    if (!this.writable && !['2', '4'].includes(data[0])) return;
    if (data[0] === '3' && !this.visible()) return;
    this.ws.send(data);
  }
  request: Control = (action, payload = {}) => {
    if (!this.owner || !this.controls || this.closed || this.ws.readyState !== 1 || !this.ticket) return Promise.reject(Error('Terminal management is unavailable'));
    if (this.pending.size) return Promise.reject(Error('Another terminal operation is running'));
    const requestId = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(requestId); reject(Error('Terminal operation timed out'));}, 60000);
      this.pending.set(requestId, {resolve, reject, timer});
      this.ws.send(JSON.stringify({control: {id: requestId, action, payload}}));
    });
  };
  reportView() {if (this.ws.readyState === 1 && this.ticket && !this.closed) this.ws.send(JSON.stringify({viewing: this.viewing()}));}
}

function apiFailure(error:unknown):{code:number;reason:string}|undefined{
  if(!(error instanceof APIError))return;
  if(error.code==='origin_mismatch'||error.code==='invalid_proxy_headers')return {code:1008,reason:'Authentication origin validation failed'};
  if(error.status===401||error.status===403)return {code:1008,reason:'Authentication or instance access denied'};
  if(error.code==='instance_offline')return {code:1013,reason:'Instance offline'};
  if(error.code==='server_shutting_down')return {code:1012,reason:'Hub restarting or stopping'};
}

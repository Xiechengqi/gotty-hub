import type {Connection} from '@gotty/terminal-core';
import {api} from '../api';
import type {Control} from './ShareManager';

export class HubConnection implements Connection {
  ws: WebSocket; closed = false; ticket = '';
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
    this.ws.onclose = event => {this.closed = true; this.rejectPending(); this.onclose(event);};
    this.ws.onopen = () => {api(`/instances/${this.id}/terminal-tickets`, {}).then(value => {if (!this.closed) {this.ticket = value.ticket; this.onopen();}}).catch(() => this.ws.close(1008, 'Authentication or access denied'));};
  }
  open() {} close() {this.closed = true; this.rejectPending(); this.ws.close();}
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
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(requestId); reject(Error('Terminal operation timed out'));}, 60000);
      this.pending.set(requestId, {resolve, reject, timer});
      this.ws.send(JSON.stringify({control: {id: requestId, action, payload}}));
    });
  };
  reportView() {if (this.ws.readyState === 1 && this.ticket && !this.closed) this.ws.send(JSON.stringify({viewing: this.viewing()}));}
}

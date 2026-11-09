import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {displayOptions,NORD_THEME} from '@gotty/terminal-core/appearance';
import {readAppearance,saveAppearance} from './appearance';
import {HubConnection} from './connection';
vi.mock('../api',async importOriginal=>({...await importOriginal<typeof import('../api')>(),api:vi.fn(async()=>({ticket:'ticket-1'}))}));
class Socket {
 readyState=1;bufferedAmount=0;send=vi.fn();onmessage:any;onclose:any;onopen:any;
 close(){this.readyState=3;this.onclose?.(new CloseEvent('close'));}
}
const connections:HubConnection[]=[];
beforeEach(()=>{localStorage.clear();vi.stubGlobal('WebSocket',Socket);});
afterEach(()=>{connections.splice(0).forEach(connection=>connection.close());vi.unstubAllGlobals();});
function connection(writable=true,owner=true,controls=true){const value=new HubConnection('id-1',writable,owner,controls,()=>true,()=>true);value.ticket='ticket';connections.push(value);return value;}
it('matches GoTTY display defaults and retains remote terminal metrics',()=>{
 const value=displayOptions({'font-size':20,'scrollback-lines':800,'cursor-style':'bar'},{nord:NORD_THEME},{});
 expect(value).toMatchObject({fontSize:20,fontFamily:"'Source Code Pro', monospace",scrollback:800,cursorStyle:'bar',theme:NORD_THEME});
});
it('isolates saved display choices between split terminals and tolerates damaged storage',()=>{
 saveAppearance('a',{theme:'light',fontSize:24});saveAppearance('b',{theme:'nord',fontSize:12});
 expect(readAppearance('a').fontSize).toBe(24);expect(readAppearance('b').fontSize).toBe(12);
 localStorage.setItem('gotty-hub:terminal:a:appearance','null');expect(readAppearance('a').fontSize).toBeUndefined();
});
it('blocks observer input, upload and remote management while keeping protocol heartbeat',async()=>{
 const value=connection(false,false);value.send('1data');value.send('3size');value.send('7file');value.send('2');
 expect(value.ws.send).toHaveBeenCalledExactlyOnceWith('2');await expect(value.request('restart')).rejects.toThrow('unavailable');
});
it('correlates management replies separately from terminal output and clears disconnects',async()=>{
 const value=connection();const receive=vi.fn();value.onReceive(receive);
 const pending=value.request('shares');const frame=JSON.parse((value.ws.send as any).mock.calls[0][0]);
 value.ws.onmessage!({data:JSON.stringify({control_result:{id:frame.control.id,value:{shares:[]}}})} as MessageEvent);
 await expect(pending).resolves.toEqual({shares:[]});expect(receive).not.toHaveBeenCalled();
 value.ws.onmessage!({data:'1aGVsbG8='} as MessageEvent);expect(receive).toHaveBeenCalledWith('1aGVsbG8=');
 const stopped=value.request('restart');value.close();await expect(stopped).rejects.toThrow('disconnected');expect(value.pending.size).toBe(0);
});
it('does not offer unsupported controls for an older Connector',async()=>{await expect(connection(true,true,false).request('restart')).rejects.toThrow('unavailable');});

it('distinguishes expired sessions, offline instances and proxy handshakes after an abnormal close',async()=>{
 const {api,APIError}=await import('../api');const mock=vi.mocked(api);
 const auth=connection();const authClose=vi.fn();auth.onClose(authClose);
 mock.mockRejectedValueOnce(new APIError(401,'authentication_required'));
 auth.ws.onclose!(new CloseEvent('close',{code:1006}));
 await vi.waitFor(()=>expect(authClose).toHaveBeenCalled());expect(authClose.mock.calls[0][0]).toMatchObject({code:1008,reason:'Authentication or instance access denied'});
 const offline=connection();const offlineClose=vi.fn();offline.onClose(offlineClose);
 mock.mockResolvedValueOnce({}).mockResolvedValueOnce([{id:'id-1',online:false}]);offline.ws.onclose!(new CloseEvent('close',{code:1006}));
 await vi.waitFor(()=>expect(offlineClose).toHaveBeenCalled());expect(offlineClose.mock.calls[0][0]).toMatchObject({code:1013,reason:'Instance offline'});
 const proxy=connection();const proxyClose=vi.fn();proxy.onClose(proxyClose);
 mock.mockResolvedValueOnce({}).mockResolvedValueOnce([{id:'id-1',online:true}]);proxy.ws.onclose!(new CloseEvent('close',{code:1006}));
 await vi.waitFor(()=>expect(proxyClose).toHaveBeenCalled());expect(proxyClose.mock.calls[0][0].reason).toContain('WebSocket handshake failed');
});
it('uses browser-permitted close codes while reporting authorization failures to WebTTY',async()=>{
 const {api,APIError}=await import('../api');vi.mocked(api).mockRejectedValueOnce(new APIError(403,'origin_mismatch'));
 const value=connection(),closed=vi.fn();value.onClose(closed);const close=vi.spyOn(value.ws,'close');
 value.ws.onopen!(new Event('open'));await vi.waitFor(()=>expect(closed).toHaveBeenCalled());
 expect(close).toHaveBeenCalledWith(4001);expect(closed.mock.calls[0][0]).toMatchObject({code:1008,reason:'Authentication origin validation failed'});
});
it('keeps restart close codes and reasons without a diagnostic API round trip',()=>{
 const value=connection(),closed=vi.fn();value.onClose(closed);
 value.ws.onclose!(new CloseEvent('close',{code:1012,reason:'Hub stopping'}));expect(closed.mock.calls[0][0]).toMatchObject({code:1012,reason:'Hub stopping'});
});
it('notifies the shared WebTTY when a stale connection is explicitly closed for probing',()=>{
 const value=connection(),closed=vi.fn();value.onClose(closed);value.close();expect(closed).toHaveBeenCalledOnce();
});

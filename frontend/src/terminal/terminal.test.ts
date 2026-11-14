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
beforeEach(async()=>{localStorage.clear();vi.stubGlobal('WebSocket',Socket);const {api}=await import('../api');vi.mocked(api).mockReset().mockResolvedValue({ticket:'ticket-1'});});
afterEach(()=>{connections.splice(0).forEach(connection=>connection.close());vi.unstubAllGlobals();});
async function connection(writable=true,owner=true,controls=true,initialize=true){const value=new HubConnection('id-1',writable,owner,controls,()=>true,()=>true);connections.push(value);await value.open();value.ticket='ticket';if(initialize){value.send('{}');value.ws!.onmessage!({data:'4{}'} as MessageEvent);}(value.ws!.send as ReturnType<typeof vi.fn>).mockClear();return value;}
it('keeps view reports and controls behind application authentication',async()=>{
 const value=await connection(true,true,true,false);
 value.reportView();value.send('2');value.send('1data');
 await expect(value.request('restart')).rejects.toThrow('unavailable');
 expect(value.ws!.send).not.toHaveBeenCalled();
 value.send(JSON.stringify({ClientKey:'browser-client-identity',ReplayVersion:2,LastSequence:17,Epoch:'epoch'}));
 const frames=(value.ws!.send as ReturnType<typeof vi.fn>).mock.calls.map(([frame])=>JSON.parse(frame));
 expect(frames).toEqual([{ticket:'ticket',epoch:'epoch',offset:0,client_key:'browser-client-identity',replay_version:2,sequence:17},{viewing:true}]);
});
it('matches GoTTY display defaults and retains remote terminal metrics',()=>{
 const value=displayOptions({'font-size':20,'scrollback-lines':800,'cursor-style':'bar'},{nord:NORD_THEME},{});
 expect(value).toMatchObject({fontSize:20,fontFamily:"'DejaVu Sans Mono', monospace",scrollback:800,cursorStyle:'bar',theme:NORD_THEME});
});
it('isolates saved display choices between split terminals and tolerates damaged storage',()=>{
 saveAppearance('a',{theme:'light',fontSize:24});saveAppearance('b',{theme:'nord',fontSize:12});
 expect(readAppearance('a').fontSize).toBe(24);expect(readAppearance('b').fontSize).toBe(12);
 localStorage.setItem('gotty-hub:terminal:a:appearance','null');expect(readAppearance('a').fontSize).toBeUndefined();
});
it('blocks observer input, upload and remote management while keeping protocol heartbeat',async()=>{
 const value=await connection(false,false);value.send('1data');value.send('3size');value.send('7file');value.send('2');
 expect(value.ws!.send).toHaveBeenCalledExactlyOnceWith('2');await expect(value.request('restart')).rejects.toThrow('unavailable');
});
it('correlates management replies separately from terminal output and clears disconnects',async()=>{
 const value=await connection();const receive=vi.fn();value.onReceive(receive);
 const pending=value.request('shares');const frame=JSON.parse((value.ws!.send as any).mock.calls[0][0]);
 value.ws!.onmessage!({data:JSON.stringify({control_result:{id:frame.control.id,value:{shares:[]}}})} as MessageEvent);
 await expect(pending).resolves.toEqual({shares:[]});expect(receive).not.toHaveBeenCalled();
 value.ws!.onmessage!({data:'1aGVsbG8='} as MessageEvent);expect(receive).toHaveBeenCalledWith('1aGVsbG8=');
 const stopped=value.request('restart');value.close();await expect(stopped).rejects.toThrow('disconnected');expect(value.pending.size).toBe(0);
});
it('does not offer unsupported controls for an older Connector',async()=>{await expect((await connection(true,true,false)).request('restart')).rejects.toThrow('unavailable');});

it('distinguishes expired sessions, offline instances and proxy handshakes after an abnormal close',async()=>{
 const {api,APIError}=await import('../api');const mock=vi.mocked(api);
 const auth=await connection();const authClose=vi.fn();auth.onClose(authClose);
 mock.mockRejectedValueOnce(new APIError(401,'authentication_required'));
 auth.ws!.onclose!(new CloseEvent('close',{code:1006}));
 await vi.waitFor(()=>expect(authClose).toHaveBeenCalled());expect(authClose.mock.calls[0][0]).toMatchObject({code:1008,reason:'Authentication or instance access denied'});
 const offline=await connection();const offlineClose=vi.fn();offline.onClose(offlineClose);
 mock.mockResolvedValueOnce({}).mockResolvedValueOnce([{id:'id-1',online:false}]);offline.ws!.onclose!(new CloseEvent('close',{code:1006}));
 await vi.waitFor(()=>expect(offlineClose).toHaveBeenCalled());expect(offlineClose.mock.calls[0][0]).toMatchObject({code:1013,reason:'Instance offline'});
 const proxy=await connection();const proxyClose=vi.fn();proxy.onClose(proxyClose);
 mock.mockResolvedValueOnce({}).mockResolvedValueOnce([{id:'id-1',online:true}]);proxy.ws!.onclose!(new CloseEvent('close',{code:1006}));
 await vi.waitFor(()=>expect(proxyClose).toHaveBeenCalled());expect(proxyClose.mock.calls[0][0].reason).toContain('WebSocket handshake failed');
});
it('reports authorization denial before constructing a socket',async()=>{
 const {api,APIError}=await import('../api');vi.mocked(api).mockRejectedValueOnce(new APIError(403,'origin_mismatch'));
 const value=new HubConnection('id-1',true,true,true,()=>true,()=>true),closed=vi.fn();connections.push(value);value.onClose(closed);
 await value.open();
 expect(value.ws).toBeUndefined();expect(closed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({code:1008,reason:'Authentication origin validation failed'}));
});
it('keeps restart close codes and reasons without a diagnostic API round trip',async()=>{
 const value=await connection(),closed=vi.fn();value.onClose(closed);
 value.ws!.onclose!(new CloseEvent('close',{code:1012,reason:'Hub stopping'}));expect(closed.mock.calls[0][0]).toMatchObject({code:1012,reason:'Hub stopping'});
});
it('notifies the shared WebTTY when a stale connection is explicitly closed for probing',async()=>{
 const value=await connection(),closed=vi.fn();value.onClose(closed);value.close();expect(closed).toHaveBeenCalledOnce();
});

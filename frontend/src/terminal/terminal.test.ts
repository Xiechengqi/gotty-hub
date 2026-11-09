import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {displayOptions,NORD_THEME} from '@gotty/terminal-core/appearance';
import {readAppearance,saveAppearance} from './appearance';
import {HubConnection} from './connection';
vi.mock('../api',()=>({api:vi.fn(async()=>({ticket:'ticket-1'}))}));
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

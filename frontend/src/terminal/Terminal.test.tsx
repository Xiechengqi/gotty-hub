import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {RealTerminal} from './Terminal';
const state=vi.hoisted(()=>({terminals:[] as any[],geometry:{cols:80,rows:24}}));
vi.mock('@gotty/terminal-core/fonts',async original=>{
 const actual=await original<typeof import('@gotty/terminal-core/fonts')>();
 return {...actual,ensureFont:vi.fn(async(id:string)=>({fontFamily:actual.fontById(id)!.value,cached:true}))};
});
vi.mock('@xterm/xterm',()=>({Terminal:class {
 options:any;cols=80;rows=24;unicode={activeVersion:'6'};textarea=document.createElement('textarea');
 parser={registerOscHandler:()=>({dispose(){}})};clear=vi.fn();focus=vi.fn(()=>this.textarea.focus());dispose=vi.fn();write=vi.fn((_data:any,callback?:()=>void)=>callback?.());reset=vi.fn();scrollToBottom=vi.fn();resize=vi.fn((cols:number,rows:number)=>{this.cols=cols;this.rows=rows;});
 constructor(options:any){this.options=options;state.terminals.push(this);}
 loadAddon(){}open(element:HTMLElement){element.append(this.textarea);}attachCustomKeyEventHandler(){}
 onData(){return {dispose(){}};}onBinary(){return {dispose(){}};}onResize(){return {dispose(){}};}onSelectionChange(){return {dispose(){}};}hasSelection(){return false;}
}}));
vi.mock('@xterm/addon-fit',()=>({FitAddon:class {proposeDimensions(){return state.geometry;}}}));
vi.mock('@xterm/addon-web-links',()=>({WebLinksAddon:class {}}));
vi.mock('@xterm/addon-unicode11',()=>({Unicode11Addon:class {}}));
vi.mock('@xterm/addon-image',()=>({ImageAddon:class {}}));
vi.mock('@xterm/addon-webgl',()=>({WebglAddon:class {onContextLoss(){}}}));
vi.mock('./ShareManager',()=>({ShareManager:({trigger}:any)=>trigger}));
vi.mock('./Transfer',()=>({FILE_LIMIT:64*1024*1024,createTransfer:()=>({consume(){},dispose(){}}),TransferModal:()=>null}));
vi.mock('../api',async importOriginal=>({...await importOriginal<typeof import('../api')>(),api:vi.fn(async()=>({ticket:'ticket'}))}));
class Socket {
 static OPEN=1;static CONNECTING=0;static CLOSED=3;
 readyState=0;bufferedAmount=0;onopen:any;onmessage:any;onclose:any;send=vi.fn();
 constructor(){sockets.push(this);}close(){this.readyState=3;this.onclose?.(new CloseEvent('close'));}
}
let sockets:Socket[]=[];
let node:HTMLDivElement;let root:ReturnType<typeof createRoot>;
beforeEach(()=>{
 sockets=[];state.terminals=[];state.geometry={cols:80,rows:24};localStorage.clear();
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('WebSocket',Socket);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('applies wire preferences and renders GoTTY controls with real WebTTY dispatch',async()=>{
 await act(async()=>root.render(<RealTerminal id="one" writable files owner controls visible locale="zh-CN" onManage={()=>{}}/>));
 await act(async()=>{sockets[0].readyState=1;sockets[0].onopen();});
 await act(async()=>{
  sockets[0].onmessage({data:'4'+JSON.stringify({'font-size':20,'scrollback-lines':900,'hub-config':{restart_mode:'exec',mobile_keys:false,themes:{nord:{background:'#2e3440',foreground:'#d8dee9'}}}})});
  sockets[0].onmessage({data:'73'});
 });
 expect(state.terminals[0].options).toMatchObject({fontSize:20,scrollback:900,fontFamily:"'DejaVu Sans Mono', monospace"});
 expect(node.querySelector<HTMLElement>('.real-terminal')?.style.getPropertyValue('--color-terminal-background')).toBe('#2e3440');
 for(const label of ['清理历史','上传文件','重启 GoTTY','Hub 实例设置']) expect(node.querySelector(`button[aria-label="${label} · one"]`)).not.toBeNull();
 expect(node.querySelector('[aria-label="连接数: 3 · one"]')).not.toBeNull();
 await act(async()=>{node.querySelector<HTMLButtonElement>('[aria-label="清理历史 · one"]')!.click();});
 expect(sockets[0].send.mock.calls.some(([data])=>data.startsWith('1')&&atob(data.slice(1))==='clear\n')).toBe(true);
});
it('keeps observer controls local and hides remote write and owner actions',async()=>{
 await act(async()=>root.render(<RealTerminal id="read" writable={false} files visible locale="en-US" onManage={()=>{}}/>));
 expect(node.querySelector('[aria-label="Display settings"]')).toBeNull();
 for(const label of ['Clear history','Upload file','Restart GoTTY']) expect(node.querySelector(`[aria-label="${label} · read"]`)).toBeNull();
});
it('refreshes a disconnected terminal by replacing its renderer and connection without touching another pane',async()=>{
 await act(async()=>root.render(<><RealTerminal id="one" writable visible locale="zh-CN" onManage={()=>{}}/><RealTerminal id="two" writable visible locale="zh-CN" onManage={()=>{}}/></>));
 expect(sockets).toHaveLength(2);
 const first=sockets[0];const second=sockets[1];const original=state.terminals[0];const other=state.terminals[1];
 const refresh=node.querySelector<HTMLButtonElement>('[aria-label="刷新当前终端 · one"]')!;
 expect(refresh.disabled).toBe(false);
 await act(async()=>refresh.click());
 expect(sockets).toHaveLength(3);expect(first.readyState).toBe(3);expect(second.readyState).toBe(0);
 expect(original.dispose).toHaveBeenCalledOnce();expect(other.dispose).not.toHaveBeenCalled();expect(state.terminals).toHaveLength(3);
});

it('applies account appearance without replacing either terminal or socket',async()=>{
 const render=(fontSize:number,theme='light')=>root.render(<RealTerminal id="one" writable visible locale="zh-CN" onManage={()=>{}} settings={{schemaVersion:1,theme,fontSize,fontId:'monospace'}}/>);
 await act(async()=>render(18));
 const term=state.terminals[0],socket=sockets[0];
 expect(term.options).toMatchObject({fontSize:18,fontFamily:'monospace',theme:{background:'#fafafa'}});
 await act(async()=>render(24,'paper'));
 expect(state.terminals).toHaveLength(1);expect(sockets).toHaveLength(1);expect(sockets[0]).toBe(socket);
 expect(term.dispose).not.toHaveBeenCalled();expect(term.options.fontSize).toBe(24);
 expect(term.options.theme).toMatchObject({background:'#f5f5d5',foreground:'#333333',selectionBackground:'#d7ddbd'});
 expect(node.querySelector<HTMLElement>('.real-terminal')?.style.getPropertyValue('--color-terminal-background')).toBe('#f5f5d5');
 expect(node.querySelector('[aria-label="显示设置"]')).toBeNull();
});

it('showing a second pane never steals focus and explicit requests focus either existing terminal',async()=>{
 const frames=new Map<number,FrameRequestCallback>();let sequence=0;
 vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++sequence,callback);return sequence;});
 vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
 const flush=async()=>{for(let i=0;i<4;i++)await act(async()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(performance.now());});};
 const handled=vi.fn();
 const render=(secondVisible:boolean,left=0,right=0)=>root.render(<>
  <RealTerminal id="one" writable visible focusRequest={left} onFocusHandled={handled} locale="zh-CN" onManage={()=>{}}/>
  <RealTerminal id="two" writable visible={secondVisible} focusRequest={right} onFocusHandled={handled} locale="zh-CN" onManage={()=>{}}/>
 </>);
 await act(async()=>render(false,1));await flush();
 const first=state.terminals[0],second=state.terminals[1];
 expect(document.activeElement).toBe(first.textarea);
 await act(async()=>render(true));await flush();
 expect(document.activeElement).toBe(first.textarea);expect(second.focus).not.toHaveBeenCalled();
 await act(async()=>{
  sockets[1].readyState=1;sockets[1].onopen();
 });
 await act(async()=>{
  sockets[1].onmessage({data:'a'+JSON.stringify({epoch:'epoch',mode:'tail',fromOffset:0})});
  sockets[1].onmessage({data:'b'+JSON.stringify({endOffset:0})});
 });
 expect(document.activeElement).toBe(first.textarea);expect(second.focus).not.toHaveBeenCalled();
 await act(async()=>render(true,0,2));await flush();
 expect(document.activeElement).toBe(second.textarea);expect(handled).toHaveBeenCalledWith('two',2);
 expect(state.terminals).toHaveLength(2);expect(sockets).toHaveLength(2);
 const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.tabIndex=-1;document.body.append(dialog);dialog.focus();
 await act(async()=>render(true,3));await flush();
 expect(document.activeElement).toBe(dialog);expect(handled).toHaveBeenCalledWith('one',3);
 dialog.remove();
});

it('renders at the confirmed PTY size while requesting the narrow viewport without resize feedback',async()=>{
 const frames=new Map<number,FrameRequestCallback>();let sequence=0;
 vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++sequence,callback);return sequence;});
 vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(500);
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600);
 const flush=async()=>{for(let i=0;i<4;i++)await act(async()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(performance.now());});};
 state.geometry={cols:36,rows:18};
 await act(async()=>root.render(<RealTerminal id="narrow" writable visible locale="zh-CN" onManage={()=>{}}/>));
 await flush();
 await act(async()=>{sockets[0].readyState=1;sockets[0].onopen();});
 expect(sockets[0].send.mock.calls.some(([frame])=>frame[0]==='3'&&JSON.parse(frame.slice(1)).columns===36)).toBe(true);
 const sent=sockets[0].send.mock.calls.length;
 await act(async()=>{sockets[0].onmessage({data:'8'+JSON.stringify({activeCols:60,activeRows:20,policy:'leader'})});});
 const term=state.terminals[0];
 expect([term.cols,term.rows]).toEqual([60,20]);
 expect(sockets[0].send.mock.calls).toHaveLength(sent);
 await act(async()=>root.render(<RealTerminal id="narrow" writable visible locale="zh-CN" onManage={()=>{}} settings={{schemaVersion:1,theme:'paper',fontSize:24,fontId:'monospace'}}/>));
 await flush();
 expect([term.cols,term.rows]).toEqual([60,20]);
 expect(state.terminals).toHaveLength(1);expect(sockets).toHaveLength(1);
});

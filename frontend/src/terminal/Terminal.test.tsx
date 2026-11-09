import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {RealTerminal} from './Terminal';
const state=vi.hoisted(()=>({terminals:[] as any[]}));
vi.mock('@xterm/xterm',()=>({Terminal:class {
 options:any;cols=80;rows=24;unicode={activeVersion:'6'};textarea=document.createElement('textarea');
 parser={registerOscHandler:()=>({dispose(){}})};clear=vi.fn();focus=vi.fn();dispose=vi.fn();write=vi.fn();reset=vi.fn();scrollToBottom=vi.fn();
 constructor(options:any){this.options=options;state.terminals.push(this);}
 loadAddon(){}open(element:HTMLElement){element.append(this.textarea);}attachCustomKeyEventHandler(){}
 onData(){return {dispose(){}};}onBinary(){return {dispose(){}};}onResize(){return {dispose(){}};}onSelectionChange(){return {dispose(){}};}hasSelection(){return false;}
}}));
vi.mock('@xterm/addon-fit',()=>({FitAddon:class {fit(){}}}));
vi.mock('@xterm/addon-web-links',()=>({WebLinksAddon:class {}}));
vi.mock('@xterm/addon-unicode11',()=>({Unicode11Addon:class {}}));
vi.mock('@xterm/addon-image',()=>({ImageAddon:class {}}));
vi.mock('@xterm/addon-webgl',()=>({WebglAddon:class {onContextLoss(){}}}));
vi.mock('./DisplaySettings',()=>({DisplaySettings:()=>null}));
vi.mock('./ShareManager',()=>({ShareManager:()=>null}));
vi.mock('./Transfer',()=>({FILE_LIMIT:64*1024*1024,createTransfer:()=>({consume(){},dispose(){}}),TransferModal:()=>null}));
vi.mock('../api',()=>({api:vi.fn(async()=>({ticket:'ticket'}))}));
class Socket {
 static OPEN=1;static CONNECTING=0;static CLOSED=3;
 readyState=0;bufferedAmount=0;onopen:any;onmessage:any;onclose:any;send=vi.fn();
 constructor(){sockets.push(this);}close(){this.readyState=3;this.onclose?.(new CloseEvent('close'));}
}
let sockets:Socket[]=[];
let node:HTMLDivElement;let root:ReturnType<typeof createRoot>;
beforeEach(()=>{
 sockets=[];state.terminals=[];localStorage.clear();
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('WebSocket',Socket);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();});
it('applies wire preferences and renders GoTTY controls with real WebTTY dispatch',async()=>{
 await act(async()=>root.render(<RealTerminal id="one" writable files owner controls visible locale="zh-CN" onManage={()=>{}}/>));
 await act(async()=>{sockets[0].readyState=1;sockets[0].onopen();});
 await act(async()=>{
  sockets[0].onmessage({data:'4'+JSON.stringify({'font-size':20,'scrollback-lines':900,'hub-config':{restart_mode:'exec',mobile_keys:false,themes:{nord:{background:'#2e3440',foreground:'#d8dee9'}}}})});
  sockets[0].onmessage({data:'73'});
 });
 expect(state.terminals[0].options).toMatchObject({fontSize:20,scrollback:900,fontFamily:"'Source Code Pro', monospace"});
 expect(node.querySelector<HTMLElement>('.real-terminal')?.style.getPropertyValue('--color-terminal-background')).toBe('#2e3440');
 for(const label of ['显示设置','清理历史','上传文件','重启 GoTTY','Hub 实例设置']) expect(node.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
 expect(node.querySelector('[aria-label="连接数: 3"]')).not.toBeNull();
 await act(async()=>{node.querySelector<HTMLButtonElement>('[aria-label="清理历史"]')!.click();});
 expect(sockets[0].send.mock.calls.some(([data])=>data.startsWith('1')&&atob(data.slice(1))==='clear\n')).toBe(true);
});
it('keeps observer controls local and hides remote write and owner actions',async()=>{
 await act(async()=>root.render(<RealTerminal id="read" writable={false} files visible locale="en-US" onManage={()=>{}}/>));
 expect(node.querySelector('[aria-label="Display settings"]')).not.toBeNull();
 for(const label of ['Clear history','Upload file','Restart GoTTY']) expect(node.querySelector(`[aria-label="${label}"]`)).toBeNull();
});

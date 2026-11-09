import {useEffect,useRef,useState} from 'react';
import {Terminal as Xterm} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {WebLinksAddon} from '@xterm/addon-web-links';
import {WebTTY,type Terminal,type Connection} from '@gotty/terminal-core';
import {Button} from '@/components/base/buttons/button';
import {terminalMessage} from './messages';
import {api} from '../api';
import {VoiceInput} from '@gotty/terminal-core/voice-input';
import {createTransfer,TransferModal,type Transfer} from './Transfer';
import '@xterm/xterm/css/xterm.css';

export function RealTerminal({id,writable,visible,locale,asr=false}:{id:string;writable:boolean;visible:boolean;locale:string;asr?:boolean}){
 const host=useRef<HTMLDivElement>(null);const view=useRef(visible);view.current=visible;
 const controller=useRef<{term:Xterm;fit:FitAddon;send:(s:string)=>void;view:()=>void}|undefined>(undefined);
 const [message,setMessage]=useState('');
 const [transfer,setTransfer]=useState<Transfer|null>(null);
 useEffect(()=>{
  if(!host.current)return;
  const term=new Xterm({cursorBlink:true,convertEol:false,fontSize:13,allowProposedApi:false,disableStdin:!writable});
  const fit=new FitAddon();term.loadAddon(fit);term.loadAddon(new WebLinksAddon());term.open(host.current);
  let input:(s:string|Uint8Array)=>void=()=>{};let resize:(c:number,r:number)=>void=()=>{};let connection:Bridge|null=null;
  const zmodem=writable?createTransfer(data=>term.write(data),data=>input(data),setTransfer,enabled=>{term.options.disableStdin=!enabled}):null;
  const adapter:Terminal={
   info:()=>({columns:term.cols,rows:term.rows}),output:data=>{if(zmodem)zmodem.consume(data);else term.write(data)},showMessage:s=>setMessage(s),removeMessage:()=>setMessage(''),setWindowTitle:()=>{},setPreferences:()=>{},
   onInput:cb=>{input=cb},onResize:cb=>{resize=cb},close:()=>{},reset:()=>term.reset(),deactivate:()=>{},focus:()=>{if(view.current)term.focus()},scrollToBottom:()=>term.scrollToBottom(),
  };
  class Bridge implements Connection{
   ws:WebSocket;closed=false;onopen=()=>{};onreceive=(_data:string)=>{};onclose=(_event:CloseEvent)=>{};
   constructor(){
    this.ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/v1/terminal-connections/${id}/ws`);
    this.ws.onmessage=e=>this.onreceive(String(e.data));this.ws.onclose=e=>{this.closed=true;this.onclose(e)};
    this.ws.onopen=()=>{api(`/instances/${id}/terminal-tickets`,{}).then(v=>{if(!this.closed){this.ticket=v.ticket;this.onopen()}}).catch(()=>this.ws.close(1008,'Access denied'))};
   }
   ticket='';open(){};close(){this.closed=true;this.ws.close()};isOpen(){return !this.closed&&this.ws.readyState<=1};readyState(){return this.ws.readyState}
   onOpen(cb:()=>void){this.onopen=cb};onReceive(cb:(s:string)=>void){this.onreceive=cb};onClose(cb:(e:CloseEvent)=>void){this.onclose=cb}
   send(data:string){if(this.ws.readyState!==1)return;
    if(data.startsWith('{')){const init=JSON.parse(data);this.ws.send(JSON.stringify({ticket:this.ticket,epoch:init.Epoch??'',offset:init.LastOffset??0}));this.reportView();return}
    if(!writable&&!['2','4'].includes(data[0]))return;
    if(data[0]==='3'&&!view.current)return;
    this.ws.send(data);
   }
   reportView(){if(this.ws.readyState===1&&this.ticket)this.ws.send(JSON.stringify({viewing:view.current&&document.visibilityState==='visible'&&document.hasFocus()&&host.current?.contains(document.activeElement)}))}
  }
  const wt=new WebTTY(adapter,{create:()=>{connection=new Bridge();return connection}},'','');
  const subscription=term.onData(data=>{if(writable)input(data)});
  const binary=term.onBinary(data=>{if(writable)input(Uint8Array.from(data,c=>c.charCodeAt(0)))});
  const size=term.onResize(({cols,rows})=>{if(view.current&&cols>0&&rows>0)resize(cols,rows)});
  const measure=()=>{if(view.current&&host.current?.clientWidth&&host.current?.clientHeight){try{fit.fit()}catch{}}};
  const observer=new ResizeObserver(measure);observer.observe(host.current);measure();
  const stop=wt.open();
  const voice=asr&&writable?new VoiceInput({enabled:true,permitWrite:true,holdMs:300,hotkeyCode:'ShiftRight',authToken:'',term:{elem:host.current,showMessage:text=>setMessage(text),removeMessage:()=>setMessage(''),disableStdin:()=>{term.options.disableStdin=true},enableStdin:()=>{term.options.disableStdin=false},sendInput:data=>input(data)},
   webSocketFactory:()=>new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/v1/terminal-connections/${id}/ws`),
   initialize:async ws=>{const v=await api(`/instances/${id}/terminal-tickets`,{});ws.send(JSON.stringify({ticket:v.ticket,channel:'asr'}))},
  }):null;
  const viewport=()=>{if(view.current&&window.visualViewport){document.documentElement.style.setProperty('--hub-viewport-height',`${window.visualViewport.height}px`);measure()}};
  window.visualViewport?.addEventListener('resize',viewport);viewport();
  const report=()=>connection?.reportView();
  const interval=setInterval(report,3000);document.addEventListener('visibilitychange',report);window.addEventListener('focus',report);window.addEventListener('blur',report);document.addEventListener('focusin',report);
  controller.current={term,fit,send:s=>{if(writable)input(s)},view:report};
  return()=>{voice?.close();zmodem?.dispose();window.visualViewport?.removeEventListener('resize',viewport);controller.current=undefined;clearInterval(interval);document.removeEventListener('visibilitychange',report);window.removeEventListener('focus',report);window.removeEventListener('blur',report);document.removeEventListener('focusin',report);stop();observer.disconnect();subscription.dispose();binary.dispose();size.dispose();term.dispose()};
 },[id,writable,asr]);
 useEffect(()=>{if(visible){requestAnimationFrame(()=>{controller.current?.fit.fit();controller.current?.term.focus();controller.current?.view()})}else controller.current?.view()},[visible]);
 return <section className="real-terminal dark"><TransferModal transfer={transfer} locale={locale} onClose={()=>setTransfer(null)}/><div ref={host} className="xterm-host"/>{message&&<div className="terminal-message text-caption-1-regular" role="status">{terminalMessage(message,locale)}</div>}<div className="terminal-keys">{[['Esc','\x1b'],['Ctrl+C','\x03'],['Tab','\t'],['↑','\x1b[A'],['↓','\x1b[B'],['←','\x1b[D'],['→','\x1b[C']].map(([label,value])=><Button key={label} variant="secondary" disabled={!writable} onClick={()=>{controller.current?.send(value);controller.current?.term.focus()}}>{label}</Button>)}</div></section>;
}

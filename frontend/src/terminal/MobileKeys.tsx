import {useCallback, useEffect, useRef, useState} from 'react';
import type {Terminal} from '@xterm/xterm';
import {ROWS, type KeyDef} from '@gotty/terminal-core/mobile-key-layout';
import {encodeChar, encodeSpecial, type Modifiers} from '@gotty/terminal-core/key-encoder';
import {computeVisibleArea, watchVisibleArea} from '@gotty/terminal-core/keyboard-viewport';
import {Button} from '@/components/base/buttons/button';
import {cx} from '@/utils/cx';

const empty = (): Modifiers => ({ctrl:false,alt:false,shift:false});
export function MobileKeys({term, enabled, transform, locale}: {
  term?: Terminal; enabled: boolean; transform: (value: ((data:string)=>string)|null)=>void; locale:string;
}) {
  const mods=useRef(empty());
  const [armed,setArmed]=useState(empty);
  const [keyboard,setKeyboard]=useState(false);
  const [touch,setTouch]=useState(()=>window.matchMedia?.('(pointer: coarse)').matches??false);
  const delay=useRef<ReturnType<typeof setTimeout>>(undefined);
  const repeat=useRef<ReturnType<typeof setInterval>>(undefined);
  const disarm=useCallback(()=>{mods.current=empty();setArmed(mods.current);},[]);
  const stop=useCallback(()=>{clearTimeout(delay.current);clearInterval(repeat.current);},[]);
  useEffect(()=>{
    const input=term?.textarea, vv=window.visualViewport;
    if(!enabled||!input||!vv){setKeyboard(false);return;}
    const touched=()=>setTouch(true);
    input.addEventListener('touchstart',touched,{passive:true});
    const update=(area:{keyboardOpen:boolean})=>setKeyboard(area.keyboardOpen);
    update(computeVisibleArea(window.innerHeight,vv,document.activeElement===input));
    const unwatch=watchVisibleArea(input,vv,update);
    transform(data=>{
      if(!mods.current.ctrl&&!mods.current.alt&&!mods.current.shift)return data;
      const out=[...data].length===1?encodeChar(data,mods.current):data;
      disarm();return out;
    });
    return()=>{input.removeEventListener('touchstart',touched);unwatch();stop();transform(null);};
  },[term,enabled,transform,disarm,stop]);
  useEffect(()=>{if(!keyboard||!enabled){stop();disarm();}},[keyboard,enabled,stop,disarm]);
  function press(key:KeyDef){
    if(!enabled||!term)return;
    if(key.kind==='mod'){mods.current={...mods.current,[key.mod]:!mods.current[key.mod]};setArmed(mods.current);return;}
    if(key.kind==='char'){term.input(key.name,true);return;}
    const data=encodeSpecial(key.name,mods.current,term.modes.applicationCursorKeysMode);
    disarm();term.input(data,true);
  }
  if(!enabled||!keyboard||!touch)return null;
  return <div className="terminal-mobile-keys" role="group" aria-label={locale==='zh-CN'?'终端快捷键':'Terminal shortcut keys'}>
    {ROWS.map((row,index)=><div className="terminal-mobile-key-row" key={index}>
      {row.map(key=>{
        const repeats=key.kind==='special'&&key.repeat;
        return <Button key={key.name} size="small" variant="secondary" className={cx('terminal-mobile-key',key.kind==='mod'&&armed[key.mod]&&'armed')}
          aria-label={key.name} aria-pressed={key.kind==='mod'?armed[key.mod]:undefined}
          onPointerDown={event=>{
            event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
            if(repeats){stop();press(key);delay.current=setTimeout(()=>{press(key);repeat.current=setInterval(()=>press(key),60);},400);}
          }}
          onPointerUp={event=>{event.preventDefault();stop();if(!repeats)press(key);}}
          onPointerCancel={stop} onPointerLeave={stop} onBlur={stop}
          onClick={event=>{if(event.detail===0)press(key);}}>{key.label}</Button>;
      })}
    </div>)}
  </div>;
}

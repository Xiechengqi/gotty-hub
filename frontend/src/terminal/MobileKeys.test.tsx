import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Terminal} from '@xterm/xterm';
import {MobileKeys} from './MobileKeys';
let node:HTMLDivElement,root:ReturnType<typeof createRoot>,textarea:HTMLTextAreaElement;
let viewport:EventTarget&{height:number;offsetTop:number;scale:number};
let transformer:((data:string)=>string)|null=null;
let term:Terminal,written:string[];
const transform=(value:typeof transformer)=>{transformer=value;};
beforeEach(()=>{
 vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('matchMedia',()=>({matches:true}));vi.stubGlobal('innerHeight',800);
 viewport=Object.assign(new EventTarget(),{height:800,offsetTop:0,scale:1});vi.stubGlobal('visualViewport',viewport);
 textarea=document.createElement('textarea');document.body.append(textarea);
 written=[];transformer=null;
 term={textarea,modes:{applicationCursorKeysMode:false},input:(data:string)=>written.push(transformer?.(data)??data)} as unknown as Terminal;
 node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();textarea.remove();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
async function render(enabled=true){await act(async()=>root.render(<MobileKeys term={term} enabled={enabled} transform={transform} locale="zh-CN"/>));}
async function open(){await act(async()=>{textarea.focus();viewport.height=450;viewport.dispatchEvent(new Event('resize'));});}
async function click(name:string){await act(async()=>node.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!.click());}
it('shows both original GoTTY rows only with the software keyboard and preserves focus',async()=>{
 await render();expect(node.querySelector('button')).toBeNull();await open();
 expect([...node.querySelectorAll('button')].map(b=>b.getAttribute('aria-label'))).toEqual(['Esc','/','-','|','Home','Up','End','PgUp','Tab','Ctrl','Alt','Shift','Left','Down','Right','PgDn']);
 await click('Home');expect(written.at(-1)).toBe('\x1b[H');expect(document.activeElement).toBe(textarea);
 await act(async()=>{viewport.height=800;viewport.dispatchEvent(new Event('resize'));});expect(node.querySelector('button')).toBeNull();
});
it('applies one-shot modifiers to phone input, special keys and application cursor mode',async()=>{
 await render();await open();await click('Ctrl');await act(async()=>term.input('c',true));expect(written.at(-1)).toBe('\x03');
 expect(node.querySelector('[aria-label="Ctrl"]')!.getAttribute('aria-pressed')).toBe('false');
 await click('Alt');await click('Up');expect(written.at(-1)).toBe('\x1b[1;3A');
 await click('Shift');await click('Tab');expect(written.at(-1)).toBe('\x1b[Z');
 (term.modes as {applicationCursorKeysMode:boolean}).applicationCursorKeysMode=true;
 await click('Up');expect(written.at(-1)).toBe('\x1bOA');
 await click('Ctrl');await act(async()=>term.input('pasted text',true));expect(written.at(-1)).toBe('pasted text');
 await render(false);expect(node.querySelector('button')).toBeNull();expect(transformer).toBeNull();
});
it('repeats navigation while held and stops on pointer cancellation',async()=>{
 await render();await open();const up=node.querySelector<HTMLButtonElement>('[aria-label="Up"]')!;
 up.setPointerCapture=vi.fn();
 await act(async()=>up.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true})));
 await act(async()=>vi.advanceTimersByTime(530));expect(written.length).toBe(4);
 await act(async()=>up.dispatchEvent(new Event('pointercancel',{bubbles:true})));
 await act(async()=>vi.advanceTimersByTime(1000));expect(written.length).toBe(4);
});
it('reports the measured strip height for overlays and resumes the input only for sent keys',async()=>{
 node.className='real-terminal';const onInput=vi.fn();let resized:()=>void=()=>{};
 vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){resized=callback;}observe(){}disconnect(){}});
 await act(async()=>root.render(<MobileKeys term={term} enabled transform={transform} locale="zh-CN" onInput={onInput}/>));
 await open();const strip=node.querySelector<HTMLElement>('.terminal-mobile-keys')!;
 Object.defineProperty(strip,'offsetHeight',{value:93});resized();
 expect(node.style.getPropertyValue('--terminal-keys-height')).toBe('93px');
 await click('Ctrl');expect(onInput).not.toHaveBeenCalled();
 await click('Home');expect(onInput).toHaveBeenCalledOnce();
 await render(false);expect(node.style.getPropertyValue('--terminal-keys-height')).toBe('');
});

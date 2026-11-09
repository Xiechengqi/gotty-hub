import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import source from '../bootstrap.js?raw';
let appCSS=false,xtermCSS=false;
let events:ReturnType<typeof vi.spyOn>;
let documentEvents:ReturnType<typeof vi.spyOn>;
beforeEach(()=>{
 vi.useFakeTimers();appCSS=xtermCSS=false;
 document.head.innerHTML='<link rel="stylesheet" href="/assets/app-12345678.css"><script type="module" src="/assets/app-12345678.js"></script>';
 document.body.innerHTML='<div id="hub-boot"><p id="hub-boot-message"></p><button id="hub-boot-retry" hidden>Retry</button><a id="hub-boot-reload" href="">Reload</a></div><div id="root" hidden></div>';
 vi.spyOn(document,'readyState','get').mockReturnValue('complete');
 vi.spyOn(window,'getComputedStyle').mockImplementation(()=>({getPropertyValue:()=>appCSS?'ready':'',position:'absolute',opacity:xtermCSS?'0':'1'} as unknown as CSSStyleDeclaration));
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 events=vi.spyOn(window,'addEventListener');documentEvents=vi.spyOn(document,'addEventListener');
});
afterEach(()=>{
 for(const [name,listener,options] of events.mock.calls)window.removeEventListener(name,listener,options);
 for(const [name,listener,options] of documentEvents.mock.calls)document.removeEventListener(name,listener,options);
 delete window.hubBoot;vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();document.body.innerHTML='';document.head.innerHTML='';
});
function start(){new Function('window','document',source)(window,document);}
function mount(){const callback=vi.fn(()=>window.hubBoot!.complete());window.hubBoot!.run(callback);return callback;}
it('waits for application and xterm CSS, and mounts only once despite late module retries',async()=>{
 start();const callback=mount();expect(callback).not.toHaveBeenCalled();
 appCSS=true;await vi.advanceTimersByTimeAsync(200);expect(callback).not.toHaveBeenCalled();
 xtermCSS=true;await vi.advanceTimersByTimeAsync(200);expect(callback).toHaveBeenCalledTimes(1);
 expect(document.getElementById('root')!.hidden).toBe(false);expect(document.getElementById('hub-boot')!.hidden).toBe(true);
 const duplicate=vi.fn();window.hubBoot!.run(duplicate);expect(duplicate).not.toHaveBeenCalled();
 const href=document.querySelector<HTMLLinkElement>('link')!.href;
 window.dispatchEvent(new Event('error'));await vi.advanceTimersByTimeAsync(60000);
 expect(document.querySelector<HTMLLinkElement>('link')!.href).toBe(href);
});
it('bounds CSS retries, hides the unstyled app, and recovers only after an explicit retry',async()=>{
 start();const callback=mount();await vi.advanceTimersByTimeAsync(30100);
 expect(document.getElementById('hub-boot')!.dataset.state).toBe('error');expect(callback).not.toHaveBeenCalled();
 expect(document.getElementById('root')!.hidden).toBe(true);
 const href=document.querySelector<HTMLLinkElement>('link')!.href;
 await vi.advanceTimersByTimeAsync(60000);expect(document.querySelector<HTMLLinkElement>('link')!.href).toBe(href);
 appCSS=xtermCSS=true;document.getElementById('hub-boot-retry')!.click();await vi.advanceTimersByTimeAsync(200);
 expect(callback).toHaveBeenCalledOnce();
});
it('recovers from a failed application bundle without reloading an active terminal',async()=>{
 appCSS=xtermCSS=true;start();await vi.advanceTimersByTimeAsync(45100);
 expect(document.getElementById('hub-boot')!.dataset.state).toBe('error');
 expect(document.querySelectorAll('script[type=module]')).toHaveLength(1);
 document.getElementById('hub-boot-retry')!.click();const callback=mount();await vi.advanceTimersByTimeAsync(200);
 expect(callback).toHaveBeenCalledOnce();
});
it('starts CSS recovery even if a blocked stylesheet also blocks DOMContentLoaded',async()=>{
 vi.spyOn(document,'readyState','get').mockReturnValue('loading');start();const callback=mount();
 await vi.advanceTimersByTimeAsync(10100);
 expect(document.querySelector<HTMLLinkElement>('link')!.href).toContain('hub_retry=');
 expect(callback).not.toHaveBeenCalled();
});
it('offers a deliberate reload after a fatal render without restarting terminals automatically',async()=>{
 appCSS=xtermCSS=true;start();const callback=mount();await vi.advanceTimersByTimeAsync(200);
 window.hubBoot!.fail();
 expect(document.getElementById('root')!.hidden).toBe(true);
 expect(document.getElementById('hub-boot')!.dataset.state).toBe('error');
 expect(document.getElementById('hub-boot-retry')!.hidden).toBe(true);
 await vi.advanceTimersByTimeAsync(60000);expect(callback).toHaveBeenCalledOnce();
});

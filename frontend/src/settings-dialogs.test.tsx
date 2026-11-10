import {act} from 'react';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';

// main.tsx mounts the whole app into #root on import; drive it through the
// real settings menu and dialogs with the network layer mocked.
const calls:{path:string;body:unknown;method?:string}[]=[];
// No instance is online here, so keep xterm.js (and its canvas probe) out of jsdom.
vi.mock('./terminal/Terminal',()=>({RealTerminal:()=>null}));
const admin=vi.hoisted(()=>({value:true}));
vi.mock('./api',async importOriginal=>({...await importOriginal<typeof import('./api')>(),api:vi.fn(async(path:string,body?:unknown,method?:string)=>{
  calls.push({path,body,method});
  if(path==='/me')return {id:'u1',username:'alice',csrf:'c',hub_address:'http://hub.test',is_admin:admin.value};
  if(path==='/instances')return [];
  if(path==='/me/preferences')return {};
  if(path==='/me/sessions'&&!method)return {sessions:[{expires:1},{expires:2}]};
  if(path==='/me/password')return {id:'u1',username:'alice',csrf:'c2',hub_address:'http://hub.test',is_admin:admin.value};
  if(path.startsWith('/admin/'))return path==='/admin/dashboard'?{users:1,instances:0,online:0,sessions:1,offline:0,uptime_seconds:5,version:'0.2.0',revision:'r'}:{active:false,stage:'',target:'',downloaded:0,total:0};
  return {};
})}));
beforeAll(async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('CSS',{escape:(value:string)=>value.replace(/[^\w-]/g,'\\$&')});
  vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}));
  vi.stubGlobal('EventSource',class{addEventListener(){}close(){}onerror=null});
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  localStorage.setItem('gotty-hub.locale','zh-CN');
  document.body.innerHTML='<div id="root"></div>';
  await act(async()=>{await import('./main');});
});
afterEach(()=>{calls.length=0;});
const button=(name:string)=>[...document.querySelectorAll('button')].find(item=>item.textContent?.trim()===name||item.getAttribute('aria-label')===name);
const dialog=(name:string)=>[...document.querySelectorAll('[role=dialog]')].find(item=>item.textContent?.includes(name));
async function choose(item:string){
  await act(async()=>button('设置')!.click());
  const entry=[...document.querySelectorAll('[role=dialog] button')].find(node=>node.textContent===item);
  expect(entry,`${item} must be in the settings menu`).toBeDefined();
  await act(async()=>(entry as HTMLButtonElement).click());
}
async function type(label:string,value:string){
  const field=[...document.querySelectorAll('input')].find(input=>document.querySelector(`label[for="${input.id}"]`)?.textContent?.includes(label)||input.getAttribute('aria-label')===label)!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function close(){await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await act(async()=>{});}

it('replaces the old account dialog with a settings menu',async()=>{
  expect(button('设置'),'settings trigger').toBeDefined();
  expect(button('账号与安全'),'legacy account button removed').toBeUndefined();
});
it('opens the console for administrators',async()=>{
  await choose('控制台');
  expect(dialog('统计')??dialog('控制台'),'console dialog').toBeDefined();
  expect(calls.some(call=>call.path==='/admin/dashboard')).toBe(true);
  await close();
});
it('validates and saves a new password in its own dialog',async()=>{
  await choose('修改密码');
  expect(dialog('为当前账号设置新的登录密码'),'password dialog').toBeDefined();
  await type('新密码','long enough password');await type('确认密码','different password!!');
  await act(async()=>button('保存密码')!.click());
  expect(document.querySelector('[role=alert]')?.textContent).toBeTruthy();
  expect(calls.some(call=>call.path==='/me/password')).toBe(false);
  await type('确认密码','long enough password');
  await act(async()=>button('保存密码')!.click());
  expect(calls).toContainEqual({path:'/me/password',body:{password:'long enough password'},method:'PUT'});
  expect(dialog('为当前账号设置新的登录密码'),'password dialog closes after saving').toBeUndefined();
});
it('signs out of the current account from the logout dialog',async()=>{
  await choose('退出');
  expect(dialog('有效登录会话: 2'),'logout dialog shows active sessions').toBeDefined();
  expect(button('退出所有设备')).toBeDefined();
  await act(async()=>button('退出当前账号')!.click());
  expect(calls).toContainEqual({path:'/auth/logout',body:{},method:undefined});
  expect(button('设置'),'signed-out users see no settings menu').toBeUndefined();
  expect(button('登录')).toBeDefined();
});

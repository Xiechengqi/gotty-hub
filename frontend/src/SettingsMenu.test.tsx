import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SettingsMenu,type SettingsAction} from './SettingsMenu';

const labels={settings:'Settings',terminalSettings:'Terminal settings',console:'Console',password:'Change password',logout:'Sign out'};
let node:HTMLDivElement,root:ReturnType<typeof createRoot>;
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  // jsdom lacks CSS.escape, which React Aria's popover uses for focus scoping.
  vi.stubGlobal('CSS',{escape:(value:string)=>value.replace(/[^\w-]/g,'\\$&')});
  node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();});
async function render(admin:boolean,onSelect=vi.fn<(action:SettingsAction)=>void>()){
  await act(async()=>root.render(<SettingsMenu labels={labels} admin={admin} onSelect={onSelect}/>));
  return onSelect;
}
async function openMenu(){
  const trigger=document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!;
  expect(trigger.textContent).toBe('Settings');
  await act(async()=>trigger.click());
  const menu=document.querySelector('[role=dialog][aria-label="Settings"]');
  expect(menu,'settings menu must open').not.toBeNull();
  return [...menu!.querySelectorAll('button')];
}
it('shows the console only to administrators and reports each selection',async()=>{
  const onSelect=await render(true);
  let items=await openMenu();
  expect(items.map(item=>item.textContent)).toEqual(['Terminal settings','Console','Change password','Sign out']);
  for(const [index,action] of (['terminal','console','password','logout'] as const).entries()){
    await act(async()=>items[index].click());
    expect(onSelect).toHaveBeenLastCalledWith(action);
    expect(document.querySelector('[role=dialog][aria-label="Settings"]'),'menu closes after a selection').toBeNull();
    if(index<3)items=await openMenu();
  }
});
it('hides the console from regular users',async()=>{
  await render(false);
  expect((await openMenu()).map(item=>item.textContent)).toEqual(['Terminal settings','Change password','Sign out']);
});

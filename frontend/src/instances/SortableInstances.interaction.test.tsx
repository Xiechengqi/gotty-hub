import {act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {WorkspaceSortProvider,WorkspaceSortList,SortableWorkspaceUnit} from './SortableInstances';
import {Dropdown,DropdownTrigger} from '@/components/base/dropdown/dropdown';
let node:HTMLDivElement,root:ReturnType<typeof createRoot>;
const moved=vi.fn();
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);moved.mockClear();
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    const unit=this.closest<HTMLElement>('[data-sort-id]');const index=unit?[...unit.parentElement!.children].indexOf(unit):0;
    return new DOMRect(index*150,0,150,30);
  });
  node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
function Fixture({portal=false}:{portal?:boolean}){const [order,setOrder]=useState(['a','b']);return <WorkspaceSortProvider onReorder={(id,target)=>{moved(id,target);setOrder([...order].reverse());}} onDragging={()=>{}} onFinish={()=>{}}><WorkspaceSortList scope="tabs" units={order.map(id=>[id])}>{order.map(id=><SortableWorkspaceUnit scope="tabs" id={id} key={id} className="unit"><Dropdown isOpen={false}><DropdownTrigger><span>{id}</span></DropdownTrigger></Dropdown>{portal&&createPortal(<div data-portal-content={id}>Menu</div>,document.body)}</SortableWorkspaceUnit>)}</WorkspaceSortList></WorkspaceSortProvider>;}
const mouse=async(target:EventTarget,type:string,button:number,x:number)=>{await act(async()=>{target.dispatchEvent(new MouseEvent(type,{button,buttons:button===2?2:1,clientX:x,clientY:15,bubbles:true,cancelable:true}));});};
it('starts from the whole tab and requires movement before sorting',async()=>{
 await act(async()=>root.render(<Fixture/>));const first=node.querySelector('span')!;
 await mouse(first,'mousedown',0,60);await mouse(document,'mouseup',0,60);expect(moved).not.toHaveBeenCalled();
 await mouse(first,'mousedown',2,60);await mouse(document,'mousemove',2,220);await mouse(document,'mouseup',2,220);expect(moved).not.toHaveBeenCalled();
 await mouse(first,'mousedown',0,60);await mouse(document,'mousemove',0,70);await mouse(document,'mousemove',0,220);await mouse(document,'mouseup',0,220);
 expect(moved).toHaveBeenCalledWith('a','b');
});
it('ignores drag gestures in portalled menu content',async()=>{
 await act(async()=>root.render(<Fixture portal/>));const menu=document.querySelector('[data-portal-content="a"]')!;
 await mouse(menu,'mousedown',0,60);await mouse(document,'mousemove',0,70);await mouse(document,'mousemove',0,220);
 expect(node.querySelector('[data-dragging=true]')).toBeNull();
 await mouse(document,'mouseup',0,220);expect(moved).not.toHaveBeenCalled();
});
it('cancels on Escape or window blur without committing the order',async()=>{
 await act(async()=>root.render(<Fixture/>));
 for(const reason of ['escape','blur']){
  const first=node.querySelector('span')!;
  await mouse(first,'mousedown',0,60);await mouse(document,'mousemove',0,70);await mouse(document,'mousemove',0,220);
  expect(node.querySelector('[data-dragging=true]')).not.toBeNull();
  expect(document.activeElement?.getAttribute('data-sort-id')).toBe('a');
  await act(async()=>{if(reason==='blur')window.dispatchEvent(new Event('blur'));else document.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',key:'Escape'}));});
  expect(node.querySelector('[data-dragging=true]')).toBeNull();
  await mouse(document,'mouseup',0,220);expect(moved).not.toHaveBeenCalled();
 }
});

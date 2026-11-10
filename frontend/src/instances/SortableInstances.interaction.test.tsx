import {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {InstanceSortList, InstanceSortProvider, SortableInstance} from './SortableInstances';

let node:HTMLDivElement, root:ReturnType<typeof createRoot>;
const reordered=vi.fn();
beforeEach(()=>{
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    const item=this.closest<HTMLElement>('[data-instance-id]');
    const scope=item?.parentElement?.dataset.scope;
    const index=item?[...item.parentElement!.children].indexOf(item):0;
    const left=scope==='tabs'?300+index*200:0;
    const top=scope==='tabs'?0:100+index*50;
    const [,dx,dy]=item?.style.transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px/)??[];
    return new DOMRect(left+Number(dx||0),top+Number(dy||0),200,40);
  });
  node=document.createElement('div');document.body.append(node);root=createRoot(node);
});
afterEach(async()=>{
  await act(async()=>root.unmount());node.remove();
  vi.restoreAllMocks();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();
});
function Fixture({initialOrder}:{initialOrder:string[]}){
  const [order,setOrder]=useState(initialOrder);
  return <InstanceSortProvider order={order} onReorder={value=>{reordered(value);setOrder(value);}} locale="zh-CN">
    {(['sidebar','tabs'] as const).map(scope=><div data-scope={scope} key={scope}>
      <InstanceSortList scope={scope} ids={order}>{order.map(id=><SortableInstance scope={scope} id={id} name={id} locale="zh-CN" className={scope==='tabs'?'session-tab':'instance-nav-row'} key={id}>{id}</SortableInstance>)}</InstanceSortList>
    </div>)}
  </InstanceSortProvider>;
}
async function key(target:HTMLElement,code:string){
  await act(async()=>{target.dispatchEvent(new KeyboardEvent('keydown',{code,key:code==='Space'?' ':code,bubbles:true,cancelable:true}));});
}
it.each([['one','two'],['two','one']])('moves instances from either surface with the real keyboard sensor (%s, %s)',async(first,last)=>{
  reordered.mockClear();
  const initialOrder=[first,last];
  await act(async()=>root.render(<Fixture initialOrder={initialOrder}/>));
  const handle=(scope:string)=>node.querySelector<HTMLButtonElement>(`[data-scope="${scope}"] [data-instance-id="${last}"] button`)!;
  const order=(scope:string)=>[...node.querySelectorAll<HTMLElement>(`[data-scope="${scope}"] [data-instance-id]`)].map(item=>item.dataset.instanceId);
  await act(async()=>handle('tabs').focus());await key(handle('tabs'),'Space');
  expect(handle('tabs').getAttribute('aria-pressed')).toBe('true');
  // The active state renders before KeyboardSensor's deferred listener.
  await act(async()=>vi.advanceTimersByTime(20));
  expect(handle('tabs').parentElement!.style.transform).not.toBe('');
  await key(handle('tabs'),'ArrowLeft');
  expect(handle('tabs').parentElement!.style.transform).toMatch(/translate3d\(-[\d.]+px,/);
  await key(handle('tabs'),'Space');
  expect(reordered).toHaveBeenLastCalledWith([last,first]);
  expect(order('sidebar')).toEqual([last,first]);
  expect(order('tabs')).toEqual([last,first]);
  await act(async()=>handle('sidebar').focus());await key(handle('sidebar'),'Space');
  await act(async()=>vi.advanceTimersByTime(20));
  await key(handle('sidebar'),'ArrowDown');
  expect(handle('sidebar').parentElement!.style.transform).toMatch(/translate3d\([^,]+, [\d.]+px,/);
  await key(handle('sidebar'),'Space');
  expect(reordered).toHaveBeenLastCalledWith(initialOrder);
  expect(order('sidebar')).toEqual(initialOrder);
  expect(order('tabs')).toEqual(initialOrder);
});

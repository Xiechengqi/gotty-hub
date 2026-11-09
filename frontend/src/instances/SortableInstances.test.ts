import {expect,it} from 'vitest';
import {scopedKeyboardCoordinates} from './SortableInstances';

it('keeps keyboard sorting within its own surface even with a closer item in another surface',()=>{
  const rect=(left:number,top:number)=>({left,top,width:100,height:40,right:left+100,bottom:top+40});
  const container=(id:string,scope:string,index:number)=>({id,disabled:false,node:{current:document.createElement('div')},data:{current:{scope,sortable:{containerId:scope,index}}}});
  const items=[container('tabs:one','tabs',0),container('tabs:two','tabs',1),container('sidebar:one','sidebar',0)];
  const containers=Object.assign(new Map(items.map(item=>[item.id,item])),{getEnabled:()=>items});
  const activeRect=rect(300,100);
  const args={active:'tabs:two',currentCoordinates:{x:300,y:100},context:{
    active:{id:'tabs:two',data:items[1].data},collisionRect:activeRect,over:null,scrollableAncestors:[],
    droppableContainers:containers,droppableRects:new Map([['tabs:one',rect(100,100)],['tabs:two',activeRect],['sidebar:one',rect(290,100)]]),
  }} as unknown as Parameters<typeof scopedKeyboardCoordinates>[1];
  expect(scopedKeyboardCoordinates(new KeyboardEvent('keydown',{code:'ArrowLeft'}),args)).toEqual({x:100,y:100});
  expect(scopedKeyboardCoordinates(new KeyboardEvent('keydown',{code:'ArrowUp'}),args)).toBeUndefined();
});

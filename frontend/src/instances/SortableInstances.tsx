import type {ReactNode} from 'react';
import {DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type KeyboardCoordinateGetter} from '@dnd-kit/core';
import {SortableContext, useSortable, verticalListSortingStrategy, horizontalListSortingStrategy, sortableKeyboardCoordinates} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {RiDraggable} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {reorderInstance} from './order';

type Scope='sidebar'|'drawer'|'tabs';
const key=(scope:Scope,id:string)=>`${scope}:${id}`;
export const scopedKeyboardCoordinates:KeyboardCoordinateGetter=(event,args)=>sortableKeyboardCoordinates(event,{
  ...args,context:{...args.context,droppableRects:new Map([...args.context.droppableRects].filter(([id])=>
    args.context.droppableContainers.get(id)?.data.current?.scope===args.context.active?.data.current?.scope))},
});
export function InstanceSortProvider({order,onReorder,locale,children}:{order:string[];onReorder:(order:string[])=>void;locale:string;children:ReactNode}){
  const sensors=useSensors(useSensor(MouseSensor,{activationConstraint:{distance:5}}),useSensor(TouchSensor,{activationConstraint:{delay:200,tolerance:8}}),useSensor(KeyboardSensor,{coordinateGetter:scopedKeyboardCoordinates}));
  const zh=locale==='zh-CN';
  return <DndContext sensors={sensors} collisionDetection={args=>closestCenter({...args,droppableContainers:args.droppableContainers.filter(container=>container.data.current?.scope===args.active.data.current?.scope)})}
    onDragEnd={({active,over})=>{const id=active.data.current?.instanceId,target=over?.data.current?.instanceId;if(typeof id==='string'&&typeof target==='string')onReorder(reorderInstance(order,id,target));}}
    accessibility={{screenReaderInstructions:{draggable:zh?'按空格开始排序，使用方向键移动，再按空格完成或 Escape 取消。':'Press Space to sort, use arrow keys to move, then Space to finish or Escape to cancel.'}}}>
    {children}
  </DndContext>;
}
export function InstanceSortList({scope,ids,children}:{scope:Scope;ids:string[];children:ReactNode}){
  return <SortableContext items={ids.map(id=>key(scope,id))} strategy={scope==='tabs'?horizontalListSortingStrategy:verticalListSortingStrategy}>{children}</SortableContext>;
}
export function SortableInstance({scope,id,name,locale,className,children}:{scope:Scope;id:string;name:string;locale:string;className:string;children:ReactNode}){
  const {setNodeRef,setActivatorNodeRef,attributes,listeners,transform,transition,isDragging}=useSortable({id:key(scope,id),data:{instanceId:id,scope,name}});
  return <div ref={setNodeRef} className={className} style={{transform:CSS.Transform.toString(transform),transition}} data-instance-id={id} data-dragging={isDragging||undefined}>
    <Button ref={setActivatorNodeRef} {...attributes} {...listeners} variant="ghost" size="xs" iconOnly leadingIcon={RiDraggable} className="instance-sort-handle quiet-button" aria-label={`${locale==='zh-CN'?'拖动排序':'Reorder'} ${name}`}/>
    {children}
  </div>;
}

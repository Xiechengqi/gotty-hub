import {useEffect, useRef, type ReactNode} from 'react';
import {DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors} from '@dnd-kit/core';
import {SortableContext, useSortable, verticalListSortingStrategy, horizontalListSortingStrategy} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';

type Scope = 'tabs' | 'directory';
export class RightMouseSensor extends MouseSensor {
  static activators: typeof MouseSensor.activators = [{eventName: 'onMouseDown', handler: ({nativeEvent: event}, {onActivation}) => {
    if (event.button !== 2 || (event.target instanceof Element && event.target.closest('[data-no-drag]'))) return false;
    onActivation?.({event}); return true;
  }}];
}
export class WorkspaceTouchSensor extends TouchSensor {
  static activators: typeof TouchSensor.activators = [{eventName: 'onTouchStart', handler: (event, options) => {
    if (event.target instanceof Element && event.target.closest('[data-no-drag]')) return false;
    return TouchSensor.activators[0].handler(event, options);
  }}];
}
export function WorkspaceSortProvider({onReorder, onDragging, onFinish, children}: {
  onReorder: (id: string, target: string) => void; onDragging: (value: boolean) => void; onFinish: () => void; children: ReactNode;
}) {
  const sensors = useSensors(useSensor(RightMouseSensor, {activationConstraint: {distance: 5}}), useSensor(WorkspaceTouchSensor, {activationConstraint: {delay: 250, tolerance: 8}}));
  const dragging = useRef(false);
  useEffect(() => {
    // dnd-kit listens for Escape on document and cleans up the active sensor.
    // Dispatch there (never at a terminal) when the window loses the gesture.
    const cancel = () => {if (dragging.current) document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape'}));};
    window.addEventListener('blur', cancel);
    document.addEventListener('pointercancel', cancel);
    return () => {window.removeEventListener('blur', cancel); document.removeEventListener('pointercancel', cancel);};
  }, []);
  return <DndContext sensors={sensors} collisionDetection={args => closestCenter({...args, droppableContainers: args.droppableContainers.filter(c => c.data.current?.scope === args.active.data.current?.scope)})}
    onDragStart={({activatorEvent}) => {
      dragging.current = true; onDragging(true);
      // Escape cancels the gesture without also reaching the PTY.
      (activatorEvent.target as Element)?.closest<HTMLElement>('[data-sort-id]')?.focus({preventScroll: true});
    }}
    onDragCancel={() => {dragging.current = false; onDragging(false); if (document.hasFocus()) onFinish();}}
    onDragEnd={({active, over}) => {
      dragging.current = false; onDragging(false); const id = active.data.current?.instanceId, target = over?.data.current?.instanceId;
      if (typeof id === 'string' && typeof target === 'string') onReorder(id, target);
      onFinish();
    }}>
    {children}
  </DndContext>;
}
export function WorkspaceSortList({scope, units, children}: {scope: Scope; units: string[][]; children: ReactNode}) {
  return <SortableContext items={units.map(unit => scope + ':' + unit[0])} strategy={scope === 'tabs' ? horizontalListSortingStrategy : verticalListSortingStrategy}>{children}</SortableContext>;
}
export function SortableWorkspaceUnit({scope, id, className, children}: {scope: Scope; id: string; className: string; children: ReactNode}) {
  const {setNodeRef, listeners, transform, transition, isDragging} = useSortable({id: scope + ':' + id, data: {instanceId: id, scope}});
  return <div ref={setNodeRef} {...listeners} tabIndex={-1} className={className} data-sort-id={id} data-dragging={isDragging || undefined} onContextMenu={event => event.preventDefault()} style={{transform: CSS.Transform.toString(transform), transition}}>{children}</div>;
}

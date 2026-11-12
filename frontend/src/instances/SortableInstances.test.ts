import {expect,it,vi} from 'vitest';
import {WorkspaceMouseSensor} from './SortableInstances';
it('accepts only left-button starts from the tab body',()=>{
  const handler=WorkspaceMouseSensor.activators[0].handler, onActivation=vi.fn();
  const target=document.createElement('div');document.body.append(target);
  const run=(button:number)=>{const event=new MouseEvent('mousedown',{button,bubbles:true});target.dispatchEvent(event);return handler({nativeEvent:event} as Parameters<typeof handler>[0],{onActivation});};
  expect(run(0)).toBe(true);expect(run(1)).toBe(false);expect(run(2)).toBe(false);expect(onActivation).toHaveBeenCalledOnce();
  target.setAttribute('data-no-drag','true');expect(run(0)).toBe(false);target.remove();
});

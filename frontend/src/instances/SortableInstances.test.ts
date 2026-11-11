import {expect,it,vi} from 'vitest';
import {RightMouseSensor} from './SortableInstances';
it('accepts only right-button starts from the tab body',()=>{
  const handler=RightMouseSensor.activators[0].handler, onActivation=vi.fn();
  const target=document.createElement('div');document.body.append(target);
  const run=(button:number)=>{const event=new MouseEvent('mousedown',{button,bubbles:true});target.dispatchEvent(event);return handler({nativeEvent:event} as Parameters<typeof handler>[0],{onActivation});};
  expect(run(0)).toBe(false);expect(run(1)).toBe(false);expect(run(2)).toBe(true);expect(onActivation).toHaveBeenCalledOnce();
  target.setAttribute('data-no-drag','true');expect(run(2)).toBe(false);target.remove();
});

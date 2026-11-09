import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi,type Mock} from 'vitest';
import {ShareManager,type Control} from './ShareManager';

// Layout is covered by the CI browser regression. Keep this test focused on
// the real form controls and the payload sent to the owner-only RPC.
vi.mock('@/components/base/popover/popover',()=>({
  PopoverTrigger:({isOpen,children}:any)=>isOpen?children:null,
  Popover:({children}:any)=><div>{children}</div>,
}));
let node:HTMLDivElement,root:ReturnType<typeof createRoot>;
const list={shares:[],default_target:'localhost:2222',configured:true,public_domain:'example.test',subdomain_prefix:'gotty-'};
let control:Mock<Control>;
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  node=document.createElement('div');document.body.append(node);root=createRoot(node);
  control=vi.fn<Control>(async()=>list);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();});
async function render(open=true){await act(async()=>root.render(<ShareManager open={open} onOpenChange={()=>{}} trigger={<button>Share</button>} control={control} enabled locale="en-US"/>));}
async function input(label:string,value:string){
  const field=node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(field,`${label} must be available`).not.toBeNull();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function toggle(text:string){const label=[...node.querySelectorAll('label')].find(item=>item.textContent===text)!;await act(async()=>label.querySelector('input')!.click());}
async function submit(){await act(async()=>node.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}

it('submits the original share options, enforces exclusive password modes and clears a closed password',async()=>{
  await render();expect(control).toHaveBeenCalledWith('shares');
  await input('Subdomain suffix',' GoTTY-Preview ');await input('Expiry value','2');
  await toggle('Custom password');await input('Share password','private share password');
  await toggle('Passwordless');expect(node.querySelector('input[type=password]')).toBeNull();
  await submit();
  expect(control).toHaveBeenCalledWith('share_create',{type:'http',target:'localhost:2222',subdomain:'preview',expire_value:2,expire_unit:'hours',read_only:true,passwordless:true,custom_password:false,password:''});
  await toggle('Custom password');await input('Share password','second secret');await render(false);await render();
  expect(node.querySelector('input[type=password]')).toBeNull();
});
it('rejects invalid expiry before making a remote create request',async()=>{
  await render();await input('Expiry value','-2');await submit();
  expect(control.mock.calls.filter(([action])=>action==='share_create')).toHaveLength(0);
  expect(node.querySelector('[role=alert]')!.textContent).toContain('positive integer');
});

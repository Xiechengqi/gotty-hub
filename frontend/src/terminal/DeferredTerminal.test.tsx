import {useEffect} from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {DeferredTerminal} from './DeferredTerminal';
it('connects on first visit, retains a hidden terminal, and disposes when removed',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const connect=vi.fn(),disconnect=vi.fn();
  function Terminal(){useEffect(()=>{connect();return disconnect;},[]);return <div>terminal</div>;}
  const node=document.createElement('div');document.body.append(node);const root=createRoot(node);
  const render=(visible:boolean)=>act(async()=>root.render(<DeferredTerminal visible={visible}><Terminal/></DeferredTerminal>));
  try {
    await render(false);expect(connect).not.toHaveBeenCalled();
    await render(true);await render(false);await render(true);
    expect(connect).toHaveBeenCalledTimes(1);expect(disconnect).not.toHaveBeenCalled();
  }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();}
  expect(disconnect).toHaveBeenCalledTimes(1);
});

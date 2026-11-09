import {useEffect, useRef, useState, type ReactElement} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import {Checkbox} from '@/components/base/checkbox/checkbox';
import {Select, SelectItem} from '@/components/base/select/select';
import {Popover, PopoverTrigger} from '@/components/base/popover/popover';
import {ScrollFade, useScrollFade} from '@/components/foundations/scroll-fade/scroll-fade';

export type Control = (action: string, payload?: Record<string, unknown>) => Promise<any>;
type Share = {id: string; public_url: string; target: string; status: string; expires_at?: string; last_error?:string; read_only?:boolean};
type ShareList = {shares: Share[]; default_target: string; configured: boolean; missing_config?: string[]; public_domain?:string; subdomain_prefix?:string};

export function ShareManager({open, onOpenChange, trigger, control, enabled, locale}: {open: boolean; onOpenChange: (value:boolean) => void; trigger:ReactElement; control: Control; enabled: boolean; locale: string}) {
  const zh = locale === 'zh-CN', fade=useScrollFade();
  const [data, setData] = useState<ShareList>();
  const [target, setTarget] = useState(''), [subdomain, setSubdomain] = useState('');
  const [expiry, setExpiry] = useState(''), [unit,setUnit]=useState('hours');
  const [readOnly, setReadOnly] = useState(true), [passwordless, setPasswordless] = useState(false);
  const [customPassword,setCustomPassword]=useState(false), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const running=useRef(false);
  useEffect(() => {
    if(!open){setPassword('');setCustomPassword(false);return;}
    if(!enabled)return;
    let disposed = false;
    let retry:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      if(disposed)return;
      if(running.current){clearTimeout(retry);retry=setTimeout(()=>void refresh(),100);return;}
      running.current=true;setBusy(true);
      try{const value=await control('shares') as ShareList;if(!disposed){setData(value);setTarget(previous=>previous||value.default_target);setError('');}}
      catch(err){if(!disposed)setError(err instanceof Error?err.message:String(err));}
      finally{running.current=false;setBusy(false);}
    };
    void refresh();const timer=setInterval(()=>void refresh(),10000);
    return () => {disposed = true;clearInterval(timer);clearTimeout(retry);};
  }, [open, enabled, control]);
  async function action(name: string, payload: Record<string, unknown>) {
    if(running.current)return;
    running.current=true;setError('');setBusy(true);
    try {await control(name,payload);setData(await control('shares'));if(name==='share_create'){setPassword('');setCustomPassword(false);}}
    catch (err) {setError(err instanceof Error?err.message:String(err));}
    finally {running.current=false;setBusy(false);}
  }
  async function copy(url:string){
    try{
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(url);
      else{
        const field=document.createElement('textarea');field.value=url;field.style.position='fixed';field.style.opacity='0';document.body.append(field);field.select();
        const copied=document.execCommand('copy');field.remove();if(!copied)throw Error(zh?'无法复制链接':'Unable to copy link');
      }
    }catch(err){setError(err instanceof Error?err.message:String(err));}
  }
  const suffix=subdomain.trim().toLowerCase().replace(/^gotty-/,'');
  const active=data?.shares.filter(share=>share.status==='active')??[];
  const history=data?.shares.filter(share=>share.status!=='active')??[];
  function records(shares:Share[],label:string,empty:string){return <>
    <div className="terminal-section-divider"/><h3 className="terminal-section-title text-caption-2-semibold">{label}</h3>
    {!shares.length&&<p className="terminal-share-empty text-body-2-regular">{empty}</p>}
    {shares.map(share=><div className="terminal-share-row" key={share.id}>
      <p className="text-body-2-medium break-all" dir="ltr">{share.public_url||share.target}</p>
      <p className="text-caption-2-regular">{share.status}{share.read_only?' · '+(zh?'只读':'Read only'):''}{share.expires_at?' · '+new Date(share.expires_at).toLocaleString(locale):' · '+(zh?'不过期':'Never expires')}</p>
      {share.last_error&&<p className="text-caption-2-regular text-text-error-primary">{share.last_error}</p>}
      <div className="terminal-setting-options">
        {share.public_url&&<><Button variant="ghost" size="xs" disabled={busy} onClick={()=>void copy(share.public_url)}>{zh?'复制':'Copy'}</Button>{share.status==='active'&&<Button variant="ghost" size="xs" onClick={()=>{const url=new URL(share.public_url);if(['http:','https:'].includes(url.protocol))window.open(url.href,'_blank','noopener,noreferrer');}}>{zh?'打开':'Open'}</Button>}</>}
        {share.status==='active'?<Button variant="ghost" size="xs" disabled={busy} onClick={()=>void action('share_stop',{id:share.id})}>{zh?'停止':'Stop'}</Button>:<><Button variant="ghost" size="xs" disabled={busy} onClick={()=>void action('share_restart',{id:share.id})}>{zh?'重启':'Restart'}</Button><Button variant="ghost" size="xs" disabled={busy} onClick={()=>void action('share_delete',{id:share.id})}>{zh?'删除':'Delete'}</Button></>}
      </div>
    </div>)}
  </>;}
  return <PopoverTrigger isOpen={open} onOpenChange={value=>{fade.reset();onOpenChange(value);}}>{trigger}
    <Popover placement="left top" offset={-16} crossOffset={32} className="terminal-popover terminal-share-popover dark" dialogClassName="terminal-popover-dialog" aria-label={zh?'分享管理':'Share manager'}>
      <div className="terminal-popover-scroll" onScroll={fade.onScroll}>
        <h3 className="terminal-section-title text-caption-2-semibold">{zh?'分享':'Share'}</h3>
        {!enabled?<p className="terminal-share-empty text-body-2-regular">{zh?'此 GoTTY 未启用分享功能。':'Sharing is disabled on this GoTTY.'}</p>:<>
          <form className="terminal-share-form" onSubmit={event=>{event.preventDefault();if(expiry&&(!Number.isInteger(Number(expiry))||Number(expiry)<1)){setError(zh?'有效期必须为正整数':'Expiry must be a positive integer');return;}if(!busy)void action('share_create',{type:'http',target,subdomain:suffix,expire_value:expiry?Number(expiry):0,expire_unit:unit,read_only:readOnly,passwordless,custom_password:customPassword,password:customPassword?password:''});}}>
            <Input aria-label={zh?'目标地址':'Target host and port'} placeholder="localhost:8080" value={target} onChange={setTarget} isRequired size="small"/>
            <Input aria-label={zh?'子域名后缀':'Subdomain suffix'} placeholder={zh?'子域名后缀（可选）':'Subdomain suffix (optional)'} value={subdomain} onChange={setSubdomain} size="small"/>
            <div className="terminal-expiry-row">
              <Input aria-label={zh?'有效期数值':'Expiry value'} placeholder={zh?'不过期':'Never expires'} type="number" value={expiry} onChange={setExpiry} size="small"/>
              <Select aria-label={zh?'有效期单位':'Expiry unit'} selectedKey={unit} onSelectionChange={value=>setUnit(String(value))} size="sm" popoverClassName="dark">
                {['minutes','hours','days'].map((value,index)=><SelectItem id={value} key={value}>{zh?['分钟','小时','天'][index]:['Minutes','Hours','Days'][index]}</SelectItem>)}
              </Select>
            </div>
            <div className="terminal-share-options">
              <Checkbox size="sm" isSelected={readOnly} onChange={setReadOnly}>{zh?'只读':'Read only'}</Checkbox>
              <Checkbox size="sm" isSelected={passwordless} onChange={value=>{setPasswordless(value);if(value){setCustomPassword(false);setPassword('');}}}>{zh?'免密码':'Passwordless'}</Checkbox>
              <Checkbox size="sm" isSelected={customPassword} onChange={value=>{setCustomPassword(value);if(value)setPasswordless(false);else setPassword('');}}>{zh?'自定义密码':'Custom password'}</Checkbox>
            </div>
            {customPassword&&<Input aria-label={zh?'分享密码':'Share password'} placeholder={zh?'分享密码':'Share password'} type="password" autoComplete="new-password" value={password} onChange={setPassword} isRequired size="small"/>}
            {data?.public_domain&&<p className="terminal-share-preview text-caption-2-regular" dir="ltr">https://{data.subdomain_prefix??'gotty-'}{suffix||'xxxxxx'}.{data.public_domain}</p>}
            <Button type="submit" size="small" className="terminal-share-primary" disabled={busy||!data?.configured}>{busy?(zh?'处理中…':'Working…'):data?.configured?(zh?'创建分享':'Create share'):(zh?'请先配置 HTTP 隧道':'Configure HTTP tunnel first')}</Button>
          </form>
          {data&&!data.configured&&<p className="terminal-share-empty text-body-2-regular" role="status">{zh?'远程 GoTTY 需要配置：':'Configure on the remote GoTTY: '}{data.missing_config?.join(', ')}</p>}
          {records(active,zh?'进行中':'Active',zh?'暂无进行中的分享':'No active shares')}
          {records(history,zh?'历史记录':'History',zh?'暂无分享历史':'No share history')}
        </>}
        {error&&<p role="alert" className="terminal-share-empty text-body-2-regular text-text-error-primary">{error}</p>}
      </div><ScrollFade progress={fade.progress}/>
    </Popover>
  </PopoverTrigger>;
}

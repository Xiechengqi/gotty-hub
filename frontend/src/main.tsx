import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { RiTerminalBoxLine, RiAddLine, RiSettings3Line, RiSunLine, RiMoonLine, RiMenuLine, RiCloseLine, RiArrowLeftLine, RiEyeLine, RiEyeOffLine, RiTranslate2, RiArrowRightLine, RiExpandDiagonalLine, RiCollapseDiagonalLine, RiWifiOffLine, RiSideBarLine, RiLayoutTopLine } from '@remixicon/react';
import { Button } from '@/components/base/buttons/button';
import { Input } from '@/components/base/input/input';
import { Drawer, DrawerHeader, DrawerBody } from '@/components/base/drawer/drawer';
import { Modal, ModalHeader, ModalBody } from '@/components/base/modal/modal';
import { DirectionProvider } from '@/components/foundations/direction/direction';
import { cx } from '@/utils/cx';
import { initialLocale, translate, type MessageKey } from './i18n';
import '@/styles/globals.css';
import './app.css';
import {api,useAccount,type Account} from './api';
import {AdminPanel} from './Admin';
import {errorText} from './errors';
import {RealTerminal} from './terminal/Terminal';

type Group = 'production' | 'development' | 'personal';
type Instance = { status?: 'red'|'gray'|'yellow'|'green'; capabilities?: {write?:boolean;files?:boolean;asr?:boolean}; id: string; name: string; description: MessageKey; group: Group; online: boolean; role: 'owner' | 'operator' | 'observer'; host: string };
type Panel = '' | 'login' | 'account' | 'detail' | 'connect';
const demoInstances: Instance[] = [
  { id:'prod', name:'production-api', description:'prodDescription', group:'production', online:true, role:'owner', host:'ubuntu@api-01' },
  { id:'dev', name:'dev-workspace', description:'devDescription', group:'development', online:true, role:'operator', host:'developer@workspace' },
  { id:'build', name:'build-runner', description:'buildDescription', group:'development', online:true, role:'observer', host:'runner@build-02' },
  { id:'home', name:'home-server', description:'homeDescription', group:'personal', online:false, role:'owner', host:'user@home' },
  { id:'staging', name:'staging-preview', description:'stagingDescription', group:'production', online:true, role:'operator', host:'deploy@staging' },
];
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const preview=new URLSearchParams(location.search).get('preview')==='1';
function App() {
  const [instances,setInstances]=useState<Instance[]>(preview?demoInstances:[]);
  const [account,setAccount]=useState<Account|null>(null);
  const [challenge,setChallenge]=useState('');
  const [busy,setBusy]=useState(false);
  const [preferencesLoaded,setPreferencesLoaded]=useState(false);
  const remembered=useRef<any>({});
  const [apiError,setApiError]=useState('');
  const [sessions,setSessions]=useState<{expires:number}[]>([]);
  const [mobile,setMobile]=useState(()=>matchMedia('(max-width: 767px)').matches);
  useEffect(()=>{const query=matchMedia('(max-width: 767px)');const update=()=>setMobile(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update)},[]);
  function acceptAccount(value:Account|null){useAccount(value);setAccount(value)}
  function fail(error:unknown){setApiError(errorText(error instanceof Error?error.message:String(error),locale))}
  useEffect(()=>{
    if(preview)return;
    api<Account>('/me').then(acceptAccount).catch(()=>setPanel('login'));
  },[]);
  useEffect(()=>{
    if(preview||!account)return;
    const events=new EventSource('/api/v1/events');
    let initialized=false;let ready=false;
    const update=(rows:any[])=>{
      const mapped:Instance[]=rows.map(i=>({...i,host:i.name,description:'terminalPreview',group:'personal'}));
      setInstances(mapped);
      const firstSnapshot=!initialized;initialized=true;
      setOpened(previous=>{
        const restored=firstSnapshot&&Array.isArray(remembered.current.opened)?remembered.current.opened:previous;
        const permitted=restored.filter((id:string)=>mapped.some(i=>i.id===id));
        if(firstSnapshot&&Array.isArray(remembered.current.opened))return permitted;
        if(permitted.length||!firstSnapshot)return permitted.length===previous.length&&permitted.every((id:string,index:number)=>id===previous[index])?previous:permitted;
        const first=mapped.find(i=>i.online);return first?[first.id]:[];
      });
      setActive(previous=>{const candidate=firstSnapshot?remembered.current.active??previous:previous;return mapped.some(i=>i.id===candidate)?candidate:(mapped.find(i=>i.online)?.id??'')});
    };
    Promise.all([api<any[]>('/instances'),api('/me/preferences')]).then(([rows,prefs])=>{
      remembered.current=prefs;
      if(prefs.locale==='zh-CN'||prefs.locale==='en-US')setLocale(prefs.locale);
      if(typeof prefs.dark==='boolean')setDark(prefs.dark);
      if(typeof prefs.sidebarCollapsed==='boolean')setSidebarCollapsed(prefs.sidebarCollapsed);
      if(typeof prefs.navbarCollapsed==='boolean')setNavbarCollapsed(prefs.navbarCollapsed);
      if(typeof prefs.split==='boolean')setSplit(prefs.split);
      ready=true;update(rows);setPreferencesLoaded(true);
    }).catch(fail);
    events.addEventListener('instances',event=>{try{if(ready)update(JSON.parse((event as MessageEvent).data))}catch(error){fail(error)}});
    events.onerror=()=>{api('/me').catch(()=>{acceptAccount(null);setInstances([]);setOpened([]);setPanel('login')})};
    return()=>{events.close();setPreferencesLoaded(false)};
  },[account?.email]);

  const [locale,setLocale] = useState(initialLocale);
  const t = (key: MessageKey) => translate(locale,key);
  const [opened,setOpened] = useState<string[]>(preview?['prod']:[]);
  const [active,setActive] = useState(preview?'prod':'');
  const [drawer,setDrawer] = useState(false);
  const [adminOpen,setAdminOpen]=useState(false);
  const [panel,setPanel] = useState<Panel>('');
  const [detail,setDetail] = useState(preview?'prod':'');
  const [dark,setDark] = useState(()=>{try{return localStorage.getItem('gotty-hub.theme')==='dark'}catch{return false}});
  const [split,setSplit] = useState(false);
  const effectiveSplit=split&&!mobile&&opened.length>1;
  const [maximized,setMaximized] = useState(false);
  const [sidebarCollapsed,setSidebarCollapsed] = useState(false);
  const [navbarCollapsed,setNavbarCollapsed] = useState(false);
  useEffect(()=>{
    if(preview||!account||!preferencesLoaded)return;
    const timeout=setTimeout(()=>api('/me/preferences',{opened,active,dark,sidebarCollapsed,navbarCollapsed,split,locale},'PUT').catch(fail),600);
    return()=>clearTimeout(timeout);
  },[account?.email,preferencesLoaded,opened,active,dark,sidebarCollapsed,navbarCollapsed,split,locale]);
  useEffect(()=>{if(opened.length&&!opened.includes(active))setActive(opened[0])},[opened,active]);
  const [terminalStates,setTerminalStates] = useState<Record<string,'red'|'gray'|'yellow'|'green'>>(()=>Object.fromEntries(instances.filter(i=>i.online).map(i=>[i.id,'gray'])));
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!document.querySelector('[role=dialog],dialog[open]'))setMaximized(false)};
    // Only accept status from the registered instance frame and its actual origin.
    const message=(event:MessageEvent)=>{
      if(event.data?.type!=='gotty-favicon'||!['red','gray','yellow','green'].includes(event.data.color))return;
      const frame=Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-instance-id]')).find(frame=>frame.contentWindow===event.source);
      if(!frame||event.origin!==new URL(frame.src,location.href).origin)return;
      const id=frame.dataset.instanceId!;
      setTerminalStates(states=>({...states,[id]:event.data.color}));
    };
    window.addEventListener('keydown',escape);window.addEventListener('message',message);
    return()=>{window.removeEventListener('keydown',escape);window.removeEventListener('message',message)};
  },[]);

  function statusIcon(id:string){
    if(!instances.find(i=>i.id===id)?.online)return <span className="terminal-offline" role="img" aria-label={t('offline')} title={t('offline')}><RiWifiOffLine aria-hidden="true"/></span>;
    const color=(preview?terminalStates[id]:instances.find(i=>i.id===id)?.status)??'gray';
    const label=t(({red:'statusViewing',gray:'statusIdle',yellow:'statusRunning',green:'statusAttention'} as const)[color]);
    return <img className="terminal-status" data-state={color} src={`/gotty-status/${color}.svg`} alt={label} title={label}/>;
  }
  const [notice,setNotice] = useState<MessageKey|null>(null);
  const [email,setEmail] = useState('');
  const [grantEmail,setGrantEmail] = useState('');
  const [grantRole,setGrantRole]=useState<'operator'|'observer'>('operator');
  const [grantRoles,setGrantRoles]=useState<Record<string,string>>({});
  const [authStep,setAuthStep] = useState<'email'|'code'|'reset'>('email');
  const [passwordMode,setPasswordMode] = useState(false);
  const [recovering,setRecovering] = useState(false);
  const [code,setCode] = useState('');
  const [password,setPassword] = useState('');
  const [confirmation,setConfirmation] = useState('');
  const [showPassword,setShowPassword] = useState(false);
  const [error,setError] = useState<MessageKey|null>(null);
  const [grants,setGrants] = useState<Record<string,string[]>>(()=>Object.fromEntries(instances.map(i=>[i.id,['owner@example.com','operator@example.com']])));

  useEffect(()=>{
    document.documentElement.lang=locale;
    document.title=locale==='zh-CN'?'GoTTY Hub · 终端工作台':'GoTTY Hub · Terminal workspace';
    try{localStorage.setItem('gotty-hub.locale',locale)}catch{}
  },[locale]);
  useEffect(()=>{document.documentElement.classList.toggle('dark',dark);try{localStorage.setItem('gotty-hub.theme',dark?'dark':'light')}catch{}},[dark]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(null),4500);return()=>clearTimeout(timer)},[notice]);
  const selected = instances.find(i=>i.id===active)??instances[0];
  const detailInstance = instances.find(i=>i.id===detail)??{id:'',name:'',online:false,role:'observer' as const};
  function open(i:Instance){setApiError('');if(!i.online){setDetail(i.id);showPanel('detail');return}setOpened(a=>a.includes(i.id)?a:[...a,i.id]);setActive(i.id);setDrawer(false)}
  function showPanel(value:Panel){if(value==='account'&&!preview&&account)api<{sessions:{expires:number}[]}>('/me/sessions').then(v=>setSessions(v.sessions)).catch(fail);setApiError('');setNotice(null);setDrawer(false);setPanel(value);setError(null);setPassword('');setConfirmation('');setShowPassword(false);setCode('');setRecovering(false);setAuthStep('email');setPasswordMode(false)}
  function closePanel(){if(!preview&&!account)return;setPanel('');setPassword('');setConfirmation('');setCode('');setError(null)}
  async function savePassword(){
    if(password.length<(preview?8:12)){setError('passwordMissing');return}
    if(password!==confirmation){setError('passwordMismatch');return}
    if(preview){setError(null);setPassword('');setConfirmation('');setNotice('passwordSaved');return}
    setBusy(true);setApiError('');try{acceptAccount(await api<Account>('/me/password',{password},'PUT'));setPassword('');setConfirmation('');closePanel()}catch(error){fail(error)}finally{setBusy(false)}
  }
  async function submitAuth(){
    setError(null);setApiError('');
    if(preview){
      if(authStep==='reset'){savePassword();return}
      if(!validEmail(email)){setError('invalidEmail');return}
      if(passwordMode){if(!password){setError('passwordMissing');return}setPassword('');setNotice('loginDone');return}
      if(authStep==='email'){setAuthStep('code');setNotice('codeSent');return}
      if(code!=='123456'){setError('invalidCode');return}
      if(recovering){setAuthStep('reset');setCode('')}else{setNotice('loginDone');setCode('')}return;
    }
    setBusy(true);try{
      if(!validEmail(email)){setError('invalidEmail');return}
      if(authStep==='reset'){
        if(password.length<12){setError('passwordMissing');return}
        if(password!==confirmation){setError('passwordMismatch');return}
        acceptAccount(await api<Account>('/auth/password/reset',{challenge,code,password}));setPanel('');
      }else if(passwordMode){acceptAccount(await api<Account>('/auth/password/login',{email,password}));setPanel('')}
      else if(authStep==='email'){const v=await api('/auth/otp/request',{email,purpose:recovering?'reset':'login'});setChallenge(v.challenge);setAuthStep('code')}
      else if(recovering){await api('/auth/password/verify-reset',{challenge,code});setAuthStep('reset')}
      else{acceptAccount(await api<Account>('/auth/otp/verify',{challenge,code}));setPanel('')}
    }catch(error){fail(error)}finally{setBusy(false)}
  }
  async function manage(id:string){setDetail(id);setGrantEmail('');showPanel('detail');if(!preview&&instances.find(i=>i.id===id)?.role==='owner'){try{const rows=await api<any[]>(`/instances/${id}/grants`);setGrants(g=>({...g,[id]:rows.map(x=>x.email)}));setGrantRoles(Object.fromEntries(rows.map(x=>[x.email,x.role])))}catch(error){fail(error)}}}
  async function addGrant(){const value=grantEmail.trim();if(!validEmail(value)||(grants[detail]??[]).includes(value)){setNotice('duplicateEmail');return}try{if(!preview)await api(`/instances/${detail}/grants`,{email:value,role:grantRole},'PUT');setGrants(g=>({...g,[detail]:[...(g[detail]??[]),value]}));setGrantRoles(r=>({...r,[value]:grantRole}));setGrantEmail('')}catch(error){fail(error)}}
  async function removeGrant(mail:string){try{if(!preview)await api(`/instances/${detail}/grants/${encodeURIComponent(mail)}`,{},'DELETE');setGrants(g=>({...g,[detail]:g[detail].filter(v=>v!==mail)}))}catch(error){fail(error)}}
  const navigation = <>
    <div className="sidebar-account-heading"><h1 className="text-headline-medium">{preview?t('demoAccount'):account?.email??t('login')}</h1><p className="text-caption-1-regular" dir="ltr">{preview?'owner@example.com':account?.email??''}</p></div>
    <div className="instances-nav-heading"><span className="text-caption-1-regular">{t('registeredInstances')} <span className="nav-count">{instances.length}</span></span><Button variant="ghost" className="quiet-button" iconOnly leadingIcon={RiAddLine} aria-label={t('connect')} onClick={()=>showPanel('connect')}/></div>
    {instances.map(i=><div className="instance-nav-row" key={i.id}><Button variant="ghost" className="nav-item terminal-nav registered-instance" data-active={opened.includes(i.id)&&active===i.id} aria-current={opened.includes(i.id)&&active===i.id?'page':undefined} title={`${i.name} · ${t(i.online?'online':'offline')}`} onClick={()=>open(i)}><span className="session-label">{i.online?statusIcon(i.id):<span className="terminal-offline" role="img" aria-label={t('offline')} title={t('offline')}><RiWifiOffLine aria-hidden="true"/></span>}<span className="instance-nav-name">{i.name}</span></span></Button><Button className="instance-manage quiet-button" variant="ghost" iconOnly leadingIcon={RiSettings3Line} aria-label={`${t('manage')} ${i.name}`} onClick={()=>manage(i.id)}/></div>)}

  </>;
  function terminal(i:Instance){if(!preview)return <RealTerminal key={i.id} id={i.id} writable={i.role!=='observer'&&i.capabilities?.write===true} asr={i.capabilities?.asr===true} visible={active===i.id||(effectiveSplit&&opened.find(id=>id!==active)===i.id)} locale={locale}/>;return <section className="terminal-panel dark" key={i.id}>
    <div className="terminal-heading text-caption-1-regular"><span className="terminal-host"><span className="status-dot"/>{i.host}</span><span>{t(i.role==='observer'?'readOnly':'writable')} · {t('demo')}</span></div>
    <div className="terminal-output" dir="ltr"><p className="text-text-tertiary">{t('connectedDemo')}</p><p className="text-text-tertiary">{t('terminalPreview')}</p><br/><p><span className="terminal-prompt">{i.host}</span><span className="text-text-tertiary"> ~ % </span>gotty --version</p><p>GoTTY · web terminal</p><br/><p><span className="terminal-prompt">{i.host}</span><span className="text-text-tertiary"> ~ % </span><span className="cursor"/></p></div>
    <div className="terminal-keys">{['Esc','Ctrl','Tab','↑','↓','←','→','⌨'].map(k=><Button key={k} variant="secondary" onClick={()=>setNotice('keyNotice')}>{k}</Button>)}</div>
  </section>}
  const passwordFields = <><div className="password-field"><Input label={t('newPassword')} type={showPassword?'text':'password'} autoComplete="new-password" value={password} onChange={v=>{setPassword(v);setError(null)}}/><Button className="password-toggle quiet-button" variant="ghost" iconOnly leadingIcon={showPassword?RiEyeOffLine:RiEyeLine} aria-label={t(showPassword?'hidePassword':'showPassword')} onClick={()=>setShowPassword(!showPassword)}/></div><Input label={t('confirmPassword')} type={showPassword?'text':'password'} autoComplete="new-password" value={confirmation} onChange={v=>{setConfirmation(v);setError(null)}}/></>;
  const errorMessage = (error||apiError)&&<p className="text-body-regular text-text-error-primary" role="alert">{error?t(error):apiError}</p>;
  return <DirectionProvider locale={locale}><div className={cx("app",maximized&&"workspace-maximized",sidebarCollapsed&&"sidebar-collapsed",navbarCollapsed&&"navbar-collapsed")}>
    <aside className="sidebar">{navigation}</aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumb"><Button className="mobile-menu quiet-button" variant="ghost" iconOnly leadingIcon={RiMenuLine} aria-label={t('menu')} onClick={()=>setDrawer(true)}/></div><div className="topbar-actions">{preview&&<span className="prototype-label text-caption-1-regular">{t('prototype')}</span>}<Button className="quiet-button language-button" variant="ghost" leadingIcon={RiTranslate2} aria-label={t('language')} onClick={()=>setLocale(locale==='zh-CN'?'en-US':'zh-CN')}>{locale==='zh-CN'?'EN':'中文'}</Button><Button className="quiet-button" variant="ghost" iconOnly leadingIcon={dark?RiSunLine:RiMoonLine} aria-label={t('theme')} onClick={()=>setDark(!dark)}/><span className="toolbar-divider"/>{(preview||!account)&&<Button className="login-button" variant="secondary" onClick={()=>showPanel('login')}>{t('login')}</Button>}<Button className="quiet-button account-settings-button" variant="ghost" iconOnly leadingIcon={RiSettings3Line} aria-label={t('account')} title={t('account')} onClick={()=>showPanel('account')}/></div></header>
      <div className="workspace"><div className="terminal-tabs"><div className="chrome-controls"><Button className="quiet-button sidebar-toggle" variant="ghost" iconOnly leadingIcon={RiSideBarLine} aria-label={t(sidebarCollapsed?'expandSidebar':'collapseSidebar')} title={t(sidebarCollapsed?'expandSidebar':'collapseSidebar')} aria-expanded={!sidebarCollapsed} onClick={()=>setSidebarCollapsed(!sidebarCollapsed)}/><Button className="quiet-button mobile-menu" variant="ghost" iconOnly leadingIcon={RiMenuLine} aria-label={t('menu')} onClick={()=>setDrawer(true)}/></div><div className="session-tabs-scroll">{opened.map(id=><div key={id} className={cx('session-tab',active===id&&'selected')}><Button className="quiet-button" variant="ghost" onClick={()=>setActive(id)}><span className="session-label">{statusIcon(id)}{instances.find(i=>i.id===id)!.name}</span></Button><Button className="quiet-button" variant="ghost" iconOnly leadingIcon={RiCloseLine} aria-label={`${t('closeTab')} ${instances.find(i=>i.id===id)!.name}`} onClick={()=>{const next=opened.filter(v=>v!==id);setOpened(next);if(active===id){setActive(next[0]??'')}}}/></div>)}<Button className="quiet-button" variant="ghost" iconOnly leadingIcon={RiAddLine} aria-label={t('connect')} onClick={()=>showPanel('connect')}/></div><div className="workspace-actions"><Button className="quiet-button navbar-toggle" variant="ghost" iconOnly leadingIcon={RiLayoutTopLine} aria-label={t(navbarCollapsed?'expandNavbar':'collapseNavbar')} title={t(navbarCollapsed?'expandNavbar':'collapseNavbar')} aria-expanded={!navbarCollapsed} onClick={()=>setNavbarCollapsed(!navbarCollapsed)}/><Button className="split-button quiet-button" variant="ghost" disabled={opened.length<2} onClick={()=>setSplit(!split)}>{t(split?'single':'split')}</Button><Button className="maximize-button quiet-button" variant="ghost" iconOnly leadingIcon={maximized?RiCollapseDiagonalLine:RiExpandDiagonalLine} aria-label={t(maximized?'restoreWorkspace':'maximizeWorkspace')} title={t(maximized?'restoreWorkspace':'maximizeWorkspace')} aria-pressed={maximized} onClick={()=>setMaximized(!maximized)}/></div></div><div className={cx('terminals',effectiveSplit&&'split')}>{opened.length?opened.map(id=>{const instance=instances.find(i=>i.id===id);return instance&&<div key={id} className="terminal-slot" hidden={id!==active&&!(effectiveSplit&&opened.find(v=>v!==active)===id)}>{instance.online?terminal(instance):<div className="terminal-empty">{t('offline')}</div>}</div>}):<div className="terminal-empty text-body-regular">{t('noOpenTerminals')}</div>}</div><footer className="workspace-footer text-caption-1-regular"><span>{preview?t('demoConnection'):selected?t(selected.online?'online':'offline'):''} · {selected?t(selected.role):''}</span><span>{t('closeHint')}</span></footer></div>
    </main>
    <Drawer isOpen={drawer} onOpenChange={setDrawer} placement="start"><DrawerHeader title={t('switchInstance')} closeLabel={t('close')}/><DrawerBody><div className="mobile-navigation">{navigation}</div></DrawerBody></Drawer>
    <Modal isOpen={panel==='login'||panel==='account'} onOpenChange={v=>{if(!v)closePanel()}} size="md" className="auth-modal" overlayClassName="auth-overlay">
      <ModalHeader title={t(panel==='account'?'account':recovering?'resetTitle':'loginTitle')} description={t(panel==='account'?'changeDescription':recovering?'resetDescription':'loginDescription')} closeLabel={t('close')}/>
      <ModalBody><form className="auth-form" onSubmit={e=>{e.preventDefault();if(!busy){if(panel==='account')savePassword();else submitAuth()}}}>
        {panel==='account'?<>{account?.is_admin&&<Button variant="secondary" onClick={()=>{closePanel();setAdminOpen(true)}}>{locale==='zh-CN'?'管理后台':'Administration'}</Button>}<div className="account-identity"><span className="avatar">{preview?'D':account?.email.slice(0,1).toUpperCase()}</span><div className="min-w-0"><p className="text-body-medium">{preview?t('demoAccount'):account?.email}</p><p className="text-caption-1-regular text-text-secondary">{preview?'owner@example.com':account?.email??''}</p></div></div>{passwordFields}<p className="text-caption-1-regular text-text-secondary">{t('passwordHint')}</p>{errorMessage}<Button className="primary-action auth-submit" disabled={busy} type="submit">{t('setPassword')}</Button><Button className="quiet-button" variant="ghost" onClick={()=>{showPanel('login');setRecovering(true)}}>{t('forgot')}</Button>{!preview&&<><p className="text-caption-1-regular">{t('activeSessions')}: {sessions.length}</p><Button variant="secondary" onClick={async()=>{try{await api('/me/sessions',{},'DELETE');acceptAccount(null);setInstances([]);setOpened([]);setPanel('login')}catch(error){fail(error)}}}>{t('signOutAll')}</Button></>}{!preview&&<Button variant="secondary" onClick={async()=>{try{await api('/auth/logout',{});acceptAccount(null);setInstances([]);setOpened([]);setPanel('login')}catch(error){fail(error)}}}>{t('signOut')}</Button>}</>:<>
          {authStep==='reset'?passwordFields:<><Input label={t('email')} type="email" autoComplete="email" value={email} onChange={v=>{setEmail(v);setError(null)}} isReadOnly={authStep==='code'} isRequired/>{passwordMode?<div className="password-field"><Input label={t('password')} type={showPassword?'text':'password'} autoComplete="current-password" value={password} onChange={v=>{setPassword(v);setError(null)}}/><Button className="password-toggle quiet-button" variant="ghost" iconOnly leadingIcon={showPassword?RiEyeOffLine:RiEyeLine} aria-label={t(showPassword?'hidePassword':'showPassword')} onClick={()=>setShowPassword(!showPassword)}/></div>:authStep==='code'?<Input label={t('code')} autoComplete="one-time-code" value={code} onChange={v=>{setCode(v);setError(null)}} hint={preview?t('codeHint'):t('realCodeHint')}/>:null}</>}
          {errorMessage}<Button className="primary-action auth-submit" disabled={busy} type="submit" trailingIcon={RiArrowRightLine}>{t(authStep==='reset'?'setPassword':passwordMode?'login':authStep==='email'?'getCode':'verify')}</Button>
          {!recovering&&<div className="auth-links"><Button variant="ghost" className="quiet-button" onClick={()=>{setPasswordMode(!passwordMode);setAuthStep('email');setError(null);setPassword('');setCode('')}}>{t(passwordMode?'useCode':'usePassword')}</Button><Button variant="ghost" className="quiet-button" onClick={()=>{setPasswordMode(false);setRecovering(true);setAuthStep('email');setError(null);setPassword('')}}>{t('forgot')}</Button></div>}
          {(recovering||authStep==='code')&&<Button variant="ghost" className="quiet-button" leadingIcon={RiArrowLeftLine} onClick={()=>{setRecovering(false);setAuthStep('email');setCode('');setError(null);setPassword('');setConfirmation('')}}>{t('backLogin')}</Button>}
        </>}
        {preview&&<p className="auth-footnote text-caption-1-regular">{t('demoAuth')}</p>}
      </form></ModalBody>
    </Modal>
    <Modal isOpen={panel==='connect'} onOpenChange={v=>{if(!v)closePanel()}} size="md" className="auth-modal" overlayClassName="auth-overlay"><ModalHeader title={t('connectTitle')} closeLabel={t('close')}/><ModalBody><div className="panel-content"><p className="text-body-regular text-text-secondary">{t('connectDescription')}</p><ol className="connect-steps">{(['stepOne','stepTwo','stepThree'] as const).map((key,index)=><li key={key}><span className="step-number text-caption-1-regular">0{index+1}</span><span className="text-body-regular">{t(key)}</span></li>)}</ol><Input label={t('hubAddress')} value={account?.hub_address??location.origin} isReadOnly/><p className="text-caption-1-regular text-text-secondary">{t(preview?'connectHint':'realConnectHint')}</p><Button className="primary-action" onClick={closePanel}>{t('done')}</Button></div></ModalBody></Modal>
    <Drawer isOpen={panel==='detail'} onOpenChange={v=>{if(!v)closePanel()}} placement="end" size="md"><DrawerHeader title={t(panel==='detail'?'instanceDetails':'connectTitle')} closeLabel={t('close')}/><DrawerBody><div className="panel-content">
      <><div className="detail-banner"><RiTerminalBoxLine size={24}/><div className="min-w-0"><h2 className="text-headline-medium break-all">{detailInstance.name}</h2><p className="text-caption-1-regular text-text-secondary">{t(detailInstance.online?'online':'waiting')}</p><p className="text-caption-1-regular">{t(detailInstance.role)}</p></div></div>{(preview||detailInstance.role==='owner')&&<><h3 className="text-body-medium">{t('authorizedEmails')}</h3>{(grants[detail]??[]).map((g,index)=><div className="grant" key={g}><div className="min-w-0"><div className="text-body-regular truncate" dir="ltr">{g}</div><div className="text-caption-1-regular text-text-secondary">{t(preview?(index===0?'owner':'operator'):(grantRoles[g]??'operator') as 'owner'|'operator'|'observer')}</div></div>{(preview?index!==0:grantRoles[g]!=='owner')&&<Button className="quiet-button" variant="ghost" aria-label={`${t('remove')} ${g}`} onClick={()=>removeGrant(g)}>{t('remove')}</Button>}</div>)}<Input label={t('addEmail')} type="email" value={grantEmail} onChange={setGrantEmail} placeholder="member@example.com"/><div className="grant-role-controls"><Button variant="ghost" aria-pressed={grantRole==='operator'} onClick={()=>setGrantRole('operator')}>{t('operator')}</Button><Button variant="ghost" aria-pressed={grantRole==='observer'} onClick={()=>setGrantRole('observer')}>{t('observer')}</Button></div><Button variant="secondary" className="neutral-button" onClick={addGrant}>{t(grantRole==='operator'?'addOperator':'addObserver')}</Button>{errorMessage}{preview&&<p className="text-caption-1-regular text-text-secondary">{t('grantHint')}</p>}{!preview&&<Button variant="secondary" onClick={async()=>{try{await api(`/instances/${detail}/credentials/rotate`,{});closePanel()}catch(error){fail(error)}}}>{t('rotateDevice')}</Button>}{!preview&&<Button variant="danger" onClick={async()=>{try{await api(`/instances/${detail}/binding`,{},'DELETE');closePanel()}catch(error){fail(error)}}}>{t('unbind')}</Button>}</>}</>
    </div></DrawerBody></Drawer>
    {account?.is_admin&&<AdminPanel open={adminOpen} onClose={()=>setAdminOpen(false)} locale={locale}/>}
    {notice&&<div className="notice text-body-regular" role="status">{t(notice)}</div>}
  </div></DirectionProvider>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

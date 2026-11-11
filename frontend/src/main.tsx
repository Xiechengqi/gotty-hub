import React, { useCallback, useEffect, useLayoutEffect, useState, useRef, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { RiTerminalBoxLine, RiEyeLine, RiEyeOffLine, RiArrowRightLine, RiWifiOffLine } from '@remixicon/react';
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
import {type SettingsAction} from './SettingsMenu';
import {errorText} from './errors';
import {RealTerminal, type TerminalActions} from './terminal/Terminal';
import {TerminalSettings} from './terminal/TerminalSettings';
import {useTerminalSettings} from './terminal/useTerminalSettings';
import {readAppearance} from './terminal/appearance';
import {type SettingsSnapshot} from './terminal/settings';
import {type Appearance} from '@gotty/terminal-core/appearance';
import {normalizeOrder} from './instances/order';
import {WorkspaceBar} from './workspace/WorkspaceBar';
import {readLayout, rememberPinned, restorePinned, acknowledgeLayout, readWorkspaceCache, rememberWorkspace, restoreWorkspace, acknowledgeWorkspace} from './layout';
import {emptyWorkspace, workspaceReducer, saveWorkspace, clampRatio, MIN_PANE_WIDTH, DIVIDER_WIDTH, activeSplit, type Workspace, type WorkspaceAction} from './workspace/state';
import {SplitDivider, type PaneInstance} from './workspace/WorkspaceControls';

type Group = 'production' | 'development' | 'personal';
type Instance = { status?: 'red'|'gray'|'yellow'|'green'; capabilities?: {write?:boolean;files?:boolean;asr?:boolean;controls?:boolean}; id: string; name: string; description: MessageKey; group: Group; online: boolean; role: 'owner' | 'operator' | 'observer'; host: string };
type Panel = '' | 'login' | 'password' | 'logout' | 'detail' | 'connect';
const demoInstances: Instance[] = [
  { id:'prod', name:'production-api', description:'prodDescription', group:'production', online:true, role:'owner', host:'ubuntu@api-01' },
  { id:'dev', name:'dev-workspace', description:'devDescription', group:'development', online:true, role:'operator', host:'developer@workspace' },
  { id:'build', name:'build-runner', description:'buildDescription', group:'development', online:true, role:'observer', host:'runner@build-02' },
  { id:'home', name:'home-server', description:'homeDescription', group:'personal', online:false, role:'owner', host:'user@home' },
  { id:'staging', name:'staging-preview', description:'stagingDescription', group:'production', online:true, role:'operator', host:'deploy@staging' },
];
const validUsername = (value: string) => /^[a-z0-9][a-z0-9_.-]{2,63}$/i.test(value.trim());
const passwordBytes = (value:string) => new TextEncoder().encode(value).length;

const preview=new URLSearchParams(location.search).get('preview')==='1';
function App() {
  useLayoutEffect(()=>window.hubBoot?.complete(),[]);
  const [instances,setInstances]=useState<Instance[]>(preview?demoInstances:[]);
  const [account,setAccount]=useState<Account|null>(null);
  const terminalPreferences = useTerminalSettings(account?.id);
  const [previewSettings, setPreviewSettings] = useState<SettingsSnapshot>({revision: 0, settings: null});
  const displaySnapshot = preview ? previewSettings : terminalPreferences.snapshot;
  const [terminalSettingsOpen, setTerminalSettingsOpen] = useState(false);
  const reportedAppearance = useRef<Record<string, Appearance>>({});
  useEffect(() => {setTerminalSettingsOpen(false); reportedAppearance.current = {};}, [account?.id]);
  const [busy,setBusy]=useState(false);
  const [preferencesLoaded,setPreferencesLoaded]=useState(false);
  const [authLoading,setAuthLoading]=useState(!preview);
  const activeAccount=useRef<string|null>(null);
  const [workspace,setWorkspace]=useState<Workspace>(()=>preview?{opened:['prod'],order:demoInstances.map(i=>i.id),active:'prod',groups:[]}:emptyWorkspace());
  const order=normalizeOrder(workspace.order,instances.map(i=>i.id));
  const orderedInstances=order.map(id=>instances.find(i=>i.id===id)!);
  const [terminalActions,setTerminalActions]=useState<Record<string,TerminalActions>>({});
  const registerActions=useCallback((id:string,actions:TerminalActions|undefined)=>setTerminalActions(previous=>{
    const next={...previous};if(actions)next[id]=actions;else delete next[id];return next;
  }),[]);
  const workspaceRef=useRef(workspace);
  const workspaceReady=useRef(preview);
  const changeWorkspace=useCallback((action:WorkspaceAction,persist=true)=>{
    const next=workspaceReducer(workspaceRef.current,action);
    if(next===workspaceRef.current)return;
    workspaceRef.current=next;
    if(persist&&workspaceReady.current&&activeAccount.current&&!preview)rememberWorkspace(activeAccount.current,next);
    setWorkspace(next);
  },[]);
  const focusSequence=useRef(0);
  const [focusTarget,setFocusTarget]=useState<{id:string;request:number}|null>(null);
  const requestTerminalFocus=useCallback((id:string)=>{if(id)setFocusTarget({id,request:++focusSequence.current});},[]);
  const focusHandled=useCallback((id:string,request:number)=>setFocusTarget(current=>current?.id===id&&current.request===request?null:current),[]);
  useEffect(()=>{
    if(!focusTarget)return;
    const timeout=setTimeout(()=>focusHandled(focusTarget.id,focusTarget.request),1600);
    return()=>clearTimeout(timeout);
  },[focusTarget,focusHandled]);
  const preferenceWrites=useRef<Promise<unknown>>(Promise.resolve());
  const preferenceRevision=useRef(0);
  const remembered=useRef<any>({});
  const [apiError,setApiError]=useState('');
  const [sessions,setSessions]=useState<{expires:number}[]>([]);
  const [mobile,setMobile]=useState(()=>matchMedia('(max-width: 767px)').matches);
  useEffect(()=>{const query=matchMedia('(max-width: 767px)');const update=()=>setMobile(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update)},[]);
  // Track the visual viewport app-wide so the workspace stays correctly sized
  // when mobile browser chrome collapses, even before any terminal mounts.
  const applyViewportHeight=useCallback((height:number)=>{document.documentElement.style.setProperty('--hub-viewport-height',`${height}px`)},[]);
  useEffect(()=>{
    const vv=window.visualViewport;if(!vv)return;
    const update=()=>applyViewportHeight(vv.height);
    update();vv.addEventListener('resize',update);return()=>vv.removeEventListener('resize',update);
  },[applyViewportHeight]);
  function acceptAccount(value:Account|null){
    if(activeAccount.current!==(value?.id??null)){
      preferenceRevision.current++;
      workspaceReady.current=false;
      setPreferencesLoaded(false);setInstances([]);changeWorkspace({type:'restore',value:emptyWorkspace()},false);setFocusTarget(null);setTerminalActions({});remembered.current={};
      setPinnedState(value?readLayout(value.id)?.pinned??true:true);
    }
    activeAccount.current=value?.id??null;useAccount(value);setAccount(value);setAuthLoading(false);
  }
  function fail(error:unknown){setApiError(errorText(error instanceof Error?error.message:String(error),locale))}
  useEffect(()=>{
    if(preview)return;
    api<Account>('/me').then(acceptAccount).catch(()=>{setAuthLoading(false);setPanel('login')});
  },[]);
  useEffect(()=>{
    if(preview||!account)return;
    const events=new EventSource('/api/v1/events');
    let initialized=false;let ready=false;let disposed=false;
    const update=(rows:any[])=>{
      const mapped:Instance[]=rows.map(i=>({...i,host:i.name,description:'terminalPreview',group:'personal'}));
      setInstances(mapped);
      const firstSnapshot=!initialized;initialized=true;
      if(firstSnapshot){
        const restored=restoreWorkspace(account.id,remembered.current,mapped.map(i=>i.id),mapped.find(i=>i.online)?.id);
        changeWorkspace({type:'restore',value:restored},false);workspaceReady.current=true;
        requestTerminalFocus(restored.active);
      }else changeWorkspace({type:'reconcile',available:mapped.map(i=>i.id)});
    };
    Promise.all([api<any[]>('/instances'),api('/me/preferences')]).then(([rows,prefs])=>{
      if(disposed)return;
      remembered.current=prefs;
      if(prefs.locale==='zh-CN'||prefs.locale==='en-US')setLocale(prefs.locale);
      if(typeof prefs.dark==='boolean')setDark(prefs.dark);
      setPinnedState(restorePinned(account.id,prefs.toolbarPinned,prefs.maximized));
      ready=true;update(rows);setPreferencesLoaded(true);
    }).catch(error=>{if(!disposed)fail(error)});
    events.addEventListener('instances',event=>{try{if(ready)update(JSON.parse((event as MessageEvent).data))}catch(error){fail(error)}});
    events.onerror=()=>{if(!disposed)api('/me').catch(()=>{if(!disposed){acceptAccount(null);setPanel('login')}})};
    return()=>{disposed=true;events.close();workspaceReady.current=false;setPreferencesLoaded(false)};
  },[account?.id]);

  const [locale,setLocale] = useState(initialLocale);
  const t = (key: MessageKey) => translate(locale,key);
  const opened=workspace.opened;
  const [adminOpen,setAdminOpen]=useState(false);
  const [panel,setPanel] = useState<Panel>('');
  const [detail,setDetail] = useState(preview?'prod':'');
  const [dark,setDark] = useState(()=>{try{return localStorage.getItem('gotty-hub.theme')==='dark'}catch{return false}});
  const terminalsRef=useRef<HTMLDivElement>(null);
  const [workspaceWidth,setWorkspaceWidth]=useState(0);
  useLayoutEffect(()=>{
    const element=terminalsRef.current;if(!element)return;
    const measure=()=>setWorkspaceWidth(element.clientWidth);
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[]);
  const canSplit=!mobile&&workspaceWidth>=MIN_PANE_WIDTH*2+DIVIDER_WIDTH;
  const split=activeSplit(workspace);
  const effectiveSplit=!!split&&canSplit;
  const active=workspace.active;
  const visibleIds=new Set(effectiveSplit?[split!.left,split!.right]:[active]);
  const minimumRatio=workspaceWidth>DIVIDER_WIDTH?Math.min(0.5,Math.max(0.1,MIN_PANE_WIDTH/(workspaceWidth-DIVIDER_WIDTH))):0.5;
  const splitRatio=clampRatio(split?.ratio??0.5,minimumRatio);
  const previousSplit=useRef(effectiveSplit);
  useEffect(()=>{
    const changed=previousSplit.current!==effectiveSplit;previousSplit.current=effectiveSplit;
    if(changed&&workspaceReady.current&&document.hasFocus()&&(document.activeElement===document.body||document.activeElement?.closest('.terminal-slot')))requestTerminalFocus(active);
  },[effectiveSplit,active,requestTerminalFocus]);
  const [pinned,setPinnedState] = useState(true);
  const setPinned=useCallback((value:boolean)=>{
    if(account)rememberPinned(account.id,value);
    setPinnedState(value);
  },[account?.id]);
  useEffect(()=>{
    if(preview||!account||!preferencesLoaded)return;
    const id=account.id;
    const saveRevision=++preferenceRevision.current;
    const revision=readLayout(id)?.revision;
    const workspaceRevision=readWorkspaceCache(id)?.revision;
    const preferences={...remembered.current,opened:workspace.order.filter(id=>opened.includes(id)),instanceOrder:workspace.order,active,dark,sidebarCollapsed:true,navbarCollapsed:true,split:!!split,workspace:saveWorkspace(workspace),toolbarPinned:pinned,maximized:!pinned,locale};
    const timeout=setTimeout(()=>{
      preferenceWrites.current=preferenceWrites.current.catch(()=>{}).then(async()=>{
        if(activeAccount.current!==id||preferenceRevision.current!==saveRevision)return;
        await api('/me/preferences',preferences,'PUT');
        acknowledgeLayout(id,revision,pinned);
        acknowledgeWorkspace(id,workspaceRevision,workspace);
      }).catch(error=>{if(activeAccount.current===id)fail(error)});
    },600);
    return()=>clearTimeout(timeout);
  },[account?.id,preferencesLoaded,workspace,active,dark,pinned,locale]);
  const [terminalStates,setTerminalStates] = useState<Record<string,'red'|'gray'|'yellow'|'green'>>(()=>Object.fromEntries(instances.filter(i=>i.online).map(i=>[i.id,'gray'])));
  useEffect(()=>{
    // Only accept status from the registered instance frame and its actual origin.
    const message=(event:MessageEvent)=>{
      if(event.data?.type!=='gotty-favicon'||!['red','gray','yellow','green'].includes(event.data.color))return;
      const frame=Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-instance-id]')).find(frame=>frame.contentWindow===event.source);
      if(!frame||event.origin!==new URL(frame.src,location.href).origin)return;
      const id=frame.dataset.instanceId!;
      setTerminalStates(states=>({...states,[id]:event.data.color}));
    };
    window.addEventListener('message',message);
    return()=>{window.removeEventListener('message',message)};
  },[]);

  function statusIcon(id:string){
    if(!instances.find(i=>i.id===id)?.online)return <span className="terminal-offline" role="img" aria-label={t('offline')} title={t('offline')}><RiWifiOffLine aria-hidden="true"/></span>;
    const color=(preview?terminalStates[id]:instances.find(i=>i.id===id)?.status)??'gray';
    const label=t(({red:'statusViewing',gray:'statusIdle',yellow:'statusRunning',green:'statusAttention'} as const)[color]);
    return <img className="terminal-status" data-state={color} src={`/gotty-status/${color}.svg`} alt={label} title={label}/>;
  }
  const [notice,setNotice] = useState<MessageKey|null>(null);
  const [username,setUsername] = useState('');
  const [grantUsername,setGrantUsername] = useState('');
  const [grantRole,setGrantRole]=useState<'operator'|'observer'>('operator');
  const [grantRoles,setGrantRoles]=useState<Record<string,string>>({});
  const [authMode,setAuthMode] = useState<'login'|'register'|'recover'>(()=>new URLSearchParams(location.search).get('auth')==='register'?'register':'login');
  const [password,setPassword] = useState('');
  const [confirmation,setConfirmation] = useState('');
  const [showPassword,setShowPassword] = useState(false);
  const [error,setError] = useState<MessageKey|null>(null);
  const [grants,setGrants] = useState<Record<string,string[]>>(()=>Object.fromEntries(instances.map(i=>[i.id,['owner','operator']])));

  useEffect(()=>{
    document.documentElement.lang=locale;
    document.title=locale==='zh-CN'?'GoTTY Hub · 终端工作台':'GoTTY Hub · Terminal workspace';
    try{localStorage.setItem('gotty-hub.locale',locale)}catch{}
  },[locale]);
  useEffect(()=>{document.documentElement.classList.toggle('dark',dark);try{localStorage.setItem('gotty-hub.theme',dark?'dark':'light')}catch{}},[dark]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(null),4500);return()=>clearTimeout(timer)},[notice]);
  const detailInstance = instances.find(i=>i.id===detail)??{id:'',name:'',online:false,role:'observer' as const};
  function activateInstance(id:string,focus=true){changeWorkspace({type:'select',id});if(focus)requestTerminalFocus(id);}
  function focusPane(id:string){if(visibleIds.has(id))changeWorkspace({type:'focus',id});}
  function closeTerminal(id:string){
    const next=workspaceReducer(workspaceRef.current,{type:'close',id});
    const pair=activeSplit(workspaceRef.current);const wasActive=active===id||!!pair&&[pair.left,pair.right].includes(id);
    changeWorkspace({type:'restore',value:next});if(wasActive)requestTerminalFocus(next.active);
  }
  function open(i:Instance){setApiError('');if(!i.online){setDetail(i.id);showPanel('detail');return}activateInstance(i.id)}
  function showPanel(value:Panel){if(value==='logout'&&!preview&&account)api<{sessions:{expires:number}[]}>('/me/sessions').then(v=>setSessions(v.sessions)).catch(fail);setApiError('');setNotice(null);setPanel(value);setError(null);setPassword('');setConfirmation('');setShowPassword(false);setAuthMode('login')}
  function closePanel(){if(!preview&&!account)return;setPanel('');setPassword('');setConfirmation('');setError(null)}
  async function savePassword(){
    if(passwordBytes(password)<(account?.is_admin?1:12)||passwordBytes(password)>256||!password.trim()){setError('passwordMissing');return}
    if(password!==confirmation){setError('passwordMismatch');return}
    if(preview){closePanel();setNotice('passwordSaved');return}
    setBusy(true);setApiError('');try{acceptAccount(await api<Account>('/me/password',{password},'PUT'));setPassword('');setConfirmation('');closePanel()}catch(error){fail(error)}finally{setBusy(false)}
  }
  async function signOut(path:string,method?:string){
    if(preview){closePanel();setNotice('signOutPreview');return}
    setBusy(true);setApiError('');
    try{await api(path,{},method);acceptAccount(null);setInstances([]);setAuthMode('login');setPanel('login')}catch(error){fail(error)}finally{setBusy(false)}
  }
  function settings(action:SettingsAction){if(action==='terminal'){setTerminalSettingsOpen(true)}else if(action==='console'){setApiError('');setAdminOpen(true)}else showPanel(action)}
  async function submitAuth(){
    setError(null);setApiError('');
    if(!validUsername(username)){setError('invalidUsername');return}
    if(!password.trim()||passwordBytes(password)>256||(authMode==='register'&&passwordBytes(password)<12)){setError('passwordMissing');return}
    if(preview){setNotice('loginDone');setPassword('');return}
    setBusy(true);
    try{
      const value=await api<Account>(authMode==='register'?'/auth/register':'/auth/password/login',{username:username.trim(),password});
      acceptAccount(value);setPanel('');setPassword('');
      const url=new URL(location.href);url.searchParams.delete('auth');history.replaceState(null,'',url);
    }catch(error){fail(error)}finally{setBusy(false)}
  }
  async function manage(id:string){setDetail(id);setGrantUsername('');showPanel('detail');if(!preview&&instances.find(i=>i.id===id)?.role==='owner'){try{const rows=await api<any[]>(`/instances/${id}/grants`);setGrants(g=>({...g,[id]:rows.map(x=>x.username)}));setGrantRoles(Object.fromEntries(rows.map(x=>[x.username,x.role])))}catch(error){fail(error)}}}
  async function addGrant(){const value=grantUsername.trim().toLowerCase();if(!validUsername(value)||(grants[detail]??[]).includes(value)){setNotice('duplicateUsername');return}try{if(!preview)await api(`/instances/${detail}/grants`,{username:value,role:grantRole},'PUT');setGrants(g=>({...g,[detail]:[...(g[detail]??[]),value]}));setGrantRoles(r=>({...r,[value]:grantRole}));setGrantUsername('')}catch(error){fail(error)}}
  async function removeGrant(name:string){try{if(!preview)await api(`/instances/${detail}/grants/${encodeURIComponent(name)}`,{},'DELETE');setGrants(g=>({...g,[detail]:g[detail].filter(v=>v!==name)}))}catch(error){fail(error)}}
  function terminal(i:Instance){if(!preview)return <RealTerminal key={i.id} id={i.id} writable={i.role!=='observer'&&i.capabilities?.write===true} asr={i.capabilities?.asr===true} files={i.capabilities?.files===true} owner={i.role==='owner'} controls={i.capabilities?.controls===true} onManage={()=>void manage(i.id)} onActions={registerActions} visible={visibleIds.has(i.id)} focusRequest={focusTarget?.id===i.id?focusTarget.request:0} onFocusHandled={focusHandled} locale={locale} onViewport={applyViewportHeight} settings={displaySnapshot.settings} instanceName={i.name} onAppearance={value => {reportedAppearance.current[i.id] = value;}}/>;return <section className="terminal-panel dark" key={i.id}>
    <div className="terminal-heading text-caption-1-regular"><span className="terminal-host"><span className="status-dot"/>{i.host}</span><span>{t(i.role==='observer'?'readOnly':'writable')} · {t('demo')}</span></div>
    <div className="terminal-output" dir="ltr"><p className="text-text-tertiary">{t('connectedDemo')}</p><p className="text-text-tertiary">{t('terminalPreview')}</p><br/><p><span className="terminal-prompt">{i.host}</span><span className="text-text-tertiary"> ~ % </span>gotty --version</p><p>GoTTY · web terminal</p><br/><p><span className="terminal-prompt">{i.host}</span><span className="text-text-tertiary"> ~ % </span><span className="cursor"/></p></div>
    <div className="terminal-keys">{['Esc','Ctrl','Tab','↑','↓','←','→','⌨'].map(k=><Button key={k} variant="secondary" onClick={()=>setNotice('keyNotice')}>{k}</Button>)}</div>
  </section>}
  function paneInstance(i:Instance):PaneInstance{
    const duplicate=instances.some(other=>other.id!==i.id&&other.name===i.name);
    return {id:i.id,name:i.name,label:duplicate?i.name+' · '+i.id.slice(0,8):i.name,online:i.online,writable:i.role!=='observer'&&(preview||i.capabilities?.write===true),icon:statusIcon(i.id)};
  }
  const passwordFields = <><div className="password-field"><Input label={t('newPassword')} type={showPassword?'text':'password'} autoComplete="new-password" value={password} onChange={v=>{setPassword(v);setError(null)}}/><Button className="password-toggle quiet-button" variant="ghost" iconOnly leadingIcon={showPassword?RiEyeOffLine:RiEyeLine} aria-label={t(showPassword?'hidePassword':'showPassword')} onClick={()=>setShowPassword(!showPassword)}/></div><Input label={t('confirmPassword')} type={showPassword?'text':'password'} autoComplete="new-password" value={confirmation} onChange={v=>{setConfirmation(v);setError(null)}}/></>;
  const errorMessage = (error||apiError)&&<p className="text-body-regular text-text-error-primary" role="alert">{error?t(error):apiError}</p>;
  return <DirectionProvider locale={locale}><div className={cx("app",!pinned&&"chrome-unpinned",(authLoading||!!account&&(!preferencesLoaded||terminalPreferences.loading))&&"workspace-loading")}>
    <div className="workspace-loading-status text-body-regular" role="status">{apiError || (locale==='zh-CN'?'正在加载工作区…':'Loading workspace…')}{apiError&&<Button variant="secondary" onClick={()=>location.reload()}>{t('refreshPage')}</Button>}</div>
    <main className="main">
      <WorkspaceBar key={account?.id||'preview'} workspace={workspace} instances={orderedInstances.map(paneInstance)} actions={terminalActions} locale={locale} mobile={mobile} pinned={pinned} onPin={setPinned} canSplit={canSplit}
        locked={!!panel||adminOpen||terminalSettingsOpen||Object.values(terminalActions).some(actions=>actions.dialogOpen)} dark={dark} onDark={()=>setDark(!dark)} onLocale={()=>setLocale(locale==='zh-CN'?'en-US':'zh-CN')}
        accountName={preview?t('demoAccount'):account?.username} admin={!!account?.is_admin} authenticated={preview||!!account} onLogin={()=>showPanel('login')} onSettings={settings}
        onSelect={activateInstance} onBrowseSelect={id=>{const instance=instances.find(i=>i.id===id);if(instance)open(instance);}} onManage={id=>void manage(id)} onConnect={()=>showPanel('connect')}
        onChange={changeWorkspace} onClose={closeTerminal} onFocus={()=>requestTerminalFocus(workspaceRef.current.active)}/>
      <div className="workspace">
        <div ref={terminalsRef} className={cx('terminals',effectiveSplit&&'split')} style={effectiveSplit?{gridTemplateColumns:'minmax(0,'+splitRatio+'fr) '+DIVIDER_WIDTH+'px minmax(0,'+(1-splitRatio)+'fr)'} as CSSProperties:undefined}>
          {opened.length?opened.map(id=>{
            const instance=instances.find(i=>i.id===id);if(!instance)return null;
            const info=paneInstance(instance);
            const pane=effectiveSplit?(split!.left===id?'left':split!.right===id?'right':undefined):undefined;
            const visible=visibleIds.has(id);
            return <div key={id} id={'terminal-pane-'+id} className="terminal-slot" role="region" aria-label={(pane?t(pane==='left'?'leftPane':'rightPane')+' · ':'')+info.label} data-instance-id={id} data-pane={pane} data-focused={visible&&active===id} hidden={!visible} onFocusCapture={()=>focusPane(id)} onPointerDownCapture={()=>focusPane(id)}>
              {pane&&<div className="pane-identity text-caption-1-semibold" aria-hidden="true">{t(pane==='left'?'leftPane':'rightPane')} · {info.label}{!info.writable&&' · '+t('readOnly')}</div>}
              {instance.online?terminal(instance):<div className="terminal-empty">{info.label} · {t('offline')}</div>}
            </div>;
          }):<div className="terminal-empty text-body-regular">{t('noOpenTerminals')}</div>}
          {effectiveSplit&&<SplitDivider key="split-divider" container={terminalsRef} ratio={splitRatio} minimum={minimumRatio} locale={locale} onResize={ratio=>changeWorkspace({type:'resize',id:active,ratio})}/>}
        </div>
      </div>
    </main>
    <Modal isOpen={panel==='login'} onOpenChange={v=>{if(!v)closePanel()}} size="md" className="auth-modal" overlayClassName="auth-overlay">
      <ModalHeader title={t(authMode==='recover'?'resetTitle':authMode==='register'?'registerTitle':'loginTitle')} description={t(authMode==='recover'?'resetDescription':authMode==='register'?'registerDescription':'loginDescription')} closeLabel={t('close')}/>
      <ModalBody>{authMode==='recover'?<div className="auth-form"><p className="text-body-regular text-text-secondary">{t('resetInstructions')}</p><Button variant="secondary" onClick={()=>{setAuthMode('login');setError(null);setApiError('')}}>{t('backLogin')}</Button></div>:<form className="auth-form" onSubmit={e=>{e.preventDefault();if(!busy)submitAuth()}}>
        <>
          <Input label={t('username')} autoComplete="username" value={username} onChange={v=>{setUsername(v);setError(null)}} hint={authMode==='register'?t('usernameHint'):undefined} isRequired/>
          <div className="password-field"><Input label={t('password')} type={showPassword?'text':'password'} autoComplete={authMode==='register'?'new-password':'current-password'} value={password} onChange={v=>{setPassword(v);setError(null)}} isRequired/><Button className="password-toggle quiet-button" variant="ghost" iconOnly leadingIcon={showPassword?RiEyeOffLine:RiEyeLine} aria-label={t(showPassword?'hidePassword':'showPassword')} onClick={()=>setShowPassword(!showPassword)}/></div>
          {authMode==='register'&&<p className="text-caption-1-regular text-text-secondary">{t('registrationPasswordHint')}</p>}{errorMessage}<Button className="primary-action auth-submit" disabled={busy} type="submit" trailingIcon={RiArrowRightLine}>{t(authMode==='register'?'register':'login')}</Button>
          <div className="auth-links"><Button variant="ghost" className="quiet-button" onClick={()=>{setAuthMode(authMode==='register'?'login':'register');setError(null);setApiError('');setPassword('')}}>{t(authMode==='register'?'haveAccount':'createAccount')}</Button><Button variant="ghost" className="quiet-button" onClick={()=>{setAuthMode('recover');setError(null);setApiError('');setPassword('')}}>{t('forgot')}</Button></div>
        </>
        {preview&&<p className="auth-footnote text-caption-1-regular">{t('demoAuth')}</p>}
      </form>}</ModalBody>
    </Modal>
    <Modal isOpen={panel==='password'} onOpenChange={v=>{if(!v)closePanel()}} size="md" className="auth-modal" overlayClassName="auth-overlay">
      <ModalHeader title={t('changePassword')} description={t('changePasswordDescription')} closeLabel={t('close')}/>
      <ModalBody><form className="auth-form" onSubmit={e=>{e.preventDefault();if(!busy)void savePassword()}}>
        <div className="account-identity"><span className="avatar">{preview?'D':account?.username.slice(0,1).toUpperCase()}</span><p className="text-body-medium break-all">{preview?t('demoAccount'):account?.username}</p></div>
        {passwordFields}<p className="text-caption-1-regular text-text-secondary">{t('passwordHint')}</p>{errorMessage}
        <Button className="primary-action auth-submit" disabled={busy} type="submit">{t('setPassword')}</Button>
      </form></ModalBody>
    </Modal>
    <Modal isOpen={panel==='logout'} onOpenChange={v=>{if(!v)closePanel()}} size="md" className="auth-modal" overlayClassName="auth-overlay">
      <ModalHeader title={t('logout')} description={t('logoutDescription')} closeLabel={t('close')}/>
      <ModalBody><div className="auth-form">
        {!preview&&<p className="text-body-regular text-text-secondary">{t('activeSessions')}: {sessions.length}</p>}{errorMessage}
        <Button className="auth-submit" variant="secondary" disabled={busy} onClick={()=>void signOut('/auth/logout')}>{t('signOutCurrent')}</Button>
        <Button className="auth-submit" variant="danger" disabled={busy} onClick={()=>void signOut('/me/sessions','DELETE')}>{t('signOutAll')}</Button>
      </div></ModalBody>
    </Modal>
    <Modal isOpen={panel==='connect'} onOpenChange={v=>{if(!v)closePanel()}} size="md" className="auth-modal" overlayClassName="auth-overlay"><ModalHeader title={t('connectTitle')} closeLabel={t('close')}/><ModalBody><div className="panel-content"><p className="text-body-regular text-text-secondary">{t('connectDescription')}</p><ol className="connect-steps">{(['stepOne','stepTwo','stepThree'] as const).map((key,index)=><li key={key}><span className="step-number text-caption-1-regular">0{index+1}</span><span className="text-body-regular">{t(key)}</span></li>)}</ol><Input label={t('hubAddress')} value={account?.hub_address??location.origin} isReadOnly/><Input label={t('username')} value={preview?'owner':account?.username??''} isReadOnly/><p className="text-caption-1-regular text-text-secondary">{t(preview?'connectHint':'realConnectHint')}</p><Button className="primary-action" onClick={closePanel}>{t('done')}</Button></div></ModalBody></Modal>
    <Drawer isOpen={panel==='detail'} onOpenChange={v=>{if(!v)closePanel()}} placement="end" size="md"><DrawerHeader title={t(panel==='detail'?'instanceDetails':'connectTitle')} closeLabel={t('close')}/><DrawerBody><div className="panel-content">
      <><div className="detail-banner"><RiTerminalBoxLine size={24}/><div className="min-w-0"><h2 className="text-headline-medium break-all">{detailInstance.name}</h2><p className="text-caption-1-regular text-text-secondary">{t(detailInstance.online?'online':'waiting')}</p><p className="text-caption-1-regular">{t(detailInstance.role)}</p></div></div>{(preview||detailInstance.role==='owner')&&<><h3 className="text-body-medium">{t('authorizedUsers')}</h3>{(grants[detail]??[]).map((g,index)=><div className="grant" key={g}><div className="min-w-0"><div className="text-body-regular truncate" dir="ltr">{g}</div><div className="text-caption-1-regular text-text-secondary">{t(preview?(index===0?'owner':'operator'):(grantRoles[g]??'operator') as 'owner'|'operator'|'observer')}</div></div>{(preview?index!==0:grantRoles[g]!=='owner')&&<Button className="quiet-button" variant="ghost" aria-label={`${t('remove')} ${g}`} onClick={()=>removeGrant(g)}>{t('remove')}</Button>}</div>)}<Input label={t('addUsername')} autoComplete="off" value={grantUsername} onChange={setGrantUsername} placeholder="member"/><div className="grant-role-controls"><Button variant="ghost" aria-pressed={grantRole==='operator'} onClick={()=>setGrantRole('operator')}>{t('operator')}</Button><Button variant="ghost" aria-pressed={grantRole==='observer'} onClick={()=>setGrantRole('observer')}>{t('observer')}</Button></div><Button variant="secondary" className="neutral-button" onClick={addGrant}>{t(grantRole==='operator'?'addOperator':'addObserver')}</Button>{errorMessage}{preview&&<p className="text-caption-1-regular text-text-secondary">{t('grantHint')}</p>}{!preview&&<Button variant="secondary" onClick={async()=>{try{await api(`/instances/${detail}/credentials/rotate`,{});closePanel()}catch(error){fail(error)}}}>{t('rotateDevice')}</Button>}{!preview&&<Button variant="danger" onClick={async()=>{try{await api(`/instances/${detail}/binding`,{},'DELETE');closePanel()}catch(error){fail(error)}}}>{t('unbind')}</Button>}</>}</>
    </div></DrawerBody></Drawer>
    <TerminalSettings key={account?.id || 'preview'} open={terminalSettingsOpen && (!!account || preview)} onClose={() => setTerminalSettingsOpen(false)} snapshot={displaySnapshot} legacy={reportedAppearance.current[active] || readAppearance(active)} locale={locale} loading={terminalPreferences.loading} loadError={terminalPreferences.error} onSave={async (settings, revision) => {if (preview) setPreviewSettings({settings, revision: revision + 1}); else await terminalPreferences.save(settings, revision);}}/>
    {account?.is_admin&&<AdminPanel open={adminOpen} onClose={()=>setAdminOpen(false)} locale={locale}/>}
    {notice&&<div className="notice text-body-regular" role="status">{t(notice)}</div>}
  </div></DirectionProvider>;
}
const mount=()=>createRoot(document.getElementById('root')!, {
  onUncaughtError:()=>window.hubBoot?.fail(),
}).render(<React.StrictMode><App/></React.StrictMode>);
if(window.hubBoot)window.hubBoot.run(mount);else mount();

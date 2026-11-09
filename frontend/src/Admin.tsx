import {useEffect,useState} from 'react';
import {Modal,ModalHeader,ModalBody} from '@/components/base/modal/modal';
import {Button} from '@/components/base/buttons/button';
import {ScrollFade,useScrollFade} from '@/components/foundations/scroll-fade/scroll-fade';
import {api} from './api';
import {errorText} from './errors';
type Stats={users:number;instances:number;online:number;sessions:number;mail_pending:number;uptime_seconds:number;version:string;revision:string};
type Update={active:boolean;stage:string;target:string;downloaded:number;total:number;error?:string};
export function AdminPanel({open,onClose,locale}:{open:boolean;onClose:()=>void;locale:string}){
 const zh=locale==='zh-CN';const tr=(cn:string,en:string)=>zh?cn:en;
 const [tab,setTab]=useState<'dashboard'|'system'|'logs'>('dashboard');
 const [stats,setStats]=useState<Stats|null>(null);const [logs,setLogs]=useState('');const [update,setUpdate]=useState<Update|null>(null);
 const [release,setRelease]=useState<{latest:string;version:string;revision:string}|null>(null);
 const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);const [confirm,setConfirm]=useState<'restart'|'upgrade'|null>(null);
 const fade=useScrollFade();
 useEffect(()=>{if(!open)return;let cancelled=false;let loading=false;
  async function refresh(){if(loading)return;loading=true;try{
   const [stats,update]=await Promise.all([api<Stats>('/admin/dashboard'),api<Update>('/admin/upgrade')]);
   const log=tab==='logs'?await api<{text:string}>('/admin/logs'):null;
   if(!cancelled){setStats(stats);setUpdate(update);if(log)setLogs(log.text);setError('')}
  }catch(e){if(!cancelled)setError(errorText(e instanceof Error?e.message:String(e),locale))}finally{loading=false}}
  void refresh();const timer=setInterval(refresh,3000);return()=>{cancelled=true;clearInterval(timer)};
 },[open,tab,locale]);
 async function check(){setBusy(true);setError('');try{setRelease(await api('/admin/version'))}catch(e){setError(errorText(e instanceof Error?e.message:String(e),locale))}finally{setBusy(false)}}
 async function operate(){if(!confirm)return;setBusy(true);setError('');const action=confirm;setConfirm(null);try{await api(`/admin/${action}`,{});setNotice(tr(action==='restart'?'已请求重启，连接会短暂中断。':'升级已开始，校验完成后将自动重启。',action==='restart'?'Restart requested. Connections will briefly disconnect.':'Upgrade started. Hub will restart after verification.'))}catch(e){setError(errorText(e instanceof Error?e.message:String(e),locale))}finally{setBusy(false)}}
 const stages:Record<string,[string,string]>={checking:['检查版本','Checking release'],downloading:['下载中','Downloading'],backing_up:['备份中','Backing up'],restarting:['重启中','Restarting'],complete:['升级完成','Upgrade complete'],failed:['升级失败，请查看日志','Upgrade failed; inspect logs'],interrupted:['上次升级被中断','Previous upgrade interrupted']};
 return <Modal isOpen={open} onOpenChange={value=>{if(!value){setConfirm(null);onClose()}}} size="xl"><ModalHeader title={tr('管理后台','Administration')} closeLabel={tr('关闭','Close')}/><ModalBody>
  <nav className="flex flex-wrap gap-2 mb-4" aria-label={tr('后台导航','Administration navigation')}>{(['dashboard','system','logs'] as const).map(key=><Button key={key} variant={tab===key?'secondary':'ghost'} aria-pressed={tab===key} onClick={()=>{setTab(key);setConfirm(null);fade.reset()}}>{key==='dashboard'?tr('统计概览','Dashboard'):key==='system'?tr('升级与重启','Updates & restart'):tr('系统日志','System logs')}</Button>)}</nav>
  {error&&<p role="alert" className="text-body-regular text-text-error-primary mb-4">{error}</p>}
  {notice&&<p role="status" className="text-body-regular text-text-secondary mb-4">{notice}</p>}
  {tab==='dashboard'&&stats&&<><div className="grid grid-cols-2 sm:grid-cols-3 gap-4">{[[tr('账号','Accounts'),stats.users],[tr('注册实例','Registered instances'),stats.instances],[tr('在线实例','Online instances'),stats.online],[tr('有效会话','Active sessions'),stats.sessions],[tr('待投递邮件','Pending mail'),stats.mail_pending],[tr('运行时间（秒）','Uptime (seconds)'),stats.uptime_seconds]].map(([label,value])=><div key={label} className="rounded-3xl border border-border-button-default p-4"><p className="text-caption-1-regular text-text-secondary">{label}</p><p className="text-title-2-medium">{value}</p></div>)}</div><p className="text-caption-1-regular text-text-secondary mt-4 break-all" dir="ltr">v{stats.version} · {stats.revision}</p></>}
  {tab==='system'&&<div className="flex flex-col gap-4"><p className="text-body-regular">{tr('升级来源：Xiechengqi/gotty-hub 的 GitHub Release。下载、校验 SHA256 并备份后替换程序；升级和重启会断开当前终端连接，远端进程继续运行。','Updates come from Xiechengqi/gotty-hub GitHub Releases. Hub verifies SHA256 and backs up before replacement. Updates and restarts disconnect terminals; remote processes continue.')}</p><p className="text-caption-1-regular break-all" dir="ltr">v{stats?.version} · {stats?.revision}</p>
  {release&&<p className="text-body-regular">{tr('最新版本','Latest release')}: {release.latest}</p>}
  {update?.stage&&<p role="status" className="text-body-regular">{stages[update.stage]?tr(...stages[update.stage]):update.stage}{update.target?` · ${update.target}`:''}{update.active&&update.downloaded?` · ${(update.downloaded/1048576).toFixed(1)} / ${(update.total/1048576).toFixed(1)} MiB`:''}</p>}
  <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy||update?.active} onClick={check}>{tr('检查更新','Check for updates')}</Button><Button variant="primary" disabled={busy||update?.active} onClick={()=>setConfirm('upgrade')}>{tr('升级系统','Upgrade Hub')}</Button><Button variant="secondary" disabled={busy||update?.active} onClick={()=>setConfirm('restart')}>{tr('重启系统','Restart Hub')}</Button></div>
  {confirm&&<div className="border border-border-button-default rounded-xl p-4 flex flex-col gap-4"><p className="text-body-regular">{tr(confirm==='restart'?'确认重启 Hub？':'确认下载最新 Release 并升级 Hub？',confirm==='restart'?'Restart Hub now?':'Download and install the latest Hub release?')}</p><div className="flex gap-2"><Button variant="danger" disabled={busy} onClick={operate}>{tr('确认','Confirm')}</Button><Button variant="secondary" onClick={()=>setConfirm(null)}>{tr('取消','Cancel')}</Button></div></div>}
  </div>}
  {tab==='logs'&&<><p className="text-caption-1-regular text-text-secondary mb-2">{tr('最近 128 KiB，每 3 秒刷新；日志保留 7 天。','Latest 128 KiB, refreshed every 3 seconds; retained for 7 days.')}</p><div className="relative"><pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-all text-caption-1-regular bg-background-secondary-default rounded-xl p-4" dir="ltr" tabIndex={0} onScroll={fade.onScroll}>{logs||tr('暂无日志','No logs yet')}</pre><ScrollFade progress={fade.progress} surfaceClassName="from-background-secondary-default"/></div></>}
 </ModalBody></Modal>;
}

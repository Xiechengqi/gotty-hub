import {useEffect, useState} from 'react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import {Modal, ModalBody, ModalHeader} from '@/components/base/modal/modal';

export type Control = (action: string, payload?: Record<string, unknown>) => Promise<any>;
type Share = {id: string; public_url: string; target: string; status: string; expires_at?: string};
type ShareList = {shares: Share[]; default_target: string; configured: boolean; missing_config?: string[]};

export function ShareManager({open, onClose, control, enabled, locale}: {open: boolean; onClose: () => void; control: Control; enabled: boolean; locale: string}) {
  const zh = locale === 'zh-CN';
  const [data, setData] = useState<ShareList>();
  const [target, setTarget] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [hours, setHours] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [passwordless, setPasswordless] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !enabled) return;
    let disposed = false;
    setError(''); setBusy(true);
    control('shares').then((value: ShareList) => {if (!disposed) {setData(value); setTarget(value.default_target);}})
      .catch(err => {if (!disposed) setError(String(err.message || err));})
      .finally(() => {if (!disposed) setBusy(false);});
    return () => {disposed = true;};
  }, [open, enabled, control]);
  async function action(name: string, payload: Record<string, unknown>) {
    setError(''); setBusy(true);
    try { await control(name, payload); setData(await control('shares')); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <Modal isOpen={open} onOpenChange={value => {if (!value) onClose();}} size="md">
    <ModalHeader title={zh ? '分享管理' : 'Share manager'} closeLabel={zh ? '关闭' : 'Close'}/>
    <ModalBody><div className="flex flex-col gap-4">
      {!enabled ? <p>{zh ? '此 GoTTY 未启用分享功能。' : 'Sharing is disabled on this GoTTY.'}</p> : <>
        {data && !data.configured && <p role="status">{zh ? '远程 GoTTY 需要配置：' : 'Configure on the remote GoTTY: '}{data.missing_config?.join(', ')}</p>}
        <form className="flex flex-col gap-4" onSubmit={event => {event.preventDefault(); if (!busy) void action('share_create', {type: 'http', target, subdomain, expire_value: hours ? Number(hours) : 0, expire_unit: 'hours', read_only: readOnly, passwordless, custom_password: !passwordless && !!password, password: passwordless ? '' : password});}}>
          <Input label={zh ? '目标地址' : 'Target URL'} value={target} onChange={setTarget} isRequired/>
          <Input label={zh ? '子域名（可选）' : 'Subdomain (optional)'} value={subdomain} onChange={setSubdomain}/>
          <Input label={zh ? '有效期（小时；留空为不过期）' : 'Expires in hours (empty: never)'} type="number" value={hours} onChange={setHours}/>
          <div className="terminal-setting-options"><Button variant="secondary" aria-pressed={readOnly} onClick={() => setReadOnly(!readOnly)}>{zh ? '只读终端' : 'Read-only terminal'}</Button><Button variant="secondary" aria-pressed={passwordless} onClick={() => {setPasswordless(!passwordless); setPassword('');}}>{zh ? '免密码访问' : 'Passwordless access'}</Button></div>
          {!passwordless && <Input label={zh ? '分享密码（留空沿用 GoTTY 登录）' : 'Share password (empty: GoTTY login)'} type="password" autoComplete="new-password" value={password} onChange={setPassword}/>}
          <Button type="submit" disabled={busy || !data?.configured}>{zh ? '创建分享' : 'Create share'}</Button>
        </form>
        {data?.shares.map(share => <div className="terminal-share-row" key={share.id}>
          <p className="text-body-medium break-all" dir="ltr">{share.public_url || share.target}</p><p className="text-caption-1-regular">{share.status}{share.expires_at ? ` · ${new Date(share.expires_at).toLocaleString(locale)}` : ''}</p>
          <div className="terminal-setting-options">{share.public_url && <Button variant="secondary" size="small" onClick={() => {void navigator.clipboard?.writeText(share.public_url).catch(err => setError(String(err)));}}>{zh ? '复制链接' : 'Copy link'}</Button>}
            {['active', 'creating'].includes(share.status) ? <Button variant="secondary" size="small" disabled={busy} onClick={() => void action('share_stop', {id: share.id})}>{zh ? '停止' : 'Stop'}</Button> : <><Button variant="secondary" size="small" disabled={busy} onClick={() => void action('share_restart', {id: share.id})}>{zh ? '重启' : 'Restart'}</Button><Button variant="secondary" size="small" disabled={busy} onClick={() => void action('share_delete', {id: share.id})}>{zh ? '删除' : 'Delete'}</Button></>}
          </div>
        </div>)}
      </>}
      {error && <p role="alert" className="text-text-error-primary">{error}</p>}
    </div></ModalBody>
  </Modal>;
}

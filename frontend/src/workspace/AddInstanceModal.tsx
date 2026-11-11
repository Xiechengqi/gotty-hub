import {useEffect, useRef, useState} from 'react';
import {RiCheckLine, RiFileCopyLine} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import {Modal, ModalBody, ModalHeader} from '@/components/base/modal/modal';
import {Select, SelectItem} from '@/components/base/select/select';
import type {PaneInstance} from './WorkspaceControls';

export function AddInstanceModal({open, onClose, address, username, closed, onReopen, locale}: {
  open: boolean; onClose: () => void; address: string; username: string; closed: PaneInstance[]; onReopen: (id: string) => void; locale: string;
}) {
  const zh = locale === 'zh-CN';
  const body = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(''), [error, setError] = useState('');
  useEffect(() => {if (open) {setCopied(''); setError('');}}, [open]);
  async function copy(key: string, value: string) {
    setError('');
    try {
      try {if (!navigator.clipboard?.writeText) throw Error(); await navigator.clipboard.writeText(value);}
      catch {
        const field = body.current?.querySelector<HTMLInputElement>(`[data-copy-field="${key}"] input`);
        if (!field) throw Error();
        const previous = document.activeElement; field.focus(); field.select();
        try {if (!document.execCommand('copy')) throw Error();}
        finally {field.setSelectionRange(0, 0); if (previous instanceof HTMLElement) previous.focus();}
      }
      setCopied(key);
    } catch {setError(zh ? '复制失败，请选中内容手动复制。' : 'Unable to copy. Select the text and copy it manually.');}
  }
  return <Modal isOpen={open} onOpenChange={value => {if (!value) onClose();}} size="sm" className="auth-modal add-instance-dialog" overlayClassName="auth-overlay">
    <ModalHeader title={zh ? '添加实例' : 'Add instance'} closeLabel={zh ? '关闭' : 'Close'}/>
    <ModalBody><div ref={body} className="flex flex-col gap-4">
      {([['address', zh ? 'Hub 地址' : 'Hub address', address], ['username', zh ? '用户名' : 'Username', username]] as const).map(([key, label, value]) => <div key={key} className="add-instance-field" data-copy-field={key}>
        <Input label={label} value={value} isReadOnly/><Button variant="ghost" iconOnly leadingIcon={copied === key ? RiCheckLine : RiFileCopyLine} aria-label={(zh ? '复制' : 'Copy ') + label} onClick={() => void copy(key, value)}/>
      </div>)}
      <p className="text-body-2-regular text-text-secondary">{zh ? '在 GoTTY 中打开“接入 Hub”，填写以上信息即可。' : 'In GoTTY, open “Connect to Hub” and enter these details.'}</p>
      {copied && <span className="text-caption-1-regular text-text-secondary" role="status">{zh ? '已复制' : 'Copied'}</span>}
      {error && <p className="text-body-2-regular text-text-error-primary" role="alert">{error}</p>}
      {!!closed.length && <Select label={zh ? '重新打开已关闭实例' : 'Reopen a closed instance'} placeholder={zh ? '选择实例' : 'Choose an instance'} selectedKey={null} onSelectionChange={key => {if (key !== null) {onReopen(String(key)); onClose();}}}>
        {closed.map(instance => <SelectItem key={instance.id} id={instance.id} textValue={instance.label}>{instance.label}{!instance.online && (zh ? ' · 离线' : ' · Offline')}</SelectItem>)}
      </Select>}
    </div></ModalBody>
  </Modal>;
}

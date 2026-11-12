import {useEffect, useRef, useState} from 'react';
import {AlertDialog} from '@/components/base/modal/modal';
import {errorText} from '../errors';
import type {Locale} from '../i18n';

export function DeleteInstanceDialog({instance, canDelete, locale, onDelete, onClose}: {
  instance: {id: string; name: string} | null; canDelete: boolean; locale: Locale;
  onDelete: (id: string) => Promise<void>; onClose: () => void;
}) {
  const [error, setError] = useState('');
  const pending = useRef(false);
  const zh = locale === 'zh-CN';
  useEffect(() => {setError('');}, [instance?.id]);
  return <AlertDialog isOpen={!!instance} onOpenChange={open => {if (!open) onClose();}}
    title={zh ? '删除实例' : 'Delete instance'}
    description={zh ? `从 Hub 删除“${instance?.name ?? ''}”并解除绑定，所有通过 Hub 的连接将断开。之后可从 GoTTY 重新接入。` : `Delete “${instance?.name ?? ''}” from Hub and remove its binding. All connections through Hub will close. You can connect again from GoTTY.`}
    confirmLabel={zh ? '删除' : 'Delete'} cancelLabel={zh ? '取消' : 'Cancel'} pendingLabel={zh ? '删除中…' : 'Deleting…'}
    isConfirmDisabled={!canDelete} onConfirm={async () => {
      if (!instance || !canDelete || pending.current) return;
      pending.current = true; setError('');
      try {await onDelete(instance.id);}
      catch (cause) {setError(errorText(cause instanceof Error ? cause.message : String(cause), locale)); throw cause;}
      finally {pending.current = false;}
    }}>
    {error && <p role="alert" className="text-body-regular text-text-error-primary">{error}</p>}
  </AlertDialog>;
}

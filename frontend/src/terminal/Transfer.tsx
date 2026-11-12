import {useId,useRef,useState} from 'react';
import {Sentry,type Session,type Offer} from 'zmodem.js';
import {Browser} from 'zmodem.js/src/zmodem_browser';
import {Modal,ModalHeader,ModalBody} from '@/components/base/modal/modal';
import {Button} from '@/components/base/buttons/button';
import {InputBase} from '@/components/base/input/input';
import {Label} from '@/components/base/input/label';
import {FILE_LIMIT} from './upload';
export type Transfer={session:Session;offer?:Offer};
export function createTransfer(output:(data:Uint8Array)=>void,send:(data:Uint8Array)=>void,show:(transfer:Transfer|null)=>void,setStdin:(enabled:boolean)=>void){
 let session:Session|undefined;let disposed=false;
 const sentry=new Sentry({to_terminal:output,sender:send,on_retract:()=>{show(null);setStdin(true)},on_detect:d=>{
  if(disposed)return;session=d.confirm();setStdin(false);const current=session;
  current.on('session_end',()=>{if(!disposed){show(null);setStdin(true)}});
  if(current.type==='send')show({session:current});else{current.on('offer',(offer:Offer)=>{if(offer.get_details().size>FILE_LIMIT){offer.skip();return}show({session:current,offer})});current.start()}
 }});
 return {consume:(data:Uint8Array)=>{try{sentry.consume(data)}catch{try{session?.abort()}catch{}show(null);setStdin(true)}},dispose:()=>{disposed=true;try{session?.abort()}catch{}}};
}
export function TransferModal({transfer,locale,onClose}:{transfer:Transfer|null;locale:string;onClose:()=>void}){
 const files=useRef<HTMLInputElement>(null);const inputId=useId();const [busy,setBusy]=useState(false);const [error,setError]=useState('');const zh=locale==='zh-CN';
 function cancel(){try{transfer?.session.abort()}catch{}setBusy(false);setError('');onClose()}
 async function start(){if(!transfer||busy)return;setError('');setBusy(true);try{
  if(transfer.offer){const payload:Uint8Array[]=[];let received=0;await (transfer.offer as any).accept({on_input:(chunk:Uint8Array)=>{received+=chunk.length;if(received>FILE_LIMIT){transfer.session.abort();throw Error('Maximum file size: 64 MiB')}payload.push(new Uint8Array(chunk))}});Browser.save_to_disk(payload,transfer.offer.get_details().name)}
  else{const selected=files.current?.files;if(!selected?.length){setBusy(false);return}if(Array.from(selected).some(f=>f.size>FILE_LIMIT))throw Error(zh?'文件最大 64 MiB':'Maximum file size: 64 MiB');await Browser.send_files(transfer.session,selected);transfer.session.close()}
  setBusy(false);onClose();
 }catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);try{transfer.session.abort()}catch{}}}
 return <Modal isOpen={!!transfer} onOpenChange={open=>{if(!open)cancel()}} size="md"><ModalHeader title={zh?'文件传输':'File transfer'} closeLabel={zh?'取消':'Cancel'}/><ModalBody><div className="panel-content">{transfer?.offer?<p>{transfer.offer.get_details().name}</p>:<div className="flex flex-col gap-1"><Label htmlFor={inputId}>{zh?'选择文件（最大 64 MiB）':'Choose file (maximum 64 MiB)'}</Label><InputBase id={inputId} ref={files} type="file"/></div>}<p>{zh?'在终端运行 rz 上传，或 sz 文件名下载。':'Run rz to upload, or sz filename to download.'}</p>{error&&<p role="alert">{error}</p>}<Button disabled={busy} onClick={start}>{zh?'开始':'Start'}</Button><Button variant="secondary" onClick={cancel}>{zh?'取消':'Cancel'}</Button></div></ModalBody></Modal>;
}

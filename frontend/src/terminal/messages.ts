// Translate messages at the adapter boundary; keep the shared GoTTY API stable.
export function terminalMessage(text:string,locale:string):string{
 if(locale==='en-US'){
  const voice:Record<string,string>={
   '录音中，停止后插入':'Recording; release to insert text',
   '无法开始语音输入：麦克风权限被拒绝':'Cannot start voice input: microphone permission denied',
   '无法开始语音输入：未检测到麦克风设备':'Cannot start voice input: no microphone found',
   '无法开始语音输入：麦克风被占用或不可用':'Cannot start voice input: microphone is busy or unavailable',
   '无法开始语音输入：连接 ASR 服务失败':'Cannot start voice input: ASR connection failed',
   '语音输入连接失败':'Voice input connection failed',
   '语音输入不可用：未启用写入权限（gotty 需要 --permit-write）':'Voice input requires terminal write permission',
  };
  if(text.startsWith('语音输入连接已断开'))return 'Voice input disconnected'+text.slice('语音输入连接已断开'.length);
  if(text.startsWith('语音输入需要 HTTPS'))return 'Voice input requires HTTPS and microphone permission';
  return voice[text]??text;
 }
 return text.replace('Restoring session...','正在恢复会话…').replace(/Reconnecting in (\d+)s\.\.\./g,'将在 $1 秒后重连…').replace('Refresh the page or sign in again.','请刷新页面或重新登录。').replace('Connection closed','连接已关闭').replace('Connection lost','连接已断开');
}

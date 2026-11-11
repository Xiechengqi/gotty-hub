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
 const reasons:Record<string,string>={
  'Older output exceeded the retained history limit.':'较早的输出已超出历史保留上限，仅恢复保留范围内的内容。',
  'Authentication or instance access denied':'登录已过期或实例访问权限已被取消',
  'Authentication origin validation failed':'连接来源校验失败，请检查反向代理转发的地址',
  'Instance offline':'GoTTY 实例已离线',
  'Hub restarting or stopping':'Hub 正在重启或停止',
  'Hub stopping':'Hub 正在停止',
  'Terminal authorization temporarily unavailable':'暂时无法取得终端连接凭据',
  'Network or proxy connection interrupted':'网络或反向代理连接中断',
  'WebSocket handshake failed; check proxy Upgrade support and network':'WebSocket 握手失败，请检查反向代理的 Upgrade 支持及网络',
  'Instance stream closed':'GoTTY 终端连接已关闭',
  'Heartbeat timed out':'连接心跳超时',
  'Authentication timed out':'终端凭据校验超时',
  'Authentication ticket expired or invalid':'终端连接凭据已过期或无效',
  'Authentication channel access denied':'无权访问此终端通道',
  'Instance connection limit reached':'实例连接数已达到上限',
  'Instance temporarily unavailable':'GoTTY 实例暂时不可用，请等待重连',
 };
 for(const [source,target] of Object.entries(reasons))text=text.replace(source,target);
 return text.replace('Restoring session...','正在恢复会话…').replace(/Reconnecting in (\d+)s\.\.\./g,'将在 $1 秒后重连…').replace('Refresh the page or sign in again.','请刷新页面或重新登录。').replace('Connection closed','连接已关闭').replace('Connection lost','连接已断开');
}

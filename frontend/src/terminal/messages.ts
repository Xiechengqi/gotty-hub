import {pasteError} from '@gotty/terminal-core/paste';
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
 text = pasteError(text);
 const reasons:Record<string,string>={
  'Maximum file size: 64 MiB':'文件最大支持 64 MiB',
  'Filename is too long':'文件名过长，请缩短后重试',
  'Invalid upload filename':'文件名无效，请勿包含路径分隔符或连续的两个点',
  'Terminal is disconnected':'终端连接已断开，请等待重连后重试',
  'File upload requires write permission':'上传文件需要终端写入权限',
  'Upload timed out; check the connection and retry':'上传超时，请检查连接后重试',
  'Invalid upload confirmation':'收到的上传确认与文件不一致，请重试',
  'Upload cancelled':'上传已取消',
  'Another upload is running':'另一个文件正在上传',
  'Invalid upload request':'上传请求无效',
  'Invalid upload size or chunk':'文件大小或分块信息无效',
  'Invalid upload data':'文件数据无效',
  'Cannot locate terminal working directory':'无法获取终端当前目录',
  'This file is being uploaded by another client':'另一个客户端正在上传同名文件，请稍后重试',
  'Upload destination is not a regular file':'目标已存在且不是普通文件，请更换文件名',
  'Cannot access upload destination':'无法访问目标文件，请检查目录权限',
  'Cannot create upload file; check directory permissions and free space':'无法创建文件，请检查目录权限和剩余空间',
  'Cannot set upload file permissions':'无法设置文件权限',
  'Upload chunks are out of sequence; retry the upload':'文件分块顺序异常，请重试',
  'Uploaded size does not match the file':'实际上传大小与文件不一致，请重试',
  'Cannot write upload file; check free space':'文件写入失败，请检查剩余空间',
  'Cannot save upload file; check free space':'文件保存失败，请检查剩余空间',
  'Cannot finalize upload file; check directory permissions':'文件保存失败，请检查目标目录权限',
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
  'Instance input queue unavailable':'实例输入队列暂不可用，请等待重连',
 };
 for(const [source,target] of Object.entries(reasons))text=text.replace(source,target);
 return text.replace('Restoring session...','正在恢复会话…').replace(/Reconnecting in (\d+)s\.\.\./g,'将在 $1 秒后重连…').replace('Refresh the page or sign in again.','请刷新页面或重新登录。').replace('Connection closed','连接已关闭').replace('Connection lost','连接已断开');
}

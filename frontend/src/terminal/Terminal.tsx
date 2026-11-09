import {useCallback, useEffect, useRef, useState, type CSSProperties} from 'react';
import {Terminal as Xterm} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {WebLinksAddon} from '@xterm/addon-web-links';
import {Unicode11Addon} from '@xterm/addon-unicode11';
import {ImageAddon} from '@xterm/addon-image';
import {WebglAddon} from '@xterm/addon-webgl';
import {WebTTY, type Terminal, type TerminalStatePayload} from '@gotty/terminal-core';
import {VoiceInput} from '@gotty/terminal-core/voice-input';
import {defaultDisplayOptions, displayOptions, NORD_THEME, type Appearance, type ThemeMap} from '@gotty/terminal-core/appearance';
import {RiDeleteBinLine, RiFontSize, RiRestartLine, RiServerLine, RiUpload2Line, RiUserLine} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import {Modal, ModalBody, ModalHeader} from '@/components/base/modal/modal';
import {api} from '../api';
import {terminalMessage} from './messages';
import {createTransfer, TransferModal, FILE_LIMIT, type Transfer} from './Transfer';
import {readAppearance, saveAppearance, type TerminalConfig} from './appearance';
import {DisplaySettings} from './DisplaySettings';
import {ShareManager, type Control} from './ShareManager';
import {HubConnection} from './connection';
import '@xterm/xterm/css/xterm.css';

type Controller = {term: Xterm; measure: () => void; send: (data: string) => void; view: () => void; control: Control; upload: (file: File, signal: AbortSignal) => Promise<void>};
type Props = {id: string; writable: boolean; visible: boolean; locale: string; asr?: boolean; files?: boolean; owner?: boolean; controls?: boolean; onManage: () => void};
const FALLBACK_THEMES: ThemeMap = {nord: NORD_THEME};

export function RealTerminal({id, writable, visible, locale, asr = false, files = false, owner = false, controls = false, onManage}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef(visible); view.current = visible;
  const controller = useRef<Controller>(undefined);
  const preferences = useRef<Record<string, unknown>>({});
  const appearanceRef = useRef<Appearance>(readAppearance(id));
  const configRef = useRef<TerminalConfig>({});
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | undefined>(undefined);
  const [appearance, setAppearance] = useState(appearanceRef.current);
  const [config, setConfig] = useState<TerminalConfig>({});
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);
  const [count, setCount] = useState(0);
  const [terminalState, setTerminalState] = useState<TerminalStatePayload>();
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [upload, setUpload] = useState<{name: string; progress: number; done?: boolean}>();
  const [dragging, setDragging] = useState(false);
  const [colors, setColors] = useState({background: NORD_THEME.background, foreground: NORD_THEME.foreground});
  const [apiRunning, setAPIRunning] = useState(false);
  const zh = locale === 'zh-CN';
  const control = useCallback<Control>((action, payload = {}) => controller.current?.control(action, payload) ?? Promise.reject(Error('Terminal is disconnected')), []);

  function updateAppearance(value: Appearance) {
    appearanceRef.current = value; setAppearance(value); saveAppearance(id, value);
    const current = controller.current;
    if (current) {
      const options = displayOptions(preferences.current, configRef.current.themes || FALLBACK_THEMES, value);
      Object.assign(current.term.options, options);
      setColors({background: options.theme.background, foreground: options.theme.foreground}); current.measure();
    }
  }

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const term = new Xterm({...defaultDisplayOptions(), allowProposedApi: true, disableStdin: !writable});
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new WebLinksAddon()); term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11';
    try {term.loadAddon(new ImageAddon());} catch { /* Text renderer remains usable. */ }
    term.open(host.current); term.textarea?.setAttribute('autocomplete', 'off');
    try {const webgl = new WebglAddon(); webgl.onContextLoss(() => webgl.dispose()); term.loadAddon(webgl);} catch { /* WebGL is optional. */ }
    let input: (data: string | Uint8Array) => void = () => {};
    let resize: (cols: number, rows: number) => void = () => {};
    let sendUpload: (message: string) => void = () => {};
    let bufferSize = 1024;
    let connection: HubConnection | null = null;
    let voice: VoiceInput | null = null;
    let messageTimer: ReturnType<typeof setTimeout> | undefined;
    let fitFrame = 0;
    let altIsMeta = false;
    const apiExecutions = new Set<string>();
    const showMessage = (text: string, timeout = 2000) => {
      clearTimeout(messageTimer); if (disposed) return; setMessage(text);
      if (timeout > 0) messageTimer = setTimeout(() => {if (!disposed) setMessage('');}, timeout);
    };
    const measure = () => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {fitFrame = requestAnimationFrame(() => {
        if (!disposed && view.current && host.current?.clientWidth && host.current?.clientHeight) {try {fit.fit();} catch { /* Hidden pane. */ }}
      });});
    };
    const applyAppearance = () => {
      const options = displayOptions(preferences.current, configRef.current.themes || FALLBACK_THEMES, appearanceRef.current);
      Object.assign(term.options, options);
      setColors({background: options.theme.background, foreground: options.theme.foreground}); measure();
    };
    const installVoice = () => {
      voice?.close(); voice = null;
      if (!asr || !writable || !host.current) return;
      voice = new VoiceInput({enabled: true, permitWrite: true,
        holdMs: configRef.current.asr_hold_ms ?? 500, hotkeyCode: configRef.current.asr_hotkey || 'ShiftRight', authToken: '',
        term: {elem: host.current, showMessage, removeMessage: () => showMessage('', 0), disableStdin: () => {term.options.disableStdin = true;}, enableStdin: () => {term.options.disableStdin = !writable;}, sendInput: data => input(data)},
        webSocketFactory: () => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/terminal-connections/${id}/ws`),
        initialize: async ws => {const value = await api(`/instances/${id}/terminal-tickets`, {}); ws.send(JSON.stringify({ticket: value.ticket, channel: 'asr'}));},
      });
    };
    const zmodem = writable && files ? createTransfer(data => term.write(data), data => input(data), setTransfer, enabled => {term.options.disableStdin = !enabled || !writable;}) : null;
    const adapter: Terminal & {setUploadFileSender: (sender: (message: string) => void) => void; setUploadFileBufferSize: (size: number) => void} = {
      info: () => ({columns: term.cols, rows: term.rows}), output: data => {if (zmodem) zmodem.consume(data); else term.write(data);},
      showMessage, removeMessage: () => showMessage('', 0), setWindowTitle: () => {},
      setPreferences: value => {
        preferences.current = value;
        if (value['hub-config'] && typeof value['hub-config'] === 'object') {configRef.current = value['hub-config'] as TerminalConfig; setConfig(configRef.current); installVoice();}
        altIsMeta = value['alt-is-meta'] === true; applyAppearance();
      },
      updateConnectionCount: value => setCount(value), updateTerminalState: value => setTerminalState(value),
      showAPIIndicator: execId => {apiExecutions.add(execId); setAPIRunning(true);}, hideAPIIndicator: execId => {apiExecutions.delete(execId); setAPIRunning(apiExecutions.size > 0);},
      setUploadFileSender: sender => {sendUpload = sender;}, setUploadFileBufferSize: size => {bufferSize = size;},
      onInput: callback => {input = callback;}, onResize: callback => {resize = callback;}, close: () => {}, reset: () => term.reset(), deactivate: () => {}, focus: () => {if (view.current) term.focus();}, scrollToBottom: () => term.scrollToBottom(),
    };
    const viewing = () => view.current && document.visibilityState === 'visible' && document.hasFocus() && !!host.current?.contains(document.activeElement);
    const wt = new WebTTY(adapter, {create: () => {connection = new HubConnection(id, writable, owner, controls, viewing, () => view.current); return connection;}}, '', '');
    wt.onConnect = () => setConnected(true); wt.onDisconnect = () => {if (!disposed) {setConnected(false); setCount(0);}};
    const subscription = term.onData(data => {if (writable) input(data);});
    const binary = term.onBinary(data => {if (writable) input(Uint8Array.from(data, char => char.charCodeAt(0)));});
    const size = term.onResize(({cols, rows}) => {if (view.current && cols > 0 && rows > 0) resize(cols, rows);});
    term.attachCustomKeyEventHandler(event => {
      if (!writable || !altIsMeta || event.type !== 'keydown' || !event.altKey || event.ctrlKey || event.metaKey || event.code === 'Tab') return true;
      const char = /^Key[A-Z]$/.test(event.code) ? (event.shiftKey ? event.code[3] : event.code[3].toLowerCase()) : event.key.length === 1 ? event.key : '';
      if (!char) return true; input(`\x1b${char}`); event.preventDefault(); return false;
    });
    const copy = async (text: string) => {
      if (!text || !view.current) return;
      try {if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {const field = document.createElement('textarea'); field.value = text; field.style.position = 'fixed'; field.style.opacity = '0'; host.current?.appendChild(field); field.select(); document.execCommand('copy'); field.remove();}
      } catch {return;}
      if (!disposed) {showMessage('Copied to clipboard', 1400); term.focus();}
    };
    const selection = term.onSelectionChange(() => {if (term.hasSelection()) void copy(term.getSelection());});
    const osc = term.parser.registerOscHandler(52, data => {const payload = data.slice(data.indexOf(';') + 1); if (data.includes(';') && payload && payload !== '?') {try {void copy(new TextDecoder().decode(Uint8Array.from(atob(payload), char => char.charCodeAt(0))));} catch { /* Invalid clipboard sequence. */ }} return true;});
    const observer = new ResizeObserver(measure); observer.observe(host.current); applyAppearance();
    const stop = wt.open(); installVoice();
    const viewport = () => {if (view.current && window.visualViewport) {document.documentElement.style.setProperty('--hub-viewport-height', `${window.visualViewport.height}px`); measure();}};
    window.visualViewport?.addEventListener('resize', viewport); viewport();
    const report = () => connection?.reportView(); const interval = setInterval(report, 3000);
    document.addEventListener('visibilitychange', report); window.addEventListener('focus', report); window.addEventListener('blur', report); document.addEventListener('focusin', report);
    controller.current = {term, measure, send: data => {if (writable) input(data);}, view: report,
      control: (action, payload) => connection?.request(action, payload) ?? Promise.reject(Error('Terminal is disconnected')),
      upload: async (file, signal) => {
        if (!writable || !files || !file.size || file.size > FILE_LIMIT) throw Error('Maximum file size: 64 MiB; empty files are not supported');
        const overhead = new TextEncoder().encode(JSON.stringify({name: file.name, size: file.size, chunk: file.size, totalChunks: file.size, data: ''})).length + 1;
        const chunkSize = Math.min(8192, Math.floor((bufferSize - overhead) / 4) * 3);
        if (chunkSize <= 0) throw Error('Filename is too long');
        const totalChunks = Math.ceil(file.size / chunkSize);
        for (let chunk = 0; chunk < totalChunks; chunk++) {
          if (signal.aborted || disposed) throw Error('Upload cancelled');
          if (!connection || connection.closed || connection.ws.readyState !== 1) throw Error('Terminal is disconnected');
          while (connection.ws.bufferedAmount > 256 * 1024) {await new Promise(resolve => setTimeout(resolve, 10)); if (signal.aborted || disposed || connection.closed) throw Error('Upload cancelled or disconnected');}
          const bytes = new Uint8Array(await file.slice(chunk * chunkSize, (chunk + 1) * chunkSize).arrayBuffer());
          if (signal.aborted || disposed) throw Error('Upload cancelled');
          const data = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
          sendUpload('7' + JSON.stringify({name: file.name, size: file.size, chunk, totalChunks, data}));
          setUpload({name: file.name, progress: Math.round((chunk + 1) / totalChunks * 100)});
        }
      },
    };
    return () => {
      disposed = true; uploadAbort.current?.abort(); clearTimeout(messageTimer); cancelAnimationFrame(fitFrame); voice?.close(); zmodem?.dispose();
      window.visualViewport?.removeEventListener('resize', viewport); controller.current = undefined; clearInterval(interval);
      document.removeEventListener('visibilitychange', report); window.removeEventListener('focus', report); window.removeEventListener('blur', report); document.removeEventListener('focusin', report);
      stop(); observer.disconnect(); subscription.dispose(); binary.dispose(); size.dispose(); selection.dispose(); osc.dispose(); term.dispose();
    };
  }, [id, writable, asr, files, owner, controls]);
  useEffect(() => {if (visible) {controller.current?.measure(); controller.current?.term.focus();} else {setDisplayOpen(false); setShareOpen(false);} controller.current?.view();}, [visible]);

  async function startUpload(file: File) {
    if (!controller.current || uploadAbort.current) return;
    const abort = new AbortController(); uploadAbort.current = abort; setUpload({name: file.name, progress: 0});
    try {await controller.current.upload(file, abort.signal); if (!abort.signal.aborted) setUpload({name: file.name, progress: 100, done: true});}
    catch (error) {if (!abort.signal.aborted) {setMessage(error instanceof Error ? error.message : String(error)); setUpload(undefined);}}
    finally {if (uploadAbort.current === abort) uploadAbort.current = undefined;}
  }
  const closeUpload = () => {uploadAbort.current?.abort(); setUpload(undefined); controller.current?.term.focus();};
  return <section className="real-terminal dark" style={{'--color-terminal-background': colors.background, '--color-terminal-foreground': colors.foreground} as CSSProperties}
    onDragOver={event => {if (writable && files && connected && event.dataTransfer.types.includes('Files')) {event.preventDefault(); setDragging(true);}}}
    onDragLeave={event => {if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);}}
    onDrop={event => {setDragging(false); if (writable && files && connected) {event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void startUpload(file);}}}>
    <div ref={host} className="xterm-host" dir="ltr"/>
    <div className="terminal-toolbar" role="toolbar" aria-label={zh ? 'GoTTY 终端工具' : 'GoTTY terminal controls'}>
      <Button className="terminal-control terminal-connections" variant="ghost" size="xs" leadingIcon={RiUserLine} title={zh ? '连接数 / 分享管理' : 'Connections / Share manager'} aria-label={`${zh ? '连接数' : 'Connections'}: ${count}`} disabled={!owner || !controls || !connected} onClick={() => setShareOpen(true)}>{count}</Button>
      <Button className="terminal-control" variant="ghost" size="xs" iconOnly leadingIcon={RiFontSize} title={zh ? '显示设置' : 'Display settings'} aria-label={zh ? '显示设置' : 'Display settings'} onClick={() => setDisplayOpen(true)}/>
      {writable && <Button className="terminal-control" variant="ghost" size="xs" iconOnly leadingIcon={RiDeleteBinLine} title={zh ? '清理历史' : 'Clear history'} aria-label={zh ? '清理历史' : 'Clear history'} disabled={!connected} onClick={() => {controller.current?.send('clear\n'); controller.current?.term.clear(); controller.current?.term.focus();}}/>}
      {writable && files && <Button className="terminal-control" variant="ghost" size="xs" iconOnly leadingIcon={RiUpload2Line} title={zh ? '上传文件' : 'Upload file'} aria-label={zh ? '上传文件' : 'Upload file'} disabled={!connected || !!uploadAbort.current} onClick={() => uploadInput.current?.click()}/>}
      {owner && controls && <Button className="terminal-control" variant="ghost" size="xs" iconOnly leadingIcon={RiRestartLine} title={zh ? '重启 GoTTY' : 'Restart GoTTY'} aria-label={zh ? '重启 GoTTY' : 'Restart GoTTY'} disabled={!connected || !config.restart_mode || config.restart_mode === 'disabled'} onClick={() => {void control('restart').then(() => setMessage(zh ? '已发送重启请求，正在等待 GoTTY 重连…' : 'Restart requested. Waiting for GoTTY to reconnect…')).catch(error => setMessage(String(error.message || error)));}}/>}
      <Button className="terminal-control" variant="ghost" size="xs" iconOnly leadingIcon={RiServerLine} title={zh ? 'Hub 实例设置' : 'Hub instance settings'} aria-label={zh ? 'Hub 实例设置' : 'Hub instance settings'} onClick={onManage}/>
    </div>
    {config.show_terminal_state && terminalState && <div className="terminal-state text-caption-1-regular" dir="ltr">{terminalState.activeCols} × {terminalState.activeRows} · {terminalState.policy}</div>}
    {apiRunning && <div className="terminal-api-indicator text-caption-1-regular" role="status">API running</div>}
    {message && <div className="terminal-message text-caption-1-regular" role="status">{terminalMessage(message, locale)}</div>}
    {dragging && <div className="terminal-drop-overlay text-body-medium">{zh ? '松开以上传文件' : 'Drop files here to upload'}</div>}
    <div hidden><Input ref={uploadInput} type="file" aria-label={zh ? '选择上传文件' : 'Choose file to upload'} onChange={() => {const file = uploadInput.current?.files?.[0]; if (file) void startUpload(file); if (uploadInput.current) uploadInput.current.value = '';}}/></div>
    {writable && config.mobile_keys !== false && <div className="terminal-keys">{[['Esc', '\x1b'], ['Ctrl+C', '\x03'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C']].map(([label, value]) => <Button key={label} variant="secondary" disabled={!connected} onClick={() => {controller.current?.send(value); controller.current?.term.focus();}}>{label}</Button>)}</div>}
    <DisplaySettings open={displayOpen} onClose={() => setDisplayOpen(false)} appearance={appearance} themes={config.themes || FALLBACK_THEMES} fontSize={controller.current?.term.options.fontSize || 14} onChange={updateAppearance} locale={locale}/>
    <ShareManager open={shareOpen} onClose={() => setShareOpen(false)} control={control} enabled={config.share_enabled === true} locale={locale}/>
    <TransferModal transfer={transfer} locale={locale} onClose={() => setTransfer(null)}/>
    <Modal isOpen={!!upload} onOpenChange={value => {if (!value) closeUpload();}} size="sm"><ModalHeader title={zh ? '上传文件' : 'Upload file'} closeLabel={zh ? '关闭' : 'Close'}/><ModalBody><div className="flex flex-col gap-4"><p className="break-all">{upload?.name}</p><progress className="terminal-upload-progress" value={upload?.progress || 0} max={100}/><p>{upload?.progress}%</p><Button variant="secondary" onClick={closeUpload}>{upload?.done ? (zh ? '完成' : 'Done') : (zh ? '取消' : 'Cancel')}</Button></div></ModalBody></Modal>
  </section>;
}

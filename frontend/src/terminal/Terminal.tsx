import {useCallback, useEffect, useRef, useState, type CSSProperties} from 'react';
import {Terminal as Xterm} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {WebLinksAddon} from '@xterm/addon-web-links';
import {Unicode11Addon} from '@xterm/addon-unicode11';
import {ImageAddon} from '@xterm/addon-image';
import {WebglAddon} from '@xterm/addon-webgl';
import {WebTTY, type Terminal, type TerminalStatePayload} from '@gotty/terminal-core';
import {bindPaste} from '@gotty/terminal-core/paste';
import {describeGeometry} from '@gotty/terminal-core/geometry';
import {ViewportFollow} from '@gotty/terminal-core/viewport-follow';
import {reportPaste} from './PasteProgress';
import {VoiceInput} from '@gotty/terminal-core/voice-input';
import {defaultDisplayOptions, displayOptions, NORD_THEME, BUILTIN_THEMES, type Appearance} from '@gotty/terminal-core/appearance';
import {RiDeleteBinLine, RiUpload2Line, RiGroupLine, RiArrowDownLine} from '@remixicon/react';
import {Button} from '@/components/base/buttons/button';
import {InputBase} from '@/components/base/input/input';
import {AlertDialog, Modal, ModalBody, ModalHeader} from '@/components/base/modal/modal';
import {api} from '../api';
import {terminalMessage} from './messages';
import {createTransfer, TransferModal, type Transfer} from './Transfer';
import {uploadFile, uploadBytes, type UploadProgress} from './upload';
import {readAppearance, type TerminalConfig} from './appearance';
import {applyTerminalFont, fontDiagnostics, type FontApplication} from '@gotty/terminal-core/font-rendering';
import {FontStatus} from './FontStatus';
import {settingsAppearance, type TerminalSettings} from './settings';
import {ShareManager, type Control} from './ShareManager';
import {HubConnection} from './connection';
import {MobileKeys} from './MobileKeys';
import '@xterm/xterm/css/xterm.css';

type Controller = {refresh: () => void; term: Xterm; viewport: ViewportFollow; measure: () => void; send: (data: string) => void; view: () => void; control: Control; upload: (file: File, signal: AbortSignal, progress: (value: UploadProgress) => void) => Promise<boolean>};
type UploadState = UploadProgress & {file: File; status: 'uploading' | 'success' | 'sent' | 'error'; error?: string};
export type TerminalActions = {refresh: () => void; restart: () => void; restartAvailable: boolean; canRestart: boolean};
type Props = {onActions?: (id: string, actions: TerminalActions | undefined) => void; id: string; writable: boolean; visible: boolean; locale: string; asr?: boolean; files?: boolean; owner?: boolean; controls?: boolean; settings?: TerminalSettings | null; instanceName?: string; onAppearance?: (value: Appearance) => void; focusRequest?: number; onFocusHandled?: (id: string, request: number) => void};

export function RealTerminal({id, writable, visible, locale, asr = false, files = false, owner = false, controls = false, settings, instanceName, onAppearance, focusRequest = 0, onFocusHandled, onActions}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef(visible); view.current = visible;
  const controller = useRef<Controller>(undefined);
  const [terminal,setTerminal]=useState<Xterm>();
  const inputTransform=useRef<((data:string)=>string)|null>(null);
  const setInputTransform=useCallback((value:((data:string)=>string)|null)=>{inputTransform.current=value;},[]);
  const preferences = useRef<Record<string, unknown>>({});
  const appearanceRef = useRef<Appearance>({});
  appearanceRef.current = settings ? settingsAppearance(settings) : readAppearance(id);
  const reportAppearance = useRef(onAppearance); reportAppearance.current = onAppearance;
  const reportFocus = useRef(onFocusHandled); reportFocus.current = onFocusHandled;
  const aliveTerm = useRef<Xterm | undefined>(undefined);
  const appearanceEpoch = useRef(0);
  const configRef = useRef<TerminalConfig>({});
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | undefined>(undefined);
  const [config, setConfig] = useState<TerminalConfig>({});
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);
  const [count, setCount] = useState(0);
  const [terminalState, setTerminalState] = useState<TerminalStatePayload>();
  const [localSize, setLocalSize] = useState<{columns: number; rows: number}>();
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [upload, setUpload] = useState<UploadState>();
  const [dragging, setDragging] = useState(false);
  const [colors, setColors] = useState({background: NORD_THEME.background, foreground: NORD_THEME.foreground});
  const [fontStatus, setFontStatus] = useState<FontApplication>();
  const [apiRunning, setAPIRunning] = useState(false);
  const [following, setFollowing] = useState(true);
  const resumeInput = useCallback(() => controller.current?.viewport.userInput(), []);

  const [refreshConfirm, setRefreshConfirm] = useState(false);
  const refreshPending = useRef(false);
  const [restartConfirm, setRestartConfirm] = useState(false);
  const [restartError, setRestartError] = useState('');
  const restartPending = useRef(false);
  const zh = locale === 'zh-CN';
  const nameRef = useRef(instanceName || id); nameRef.current = instanceName || id;
  const named = (label: string) => label + ' · ' + (instanceName || id);
  const control = useCallback<Control>((action, payload = {}) => controller.current?.control(action, payload) ?? Promise.reject(Error('Terminal is disconnected')), []);

  function refreshTerminal() {
    if (refreshPending.current) return;
    refreshPending.current = true;
    setRefreshConfirm(false);
    uploadAbort.current?.abort();
    uploadAbort.current = undefined;
    setUpload(undefined); setTransfer(null); setMessage(''); setConnected(false);
    setShareOpen(false);
    controller.current?.refresh();
    refreshPending.current = false;
  }

  useEffect(() => {
    onActions?.(id, {
      refresh: () => {if (uploadAbort.current || transfer) setRefreshConfirm(true); else refreshTerminal();},
      restart: () => {if (owner && controls && connected && config.restart_mode && config.restart_mode !== 'disabled') {setRestartError(''); setRestartConfirm(true);}},
      restartAvailable: owner && controls,
      canRestart: !!(owner && controls && connected && config.restart_mode && config.restart_mode !== 'disabled'),
    });
    return () => onActions?.(id, undefined);
  }, [id, onActions, owner, controls, connected, config.restart_mode, transfer]);

  const applyAppearance = useCallback((term: Xterm, measure: () => void) => {
    const epoch = ++appearanceEpoch.current;
    const options = displayOptions(preferences.current, BUILTIN_THEMES, appearanceRef.current);
    const {fontFamily, ...display} = options;
    Object.assign(term.options, display);
    setColors({background: options.theme.background, foreground: options.theme.foreground});
    reportAppearance.current?.({theme: appearanceRef.current.theme || 'nord', fontSize: options.fontSize, fontFamily: options.fontFamily});
    measure();
    void applyTerminalFont({options: term.options, family: fontFamily,
      isCurrent: () => aliveTerm.current === term && appearanceEpoch.current === epoch,
      onChange: state => {fontDiagnostics(host.current, state); setFontStatus(state);}, onApplied: measure});
  }, []);
  useEffect(() => {const value = controller.current; if (value) applyAppearance(value.term, value.measure);}, [settings?.theme, settings?.fontSize, settings?.fontId, applyAppearance]);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let replaying = false;
    refreshPending.current = false;
    const term = new Xterm({...defaultDisplayOptions(), fontFamily: 'monospace', allowProposedApi: true, disableStdin: !writable});
    aliveTerm.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new WebLinksAddon()); term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11';
    try {term.loadAddon(new ImageAddon());} catch { /* Text renderer remains usable. */ }
    term.open(host.current); term.textarea?.setAttribute('autocomplete', 'off');
    const viewport = new ViewportFollow(term, host.current, setFollowing);
    setTerminal(term);
    const element = host.current;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {webgl.dispose(); element.dataset.terminalRenderer = 'dom';});
      term.loadAddon(webgl); element.dataset.terminalRenderer = 'webgl';
    } catch {element.dataset.terminalRenderer = 'dom';}
    let input: (data: string | Uint8Array) => void = () => {};
    let paste: (text: string, bracketed: boolean) => void = () => {};
    const unbindPaste = bindPaste(element, () => ({enabled: writable && !replaying && !term.options.disableStdin, bracketed: term.modes.bracketedPasteMode && !term.options.ignoreBracketedPasteMode}), (text, bracketed) => {viewport.userInput(); inputTransform.current?.(''); paste(text, bracketed);});
    let resize: (cols: number, rows: number) => void = () => {};
    let requestedSize: {cols: number; rows: number} | undefined;
    let serverSize: {cols: number; rows: number} | undefined;
    let bufferSize = 1024;
    let uploadAcknowledged = false;
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
        if (!disposed && view.current && host.current?.clientWidth && host.current?.clientHeight) {
          try {
            const size = fit.proposeDimensions();
            if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
            // Request the viewport size independently from the rendering grid.
            // GoTTY may enforce a minimum or use another client as PTY leader.
            // Fitting that output into a smaller grid corrupts full-screen apps.
            if (!requestedSize || size.cols !== requestedSize.cols || size.rows !== requestedSize.rows) {
              requestedSize = size;
              setLocalSize({columns: size.cols, rows: size.rows});
              resize(size.cols, size.rows);
            }
            const grid = serverSize || size;
            viewport.changeLayout(() => term.resize(grid.cols, grid.rows));
          } catch { /* Hidden pane or unavailable font metrics. */ }
        }
      });});
    };
    const installVoice = () => {
      voice?.close(); voice = null;
      if (!asr || !writable || !host.current) return;
      voice = new VoiceInput({enabled: true, permitWrite: true,
        holdMs: configRef.current.asr_hold_ms ?? 500, hotkeyCode: configRef.current.asr_hotkey || 'ShiftRight', authToken: '',
        term: {elem: host.current, showMessage, removeMessage: () => showMessage('', 0), disableStdin: () => {term.options.disableStdin = true;}, enableStdin: () => {term.options.disableStdin = !writable;}, sendInput: data => {viewport.userInput(); input(data);}},
        webSocketFactory: () => new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/terminal-connections/${id}/ws`),
        initialize: async ws => {const value = await api(`/instances/${id}/terminal-tickets`, {}); ws.send(JSON.stringify({ticket: value.ticket, channel: 'asr'}));},
      });
    };
    const makeTransfer = () => writable && files ? createTransfer(data => term.write(data), data => input(data), setTransfer, enabled => {term.options.disableStdin = !enabled || !writable;}) : null;
    let zmodem = makeTransfer();
    const adapter: Terminal & {setUploadFileBufferSize: (size: number) => void} = {
      setPasteSender: sender => {paste = sender;}, onPasteProgress: (state, cancel, dismiss) => {if (!disposed) reportPaste(id, nameRef.current, state, cancel, dismiss);},
      isVisible: () => view.current, onHistoryStatus: truncated => {if (host.current) host.current.dataset.historyTruncated = String(truncated); if (truncated) showMessage('Older output exceeded the retained history limit.', 6000);},
      info: () => ({columns: requestedSize?.cols ?? term.cols, rows: requestedSize?.rows ?? term.rows}), output: (data, replay) => {if (zmodem && !replay) zmodem.consume(data); else term.write(data);},
      flushOutput: callback => term.write(new Uint8Array(0), callback), setReplayMode: active => {replaying = active; viewport.setReplayMode(active); element.dataset.replayActive = String(active);},
      showMessage, removeMessage: () => showMessage('', 0), setWindowTitle: () => {},
      setPreferences: value => {
        preferences.current = value;
        uploadAcknowledged = !!value['hub-config'] && typeof value['hub-config'] === 'object' && (value['hub-config'] as TerminalConfig).upload_ack === true;
        if (value['hub-config'] && typeof value['hub-config'] === 'object') {configRef.current = value['hub-config'] as TerminalConfig; setConfig(configRef.current); installVoice();}
        altIsMeta = value['alt-is-meta'] === true; applyAppearance(term, measure);
      },
      updateConnectionCount: value => setCount(value), updateTerminalState: value => {
        setTerminalState(value);
        const {activeCols: cols, activeRows: rows} = value;
        if (Number.isInteger(cols) && cols > 0 && cols <= 4096 && Number.isInteger(rows) && rows > 0 && rows <= 4096) {
          serverSize = {cols, rows};
          viewport.changeLayout(() => term.resize(cols, rows));
        }
      },
      showAPIIndicator: execId => {apiExecutions.add(execId); setAPIRunning(true);}, hideAPIIndicator: execId => {apiExecutions.delete(execId); setAPIRunning(apiExecutions.size > 0);},
      setUploadFileBufferSize: size => {bufferSize = size;},
      onInput: callback => {input = callback;}, onResize: callback => {resize = callback;}, close: () => {}, reset: () => {viewport.reset(); term.reset();}, deactivate: () => {}, focus: () => {if (view.current && host.current?.parentElement?.contains(document.activeElement)) term.focus();}, scrollToBottom: viewport.layout,
    };
    const viewing = () => view.current && document.visibilityState === 'visible' && document.hasFocus() && !!host.current?.contains(document.activeElement);
    const wt = new WebTTY(adapter, {create: () => {uploadAcknowledged = false; bufferSize = 1024; connection = new HubConnection(id, writable, owner, controls, viewing, () => view.current); return connection;}}, '', '', 'hub:' + id);
    wt.onConnect = () => {if (!disposed) setConnected(true);}; wt.onDisconnect = () => {if (!disposed) {setConnected(false); setCount(0);}};
    const subscription = term.onData(data => {if (writable && !replaying) input(inputTransform.current?.(data)??data);});
    const binary = term.onBinary(data => {if (writable && !replaying) input(Uint8Array.from(data, char => char.charCodeAt(0)));});
    term.attachCustomKeyEventHandler(event => {
      if (!writable || !altIsMeta || event.type !== 'keydown' || !event.altKey || event.ctrlKey || event.metaKey || event.code === 'Tab') return true;
      const char = /^Key[A-Z]$/.test(event.code) ? (event.shiftKey ? event.code[3] : event.code[3].toLowerCase()) : event.key.length === 1 ? event.key : '';
      if (!char) return true; viewport.userInput(); input(`\x1b${char}`); event.preventDefault(); return false;
    });
    const copy = async (text: string) => {
      if (!text || !view.current) return;
      try {if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
          const previousFocus = document.activeElement;
          const field = document.createElement('textarea'); field.value = text; field.style.position = 'fixed'; field.style.opacity = '0'; host.current?.appendChild(field);
          try {field.select(); document.execCommand('copy');}
          finally {field.remove(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();}
        }
      } catch {return;}
      if (!disposed) showMessage('Copied to clipboard', 1400);
    };
    const selection = term.onSelectionChange(() => {if (term.hasSelection()) void copy(term.getSelection());});
    const osc = term.parser.registerOscHandler(52, data => {if (replaying) return true; const payload = data.slice(data.indexOf(';') + 1); if (data.includes(';') && payload && payload !== '?') {try {void copy(new TextDecoder().decode(Uint8Array.from(atob(payload), char => char.charCodeAt(0))));} catch { /* Invalid clipboard sequence. */ }} return true;});
    const observer = new ResizeObserver(measure); observer.observe(host.current); applyAppearance(term, measure);
    void document.fonts?.ready.then(()=>{if(!disposed)measure();});
    document.fonts?.addEventListener('loadingdone',measure);
    const stop = wt.open(); installVoice();
    const viewportChanged = () => {if (view.current && (!window.visualViewport || Math.abs(window.visualViewport.scale - 1) < 0.01)) {measure(); viewport.layout();}};
    window.visualViewport?.addEventListener('resize', viewportChanged);
    window.visualViewport?.addEventListener('scroll', viewportChanged);
    const report = () => connection?.reportView(); const interval = setInterval(report, 3000);
    document.addEventListener('visibilitychange', report); window.addEventListener('focus', report); window.addEventListener('blur', report); document.addEventListener('focusin', report);
    controller.current = {refresh: () => {zmodem?.dispose(); zmodem=makeTransfer(); term.options.disableStdin = !writable; wt.reconnectNow(); measure();}, term, viewport, measure, send: data => {if (writable) {viewport.userInput(); input(data);}}, view: () => {report(); wt.reportVisibility(); viewport.layout();},
      control: (action, payload) => connection?.request(action, payload) ?? Promise.reject(Error('Terminal is disconnected')),
      upload: async (file, signal, progress) => {
        if (!writable || !files) throw Error('File upload requires write permission');
        if (disposed || !connection) throw Error('Terminal is disconnected');
        return uploadFile(file, connection, bufferSize, uploadAcknowledged, signal, progress);
      },
    };
    return () => {
      disposed = true; if (aliveTerm.current === term) aliveTerm.current = undefined; uploadAbort.current?.abort(); uploadAbort.current = undefined; setUpload(undefined); clearTimeout(messageTimer); cancelAnimationFrame(fitFrame); voice?.close(); zmodem?.dispose();
      window.visualViewport?.removeEventListener('resize', viewportChanged); window.visualViewport?.removeEventListener('scroll', viewportChanged); controller.current = undefined; clearInterval(interval);
      document.removeEventListener('visibilitychange', report); window.removeEventListener('focus', report); window.removeEventListener('blur', report); document.removeEventListener('focusin', report);
      stop(); unbindPaste(); reportPaste(id, nameRef.current, undefined); observer.disconnect(); subscription.dispose(); binary.dispose(); selection.dispose(); osc.dispose(); viewport.dispose(); term.dispose();
      document.fonts?.removeEventListener('loadingdone',measure);
    };
  }, [id, writable, asr, files, owner, controls, applyAppearance]);
  // Browsers using DOM font measurement cannot measure a hidden pane. Reapply
  // its loaded font when shown so it does not retain the old cell dimensions.
  useEffect(() => {if (visible) {const value = controller.current; if (value) applyAppearance(value.term, value.measure);} else {setShareOpen(false);} controller.current?.view();}, [visible, applyAppearance]);
  useEffect(() => {
    if (!visible || !focusRequest) return;
    let frame = 0;
    const started = performance.now();
    const focus = () => {
      // React Aria restores its trigger after an exiting dialog unmounts.
      // Wait for that restoration, and never steal focus from a new dialog.
      const overlays = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [role=listbox]')];
      if (overlays.length) {
        if (performance.now() - started < 1500 && overlays.every(element => element.closest('[data-exiting]'))) frame = requestAnimationFrame(focus);
        else reportFocus.current?.(id, focusRequest);
        return;
      }
      controller.current?.term.focus();
      reportFocus.current?.(id, focusRequest);
    };
    frame = requestAnimationFrame(() => {frame = requestAnimationFrame(focus);});
    return () => cancelAnimationFrame(frame);
  }, [visible, focusRequest, id]);

  async function startUpload(file: File) {
    if (uploadAbort.current) return;
    const abort = new AbortController(); uploadAbort.current = abort; setUpload({file, loaded: 0, progress: 0, status: 'uploading'});
    try {
      if (!controller.current) throw Error('Terminal is disconnected');
      const verified = await controller.current.upload(file, abort.signal, value => {if (!abort.signal.aborted) setUpload({file, ...value, status: 'uploading'});});
      if (!abort.signal.aborted) setUpload({file, loaded: file.size, progress: 100, status: verified ? 'success' : 'sent'});
    }
    catch (error) {if (!abort.signal.aborted) setUpload(value => value ? {...value, status: 'error', error: error instanceof Error ? error.message : String(error)} : value);}
    finally {if (uploadAbort.current === abort) {uploadAbort.current = undefined; if (abort.signal.aborted) setUpload(undefined);}}
  }
  const closeUpload = () => {uploadAbort.current?.abort(); uploadAbort.current = undefined; setUpload(undefined); controller.current?.term.focus();};
  return <section className="real-terminal dark" style={{'--color-terminal-background': colors.background, '--color-terminal-foreground': colors.foreground} as CSSProperties}
    onDragOver={event => {if (writable && files && connected && event.dataTransfer.types.includes('Files')) {event.preventDefault(); setDragging(true);}}}
    onDragLeave={event => {if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);}}
    onDrop={event => {setDragging(false); if (writable && files && connected) {event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void startUpload(file);}}}>
    <div ref={host} className="xterm-host" dir="ltr"/>
    {fontStatus?.status === 'fallback' && <div className="terminal-font-notice"><FontStatus value={fontStatus} locale={locale}/></div>}
    <div className="terminal-toolbar" role="toolbar" aria-label={named(zh ? 'GoTTY 终端工具' : 'GoTTY terminal controls')}>
      <ShareManager open={shareOpen} onOpenChange={setShareOpen} trigger={<Button className="terminal-control terminal-connections" variant="ghost" size="xs" leadingIcon={RiGroupLine} title={named(zh ? '连接数 / 分享管理' : 'Connections / Share manager') + '\n' + describeGeometry(terminalState, localSize, locale)} aria-label={named(`${zh ? '连接数' : 'Connections'}: ${count}`)} disabled={!owner || !controls || !connected}>{count}</Button>} control={control} enabled={config.share_enabled === true} locale={locale}/>
      {writable && <Button className="terminal-control terminal-clear-control" variant="ghost" size="xs" iconOnly leadingIcon={RiDeleteBinLine} title={named(zh ? '清理历史' : 'Clear history')} aria-label={named(zh ? '清理历史' : 'Clear history')} disabled={!connected} onClick={() => {controller.current?.send('clear\n'); controller.current?.term.clear(); controller.current?.term.focus();}}/>}
      {writable && files && <Button className="terminal-control terminal-upload-control" variant="ghost" size="xs" iconOnly leadingIcon={RiUpload2Line} title={named(zh ? '上传文件' : 'Upload file')} aria-label={named(zh ? '上传文件' : 'Upload file')} disabled={!connected || !!uploadAbort.current} onClick={() => uploadInput.current?.click()}/>}
    </div>
    {config.show_terminal_state && terminalState && <div className="terminal-state text-caption-1-regular" dir="ltr">{terminalState.activeCols} × {terminalState.activeRows} · {terminalState.policy}</div>}
    {apiRunning && <div className="terminal-api-indicator text-caption-1-regular" role="status">API running</div>}
    {message && <div className="terminal-message text-caption-1-regular" role="status">{terminalMessage(message, locale)}</div>}
    {dragging && <div className="terminal-drop-overlay text-body-medium">{zh ? '松开以上传文件' : 'Drop files here to upload'}</div>}
    {/* FileList must bypass TextField's controlled string value. */}
    <div hidden><InputBase ref={uploadInput} type="file" aria-label={zh ? '选择上传文件' : 'Choose file to upload'} onChange={event => {const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void startUpload(file);}}/></div>
    {!following && <Button className="terminal-return-input" variant="secondary" size="small" leadingIcon={RiArrowDownLine} onPointerDown={event => event.preventDefault()} onClick={() => {resumeInput(); controller.current?.term.focus();}}>{zh ? '回到输入位置' : 'Return to input'}</Button>}
    <MobileKeys term={terminal} enabled={writable&&visible&&connected&&config.mobile_keys!==false} transform={setInputTransform} locale={locale} onInput={resumeInput}/>
    <TransferModal transfer={transfer} locale={locale} onClose={() => setTransfer(null)}/>
    <AlertDialog isOpen={restartConfirm} onOpenChange={setRestartConfirm} title={zh ? '重启 GoTTY' : 'Restart GoTTY'} description={zh ? `确认重启“${instanceName || id}”？此实例的连接和正在运行的命令可能中断。` : `Restart “${instanceName || id}”? Connections and running commands on this instance may be interrupted.`} confirmLabel={zh ? '重启' : 'Restart'} cancelLabel={zh ? '取消' : 'Cancel'} pendingLabel={zh ? '发送中…' : 'Sending…'} isConfirmDisabled={!owner || !controls || !connected || !config.restart_mode || config.restart_mode === 'disabled'} onConfirm={async () => {
      if (restartPending.current || !owner || !controls || !connected || !config.restart_mode || config.restart_mode === 'disabled') return;
      restartPending.current = true;
      try {await control('restart'); setMessage(zh ? '已发送重启请求，正在等待 GoTTY 重连…' : 'Restart requested. Waiting for GoTTY to reconnect…');}
      catch (error) {setRestartError(String(error instanceof Error ? error.message : error)); throw error;}
      finally {restartPending.current = false;}
    }}>{restartError && <p role="alert" className="text-text-error-primary">{restartError}</p>}</AlertDialog>
    <Modal isOpen={refreshConfirm} onOpenChange={setRefreshConfirm} size="sm"><ModalHeader title={zh ? '刷新当前终端' : 'Refresh current terminal'} closeLabel={zh ? '取消' : 'Cancel'}/><ModalBody><div className="flex flex-col gap-4"><p>{zh ? '刷新会中断当前文件传输。远端命令会继续运行。' : 'Refreshing interrupts the current file transfer. Remote commands keep running.'}</p><Button onClick={refreshTerminal}>{zh ? '中断传输并刷新' : 'Stop transfer and refresh'}</Button><Button variant="secondary" onClick={() => setRefreshConfirm(false)}>{zh ? '取消' : 'Cancel'}</Button></div></ModalBody></Modal>
    <Modal isOpen={!!upload} onOpenChange={value => {if (!value) closeUpload();}} size="sm"><ModalHeader title={zh ? '上传文件' : 'Upload file'} closeLabel={zh ? '关闭' : 'Close'}/><ModalBody>{upload && <div className="flex flex-col gap-4">
      <p className="break-all"><bdi>{upload.file.name}</bdi></p>
      <progress className="terminal-upload-progress" aria-label={zh ? '上传进度' : 'Upload progress'} value={upload.progress} max={100}/>
      <p className="text-body-2-regular text-text-secondary">{upload.progress}% · {uploadBytes(upload.loaded)} / {uploadBytes(upload.file.size)}</p>
      {upload.status === 'error' ? <p role="alert" className="text-text-error-primary">{zh ? '上传失败：' : 'Upload failed: '}{terminalMessage(upload.error || '', locale)}</p> : <p role="status" className="break-all">
        {upload.status === 'success' ? (zh ? `上传成功：${upload.file.name}` : `Uploaded: ${upload.file.name}`) : upload.status === 'sent' ? (zh ? `已发送：${upload.file.name}。当前 GoTTY 不支持写入确认，请在终端中确认文件。` : `Sent: ${upload.file.name}. This GoTTY version cannot confirm the saved file. Check it in the terminal.`) : (zh ? '正在上传到终端当前目录…' : 'Uploading to the terminal working directory…')}
      </p>}
      {upload.status === 'error' && <Button disabled={!connected} onClick={() => void startUpload(upload.file)}>{zh ? '重试' : 'Retry'}</Button>}
      <Button variant="secondary" onClick={closeUpload}>{upload.status === 'uploading' ? (zh ? '取消' : 'Cancel') : upload.status === 'error' ? (zh ? '关闭' : 'Close') : (zh ? '完成' : 'Done')}</Button>
    </div>}</ModalBody></Modal>
  </section>;
}

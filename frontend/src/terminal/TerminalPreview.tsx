import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {Terminal as Xterm} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {Unicode11Addon} from '@xterm/addon-unicode11';
import {WebglAddon} from '@xterm/addon-webgl';
import {BUILTIN_THEMES, defaultDisplayOptions, displayOptions} from '@gotty/terminal-core/appearance';
import {applyTerminalFont, fontDiagnostics, type FontApplication} from '@gotty/terminal-core/font-rendering';
import {FontStatus} from './FontStatus';
import {DEFAULT_SETTINGS, settingsAppearance, type TerminalSettings} from './settings';
import '@xterm/xterm/css/xterm.css';

const SAMPLE_LINES = [
  '$ printf "Hello, GoTTY!"',
  'Hello, GoTTY!  中文 λ →',
  'Normal  \x1b[1mBold 0123456789 Aa #@\x1b[0m',
  '\x1b[48;5;22m+ const added = "清晰";       \x1b[0m',
  '\x1b[48;5;52m- const removed = "text";     \x1b[0m',
  '\x1b[31mError  \x1b[33mWarning  \x1b[32mSuccess  \x1b[34mInfo\x1b[0m',
  '┌──────────────────────────┐',
  '│  box drawing  ─ │ ┼      │',
  '└──────────────────────────┘',
];

// A local, read-only xterm. It owns no connection and never requests focus, so
// experimenting with display settings cannot type into or resize a live PTY.
export function TerminalPreview({settings, locale}: {settings: TerminalSettings; locale: string}) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<{term: Xterm; measure: () => void} | undefined>(undefined);
  const [fontStatus, setFontStatus] = useState<FontApplication>();
  const validSize = Number.isInteger(settings.fontSize) && settings.fontSize >= 8 && settings.fontSize <= 48;
  const safe = {...settings, fontSize: validSize ? settings.fontSize : DEFAULT_SETTINGS.fontSize};
  const colors = BUILTIN_THEMES[safe.theme] || BUILTIN_THEMES.nord;
  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    const term = new Xterm({...defaultDisplayOptions(), fontFamily: 'monospace', cols: 44, rows: SAMPLE_LINES.length,
      allowProposedApi: true, disableStdin: true, scrollback: 0});
    const fit = new FitAddon();
    term.loadAddon(fit); term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11';
    term.open(element);
    if (term.textarea) term.textarea.tabIndex = -1;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {webgl.dispose(); element.dataset.terminalRenderer = 'dom';});
      term.loadAddon(webgl); element.dataset.terminalRenderer = 'webgl';
    } catch {element.dataset.terminalRenderer = 'dom';}
    term.write('\x1b[?25l' + SAMPLE_LINES.join('\r\n'));
    let frame = 0, disposed = false;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {frame = requestAnimationFrame(() => {
        if (disposed || !element.clientWidth) return;
        const size = fit.proposeDimensions();
        if (size) term.resize(Math.max(44, size.cols), SAMPLE_LINES.length);
      });});
    };
    controller.current = {term, measure};
    const observer = new ResizeObserver(measure); observer.observe(element);
    measure();
    return () => {disposed = true; controller.current = undefined; cancelAnimationFrame(frame); observer.disconnect(); term.dispose();};
  }, []);
  useEffect(() => {
    const value = controller.current; if (!value) return;
    let current = true;
    const {fontFamily, ...options} = displayOptions({}, BUILTIN_THEMES, settingsAppearance(safe));
    Object.assign(value.term.options, options, {scrollback: 0});
    value.measure();
    void applyTerminalFont({options: value.term.options, family: fontFamily,
      isCurrent: () => current && controller.current === value,
      onChange: state => {fontDiagnostics(host.current, state); setFontStatus(state);}, onApplied: value.measure});
    return () => {current = false;};
  }, [safe.theme, safe.fontId, safe.fontSize]);
  return <>
    <div className="terminal-settings-preview" dir="ltr" style={{background: colors.background, color: colors.foreground} as CSSProperties}>
      <div ref={host} className="terminal-preview-host" role="group" aria-label={locale === 'zh-CN' ? '终端字体预览（只读）' : 'Terminal font preview (read only)'}/>
    </div>
    <FontStatus value={fontStatus} locale={locale}/>
  </>;
}

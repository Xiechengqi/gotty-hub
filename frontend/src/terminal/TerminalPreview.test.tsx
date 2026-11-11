import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {TerminalPreview} from './TerminalPreview';
import {DEFAULT_SETTINGS} from './settings';

const state = vi.hoisted(() => ({terms: [] as any[]}));
vi.mock('@xterm/xterm', () => ({Terminal: class {
  options: any; unicode = {activeVersion: '6'}; textarea = document.createElement('textarea');
  dispose = vi.fn(); resize = vi.fn(); write = vi.fn(); focus = vi.fn();
  constructor(options: any) {this.options = options; state.terms.push(this);}
  loadAddon() {} open(element: HTMLElement) {element.append(this.textarea);}
}}));
vi.mock('@xterm/addon-fit', () => ({FitAddon: class {proposeDimensions() {return {cols: 60, rows: 8};}}}));
vi.mock('@xterm/addon-unicode11', () => ({Unicode11Addon: class {}}));
vi.mock('@xterm/addon-webgl', () => ({WebglAddon: class {onContextLoss() {}}}));
vi.mock('@gotty/terminal-core/fonts', async original => {
  const actual = await original<typeof import('@gotty/terminal-core/fonts')>();
  return {...actual, ensureFont: vi.fn(async (id: string) => ({fontFamily: actual.fontById(id)!.value, cached: true}))};
});
let node: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  state.terms = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
  vi.stubGlobal('WebSocket', vi.fn(() => {throw Error('preview must stay local');}));
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals();});

it('renders ANSI locally, updates the existing preview and disposes it on close without focus or sockets', async () => {
  await act(async () => root.render(<TerminalPreview settings={DEFAULT_SETTINGS} locale="zh-CN"/>));
  const term = state.terms[0];
  expect(term.options).toMatchObject({disableStdin: true, scrollback: 0, fontFamily: "'DejaVu Sans Mono', monospace", fontWeight: 400, fontWeightBold: 700});
  expect(term.write.mock.calls[0][0]).toContain('\x1b[48;5;22m');
  expect(term.write.mock.calls[0][0]).toContain('\x1b[1m');
  expect(term.write.mock.calls[0][0]).toContain('\x1b[31mError');
  expect(term.textarea.tabIndex).toBe(-1);
  await act(async () => root.render(<TerminalPreview settings={{...DEFAULT_SETTINGS, fontId: 'source-code-pro', fontSize: 24}} locale="zh-CN"/>));
  expect(state.terms).toHaveLength(1);
  expect(term.options).toMatchObject({fontSize: 24, fontFamily: "'Source Code Pro', monospace"});
  expect(node.querySelector('.terminal-preview-host')?.getAttribute('data-font-applied')).toBe("'Source Code Pro', monospace");
  expect(term.focus).not.toHaveBeenCalled(); expect(WebSocket).not.toHaveBeenCalled();
  await act(async () => root.render(null)); expect(term.dispose).toHaveBeenCalledOnce();
});

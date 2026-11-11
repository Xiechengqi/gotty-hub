import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {RiCheckLine} from '@remixicon/react';
import {BUILTIN_THEMES, FONT_FAMILIES, FONT_SIZES, themeLabel, type Appearance} from '@gotty/terminal-core/appearance';
import {ensureFont, fontById, fontState, inspectFontCache, subscribeFonts, type FontState} from '@gotty/terminal-core/fonts';
import {Button} from '@/components/base/buttons/button';
import {Input} from '@/components/base/input/input';
import {Modal, ModalBody, ModalFooter, ModalHeader} from '@/components/base/modal/modal';
import {errorText} from '../errors';
import {DEFAULT_SETTINGS, migrateAppearance, validSettings, type SettingsSnapshot, type TerminalSettings as Settings} from './settings';

export function TerminalSettings({open, onClose, snapshot, legacy, locale, loading, loadError, onSave}: {
  open: boolean; onClose: () => void; snapshot: SettingsSnapshot; legacy?: Appearance; locale: string; loading: boolean;
  loadError: string; onSave: (settings: Settings, revision: number) => Promise<void>;
}) {
  const zh = locale === 'zh-CN';
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingFont, setPendingFont] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const selection = useRef(0), revision = useRef(0);
  const latest = useRef({snapshot, legacy}); latest.current = {snapshot, legacy};
  useEffect(() => subscribeFonts(() => redraw(value => value + 1)), []);
  useEffect(() => {
    ++selection.current;
    if (!open) return;
    const initial = latest.current.snapshot.settings || migrateAppearance(latest.current.legacy);
    revision.current = latest.current.snapshot.revision;
    setDraft(initial); setError(''); setSaving(false); setPendingFont(null);
    void inspectFontCache();
    void ensureFont(initial.fontId).catch(() => {void ensureFont('source-code-pro').catch(() => {});});
    return () => {++selection.current;};
  }, [open]);
  async function selectFont(id: string) {
    const current = ++selection.current; setPendingFont(id); setError('');
    try {
      await ensureFont(id);
      if (current === selection.current) setDraft(value => ({...value, fontId: id}));
    } catch {if (current === selection.current) setError(zh ? '字体加载失败，请重试或选择其他字体。' : 'Unable to load this font. Retry or choose another font.');}
    finally {if (current === selection.current) setPendingFont(null);}
  }
  async function save() {
    if (saving || pendingFont || !validSettings(draft)) return;
    setSaving(true); setError('');
    try {if (fontState(draft.fontId) !== 'unavailable') await ensureFont(draft.fontId); await onSave(draft, revision.current); onClose();}
    catch (error) {setError(errorText(error instanceof Error ? error.message : String(error), locale));}
    finally {setSaving(false);}
  }
  if (!open) return null;
  const labels: Record<FontState, string> = zh
    ? {downloadable: '点击下载', loading: '加载中…', cached: '已缓存', ready: '已加载', system: '系统字体', unavailable: '当前设备不可用', error: '下载失败，点击重试'}
    : {downloadable: 'Download', loading: 'Loading…', cached: 'Cached', ready: 'Loaded', system: 'System font', unavailable: 'Unavailable on this device', error: 'Download failed · Retry'};
  const colors = BUILTIN_THEMES[draft.theme] || BUILTIN_THEMES.nord;
  const previewFont = fontState(draft.fontId) === 'unavailable' || fontState(draft.fontId) === 'error' ? DEFAULT_SETTINGS.fontId : draft.fontId;
  return <Modal isOpen={open} onOpenChange={value => {if (!value && !saving) onClose();}} isDismissable={!saving} isKeyboardDismissDisabled={saving} size="lg" className="terminal-settings-dialog" overlayClassName="terminal-settings-overlay">
    <ModalHeader title={zh ? '终端设置' : 'Terminal settings'} description={zh ? '保存后应用于当前账号的全部终端。' : 'Apply to all terminals in your account.'} closeLabel={zh ? '取消' : 'Cancel'} showCloseButton={!saving}/>
    <ModalBody><div className="flex flex-col gap-6">
      {(error || loadError) && <p role="alert" className="text-text-error-primary">{error || errorText(loadError, locale)}</p>}
      <section className="flex flex-col gap-2"><h3 className="text-body-medium text-text-primary">{zh ? '配色主题' : 'Color theme'}</h3>
        <div className="terminal-settings-themes">{Object.entries(BUILTIN_THEMES).map(([name, theme]) => <Button key={name} variant="secondary" disabled={saving} aria-pressed={draft.theme === name} onClick={() => setDraft(value => ({...value, theme: name}))} trailingIcon={draft.theme === name ? RiCheckLine : undefined}>
          <span className="terminal-settings-swatch" style={{background: theme.background, color: theme.foreground}}>Aa</span>{themeLabel(name)}
        </Button>)}</div>
      </section>
      <section className="flex flex-col gap-2"><Input label={zh ? '文字大小（8–48px）' : 'Text size (8–48px)'} aria-label={zh ? '文字大小（px）' : 'Text size (px)'} type="number" inputMode="numeric" isDisabled={saving} value={String(draft.fontSize)} onChange={value => setDraft(previous => ({...previous, fontSize: Number(value)}))}/>
        <div className="flex flex-wrap gap-2">{FONT_SIZES.map(size => <Button key={size} size="small" variant="secondary" disabled={saving} aria-pressed={draft.fontSize === size} onClick={() => setDraft(value => ({...value, fontSize: size}))}>{size}px</Button>)}</div>
      </section>
      <section className="flex flex-col gap-2"><h3 className="text-body-medium text-text-primary">{zh ? '字体' : 'Font family'}</h3>
        {FONT_FAMILIES.map(font => {const state = fontState(font.id); return <Button key={font.id} className="terminal-settings-font" variant="secondary" disabled={state === 'unavailable' || state === 'loading' || saving} aria-pressed={draft.fontId === font.id} trailingIcon={draft.fontId === font.id ? RiCheckLine : undefined} onClick={() => void selectFont(font.id)}>
          <span>{font.name}</span><span className="text-caption-1-regular text-text-tertiary">{labels[state]}</span>
        </Button>;})}
      </section>
      <section className="flex flex-col gap-2"><h3 className="text-body-medium text-text-primary">{zh ? '预览' : 'Preview'}</h3>
        <div className="terminal-settings-preview" dir="ltr" style={{background: colors.background, color: colors.foreground, fontSize: `${validSettings(draft) ? draft.fontSize : 14}px`, fontFamily: fontById(previewFont)?.value} as CSSProperties}>
          <div>$ printf 'Hello, GoTTY Hub!'</div><div>Hello, GoTTY Hub! 中文 λ →</div><div>┌──────────────┐</div><div>│ 0123456789 Aa │</div><div>└──────────────┘</div>
        </div>
      </section>
    </div></ModalBody>
    <ModalFooter><Button variant="ghost" disabled={saving} onClick={() => {setDraft(DEFAULT_SETTINGS); void selectFont(DEFAULT_SETTINGS.fontId);}}>{zh ? '恢复默认' : 'Restore defaults'}</Button><Button variant="secondary" disabled={saving} onClick={onClose}>{zh ? '取消' : 'Cancel'}</Button><Button disabled={saving || loading || !!pendingFont || !validSettings(draft)} aria-busy={saving || undefined} onClick={() => void save()}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存并应用' : 'Save and apply')}</Button></ModalFooter>
  </Modal>;
}

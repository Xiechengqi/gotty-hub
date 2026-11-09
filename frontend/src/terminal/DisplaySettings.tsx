import {useMemo} from 'react';
import {DEFAULT_FONT_FAMILY, DEFAULT_THEME, FONT_FAMILIES, FONT_SIZES, isFontAvailable, themeLabel, type Appearance, type ThemeMap} from '@gotty/terminal-core/appearance';
import {Button} from '@/components/base/buttons/button';
import {Modal, ModalBody, ModalHeader} from '@/components/base/modal/modal';

export function DisplaySettings({open, onClose, appearance, themes, fontSize, onChange, locale}: {
  open: boolean; onClose: () => void; appearance: Appearance; themes: ThemeMap; fontSize: number;
  onChange: (value: Appearance) => void; locale: string;
}) {
  const zh = locale === 'zh-CN';
  const fonts = useMemo(() => FONT_FAMILIES.map(font => ({...font, available: isFontAvailable(font.name)})), []);
  return <Modal isOpen={open} onOpenChange={value => {if (!value) onClose();}} size="sm" overlayClassName="terminal-display-overlay">
    <ModalHeader title={zh ? '显示设置' : 'Display settings'} closeLabel={zh ? '关闭' : 'Close'}/>
    <ModalBody><div className="flex flex-col gap-4">
      <div><h3 className="text-caption-1-semibold text-text-secondary">{zh ? '主题' : 'Themes'}</h3><div className="terminal-setting-options">
        {Object.keys(themes).map(name => <Button key={name} size="small" variant="secondary" aria-pressed={(appearance.theme || DEFAULT_THEME) === name} onClick={() => onChange({...appearance, theme: name})}>{themeLabel(name)}</Button>)}
      </div></div>
      <div><h3 className="text-caption-1-semibold text-text-secondary">{zh ? '字号' : 'Font size'}</h3><div className="terminal-setting-options">
        {FONT_SIZES.map(size => <Button key={size} size="small" variant="secondary" aria-pressed={fontSize === size} onClick={() => onChange({...appearance, fontSize: size})}>{size}</Button>)}
      </div></div>
      <div><h3 className="text-caption-1-semibold text-text-secondary">{zh ? '字体' : 'Font family'}</h3><div className="terminal-font-options">
        {fonts.map(font => <Button key={font.value} size="small" variant="secondary" disabled={!font.available} aria-pressed={(appearance.fontFamily || DEFAULT_FONT_FAMILY) === font.value} onClick={() => onChange({...appearance, fontFamily: font.value})}>{font.name}{!font.available && (zh ? ' · 未安装' : ' · not installed')}</Button>)}
      </div></div>
    </div></ModalBody>
  </Modal>;
}

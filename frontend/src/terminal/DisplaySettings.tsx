import {useMemo, type ReactElement} from 'react';
import {RiCheckLine} from '@remixicon/react';
import {DEFAULT_FONT_FAMILY, DEFAULT_THEME, FONT_FAMILIES, FONT_SIZES, isFontAvailable, themeLabel, type Appearance, type ThemeMap} from '@gotty/terminal-core/appearance';
import {Button} from '@/components/base/buttons/button';
import {Popover, PopoverTrigger} from '@/components/base/popover/popover';
import {ScrollFade, useScrollFade} from '@/components/foundations/scroll-fade/scroll-fade';

export function DisplaySettings({open, onOpenChange, trigger, appearance, themes, fontSize, onChange, locale}: {
  open: boolean; onOpenChange: (value:boolean) => void; trigger: ReactElement; appearance: Appearance; themes: ThemeMap; fontSize: number;
  onChange: (value: Appearance) => void; locale: string;
}) {
  const zh = locale === 'zh-CN';
  const fade=useScrollFade();
  const fonts = useMemo(() => FONT_FAMILIES.map(font => ({...font, available: isFontAvailable(font.name)})), []);
  return <PopoverTrigger isOpen={open} onOpenChange={value=>{fade.reset();onOpenChange(value);}}>{trigger}
    <Popover placement="left top" offset={8} className="terminal-popover terminal-display-popover dark" dialogClassName="terminal-popover-dialog" aria-label={zh?'显示设置':'Display settings'}>
      <div className="terminal-popover-scroll" onScroll={fade.onScroll}>
        <h3 className="terminal-section-title text-caption-2-semibold">{zh ? '主题' : 'Themes'}</h3>
        {Object.keys(themes).map(name => <Button className="terminal-theme-item" key={name} size="small" variant="ghost" trailingIcon={(appearance.theme || DEFAULT_THEME)===name?RiCheckLine:undefined} aria-pressed={(appearance.theme || DEFAULT_THEME) === name} onClick={() => onChange({...appearance, theme: name})}>
          <span className="terminal-theme-swatch" style={{background:themes[name].background}}/>{themeLabel(name)}
        </Button>)}
        <div className="terminal-section-divider"/>
        <h3 className="terminal-section-title text-caption-2-semibold">{zh ? '字号' : 'Font size'}</h3>
        <div className="terminal-setting-options terminal-font-sizes">
          {FONT_SIZES.map(size => <Button key={size} size="xs" variant="secondary" aria-pressed={fontSize === size} onClick={() => onChange({...appearance, fontSize: size})}>{size}</Button>)}
        </div>
        <div className="terminal-section-divider"/>
        <h3 className="terminal-section-title text-caption-2-semibold">{zh ? '字体' : 'Font family'}</h3>
        <div className="terminal-font-options">
          {fonts.map(font => <Button key={font.value} size="small" variant="ghost" disabled={!font.available} trailingIcon={(appearance.fontFamily || DEFAULT_FONT_FAMILY)===font.value?RiCheckLine:undefined} aria-pressed={(appearance.fontFamily || DEFAULT_FONT_FAMILY) === font.value} onClick={() => onChange({...appearance, fontFamily: font.value})}>
            <span style={{fontFamily:font.value}}>{font.name}</span>{!font.available && <span className="text-caption-2-regular">{zh?'未安装':'not installed'}</span>}
          </Button>)}
        </div>
      </div>
      <ScrollFade progress={fade.progress}/>
    </Popover>
  </PopoverTrigger>;
}

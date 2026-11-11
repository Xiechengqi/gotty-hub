import {fontById, fontIdForFamily} from '@gotty/terminal-core/fonts';
import type {FontApplication} from '@gotty/terminal-core/font-rendering';

export function FontStatus({value, locale}: {value?: FontApplication; locale: string}) {
  if (!value) return null;
  const zh = locale === 'zh-CN';
  const name = fontById(fontIdForFamily(value.appliedFamily) || '')?.name || value.appliedFamily;
  const text = value.status === 'loading' ? (zh ? '字体加载中…' : 'Loading font…')
    : value.status === 'fallback' ? (zh ? `所选字体暂不可用，当前使用 ${name}。可在终端设置中重新选择字体。` : `Selected font unavailable. Using ${name}. Choose a font in Terminal settings to retry.`)
    : (zh ? `当前字体：${name}` : `Current font: ${name}`);
  return <p role="status" className="text-caption-1-regular text-text-secondary">{text}</p>;
}

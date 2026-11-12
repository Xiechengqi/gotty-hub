import {DEFAULT_THEME, type Appearance} from '@gotty/terminal-core/appearance';

const key = (id: string) => `gotty-hub:terminal:${id}:appearance`;
export function readAppearance(id: string): Appearance {
  try {
    const value = JSON.parse(localStorage.getItem(key(id)) || '{}');
    return {
      theme: typeof value?.theme === 'string' ? value.theme : DEFAULT_THEME,
      fontFamily: typeof value?.fontFamily === 'string' ? value.fontFamily : undefined,
      fontSize: typeof value?.fontSize === 'number' && value.fontSize >= 8 && value.fontSize <= 48 ? value.fontSize : undefined,
    };
  } catch { return {}; }
}
export function saveAppearance(id: string, value: Appearance) {
  try { localStorage.setItem(key(id), JSON.stringify(value)); } catch { /* Browser storage may be disabled. */ }
}

export type TerminalConfig = {
  themes?: Record<string, Record<string, string>>;
  mobile_keys?: boolean;
  show_terminal_state?: boolean;
  asr_hold_ms?: number;
  asr_hotkey?: string;
  restart_mode?: string;
  share_enabled?: boolean;
  upload_ack?: boolean;
};

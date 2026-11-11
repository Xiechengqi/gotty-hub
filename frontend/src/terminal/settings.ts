import {BUILTIN_THEMES, DEFAULT_THEME, DEFAULT_FONT_ID, DEFAULT_FONT_SIZE, type Appearance} from '@gotty/terminal-core/appearance';
import {fontById, fontIdForFamily} from '@gotty/terminal-core/fonts';

export type TerminalSettings = {schemaVersion: 1; theme: string; fontSize: number; fontId: string; tabBarTransparency?: number};
export type SettingsSnapshot = {revision: number; settings: TerminalSettings | null};
export const DEFAULT_SETTINGS: TerminalSettings = {schemaVersion: 1, theme: DEFAULT_THEME, fontSize: DEFAULT_FONT_SIZE, fontId: DEFAULT_FONT_ID, tabBarTransparency: 50};
export const settingsKey = (account: string) => `gotty-hub:account:${account}:terminal-settings`;
export function validSettings(value: unknown): value is TerminalSettings {
  const v = value as Partial<TerminalSettings> | null;
  return !!v && v.schemaVersion === 1 && typeof v.theme === 'string' && Object.hasOwn(BUILTIN_THEMES, v.theme)
    && Number.isInteger(v.fontSize) && v.fontSize! >= 8 && v.fontSize! <= 48
    && typeof v.fontId === 'string' && !!fontById(v.fontId)
    && (v.tabBarTransparency === undefined || Number.isInteger(v.tabBarTransparency) && v.tabBarTransparency >= 0 && v.tabBarTransparency <= 100);
}
export function parseSnapshot(value: unknown): SettingsSnapshot {
  const v = value as Partial<SettingsSnapshot> | null;
  return v && Number.isSafeInteger(v.revision) && v.revision! >= 0 && (v.settings === null || validSettings(v.settings))
    ? {revision: v.revision!, settings: v.settings ? {...v.settings, tabBarTransparency: v.settings.tabBarTransparency ?? 50} : null} : {revision: 0, settings: null};
}
export function cachedSettings(account: string): SettingsSnapshot {
  try {return parseSnapshot(JSON.parse(localStorage.getItem(settingsKey(account)) || 'null'));}
  catch {return {revision: 0, settings: null};}
}
export function rememberSettings(account: string, value: SettingsSnapshot): void {
  try {localStorage.setItem(settingsKey(account), JSON.stringify(value));} catch { /* Server persistence still works. */ }
}
export function settingsAppearance(value: TerminalSettings): Appearance {
  return {theme: value.theme, fontSize: value.fontSize, fontFamily: fontById(value.fontId)!.value};
}
export function migrateAppearance(value?: Appearance): TerminalSettings {
  return {schemaVersion: 1, theme: value?.theme && Object.hasOwn(BUILTIN_THEMES, value.theme) ? value.theme : DEFAULT_SETTINGS.theme,
    fontSize: Number.isInteger(value?.fontSize) && value!.fontSize! >= 8 && value!.fontSize! <= 48 ? value!.fontSize! : DEFAULT_SETTINGS.fontSize,
    fontId: fontIdForFamily(value?.fontFamily) || DEFAULT_SETTINGS.fontId, tabBarTransparency: 50};
}

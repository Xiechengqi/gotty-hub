import {beforeEach, expect, it} from 'vitest';
import {cachedSettings, DEFAULT_SETTINGS, migrateAppearance, parseSnapshot, rememberSettings, validSettings} from './settings';
beforeEach(() => localStorage.clear());
it('isolates account snapshots and rejects corrupt browser data', () => {
  rememberSettings('first', {revision: 2, settings: {...DEFAULT_SETTINGS, theme: 'paper', fontSize: 20}});
  expect(cachedSettings('first').settings?.fontSize).toBe(20);
  expect(cachedSettings('first').settings?.theme).toBe('paper');
  expect(cachedSettings('second')).toEqual({revision: 0, settings: null});
  expect(parseSnapshot({revision: -1, settings: DEFAULT_SETTINGS}).settings).toBeNull();
  expect(parseSnapshot({revision: 2, settings: {...DEFAULT_SETTINGS, fontId: 'unknown'}}).settings).toBeNull();
});
it('migrates known legacy values and validates safe catalog choices', () => {
  expect(migrateAppearance({theme: 'monokai', fontSize: 24, fontFamily: 'Menlo, monospace'})).toEqual({schemaVersion: 1, theme: 'monokai', fontSize: 24, fontId: 'menlo', tabBarTransparency: 50});
  expect(migrateAppearance({theme: 'missing', fontSize: 100, fontFamily: 'missing'})).toEqual(DEFAULT_SETTINGS);
  expect(validSettings({...DEFAULT_SETTINGS, fontSize: 8.5})).toBe(false);
  expect(validSettings({...DEFAULT_SETTINGS, theme: 'toString'})).toBe(false);
});
it('uses the new default only when no explicit font preference was saved', () => {
  expect(migrateAppearance().fontId).toBe('dejavu-sans-mono');
  expect(migrateAppearance({fontFamily: "'Source Code Pro', monospace"}).fontId).toBe('source-code-pro');
  const settings = {...DEFAULT_SETTINGS, fontId: 'source-code-pro'};
  rememberSettings('existing', {revision: 3, settings});
  expect(cachedSettings('existing').settings).toEqual(settings);
});

it('migrates transparency without losing appearance and validates its percentage',()=>{
  const old={schemaVersion:1,theme:'paper',fontSize:18,fontId:'monospace'};
  expect(parseSnapshot({revision:7,settings:old})).toEqual({revision:7,settings:{...old,tabBarTransparency:50}});
  for(const value of [-1,101,NaN,1.5,'50',null])expect(validSettings({...old,tabBarTransparency:value})).toBe(false);
  for(const value of [0,50,100])expect(parseSnapshot({revision:7,settings:{...old,tabBarTransparency:value}}).settings?.tabBarTransparency).toBe(value);
});

import {beforeEach, expect, it} from 'vitest';
import {cachedSettings, DEFAULT_SETTINGS, migrateAppearance, parseSnapshot, rememberSettings, validSettings} from './settings';
beforeEach(() => localStorage.clear());
it('isolates account snapshots and rejects corrupt browser data', () => {
  rememberSettings('first', {revision: 2, settings: {...DEFAULT_SETTINGS, fontSize: 20}});
  expect(cachedSettings('first').settings?.fontSize).toBe(20);
  expect(cachedSettings('second')).toEqual({revision: 0, settings: null});
  expect(parseSnapshot({revision: -1, settings: DEFAULT_SETTINGS}).settings).toBeNull();
  expect(parseSnapshot({revision: 2, settings: {...DEFAULT_SETTINGS, fontId: 'unknown'}}).settings).toBeNull();
});
it('migrates known legacy values and validates safe catalog choices', () => {
  expect(migrateAppearance({theme: 'monokai', fontSize: 24, fontFamily: 'Menlo, monospace'})).toEqual({schemaVersion: 1, theme: 'monokai', fontSize: 24, fontId: 'menlo'});
  expect(migrateAppearance({theme: 'missing', fontSize: 100, fontFamily: 'missing'})).toEqual(DEFAULT_SETTINGS);
  expect(validSettings({...DEFAULT_SETTINGS, fontSize: 8.5})).toBe(false);
  expect(validSettings({...DEFAULT_SETTINGS, theme: 'toString'})).toBe(false);
});

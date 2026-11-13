import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {defaultTabSwipe, interactionSettingsKey, readTabSwipe, useInteractionSettings} from './interactionSettings';

let node: HTMLDivElement, root: ReturnType<typeof createRoot>, current: ReturnType<typeof useInteractionSettings>;
function Probe({account}: {account: string}) {current = useInteractionSettings(account); return null;}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear();
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => {await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

it('defaults on for Macs and touchscreens, preserving the opt-in on other desktops', () => {
  expect(defaultTabSwipe({platform: 'MacIntel', userAgent: 'Macintosh', maxTouchPoints: 0})).toBe(true);
  expect(defaultTabSwipe({platform: 'MacIntel', userAgent: 'Macintosh', maxTouchPoints: 5})).toBe(true);
  expect(defaultTabSwipe({platform: 'iPad', userAgent: 'iPad', maxTouchPoints: 5})).toBe(true);
  expect(defaultTabSwipe({platform: 'iPhone', userAgent: 'iPhone', maxTouchPoints: 5})).toBe(true);
  expect(defaultTabSwipe({platform: 'Linux armv8l', userAgent: 'Android', maxTouchPoints: 5})).toBe(true);
  expect(defaultTabSwipe({platform: 'Linux x86_64', userAgent: 'Linux', maxTouchPoints: 0})).toBe(false);
});

it('persists explicit false, survives remount and isolates accounts from server appearance', async () => {
  await act(async () => root.render(<Probe account="first"/>));
  await act(async () => current.saveTabSwipe(false));
  expect(JSON.parse(localStorage.getItem(interactionSettingsKey('first'))!)).toEqual({schemaVersion: 1, tabSwipe: false});
  await act(async () => root.render(null));
  await act(async () => root.render(<Probe account="first"/>)); expect(current.tabSwipe).toBe(false);
  await act(async () => current.saveTabSwipe(true)); const staleSave = current.saveTabSwipe;
  await act(async () => root.render(<Probe account="second"/>));
  expect(() => staleSave(false)).toThrow('authentication_required');
  await act(async () => current.saveTabSwipe(false));
  expect(readTabSwipe('first')).toBe(true); expect(readTabSwipe('second')).toBe(false);
  expect(localStorage.length).toBe(2);
});

it('accepts same-browser storage updates and recovers from invalid or blocked storage', async () => {
  localStorage.setItem(interactionSettingsKey('first'), '{invalid');
  expect(readTabSwipe('first')).toBe(defaultTabSwipe());
  await act(async () => root.render(<Probe account="first"/>));
  localStorage.setItem(interactionSettingsKey('first'), JSON.stringify({schemaVersion: 1, tabSwipe: true}));
  await act(async () => window.dispatchEvent(new StorageEvent('storage', {key: interactionSettingsKey('first')})));
  expect(current.tabSwipe).toBe(true);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {throw Error('blocked');});
  await act(async () => current.saveTabSwipe(false)); expect(current.tabSwipe).toBe(false);
});

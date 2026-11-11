// Loaded by workspace-regressions.cjs; all instances belong to its disposable Hub.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function splitRegression({page, context, browser, hub, ids, devices, api, wait, sleep, dir, report, installInspection, start, errors}) {
  const names = Object.fromEntries((await api('/instances')).map(instance => [instance.id, instance.name]));
  const [a, b, c, d] = ids;
  const slot = id => page.locator('.terminal-slot[data-instance-id="' + id + '"]');
  const tab = id => page.locator('.session-tab[data-instance-id="' + id + '"] button[aria-controls]');
  const pair = () => page.locator('.terminal-slot:not([hidden])').evaluateAll(elements => elements.map(element => ({id: element.dataset.instanceId, pane: element.dataset.pane})).sort((a, b) => a.pane.localeCompare(b.pane)));
  const expectPair = async (left, right) => wait(async () => JSON.stringify(await pair()) === JSON.stringify([{id: left, pane: 'left'}, {id: right, pane: 'right'}]), 'stable left/right pair');
  const focused = () => page.evaluate(() => document.activeElement?.closest('.terminal-slot')?.dataset.instanceId);
  const expectFocus = async id => wait(async () => await focused() === id && await page.locator('.session-tab.selected').getAttribute('data-instance-id') === id, 'pane and tab focus ' + names[id]);
  async function choose(id) {
    const dialog = page.getByRole('dialog').filter({has: page.locator('.split-instance-list')});
    await dialog.waitFor();
    await dialog.locator('.split-instance-option').filter({hasText: names[id]}).click();
    await dialog.waitFor({state: 'hidden'});
  }
  async function enter(id) {await page.locator('.split-button').click(); await choose(id);}
  async function terminal(id) {
    return page.evaluate(id => {
      const all = [...document.querySelectorAll('.real-terminal')];
      const index = all.findIndex(element => element.closest('.terminal-slot').dataset.instanceId === id);
      return window.reviewSnapshot(index);
    }, id);
  }
  async function identity() {
    assert(await page.evaluate(() => {
      const all = [...document.querySelectorAll('.real-terminal')];
      return all.every((element, index) => window.splitOriginalTerms[element.closest('.terminal-slot').dataset.instanceId] === window.reviewTerm(index)) && window.reviewSockets.length === window.splitSocketCount;
    }), 'a split operation recreated a terminal or WebSocket');
  }
  async function headingContrast() {
    // BoardUI animates button text colors for 150ms when the theme changes.
    await wait(async () => {
      const ratios = await page.locator('.terminal-slot:not([hidden]) .terminal-pane-heading').evaluateAll(headings => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      const luminance = color => {
        ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
        const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      return headings.flatMap(heading => {
        const background = luminance(getComputedStyle(heading).backgroundColor);
        return [...heading.querySelectorAll('.pane-instance-trigger, .pane-position, .pane-active-label')].map(element => {
          const foreground = luminance(getComputedStyle(element).color);
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        });
      });
      });
      return ratios.length >= 4 && ratios.every(ratio => ratio >= 4.5);
    }, 'pane identity contrast at least 4.5:1');
  }
  const me = await api('/me');
  const prefs = await api('/me/preferences');
  const legacy = {...prefs, opened: ids, instanceOrder: ids, active: c, split: true}; delete legacy.workspace;
  await api('/me/preferences', legacy, 'PUT');
  await page.evaluate(id => localStorage.removeItem('gotty-hub:workspace:' + encodeURIComponent(id)), me.id);
  await page.reload({waitUntil: 'domcontentloaded'});
  await expectPair(a, c); await expectFocus(c);
  assert((await slot(a).locator('.terminal-pane-heading').innerText()).includes(names[a]));
  assert((await slot(c).locator('.terminal-pane-heading').innerText()).includes(names[c]));
  await page.locator('.split-button').click(); await tab(b).click(); await expectFocus(b);
  await enter(c); await expectPair(b, c); await expectFocus(b);
  await wait(async () => (await terminal(b))?.pending === 0 && (await terminal(c))?.pending === 0, 'split parsers ready');
  await page.evaluate(() => {
    window.splitOriginalTerms = Object.fromEntries([...document.querySelectorAll('.real-terminal')].map((element, index) => [element.closest('.terminal-slot').dataset.instanceId, window.reviewTerm(index)]));
    window.splitSocketCount = window.reviewSockets.length;
    window.splitInputs = []; window.splitSizes = [];
    for (const socket of window.reviewSockets) {
      const original = socket.send.bind(socket);
      socket.send = data => {if (typeof data === 'string' && data[0] === '1') window.splitInputs.push({url: socket.url, text: new TextDecoder().decode(Uint8Array.from(atob(data.slice(1)), char => char.charCodeAt(0)))}); if (typeof data === 'string' && data[0] === '3') window.splitSizes.push({url: socket.url, sent: data}); original(data);};
      socket.addEventListener('message', event => {if (typeof event.data === 'string' && event.data[0] === '8') window.splitSizes.push({url: socket.url, received: event.data});});
    }
  });
  const file = path.join(dir, 'vim-split.txt');
  await page.keyboard.type('vim -Nu NONE -n -i NONE \'' + file + '\''); await page.keyboard.press('Enter');
  await wait(async () => (await terminal(b))?.type === 'alternate' && (await terminal(b))?.pending === 0, 'split Vim entry');
  await page.keyboard.press('i'); await page.keyboard.insertText('split-中文-unsaved'); await page.keyboard.press('Escape');
  await wait(async () => (await terminal(b))?.pending === 0 && (await terminal(b))?.text.includes('split-中文-unsaved'), 'initial split Vim text');
  assert((await terminal(b)).text.startsWith('split-中文-unsaved'), 'Vim text was drawn on the wrong row');
  assert((await terminal(b)).cols >= 60, 'the drawing grid ignored GoTTY minimum columns');
  assert(await slot(b).locator('.xterm-host').evaluate(element => {
    element.scrollLeft = element.scrollWidth;
    const scrollable = element.scrollWidth > element.clientWidth && element.scrollLeft > 0;
    element.scrollLeft = 0;
    return scrollable;
  }), 'the wider PTY grid cannot be scrolled inside its pane');
  fs.writeFileSync(path.join(dir, 'vim-first-insert.json'), JSON.stringify(await terminal(b), null, 2));
  await slot(c).locator('.xterm-screen').click({position: {x: 20, y: 30}}); await expectFocus(c);
  await expectPair(b, c);
  await page.keyboard.type('printf C_FOCUS_PROBE'); await page.keyboard.press('Enter');
  await wait(async () => (await terminal(c))?.text.includes('C_FOCUS_PROBE'), 'right shell input');
  await tab(b).click(); await expectFocus(b);
  await page.keyboard.press('A'); await page.keyboard.insertText('-stillB'); await page.keyboard.press('Escape');
  await wait(async () => (await terminal(b))?.pending === 0 && (await terminal(b))?.text.includes('unsaved-stillB'), 'split Vim append');
  assert(await page.evaluate(({b, c}) => {
    const input = id => window.splitInputs.filter(frame => frame.url.includes('/' + id + '/ws')).map(frame => frame.text).join('');
    return input(b).includes('-stillB') && !input(c).includes('-stillB') && input(c).includes('C_FOCUS_PROBE') && !input(b).includes('C_FOCUS_PROBE');
  }, {b, c}), 'keyboard input went to the wrong instance');
  const beforeSort = await page.locator('.session-tab').evaluateAll(elements => elements.map(element => element.dataset.instanceId));
  const tabHandle = page.locator('.session-tab[data-instance-id="' + a + '"] .instance-sort-handle');
  await tabHandle.focus(); await page.keyboard.press('Space'); await sleep(80);
  await page.keyboard.press('ArrowRight'); await sleep(80); await page.keyboard.press('ArrowRight'); await sleep(80); await page.keyboard.press('Space');
  assert.notDeepEqual(await page.locator('.session-tab').evaluateAll(elements => elements.map(element => element.dataset.instanceId)), beforeSort, 'tab sorting did not run');
  await expectPair(b, c);
  const sidebarHandle = page.locator('.sidebar .instance-nav-row[data-instance-id="' + c + '"] .instance-sort-handle');
  const beforeSidebarSort = await page.locator('.session-tab').evaluateAll(elements => elements.map(element => element.dataset.instanceId));
  await sidebarHandle.focus(); await page.keyboard.press('Space'); await sleep(80); await page.keyboard.press('ArrowUp'); await sleep(80); await page.keyboard.press('Space');
  assert.notDeepEqual(await page.locator('.session-tab').evaluateAll(elements => elements.map(element => element.dataset.instanceId)), beforeSidebarSort, 'sidebar sorting did not run');
  await expectPair(b, c); await identity();
  await page.locator('.swap-panes-button').click(); await expectPair(c, b); await expectFocus(b); await identity();
  const divider = page.getByRole('separator', {name: '调整终端分屏宽度'});
  const bounds = await page.locator('.terminals').boundingBox(), handle = await divider.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100); await page.mouse.down();
  await page.mouse.move(bounds.x + 4 + (bounds.width - 8) * 0.6, handle.y + 100, {steps: 8}); await page.mouse.up();
  await wait(async () => Number(await divider.getAttribute('aria-valuenow')) === 60, 'drag split ratio');
  await divider.focus(); await page.keyboard.press('ArrowLeft');
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), 58);
  await page.keyboard.press('Enter'); assert.equal(Number(await divider.getAttribute('aria-valuenow')), 50);
  for (const key of ['Home', 'End']) {
    await page.keyboard.press(key);
    const widths = await page.locator('.terminal-slot:not([hidden])').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    assert(widths.every(width => width >= 359.9), 'a pane shrank below the minimum width');
  }
  await page.keyboard.press('Enter');
  await identity();
  await headingContrast();
  await page.screenshot({path: path.join(dir, 'split-paper-desktop.png')});
  const initiallyDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  if (!initiallyDark) await page.getByRole('button', {name: '切换主题', exact: true}).click();
  await wait(() => page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark workspace');
  await headingContrast();
  await page.screenshot({path: path.join(dir, 'split-dark-desktop.png')});
  if (!initiallyDark) await page.getByRole('button', {name: '切换主题', exact: true}).click();
  await slot(b).locator('.pane-instance-trigger').click(); await choose(d); await expectPair(c, d); await expectFocus(d);
  assert.equal((await terminal(b)).type, 'alternate');
  await slot(c).locator('.pane-instance-trigger').click(); await choose(b); await expectPair(b, d); await expectFocus(b); await identity();
  assert((await terminal(b)).text.includes('unsaved'));
  await page.locator('.split-button').click(); await expectFocus(b);
  assert.equal(await page.locator('.terminal-slot:not([hidden])').count(), 1);
  await identity(); await enter(d); await expectPair(b, d); await expectFocus(b);
  await page.route('**/api/v1/me/preferences', route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await divider.focus(); for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  const cached = await page.evaluate(id => JSON.parse(localStorage.getItem('gotty-hub:workspace:' + encodeURIComponent(id))), me.id);
  assert(cached.pending); assert(Math.abs(cached.workspace.split.ratio - 0.6) < 0.01);
  await page.reload({waitUntil: 'domcontentloaded'}); await expectPair(b, d); await expectFocus(b);
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), 60);
  await wait(async () => (await terminal(b))?.type === 'alternate' && (await terminal(b))?.pending === 0 && (await terminal(b))?.text.includes('unsaved'), 'unsaved Vim after split reload');
  await page.keyboard.press('Escape'); await page.keyboard.type(':wq'); await page.keyboard.press('Enter');
  await wait(() => fs.existsSync(file), 'split Vim save');
  assert(fs.readFileSync(file, 'utf8').includes('split-中文-unsaved-stillB'));
  await page.unroute('**/api/v1/me/preferences');
  await page.locator('.swap-panes-button').click(); await page.locator('.swap-panes-button').click(); await expectPair(b, d);
  await wait(async () => Math.abs((await api('/me/preferences')).workspace?.split?.ratio - 0.6) < 0.01, 'split server persistence');
  await tab(c).click(); await expectPair(c, d); await expectFocus(c);
  await tab(b).click(); await expectPair(b, d); await expectFocus(b);
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({width, height: 844});
    await wait(async () => await page.locator('.terminal-slot:not([hidden])').count() === 1, 'narrow single terminal');
    assert(await divider.isHidden());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
    await page.screenshot({path: path.join(dir, 'split-narrow-' + width + '.png')});
    if (width === 375) {
      await page.locator('.session-switcher-trigger').click();
      await page.locator('.session-switcher-item').filter({hasText: names[a]}).click();
      await expectFocus(a);
    }
  }
  await page.setViewportSize({width: 1280, height: 800}); await expectPair(b, d);
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), 60);
  await slot(b).locator('.xterm-screen').click({position: {x: 20, y: 30}}); await expectFocus(b);
  // A normal disconnect keeps the named pane and its fixed position.
  process.kill(-devices[3].child.pid, 'SIGTERM');
  await wait(async () => !(await api('/instances')).find(instance => instance.id === d).online, 'right instance offline');
  await expectPair(b, d);
  assert((await slot(d).locator('.terminal-pane-heading').innerText()).includes(names[d]));
  await wait(() => slot(d).locator('.terminal-empty').isVisible(), 'named offline pane');
  await page.screenshot({path: path.join(dir, 'split-offline.png')});
  await wait(() => devices[3].child.exitCode !== null, 'offline fixture stopped');
  devices[3].child = start('gotty-split-reconnect', process.env.GOTTY_BINARY, devices[3].args);
  await wait(async () => (await api('/instances')).find(instance => instance.id === d).online, 'right instance online');
  await wait(() => slot(d).locator('.terminal-clear-control').isEnabled(), 'right terminal reconnected in the UI');
  await expectPair(b, d); await sleep(150); assert.equal(await focused(), b, 'reconnecting the other pane stole focus');
  await slot(d).locator('.pane-close').click();
  assert.equal(await page.locator('.terminal-slot:not([hidden])').count(), 1);
  assert.equal(await page.locator('.split-button').getAttribute('aria-label'), '分屏');
  await page.locator('.sidebar .instance-nav-row[data-instance-id="' + d + '"] .registered-instance').click(); await expectFocus(d);
  assert.equal(await page.locator('.terminal-slot:not([hidden])').count(), 1, 'reopening a session unexpectedly restored split');
  await tab(a).click(); await expectFocus(a);

  // Observer rights and grant revocation use a separate account/context.
  const observer = await browser.newContext({viewport: {width: 1280, height: 800}});
  await observer.addInitScript(installInspection);
  await observer.addInitScript(() => localStorage.setItem('gotty-hub.locale','zh-CN'));
  const username = 'split-observer';
  const registration = await observer.request.post(hub + '/api/v1/auth/register', {data: {username, password: 'split-observer-password-123'}});
  assert(registration.ok());
  await api('/instances/' + b + '/grants', {username, role: 'observer'}, 'PUT');
  await api('/instances/' + c + '/grants', {username, role: 'observer'}, 'PUT');
  const observerPage = await observer.newPage(); observerPage.on('pageerror', error => errors.push(error.stack));
  await observerPage.goto(hub, {waitUntil: 'domcontentloaded'});
  await wait(async () => await observerPage.locator('.terminal-slot').count() === 1, 'observer initial terminal');
  await observerPage.locator('.split-button').click();
  await wait(async () => await observerPage.locator('.terminal-slot:not([hidden])').count() === 2, 'observer pair');
  assert.equal(await observerPage.locator('.terminal-clear-control,.terminal-upload-control,.terminal-restart-control').count(), 0);
  assert.equal(await observerPage.locator('.terminal-pane-heading').filter({hasText: '只读'}).count(), 2);
  await api('/instances/' + c + '/grants/' + username, {}, 'DELETE');
  await wait(async () => await observerPage.locator('.terminal-slot:not([hidden])').count() === 1 && await observerPage.locator('.terminal-slot[data-instance-id="' + c + '"]').count() === 0, 'revocation collapses split');
  assert.equal(await observerPage.locator('.split-button').getAttribute('aria-label'), '分屏');
  await observer.close(); await page.bringToFront();
  report('splitWorkspace', {identityLabels: true, legacyMigration: true, arbitraryPair: true, focusAndInput: true, sortingStable: true, swap: true, pointerAndKeyboardResize: true, noRendererOrSocketReplacement: true, confirmedPTYSizeAndScrolling: true, unsavedVim: true, immediateReload: true, narrowRestoration: true, offlineIdentity: true, reconnectDoesNotStealFocus: true, closeAndReopen: true, observerAndRevocation: true});
};

// Run only through the disposable workspace harness, outside GitHub Actions.
// CDP wheel events exercise browser/xterm integration, not physical Mac gestures.
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function swipeRegression({page, ids, api, wait, sleep, dir, report, sent}) {
  const [a, b, c, d] = ids;
  const me = await api('/me');
  const key = 'gotty-hub:interaction:' + encodeURIComponent(me.id);
  const tab = id => page.locator(`.session-tab[data-instance-id="${id}"] .tab-trigger`);
  const slot = id => page.locator(`.terminal-slot[data-instance-id="${id}"]`);
  const active = () => page.locator('.session-tab.selected').getAttribute('data-instance-id');
  const order = () => page.locator('.session-tab').evaluateAll(nodes => nodes.map(node => node.dataset.instanceId));
  const terminal = id => page.evaluate(id => {
    const nodes = [...document.querySelectorAll('.real-terminal')];
    return window.reviewSnapshot(nodes.findIndex(node => node.closest('.terminal-slot').dataset.instanceId === id));
  }, id);
  const ready = id => wait(async () => {
    const state = await terminal(id);
    return state?.pending === 0 && state.text.trim().length > 0
      && await slot(id).locator('.xterm-host').getAttribute('data-replay-active') !== 'true'
      && await slot(id).locator('.terminal-clear-control').isEnabled();
  }, 'terminal ready');
  const select = async id => {await tab(id).click(); await ready(id);};
  const openSettings = async () => {
    await page.getByRole('button', {name: '设置', exact: true}).click();
    await page.getByRole('button', {name: '终端设置', exact: true}).click();
    const dialog = page.locator('.terminal-settings-dialog'); await dialog.waitFor(); return dialog;
  };
  const checkbox = dialog => dialog.getByRole('checkbox', {name: '横向滑动切换标签'});
  const setSwipe = async (dialog, value) => {
    // React Aria keeps the native input visually hidden; use its visible label.
    if (await checkbox(dialog).isChecked() !== value) await dialog.getByText('横向滑动切换标签', {exact: true}).click();
    assert.equal(await checkbox(dialog).isChecked(), value);
  };
  const cancel = async dialog => {await dialog.getByRole('button', {name: '取消', exact: true}).last().click(); await dialog.waitFor({state: 'hidden'});};
  async function burst(direction, area = page.locator('.session-tabs-scroll'), dy = 1) {
    await sleep(260);
    const bounds = await area.boundingBox();
    await page.mouse.move(bounds.x + Math.min(50, bounds.width / 2), bounds.y + Math.min(80, bounds.height / 2));
    for (const delta of [30, 35, 40, 24, 12, 5]) await page.mouse.wheel(direction * delta, dy);
  }
  let dialog = await openSettings();
  assert.equal(await checkbox(dialog).isChecked(), false, 'non-Mac default must be off');
  await setSwipe(dialog, true); await cancel(dialog);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-hub-tab-swipe')), false);
  dialog = await openSettings(); assert.equal(await checkbox(dialog).isChecked(), false);
  await setSwipe(dialog, true); await dialog.getByRole('button', {name: '保存并应用', exact: true}).click(); await dialog.waitFor({state: 'hidden'});
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).tabSwipe, key), true);
  assert(!Object.hasOwn((await api('/me/terminal-settings')).settings, 'tabSwipe'), 'browser preference leaked into account appearance');
  // A failed appearance save must not commit the browser setting independently.
  dialog = await openSettings(); await setSwipe(dialog, false);
  await page.route('**/api/v1/me/terminal-settings', route => route.request().method() === 'PUT'
    ? route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'temporarily_unavailable'})}) : route.continue());
  await dialog.getByRole('button', {name: '保存并应用', exact: true}).click(); await dialog.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).tabSwipe, key), true);
  await cancel(dialog); await page.unroute('**/api/v1/me/terminal-settings');
  await page.reload({waitUntil: 'domcontentloaded'}); await ready(a);
  await wait(() => page.evaluate(() => document.documentElement.dataset.hubTabSwipe === 'true'), 'persisted browser setting');
  report('swipeSettings', {cancel: true, save: true, failedSaveAtomic: true, reload: true, browserOnly: true});

  // Keep feeding inertia with no silent gap, then introduce a fresh gesture.
  // The former implementation swallowed all of this until the wheel stopped.
  await page.mouse.move(120, 16); await page.mouse.wheel(90, 0);
  for (const delta of [40, 32, 24, 16, 10, 6, 4, 2, 1, 1, 1]) {await sleep(16); await page.mouse.wheel(delta, 0);}
  assert.equal(await active(), b, 'momentum repeated the switch');
  await page.mouse.wheel(30, 0); await page.mouse.wheel(60, 0);
  await wait(async () => await active() === c, 'second swipe during inertia');
  for (let i = 0; i < 10; i++) {await sleep(16); await page.mouse.wheel(2, 0);}
  await page.mouse.wheel(-40, 0); await page.mouse.wheel(-45, 0);
  await wait(async () => await active() === b, 'reverse swipe during inertia');
  report('swipeRearm', {sameDirection: true, reverse: true, momentumDoesNotRepeat: true});
  await select(a); await sleep(260);

  await page.evaluate(() => {window.swipeOriginalTerm = window.reviewTerm(0); window.swipeOriginalSocket = window.reviewSockets.find(socket => socket.readyState === 1);});
  await slot(a).locator('.xterm-helper-textarea').focus();
  await sleep(100);
  await page.keyboard.type('vim -Nu NONE -n -i NONE', {delay: 5}); await page.keyboard.press('Enter');
  await wait(async () => (await terminal(a))?.type === 'alternate', 'Vim entered');
  await page.keyboard.type(':set mouse=a', {delay: 5}); await page.keyboard.press('Enter');
  await page.keyboard.press('i'); await page.keyboard.insertText('SWIPE_UNSAVED');
  await wait(async () => (await terminal(a))?.text.includes('SWIPE_UNSAVED'), 'unsaved Vim input');
  const before = await terminal(a), inputOffset = sent.length;
  const height = (await page.locator('.terminals').boundingBox()).height;
  await burst(1, slot(a).locator('.xterm-host'));
  await wait(async () => await active() === b, 'terminal-content swipe'); await ready(b);
  assert.equal(await active(), b, 'inertia skipped more than one tab');
  assert(sent.slice(inputOffset).every(text => /^\x1b\[[IO]$/.test(text)), 'horizontal gesture reached the PTY');
  await page.locator('.tab-swipe-hint').waitFor();
  await burst(-1); await wait(async () => await active() === a, 'return swipe'); await ready(a);
  const after = await terminal(a);
  assert.equal(after.type, 'alternate'); assert.deepEqual(after.cursor, before.cursor); assert.equal(after.text, before.text);
  assert(await page.evaluate(() => window.reviewTerm(0) === window.swipeOriginalTerm && window.reviewSockets.includes(window.swipeOriginalSocket) && window.swipeOriginalSocket.readyState === 1));
  assert.equal((await page.locator('.terminals').boundingBox()).height, height);
  await burst(-1); assert.equal(await active(), a, 'first tab wrapped');
  await slot(a).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Escape'); await page.keyboard.type(':q!', {delay: 5}); await page.keyboard.press('Enter');
  await wait(async () => (await terminal(a))?.type === 'normal', 'Vim exited');
  await page.keyboard.type("printf 'SWIPE-HISTORY-%s\\n' {1..200}", {delay: 5}); await page.keyboard.press('Enter');
  await wait(async () => (await terminal(a))?.text.includes('SWIPE-HISTORY-200'), 'history output');
  await sleep(260); const bounds = await slot(a).locator('.xterm-host').boundingBox();
  await page.mouse.move(bounds.x + 120, bounds.y + 120); await page.mouse.wheel(1, -500);
  await wait(() => page.evaluate(() => {const buffer = window.reviewTerm(0).buffer.active; return buffer.viewportY < buffer.baseY;}), 'vertical scrollback');
  assert.equal(await active(), a);
  const scrollback = await page.evaluate(() => window.reviewTerm(0).buffer.active.viewportY);
  await burst(1); await wait(async () => await active() === b, 'leave scrollback');
  await burst(-1); await wait(async () => await active() === a, 'return scrollback');
  assert.equal(await page.evaluate(() => window.reviewTerm(0).buffer.active.viewportY), scrollback);
  report('swipeTerminal', {contentArea: true, onePerBurst: true, vimPreserved: true, noInputLeak: true, rendererAndSocketPreserved: true, scrollbackPreserved: true, noResize: true, boundary: true});

  await select(b); await tab(b).click({button: 'right'});
  await page.locator('.tab-actions-menu').getByRole('button', {name: /^与右侧标签分屏/}).click();
  await wait(async () => await page.locator('.terminal-slot:not([hidden])').count() === 2, 'split created');
  await select(c); await burst(1); await wait(async () => await active() === d, 'leave pair as one unit'); await ready(d);
  await select(a); await burst(1); await wait(async () => await active() === c, 'restore pair right focus');
  assert.equal(await page.locator('.terminal-slot:not([hidden])').count(), 2);
  await page.setViewportSize({width: 375, height: 844}); await sleep(350);
  assert.equal(await page.locator('.terminal-slot:not([hidden])').count(), 1);
  await burst(-1); await wait(async () => await active() === b, 'collapsed pair traverses individual tabs');
  await select(c); const host = slot(c).locator('.xterm-host');
  await wait(() => host.evaluate(node => node.scrollWidth > node.clientWidth + 2), 'real horizontal overflow');
  await host.evaluate(node => {node.scrollLeft = 0;});
  await burst(1, host, 0); assert.equal(await active(), c);
  await wait(() => host.evaluate(node => node.scrollLeft > 0), 'native horizontal scrolling');
  await host.evaluate(node => {node.scrollLeft = node.scrollWidth;});
  await burst(1, host, 0); assert.equal(await active(), c, 'scroll boundary changed tab');
  await burst(1); await wait(async () => await active() === d, 'tab row bypasses content overflow');
  await page.setViewportSize({width: 1280, height: 800}); await sleep(350);
  report('swipeSplitAndOverflow', {pairAsUnit: true, rememberedPane: true, collapsedPairAsTabs: true, horizontalScrolling: true, edgePreserved: true, tabRowAvailable: true});

  const source = await tab(d).boundingBox(), destination = await tab(a).boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
  await page.mouse.move(destination.x + 2, destination.y + destination.height / 2, {steps: 12});
  await wait(async () => await page.locator('[data-dragging=true]').count() === 1, 'tab drag');
  await page.mouse.wheel(160, 0); assert.equal(await active(), d, 'wheel interfered with drag');
  await page.mouse.up(); await wait(async () => (await order())[0] === d, 'new tab order');
  await burst(1); await wait(async () => await active() === a, 'swipe follows reordered tabs');
  await tab(a).click({button: 'right'}); const menu = page.locator('.tab-actions-menu'); await menu.waitFor();
  await burst(1); assert.equal(await active(), a, 'open menu allowed switching'); await page.keyboard.press('Escape'); await menu.waitFor({state: 'hidden'});
  await sleep(260); await page.mouse.move(100, 16); await page.keyboard.down('Shift'); await page.mouse.wheel(160, 0); await page.keyboard.up('Shift');
  assert.equal(await active(), a);
  dialog = await openSettings(); await setSwipe(dialog, false);
  await dialog.getByRole('button', {name: '保存并应用', exact: true}).click(); await dialog.waitFor({state: 'hidden'});
  await burst(1); assert.equal(await active(), a);
  await page.reload({waitUntil: 'domcontentloaded'}); await ready(a);
  assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).tabSwipe, key), false);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-hub-tab-swipe')), false);
  dialog = await openSettings(); assert.equal(await checkbox(dialog).isChecked(), false);
  await page.screenshot({path: path.join(dir, 'swipe-terminal-settings.png')}); await cancel(dialog);
  report('swipeGuards', {dragUnchanged: true, reorderedTabs: true, menus: true, modifiers: true, disablePersists: true});
};

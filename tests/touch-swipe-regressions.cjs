// Real Chromium touch input; run only in the authorized disposable harness.
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function touchSwipeRegression({page: desktop, context, browser, hub, wait, sleep, dir, report, installInspection, errors}) {
  const mobile = await browser.newContext({viewport: {width: 375, height: 844}, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});
  try {
    await mobile.addCookies(await context.cookies());
    await mobile.addInitScript(installInspection);
    const page = await mobile.newPage(); page.on('pageerror', error => errors.push(error.stack));
    const cdp = await mobile.newCDPSession(page);
    await page.goto(hub, {waitUntil: 'domcontentloaded'});
    await wait(() => page.evaluate(() => document.documentElement.dataset.hubTabSwipe === 'true'), 'touch default enabled');
    const order = () => page.locator('.session-tab').evaluateAll(nodes => nodes.map(node => node.dataset.instanceId));
    const ids = await order(), active = () => page.locator('.session-tab.selected').getAttribute('data-instance-id');
    const tab = id => page.locator(`.session-tab[data-instance-id="${id}"] .tab-trigger`);
    const select = async id => {if (await active() !== id) await tab(id).tap();};
    const host = () => page.locator('.terminal-slot:not([hidden]) .xterm-host');
    async function start(x, y) {await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y, id: 1}]});}
    async function move(x, y) {await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y, id: 1}]});}
    async function end() {await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});}
    async function swipe(x, y, dx, dy = 0) {
      await start(x, y);
      for (let step = 1; step <= 5; step++) {await move(x + dx * step / 5, y + dy * step / 5); await sleep(16);}
      await end();
    }
    await select(ids[0]);
    await swipe(240, 16, -150); await wait(async () => await active() === ids[1], 'single-finger next tab');
    await swipe(240, 16, -150); await wait(async () => await active() === ids[2], 'immediate next touch');
    await swipe(70, 16, 150); await wait(async () => await active() === ids[1], 'single-finger previous tab');
    await sleep(120); assert.equal(await page.locator('.tab-actions-menu').count(), 0, 'swipe triggered a menu');
    assert.deepEqual(await order(), ids, 'swipe reordered tabs');
    // Selection by tap and the touch menu still work after canceled presses.
    await tab(ids[2]).tap(); await wait(async () => await active() === ids[2], 'tap after swiping');
    await tab(ids[2]).tap(); await page.locator('.tab-actions-menu').waitFor();
    await swipe(240, 16, -150); assert.equal(await active(), ids[2], 'menu did not block swipe');
    await page.keyboard.press('Escape'); await page.locator('.tab-actions-menu').waitFor({state: 'hidden'});
    // A held finger continues to start sorting, not tab navigation.
    const from = await tab(ids[0]).boundingBox(), to = await tab(ids[3]).boundingBox();
    await start(from.x + from.width / 2, 16); await sleep(300);
    await wait(async () => await page.locator('[data-dragging=true]').count() === 1, 'touch long-press sorting');
    await move(to.x + to.width / 2, 16); await end();
    await wait(async () => (await order())[0] !== ids[0], 'touch reorder completed');
    await sleep(250); // Let the sort animation and its completed press settle.
    report('touchTabNavigation', {defaultEnabled: true, repeat: true, reverse: true, noMenuAfterSwipe: true, tap: true, menu: true, longPressSorting: true});

    await select(ids[2]);
    await wait(() => host().evaluate(node => node.scrollWidth > node.clientWidth + 2), 'mobile content overflow');
    await host().evaluate(node => {node.scrollLeft = 0;});
    await swipe(280, 220, -160); assert.equal(await active(), ids[2]);
    await wait(() => host().evaluate(node => node.scrollLeft > 0), 'native touch horizontal scrolling');
    await host().evaluate(node => {node.scrollLeft = node.scrollWidth;});
    await swipe(280, 220, -160); assert.equal(await active(), ids[2], 'overflow edge switched tab');
    // Give the mobile page its own fitting grid for content-area navigation.
    await desktop.close(); await page.setViewportSize({width: 900, height: 700});
    await wait(() => host().evaluate(node => node.scrollWidth <= node.clientWidth + 2), 'fitting touch terminal', 15000);
    const ordered = await order(), index = ordered.indexOf(ids[2]);
    await swipe(400, 220, -160); await wait(async () => await active() === ordered[index + 1], 'touch terminal-area next');
    await swipe(200, 220, 160); await wait(async () => await active() === ids[2], 'touch terminal-area back');
    await swipe(400, 350, 0, -140); assert.equal(await active(), ids[2], 'vertical scroll switched terminal');
    // Wide tabs: the lift can remain inside the original target, exercising
    // React Aria's synthetic-click fallback after a prevented touch gesture.
    await page.setViewportSize({width: 2400, height: 700});
    await sleep(300);
    const wide = await tab(ids[2]).boundingBox();
    assert(wide.y >= 0 && wide.y < 50 && wide.width > 120, 'wide tab must be visible throughout the gesture');
    await start(wide.x + 20, wide.y + wide.height / 2); await move(wide.x + 120, wide.y + wide.height / 2); await end(); await sleep(150);
    assert.equal(await active(), ordered[index - 1], 'wide-tab swipe was replaced by a compatibility click');
    assert.equal(await page.locator('.tab-actions-menu').count(), 0);
    await page.screenshot({path: path.join(dir, 'touch-swipe.png')});
    // Both fingers are reserved for native pinch, even when added mid-swipe.
    const pinchActive = await active();
    await start(400, 220); await move(370, 220);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: 370, y: 220, id: 1}, {x: 450, y: 240, id: 2}]});
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: 300, y: 220, id: 1}, {x: 520, y: 240, id: 2}]});
    await end(); assert.equal(await active(), pinchActive, 'adding a finger switched terminal');
    await cdp.send('Emulation.setPageScaleFactor', {pageScaleFactor: 1});
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: 350, y: 220, id: 1}, {x: 450, y: 240, id: 2}]});
    for (let i = 1; i <= 5; i++) {
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: 350 - i * 15, y: 220, id: 1}, {x: 450 + i * 15, y: 240, id: 2}]}); await sleep(16);
    }
    await end(); assert.equal(await active(), pinchActive, 'native pinch switched terminal');
    await wait(() => page.evaluate(() => visualViewport.scale > 1), 'native pinch zoom');
    report('touchTerminalNavigation', {overflowScrolls: true, overflowEdge: true, fittingContent: true, wideTabNoClick: true, pinchZoom: true, verticalPreserved: true});
  } finally {await mobile.close();}
};

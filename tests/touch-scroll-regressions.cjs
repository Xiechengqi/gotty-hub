// Manual browser regression: authorized remote disposable processes only.
// This suite is deliberately not wired into GitHub Actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function touchScrollRegression({context, browser, hub, ids, directURL, wait, sleep, dir, report, installInspection, errors}) {
  const mobile = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  let desktopContext;
  try {
    await mobile.addCookies(await context.cookies()); await mobile.addInitScript(installInspection);
    const page = await mobile.newPage(); page.on('pageerror', e => errors.push(e.stack));
    const cdp = await mobile.newCDPSession(page);
    let selector = '#terminal';
    const state = () => page.locator(selector).evaluate(h => JSON.parse(h.dataset.viewportState || '{}'));
    const ready = () => wait(async () => {const s = await state(); return s.rows > 0 && !s.replaying
      && await page.locator(selector).getAttribute('data-replay-active') === 'false';}, 'mobile terminal ready');
    const command = async text => {await page.locator(selector + ' .xterm-helper-textarea').focus(); await page.keyboard.type(text, {delay: 1}); await page.keyboard.press('Enter');};
    async function touch(type, y, x = 180) {await cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x, y, id: 1}]});}
    async function drag(delta = 400) {
      const from = delta > 0 ? 220 : 700;
      await touch('touchStart', from);
      for (let i = 1; i <= 16; i++) {await touch('touchMove', from + delta * i / 16); await sleep(20);}
      await touch('touchEnd'); await sleep(900);
    }
    const returnInput = async () => {await page.locator('.gotty-return-input, .terminal-return-input').filter({visible: true}).click(); await wait(async () => (await state()).following, 'return to live input');};

    await page.goto(directURL, {waitUntil: 'domcontentloaded'}); await ready();
    await command("for i in $(seq 1 250); do printf 'touch-history-%03d\\n' \"$i\"; done");
    await wait(async () => (await state()).base > 150, 'direct retained history');
    assert.equal((await state()).outerMax, 0);
    await drag(); let s = await state();
    assert(s.inner < s.base - 10 && !s.following, 'native touch did not enter xterm scrollback');
    await page.screenshot({path: path.join(dir, 'touch-direct-history.png')});
    await returnInput();
    await command("for i in $(seq 1 90); do printf 'touch-stream-%03d\\n' \"$i\"; sleep 0.04; done");
    await sleep(400); await drag(); const anchor = await state();
    assert(!anchor.following); await sleep(3200); s = await state();
    assert.equal(s.inner, anchor.inner, 'new output moved the touch history anchor');
    assert(s.base > anchor.base);
    await page.reload({waitUntil: 'domcontentloaded'}); await ready();
    assert((await state()).base > 150); await drag(); assert(!(await state()).following);
    report('directTouchHistory', {noOuterOverflow: true, nativeTouch: true, continuousOutputAnchor: true, reloadHistory: true});

    await returnInput(); desktopContext = await browser.newContext({viewport: {width: 1280, height: 1200}});
    const desktop = await desktopContext.newPage(); await desktop.goto(directURL, {waitUntil: 'domcontentloaded'});
    await wait(async () => (await state()).outerMax > 200, 'shared desktop grid');
    const shared = await state(); await drag(500); s = await state();
    assert(s.inner < s.base && !s.following, 'touch stopped at outer screen boundary');
    const history = s.inner;
    await page.setViewportSize({width: 844, height: 390}); await sleep(500);
    s = await state(); assert.equal(s.inner, history); assert(!s.following);
    assert.deepEqual([s.columns, s.rows], [shared.columns, shared.rows]);
    await page.setViewportSize({width: 390, height: 844}); await sleep(500);
    await drag(-500); await drag(-500); await wait(async () => (await state()).following, 'touch returns across both scroll layers');
    report('sharedTouchHistory', {crossesScreenBoundary: true, rotationAnchor: true, returnsToLive: true, gridUnchanged: true});

    await page.goto(hub, {waitUntil: 'domcontentloaded'});
    selector = '.terminal-slot:not([hidden]) .xterm-host';
    await page.locator(`.session-tab[data-instance-id="${ids[1]}"] .tab-trigger`).tap(); await ready();
    await command("for i in $(seq 1 250); do printf 'hub-touch-%03d\\n' \"$i\"; done");
    await wait(async () => (await state()).base > 150, 'Hub retained history');
    assert.equal((await state()).outerMax, 0);
    const active = await page.locator('.session-tab.selected').getAttribute('data-instance-id');
    await drag(); s = await state(); assert(s.inner < s.base && !s.following);
    assert.equal(await page.locator('.session-tab.selected').getAttribute('data-instance-id'), active);
    await page.screenshot({path: path.join(dir, 'touch-hub-history.png')});
    await returnInput();
    report('hubTouchHistory', {nativeTouch: true, noOuterOverflow: true, verticalKeepsTab: true});

    // A real raw-mode program makes both sides agree about the alternate
    // screen/mouse modes. Observe only bytes generated in this disposable PTY.
    const app = path.join(dir, 'touch-mouse-app.py'), status = path.join(dir, 'touch-mouse-status.json');
    fs.writeFileSync(app, `import os,sys,tty,termios,select,time,json,re\nold=termios.tcgetattr(0)\ndata=b''\nmouse=sys.argv[1]=='mouse'\ndef record():\n    with open(${JSON.stringify(status)},'w') as f: json.dump({'bytes':len(data),'wheels':len(re.findall(rb'\\x1b\\[<6[45];[0-9]+;[0-9]+M',data))},f)\ntry:\n    tty.setraw(0)\n    os.write(1,b'\\x1b[?1049h\\x1b[2J'+(b'\\x1b[?1000h\\x1b[?1006h' if mouse else b''))\n    record()\n    deadline=time.time()+20\n    while time.time()<deadline:\n        if select.select([0],[],[],0.1)[0]:\n            chunk=os.read(0,4096)\n            if b'\\x03' in chunk: break\n            data+=chunk\n            record()\nfinally:\n    os.write(1,b'\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l')\n    termios.tcsetattr(0,termios.TCSANOW,old)\n`);
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const startApp = async mode => {
      fs.rmSync(status, {force: true}); await command(`python3 ${quote(app)} ${mode}`);
      await wait(async () => fs.existsSync(status) && (await state()).buffer === 'alternate', 'raw alternate-screen program');
    };
    const stopApp = async () => {await page.locator(selector + ' .xterm-helper-textarea').focus(); await page.keyboard.press('Control+c'); await wait(async () => (await state()).buffer === 'normal', 'raw program exit');};
    await startApp('plain'); await drag(); assert.equal(JSON.parse(fs.readFileSync(status)).bytes, 0, 'touch injected keys without a mouse protocol'); await stopApp();
    await startApp('mouse'); await drag();
    const first = JSON.parse(fs.readFileSync(status)); assert(first.wheels > 0, 'touch failed to forward negotiated mouse wheels');
    await page.evaluate(() => {const nodes = [...document.querySelectorAll('.real-terminal')]; const index = nodes.findIndex(n => !n.closest('.terminal-slot').hidden); window.reviewTerm(index).options.disableStdin = true;});
    await drag(); assert.equal(JSON.parse(fs.readFileSync(status)).bytes, first.bytes, 'disabled input forwarded touch wheels');
    await page.evaluate(() => {const nodes = [...document.querySelectorAll('.real-terminal')]; const index = nodes.findIndex(n => !n.closest('.terminal-slot').hidden); window.reviewTerm(index).options.disableStdin = false;});
    await stopApp();
    report('touchApplicationModes', {noBlindArrowKeys: true, negotiatedMouseWheels: true, disabledInputBlocked: true});

    if (process.env.WEBKIT_EXECUTABLE) {
      const {webkit} = require(process.env.PLAYWRIGHT_MODULE || '../frontend/node_modules/playwright-core');
      const engine = await webkit.launch({headless: true, executablePath: process.env.WEBKIT_EXECUTABLE, env: {...process.env}});
      try {
        const tablet = await engine.newContext({viewport: {width: 768, height: 1024}, isMobile: true, hasTouch: true});
        await tablet.addCookies(await context.cookies());
        for (const [name, url, host] of [['direct', directURL, '#terminal'], ['hub', hub, selector]]) {
          const target = await tablet.newPage(); target.on('pageerror', e => errors.push(e.stack));
          await target.goto(url, {waitUntil: 'domcontentloaded'});
          if (name === 'hub') await target.locator(`.session-tab[data-instance-id="${ids[2]}"] .tab-trigger`).tap();
          const metrics = () => target.locator(host).evaluate(h => JSON.parse(h.dataset.viewportState || '{}'));
          await wait(async () => (await metrics()).rows > 0 && await target.locator(host).getAttribute('data-replay-active') === 'false', 'WebKit terminal ready');
          await target.locator(host + ' .xterm-helper-textarea').focus();
          await target.keyboard.type("for i in $(seq 1 250); do printf 'webkit-touch-%03d\\n' \"$i\"; done"); await target.keyboard.press('Enter');
          await wait(async () => (await metrics()).base > 150, 'WebKit retained history');
          // Playwright exposes native swipes through Chromium CDP only. On
          // Linux WebKit verify DOM touch routing against its real layout and
          // xterm renderer; this is not a physical Safari gesture test.
          const distance = (await metrics()).outerMax + 160;
          await target.locator(host).evaluate(h => {
            window.reviewTouch = (type, y) => {
              const p = {identifier: 1, clientX: 180, clientY: y};
              const e = new Event(type, {bubbles: true, cancelable: true});
              Object.defineProperties(e, {touches: {value: type === 'touchend' ? [] : [p]}, changedTouches: {value: [p]}});
              h.querySelector('.xterm-screen').dispatchEvent(e);
            };
            window.reviewTouch('touchstart', 200);
          });
          for (let i = 1; i <= 8; i++) {await target.evaluate(y => window.reviewTouch('touchmove', y), 200 + distance * i / 8); await sleep(20);}
          await target.evaluate(y => window.reviewTouch('touchend', y), 200 + distance); await sleep(900);
          const after = await metrics(); assert(after.inner < after.base && !after.following, 'WebKit touch did not enter history');
          report('webkitTouch-' + name, {realRenderer: true, domTouchHistory: true, physicalSafari: false});
          await target.close();
        }
        await tablet.close();
      } finally {await engine.close();}
    }
  } finally {await desktopContext?.close(); await mobile.close();}
};

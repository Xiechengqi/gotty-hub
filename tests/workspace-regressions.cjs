// Runs ONLY disposable processes. Set HUB_BINARY and GOTTY_BINARY to the builds
// under review. Install frontend deps and Chromium before running this script.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || '../frontend/node_modules/playwright-core');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(process.env.TEST_ARTIFACTS || os.tmpdir(), 'hub-workspace-'));
const children = [], results = {}, errors = [], sent = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, hub, cookie, csrf;
async function port() {
  return new Promise(resolve => {const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => {const p = socket.address().port; socket.close(() => resolve(p));});});
}
function start(name, binary, args, env = {}) {
  const fd = fs.openSync(path.join(dir, `${name}.log`), 'a');
  const child = spawn(binary, args, {cwd: dir, env: {...process.env, ...env}, detached: true, stdio: ['ignore', fd, fd]});
  fs.closeSync(fd); children.push(child); return child;
}
async function wait(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {try {if (await fn()) return;} catch (error) {last = error;} await sleep(80);}
  throw Error(`${label}: ${last?.message || 'timed out'}`);
}
function report(name, value) {
  results[name] = value; console.log(name, JSON.stringify(value));
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2));
}
async function api(route, body, method) {
  const response = await fetch(`${hub}/api/v1${route}`, {method: method || (body === undefined ? 'GET' : 'POST'), headers: {'content-type': 'application/json', ...(cookie ? {cookie, 'x-csrf-token': csrf} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
  const value = await response.json(); assert(response.ok, JSON.stringify(value)); return value;
}
async function account(username) {
  const response = await fetch(`${hub}/api/v1/auth/register`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username, password: randomUUID()})});
  const value = await response.json(); assert(response.ok, JSON.stringify(value)); csrf = value.csrf; cookie = response.headers.get('set-cookie').split(';')[0];
}
// Read the actual xterm parser/buffer, without replacing or mocking it.
function installInspection() {
  const NativeSocket = window.WebSocket;
  window.reviewSockets = [];
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {super(...args); window.reviewSockets.push(this);}
  };
  window.reviewTerm = (index = 0) => {
    const element = document.querySelectorAll('.real-terminal')[index];
    if (!element) return;
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return) {
      let hook = fiber.memoizedState;
      for (let i = 0; hook && i < 80; i++, hook = hook.next) {
        const value = hook.memoizedState;
        const term = value?.current?.term || (value?._core ? value : null);
        if (term?._core && term?.buffer) return term;
      }
    }
  };
  window.reviewSnapshot = (index = 0) => {
    const term = window.reviewTerm(index); if (!term) return null;
    const buffer = term.buffer.active;
    return {pending: term._core._writeBuffer._pendingData, type: buffer.type, text: Array.from({length: buffer.length}, (_, i) => buffer.getLine(i)?.translateToString(true)).join('\n')};
  };
  window.reviewVisibleLayouts = [];
  function sample() {
    const app = document.querySelector('.app'), main = document.querySelector('.main');
    if (app && main && getComputedStyle(main).visibility === 'visible') {
      const maximized = app.classList.contains('workspace-maximized');
      if (window.reviewVisibleLayouts.at(-1) !== maximized) window.reviewVisibleLayouts.push(maximized);
    }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
}
(async () => {
  assert(process.env.HUB_BINARY && process.env.GOTTY_BINARY, 'Set HUB_BINARY and GOTTY_BINARY to isolated test binaries');
  const hp = await port(); hub = `http://127.0.0.1:${hp}`;
  start('hub', process.env.HUB_BINARY, ['serve'], {HUB_HOME: path.join(dir, 'hub-home'), HUB_DATABASE: `sqlite://${dir}/hub.db?mode=rwc`, HUB_LISTEN: `127.0.0.1:${hp}`, HUB_PASSWORD: randomUUID(), HUB_ASSETS: path.join(root, 'frontend/dist')});
  await wait(async () => (await fetch(`${hub}/healthz`)).ok, 'Hub startup');
  await account('workspace-review');
  const ids = [], devices = [];
  for (let i = 1; i <= 12; i++) {
    const gp = await port(), url = `http://127.0.0.1:${gp}`, state = path.join(dir, `device-${i}.json`);
    const args = ['--config', '/dev/null', '--address', '127.0.0.1', '--port', String(gp), '--hub-state-file', state, '--permit-write', '--share-enabled=false', '--close-timeout', '1', 'bash', '--noprofile', '--norc'];
    const child = start(`gotty-${i}`, process.env.GOTTY_BINARY, args); devices.push({child, url, state, args});
    await wait(async () => (await fetch(`${url}/config.js`)).ok, 'GoTTY startup');
    const response = await fetch(`${url}/-/hub`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({URL: hub, Username: 'workspace-review', Name: `终端-${String(i).padStart(2, '0')}-长名称测试`})});
    assert(response.ok); ids.push((await response.json()).instance_id);
  }
  await wait(async () => (await api('/instances')).filter(instance => instance.online).length === 12, 'twelve devices online');
  assert.equal(new Set(ids).size, 12);
  const duplicateArgs = [...devices[0].args]; duplicateArgs[duplicateArgs.indexOf('--port') + 1] = String(await port());
  const commandStarted = path.join(dir, 'duplicate-command-started');
  duplicateArgs.splice(-3, 3, 'sh', '-c', `printf started > '${commandStarted}'`);
  const duplicate = start('duplicate', process.env.GOTTY_BINARY, duplicateArgs);
  await wait(() => duplicate.exitCode !== null, 'duplicate identity rejection'); assert.notEqual(duplicate.exitCode, 0);
  assert.match(fs.readFileSync(path.join(dir, 'duplicate.log'), 'utf8'), /already in use/);
  assert(!fs.existsSync(commandStarted), 'duplicate identity started the user command before rejecting it');
  assert.equal((await api('/instances')).filter(instance => instance.online).length, 12);
  report('identity', {online: 12, distinct: 12, duplicateRejected: true});
  const directPort = await port();
  const directURL = `http://127.0.0.1:${directPort}`;
  start('gotty-direct', process.env.GOTTY_BINARY, ['--config', '/dev/null', '--hub-disabled', '--address', '127.0.0.1', '--port', String(directPort), '--permit-write', '--share-enabled=false', 'bash', '--noprofile', '--norc']);
  await wait(async () => (await fetch(`${directURL}/config.js`)).ok, 'standalone GoTTY startup');
  await api('/me/preferences', {opened: ids, instanceOrder: ids, active: ids[0], maximized: false, locale: 'zh-CN'}, 'PUT');
  browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}), args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader']});
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  await context.addCookies([{name: 'hub_session', value: cookie.split('=')[1], url: hub}]);
  await context.addInitScript(installInspection);
  // LAN HTTP origins do not expose crypto.randomUUID (localhost normally does).
  await context.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', {value: undefined}));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.stack));
  page.on('websocket', ws => ws.on('framesent', frame => {const text = String(frame.payload); if (text[0] === '1') sent.push(Buffer.from(text.slice(1), 'base64').toString());}));
  await page.goto(hub, {waitUntil: 'domcontentloaded'});
  const snapshot = () => page.evaluate(() => window.reviewSnapshot());
  const ready = () => wait(async () => {const s = await snapshot(); return s?.pending === 0 && s.text.includes('bash-');}, 'terminal parser ready');
  async function type(text) {await page.locator('.terminal-slot:not([hidden]) .xterm-helper-textarea').focus(); await page.keyboard.type(text, {delay: 5});}
  async function command(text) {await type(text); await page.keyboard.press('Enter');}
  await ready();
  const file = path.join(dir, 'vim.txt');
  await command(`vim -Nu NONE -n -i NONE '${file}'`);
  await wait(async () => {const s = await snapshot(); return s?.type === 'alternate' && s.pending === 0;}, 'Vim parser');
  await page.keyboard.press('i'); await page.keyboard.insertText('vim-insert-中文🙂'); await page.keyboard.press('Escape'); await page.keyboard.type(':wq'); await page.keyboard.press('Enter');
  await wait(async () => fs.existsSync(file) && (await snapshot())?.type === 'normal' && (await snapshot())?.pending === 0, 'Vim saved and screen recovered');
  assert.equal(fs.readFileSync(file, 'utf8'), 'vim-insert-中文🙂\n');
  await command('export HUB_REFRESH_PROBE=preserved'); await ready();
  const beforeReplay = sent.length;
  await page.reload({waitUntil: 'domcontentloaded'}); await ready(); await sleep(200);
  const replies = sent.slice(beforeReplay).filter(value => /\x1b(?:\[[?>][\d;]*[cy]|\[\d+;\d+R|\]1[012];)/.test(value));
  assert.deepEqual(replies, [], 'historic terminal queries polluted the live shell');
  await command('printf "STATE=%s\\n" "$HUB_REFRESH_PROBE"');
  await wait(async () => (await snapshot())?.text.includes('STATE=preserved'), 'shell state after replay');
  report('vimAndReplay', {fileSaved: true, parserDrained: true, historicReplies: replies.length, shellPreserved: true});
  const direct = await context.newPage(), directSent = [], directReceived = [];
  direct.on('pageerror', error => errors.push(error.stack));
  direct.on('websocket', socket => {
    socket.on('framesent', frame => {const s = String(frame.payload); if (s[0] === '1') directSent.push(Buffer.from(s.slice(1), 'base64').toString());});
    socket.on('framereceived', frame => {const s = String(frame.payload); if (s[0] === '1') directReceived.push(Buffer.from(s.slice(1), 'base64').toString());});
  });
  await direct.goto(directURL, {waitUntil: 'domcontentloaded'});
  await wait(() => directReceived.join('').includes('bash-'), 'direct GoTTY terminal');
  await direct.locator('.xterm-helper-textarea').focus();
  const directFile = path.join(dir, 'vim-direct.txt');
  await direct.keyboard.type(`vim -Nu NONE -n -i NONE '${directFile}'`); await direct.keyboard.press('Enter');
  await wait(() => directReceived.join('').includes('[?1049h'), 'direct Vim entry'); await sleep(250);
  await direct.keyboard.press('i'); await direct.keyboard.insertText('direct-中文'); await direct.keyboard.press('Escape'); await direct.keyboard.type(':wq'); await direct.keyboard.press('Enter');
  await wait(() => fs.existsSync(directFile), 'direct Vim save'); assert.equal(fs.readFileSync(directFile, 'utf8'), 'direct-中文\n');
  directSent.length = 0; directReceived.length = 0;
  await direct.reload({waitUntil: 'domcontentloaded'}); await wait(() => directReceived.join('').includes('bash-'), 'direct replay'); await sleep(350);
  assert.deepEqual(directSent.filter(value => /\x1b(?:\[[?>][\d;]*[cy]|\[\d+;\d+R|\]1[012];)/.test(value)), []);
  await direct.close(); await page.bringToFront();
  report('standaloneGoTTY', {vimSaved: true, replayRepliesSuppressed: true});
  await page.evaluate(() => {window.reviewOriginal = window.reviewTerm(); window.reviewOther = window.reviewTerm(1);});
  await page.evaluate(() => window.reviewSockets.find(socket => socket.url.includes('terminal-connections') && socket.readyState === 1)?.close());
  await wait(() => page.locator('.terminal-slot:not([hidden]) .terminal-clear-control').isDisabled(), 'transport disconnected');
  assert(!(await page.locator('.terminal-slot:not([hidden]) .terminal-reconnect-control').isDisabled()));
  await page.locator('.terminal-slot:not([hidden]) .terminal-reconnect-control').click();
  await wait(() => page.evaluate(() => window.reviewTerm() && window.reviewTerm() !== window.reviewOriginal), 'renderer replaced'); await ready();
  assert(await page.evaluate(() => window.reviewTerm(1) === window.reviewOther));
  await command('printf "AFTER=%s\\n" "$HUB_REFRESH_PROBE"');
  await wait(async () => (await snapshot())?.text.includes('AFTER=preserved'), 'shell state after terminal refresh');
  await command(`vim -Nu NONE -n -i NONE '${file}'`);
  await wait(async () => {const s = await snapshot(); return s?.type === 'alternate' && s.pending === 0;}, 'second Vim session');
  await page.keyboard.press('G'); await page.keyboard.press('o'); await page.keyboard.type('unsaved-before-refresh');
  await page.locator('.terminal-slot:not([hidden]) .terminal-reconnect-control').click();
  await wait(async () => {const s = await snapshot(); return s?.type === 'alternate' && s.pending === 0 && s.text.includes('unsaved-before-refresh');}, 'restore active Vim');
  await page.locator('.terminal-slot:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.press('Escape'); await page.keyboard.type(':wq'); await page.keyboard.press('Enter');
  await wait(async () => (await snapshot())?.type === 'normal' && fs.readFileSync(file, 'utf8').includes('unsaved-before-refresh'), 'save preserved Vim session');
  report('terminalRefresh', {newRenderer: true, disconnectedRecovery: true, otherPaneUnchanged: true, shellPreserved: true, unsavedVimPreserved: true});
  assert.equal(await page.getByRole('button', {name: '刷新页面', exact: true}).count(), 1);
  await page.locator('.maximize-button').click();
  await page.reload({waitUntil: 'domcontentloaded'}); await ready();
  assert(await page.locator('.app').evaluate(element => element.classList.contains('workspace-maximized')));
  assert.deepEqual(await page.evaluate(() => window.reviewVisibleLayouts), [true]);
  await sleep(800);
  await page.route('**/api/v1/me/preferences', async route => {if (route.request().method() === 'GET') await sleep(800); await route.continue();});
  await page.reload({waitUntil: 'domcontentloaded'}); await ready();
  assert.deepEqual(await page.evaluate(() => window.reviewVisibleLayouts), [true]);
  await page.unroute('**/api/v1/me/preferences');
  report('maximize', {immediateReload: true, delayedPreferences: true, noOrdinaryLayoutFlash: true});
  const widths = [];
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({width, height: 844}); await sleep(180);
    const trigger = page.locator('.session-switcher-trigger'); assert(await trigger.isVisible());
    const box = await trigger.boundingBox(); assert(box.x >= 0 && box.x + box.width <= width);
    assert(await page.locator('.session-tabs-scroll').isHidden());
    await trigger.click(); await page.getByRole('dialog').waitFor();
    assert.equal(await page.locator('.session-switcher-row').count(), 12);
    await page.getByRole('textbox', {name: '搜索实例…'}).fill('终端-12');
    assert.equal(await page.locator('.session-switcher-row').count(), 1);
    await page.locator('.session-switcher-item').click();
    await wait(async () => (await trigger.textContent()).includes('终端-12'), 'mobile session selection');
    widths.push({width, allSessionsAccessible: true, searchAndSwitch: true});
  }
  await page.getByRole('dialog').waitFor({state: 'hidden'});
  await page.screenshot({path: path.join(dir, 'mobile.png')});
  await page.locator('.session-switcher-trigger').click();
  await page.getByRole('dialog').waitFor(); await sleep(350);
  await page.screenshot({path: path.join(dir, 'mobile-sessions.png')});
  await page.locator('.session-switcher-row').first().getByRole('button', {name: /关闭终端/}).click();
  assert.equal(await page.locator('.session-switcher-row').count(), 11);
  await page.keyboard.press('Escape');
  await page.setViewportSize({width: 844, height: 390}); await sleep(150);
  assert(await page.locator('.session-tabs-scroll').isVisible());
  await wait(() => page.locator('.session-tab.selected').evaluate(element => {const tab = element.getBoundingClientRect(), strip = element.closest('.session-tabs-scroll').getBoundingClientRect(); return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;}), 'active tab visible after rotation');
  report('mobile', {widths,closeSession: true, landscape: true});
  await account('other-review'); await api('/me/preferences', {maximized: false, locale: 'zh-CN'}, 'PUT');
  await context.addCookies([{name: 'hub_session', value: cookie.split('=')[1], url: hub}]);
  await page.reload({waitUntil: 'domcontentloaded'});
  await wait(async () => !(await page.locator('.app').evaluate(element => element.classList.contains('workspace-loading'))), 'other account layout');
  assert(!(await page.locator('.app').evaluate(element => element.classList.contains('workspace-maximized'))));
  assert.equal(await page.locator('.real-terminal').count(), 0);
  assert.deepEqual(errors, []); report('accountIsolation', {layout: true, terminals: true});
  report('browserErrors', errors);
})().catch(error => {report('failure', {message: error.message, stack: error.stack}); process.exitCode = 1;}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  for (const child of children) {try {process.kill(-child.pid, 'SIGTERM');} catch {}}
  await sleep(1200);
  for (const child of children) {try {process.kill(-child.pid, 'SIGKILL');} catch {}}
  console.log('Artifacts:', dir);
});

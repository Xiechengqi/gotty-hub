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
const children = [], results = {}, errors = [], sent = [], controlActions = [], fontRequests = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, hub, cookie, csrf, credentials;
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
  credentials = {username, password: randomUUID()};
  const response = await fetch(`${hub}/api/v1/auth/register`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(credentials)});
  const value = await response.json(); assert(response.ok, JSON.stringify(value)); csrf = value.csrf; cookie = response.headers.get('set-cookie').split(';')[0];
}
async function renewSession(context) {
  // Each suite has its own session budget. Keep the server's 120 upgrades per
  // five minutes limit intact despite many reloads of twelve mounted terminals.
  const response = await fetch(`${hub}/api/v1/auth/password/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(credentials)});
  const value = await response.json(); assert(response.ok, JSON.stringify(value));
  csrf = value.csrf; cookie = response.headers.get('set-cookie').split(';')[0];
  await context.addCookies([{name: 'hub_session', value: cookie.split('=')[1], url: hub}]);
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
    return {pending: term._core._writeBuffer._pendingData, type: buffer.type, cols: term.cols, rows: term.rows, cursor: [buffer.cursorX, buffer.cursorY], text: Array.from({length: buffer.length}, (_, i) => buffer.getLine(i)?.translateToString(true)).join('\n')};
  };
  window.reviewVisibleLayouts = [];
  function sample() {
    const app = document.querySelector('.app'), main = document.querySelector('.main');
    if (app && main && getComputedStyle(main).visibility === 'visible') {
      const terminal=document.querySelector('.terminals')?.getBoundingClientRect();
      const maximized = !!terminal && terminal.y === 0 && Math.abs(terminal.height-visualViewport.height)<1;
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
  browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}), env:{...process.env,...(process.env.CHROMIUM_LIBRARY_PATH?{LD_LIBRARY_PATH:process.env.CHROMIUM_LIBRARY_PATH}:{}),...(process.env.CHROMIUM_FONTCONFIG?{FONTCONFIG_FILE:process.env.CHROMIUM_FONTCONFIG}:{})}, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader']});
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  await context.addCookies([{name: 'hub_session', value: cookie.split('=')[1], url: hub}]);
  await context.addInitScript(installInspection);
  await context.addInitScript(({id}) => localStorage.setItem(`gotty-hub:terminal:${id}:appearance`, JSON.stringify({theme:'monokai',fontSize:16,fontFamily:'monospace'})), {id:ids[0]});
  // LAN HTTP origins do not expose crypto.randomUUID (localhost normally does).
  await context.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', {value: undefined}));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.stack));
  page.on('request', request => {if (new URL(request.url()).pathname.endsWith('.woff2')) fontRequests.push(request.url());});
  page.on('websocket', ws => ws.on('framesent', frame => {const text = String(frame.payload); if (text[0] === '{') {try {const action=JSON.parse(text).control?.action;if(action)controlActions.push(action);} catch {}} if (text[0] === '1') sent.push(Buffer.from(text.slice(1), 'base64').toString());}));
  await page.goto(hub, {waitUntil: 'domcontentloaded'});
  const snapshot = () => page.evaluate(() => window.reviewSnapshot());
  const ready = () => wait(async () => {const s = await snapshot(); return s?.pending === 0 && s.text.includes('bash-') && await page.locator('.terminal-slot:not([hidden]) .terminal-clear-control').isEnabled();}, 'terminal parser ready');
  async function type(text) {await page.locator('.terminal-slot:not([hidden]) .xterm-helper-textarea').focus(); await page.keyboard.type(text, {delay: 5});}
  async function command(text) {await type(text); await page.keyboard.press('Enter');}
  await ready();
  if(process.env.WORKSPACE_SUITE==='overlay'){
    await require('./overlay-regressions.cjs')({page,context,browser,hub,ids,api,wait,sleep,dir,report,start,port,installInspection,errors});
    assert.deepEqual(errors,[]);report('browserErrors',errors);return;
  }
  if(process.env.WORKSPACE_SUITE==='dataflow'){
    await require('./dataflow-regressions.cjs')({page,context,browser,hub,ids,devices,api,wait,sleep,dir,report,installInspection,errors});
    assert.deepEqual(errors,[]);report('browserErrors',errors);return;
  }
  if(process.env.WORKSPACE_SUITE==='rendering'){
    await require('./rendering-regressions.cjs')({page,context,browser,hub,ids,devices,api,wait,sleep,dir,report,installInspection,errors});
    assert.deepEqual(errors,[]);report('browserErrors',errors);return;
  }
  if(process.env.WORKSPACE_SUITE==='split'){
    await api('/me/terminal-settings',{revision:0,settings:{schemaVersion:1,theme:'paper',fontSize:24,fontId:'fira-code'}},'PUT');
    await require('./split-regressions.cjs')({page,context,browser,hub,ids,devices,api,wait,sleep,dir,report,installInspection,start,errors});
    assert.deepEqual(errors,[]);report('browserErrors',errors);return;
  }
  async function reveal(target = page) {await target.locator('.workspace-bar').waitFor();}
  async function terminalAction(name) {await reveal();await page.locator('.session-tab.selected .tab-trigger').click();const menu=page.locator('.tab-actions-menu');await menu.waitFor();await menu.getByRole('button',{name,exact:true}).click();await menu.waitFor({state:'hidden'});}
  async function settingsDialog(target = page) {
    await target.bringToFront();await reveal(target);
    await target.getByRole('button', {name:'设置',exact:true}).click();
    await target.getByRole('button', {name:'终端设置',exact:true}).click();
    const dialog=target.getByRole('dialog',{name:'终端设置',exact:true}); await dialog.waitFor();
    await target.waitForFunction(()=>!document.querySelector('[data-entering],[data-exiting]'));
    return dialog;
  }
  const fontLoaded=(target,family)=>target.evaluate(family=>[...document.fonts].some(font=>font.family.replace(/^['"]|['"]$/g,'')===family&&font.status==='loaded'),family);
  async function verifyFontMetrics(index) {
    await wait(()=>page.evaluate(index=>{
      const term=window.reviewTerm(index);if(!term)return false;
      const ctx=document.createElement('canvas').getContext('2d');ctx.font=`${term.options.fontSize}px ${term.options.fontFamily}`;
      return Math.abs(ctx.measureText('W').width-term._core._charSizeService.width)<0.1;
    },index),'loaded font cell metrics');
  }
  // Visit a second instance to test updates to retained background terminals.
  await page.locator('.session-tab[data-instance-id="'+ids[1]+'"] .tab-trigger').click({button:'right'});
  await wait(()=>page.locator('.terminal-slot:not([hidden]) .terminal-clear-control').isEnabled(),'second terminal');
  await page.locator('.session-tab[data-instance-id="'+ids[0]+'"] .tab-trigger').click({button:'right'});
  await wait(()=>fontLoaded(page,'DejaVu Sans Mono'),'embedded default font');
  await verifyFontMetrics(1);
  assert(fontRequests.every(url=>url.includes('dejavu-sans-mono')), 'unselected fonts downloaded at startup');
  assert.equal(await page.locator('.terminal-display-control').count(),0);
  let dialog=await settingsDialog();
  await page.screenshot({path:path.join(dir,'terminal-settings-desktop.png')});
  assert.equal(await dialog.getByRole('spinbutton').inputValue(),'16','legacy font size migration');
  assert.equal(await dialog.getByRole('button',{name:/Monokai$/}).getAttribute('aria-pressed'),'true');
  await dialog.getByRole('button',{name:/^Fira Code/}).click();
  await wait(()=>fontLoaded(page,'Fira Code'),'on-demand Fira Code');
  await dialog.getByRole('button',{name:'24px',exact:true}).click();
  await dialog.getByRole('button',{name:/柔和米色$/}).click();
  assert.equal(await dialog.locator('.terminal-settings-preview').evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(245, 245, 213)');
  await dialog.locator('.terminal-preview-host[data-font-status="ready"] .xterm-screen').waitFor();
  assert.equal(await dialog.locator('.terminal-preview-host').getAttribute('data-font-applied'),"'Fira Code', monospace");
  const originalCount=await page.evaluate(()=>{window.settingsOriginal=window.reviewTerm();window.settingsOther=window.reviewTerm(1);return window.reviewSockets.length;});
  await dialog.getByRole('button',{name:'保存并应用',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  await wait(()=>page.evaluate(()=>window.reviewTerm()?.options.fontSize===24&&window.reviewTerm()?.options.fontFamily.includes('Fira Code')),'account settings applied');
  assert(await page.evaluate(()=>window.reviewTerm()===window.settingsOriginal&&window.reviewTerm(1)===window.settingsOther));
  assert.equal(await page.evaluate(()=>window.reviewSockets.length),originalCount);
  assert(await page.evaluate(()=>[0,1].every(index=>window.reviewTerm(index).options.theme.background==='#f5f5d5')));
  assert.equal(await page.locator('.real-terminal').first().evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(245, 245, 213)');
  assert.equal(await page.locator('.real-terminal .xterm-viewport').first().evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(245, 245, 213)');
  assert.equal((await api('/me/terminal-settings')).settings.theme,'paper');
  assert.equal((await api('/me/terminal-settings')).settings.fontId,'fira-code');
  await sleep(800);assert.equal((await api('/me/terminal-settings')).settings.fontSize,24,'layout autosave erased terminal settings');
  await page.route('**/*.woff2',route=>route.abort());
  const requestsBeforeReload=fontRequests.length;
  await page.reload({waitUntil:'domcontentloaded'});await ready();
  await wait(()=>fontLoaded(page,'Fira Code'),'font restored from IndexedDB');await sleep(150);
  assert.equal(await page.evaluate(()=>window.reviewTerm().options.theme.background),'#f5f5d5','Paper theme lost after reload');
  assert.equal(fontRequests.length,requestsBeforeReload,'reload fetched font bytes instead of using IndexedDB');
  await page.unroute('**/*.woff2');
  await verifyFontMetrics(0);
  await page.evaluate(()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('gotty-terminal-fonts',1);request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result,read=db.transaction('files','readonly').objectStore('files').getAllKeys();
      read.onsuccess=()=>{const key=read.result.find(key=>String(key).startsWith('fira-code-'));const get=db.transaction('files','readonly').objectStore('files').get(key);
        get.onsuccess=()=>{const tx=db.transaction('files','readwrite');tx.objectStore('files').put(new ArrayBuffer(get.result.byteLength),key);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};
      };
    };
  }));
  const beforeCorruptReload=fontRequests.length;
  await page.reload({waitUntil:'domcontentloaded'});await ready();await wait(()=>fontLoaded(page,'Fira Code'),'corrupt cache redownload');
  assert(fontRequests.slice(beforeCorruptReload).some(url=>url.includes('fira-code')),'corrupt font cache was not repaired');await verifyFontMetrics(0);
  dialog=await settingsDialog();
  await page.route('**/*cascadia-code*.woff2',route=>route.abort());
  await dialog.getByRole('button',{name:/^Cascadia Code/}).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.getByRole('button',{name:/^Fira Code/}).getAttribute('aria-pressed'),'true');
  await page.unroute('**/*cascadia-code*.woff2');
  for(const [name,family] of [['Cascadia Code','Cascadia Code'],['JetBrains Mono','JetBrains Mono'],['DejaVu Sans Mono','DejaVu Sans Mono'],['Source Code Pro','Source Code Pro']]) {
    await dialog.getByRole('button',{name:new RegExp('^'+name)}).click();
    await wait(()=>fontLoaded(page,family),'font '+family);
    await wait(async()=>await dialog.getByRole('button',{name:new RegExp('^'+name)}).getAttribute('aria-pressed')==='true','font selection '+family);
  }
  await dialog.getByRole('button',{name:'取消',exact:true}).last().click(); await dialog.waitFor({state:'hidden'});
  assert.equal((await api('/me/terminal-settings')).settings.fontId,'fira-code','cancel changed account preferences');
  dialog=await settingsDialog();await dialog.getByRole('button',{name:'18px',exact:true}).click();
  await page.route('**/api/v1/me/terminal-settings',route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:'{"error":"database_error"}'}):route.continue());
  await dialog.getByRole('button',{name:'保存并应用',exact:true}).click();await dialog.getByRole('alert').waitFor();
  assert.equal(await page.evaluate(()=>window.reviewTerm().options.fontSize),24);
  await page.unroute('**/api/v1/me/terminal-settings');await dialog.getByRole('button',{name:'取消',exact:true}).last().click();
  dialog=await settingsDialog();await dialog.getByRole('button',{name:'18px',exact:true}).click();
  const conflictBase=await api('/me/terminal-settings');await api('/me/terminal-settings',{revision:conflictBase.revision,settings:{...conflictBase.settings,fontSize:22}},'PUT');
  await dialog.getByRole('button',{name:'保存并应用',exact:true}).click();await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.getByRole('spinbutton').inputValue(),'18','conflict lost the editable draft');
  await dialog.getByRole('button',{name:'取消',exact:true}).last().click();dialog=await settingsDialog();
  assert.equal(await dialog.getByRole('spinbutton').inputValue(),'22','conflict did not reload current server settings');
  await dialog.getByRole('button',{name:'24px',exact:true}).click();await dialog.getByRole('button',{name:'保存并应用',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const second=await context.newPage();await second.goto(hub,{waitUntil:'domcontentloaded'});
  await wait(async()=>await second.evaluate(()=>window.reviewTerm()?.options.fontSize===24 && window.reviewSnapshot()?.text.includes('bash-')) && await second.locator('.terminal-slot:not([hidden]) .terminal-clear-control').isEnabled(),'second tab settings');
  let secondDialog=await settingsDialog(second);await secondDialog.getByRole('button',{name:'20px',exact:true}).click();
  await secondDialog.getByRole('button',{name:/Light$/}).click();
  await secondDialog.getByRole('button',{name:'保存并应用',exact:true}).click();await secondDialog.waitFor({state:'hidden'});
  await wait(()=>page.evaluate(()=>window.reviewTerm()?.options.fontSize===20),'settings storage-event synchronization');
  await wait(()=>page.evaluate(()=>window.reviewTerm()?.options.theme.background==='#fafafa'),'theme storage-event synchronization');
  await second.close();await page.bringToFront();
  dialog=await settingsDialog();await dialog.getByRole('button',{name:'24px',exact:true}).click();
  await dialog.getByRole('button',{name:/柔和米色$/}).click();
  await dialog.getByRole('button',{name:'保存并应用',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.screenshot({path:path.join(dir,'terminal-settings-applied.png')});
  report('terminalSettings',{accountWide:true,legacyMigration:true,noReconnect:true,cachedReloadWithoutNetwork:true,corruptCacheRecovered:true,correctFontMetrics:true,allBundledFontsLoaded:true,failedDownloadRetry:true,failedSavePreserved:true,conflictRecovery:true,crossTab:true,paperTheme:true});
  await command("printf '\\033[0m\\033[31mPAPER_RED\\033[0m \\033[38;5;196mPAPER_256\\033[0m \\033[38;2;18;52;86mPAPER_RGB\\033[0m \\033[48;2;18;52;86mPAPER_BG\\033[0m\\n'");
  await wait(()=>page.evaluate(()=>{
    const term=window.reviewTerm(),buffer=term.buffer.active;
    for(let i=buffer.length-1;i>=0;i--){const line=buffer.getLine(i);if(line?.translateToString(true).startsWith('PAPER_RED PAPER_256'))return true;}
    return false;
  }),'Paper ANSI output');
  const paperColors=await page.evaluate(()=>{
    const term=window.reviewTerm(),buffer=term.buffer.active;
    let line;for(let i=buffer.length-1;i>=0;i--){const current=buffer.getLine(i);if(current?.translateToString(true).startsWith('PAPER_RED PAPER_256')){line=current;break;}}
    const text=line.translateToString(true),red=line.getCell(0),indexed=line.getCell(text.indexOf('PAPER_256')),rgb=line.getCell(text.indexOf('PAPER_RGB')),background=line.getCell(text.indexOf('PAPER_BG'));
    return {red:red.isFgPalette()&&red.getFgColor()===1,indexed:indexed.isFgPalette()&&indexed.getFgColor()===196,rgb:rgb.isFgRGB()&&rgb.getFgColor()===0x123456,background:background.isBgRGB()&&background.getBgColor()===0x123456,reset:line.getCell(text.indexOf(' ')).isBgDefault(),theme:term.options.theme};
  });
  for(const name of ['red','indexed','rgb','background','reset'])assert.equal(paperColors[name],true,name+' color semantics changed');
  assert.equal(paperColors.theme.cursor,'#5f6b53');assert.equal(paperColors.theme.selectionBackground,'#d7ddbd');
  await page.evaluate(()=>{const term=window.reviewTerm();term.select(0,term.buffer.active.cursorY+term.buffer.active.baseY-1,9);});
  await page.screenshot({path:path.join(dir,'paper-terminal-desktop.png')});await page.evaluate(()=>window.reviewTerm().clearSelection());
  report('paperColors',{ansi16:true,indexed256Preserved:true,trueColorPreserved:true,explicitBackgroundPreserved:true,cursorAndSelection:true});
  const restart={click:()=>terminalAction('重启此 GoTTY…')};
  const beforeRestart=controlActions.length;await restart.click();
  const confirmation=page.getByRole('alertdialog');await confirmation.waitFor();
  assert((await confirmation.textContent()).includes('终端-01'));assert.equal(controlActions.length,beforeRestart);
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();await confirmation.waitFor({state:'hidden'});
  assert.equal(controlActions.length,beforeRestart);
  await restart.click();await confirmation.getByRole('button',{name:'重启此 GoTTY',exact:true}).click();
  await wait(()=>controlActions.length===beforeRestart+1,'confirmed restart');
  assert.equal(controlActions.at(-1),'restart');await confirmation.waitFor({state:'hidden'});await sleep(1400);await ready();
  report('restartConfirmation',{cancelSendsNothing:true,confirmedExactlyOnce:true});
  const file = path.join(dir, 'vim.txt');
  await command(`vim -Nu NONE -n -i NONE '${file}'`);
  await wait(async () => {const s = await snapshot(); return s?.type === 'alternate' && s.pending === 0;}, 'Vim parser');
  await page.screenshot({path:path.join(dir,'paper-vim-hub.png')});
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
    socket.on('framereceived', frame => {let s = String(frame.payload); if (s[0] === 'c') s = JSON.parse(s.slice(1)).data; if (s[0] === '1') directReceived.push(Buffer.from(s.slice(1), 'base64').toString());});
  });
  await direct.goto(directURL, {waitUntil: 'domcontentloaded'});
  await wait(() => directReceived.join('').includes('bash-'), 'direct GoTTY terminal');
  await direct.locator('#gotty-theme-btn').click();
  await direct.locator('.theme-item').filter({hasText:'Paper'}).click();
  await direct.locator('#gotty-theme-btn').click();
  await direct.locator('.xterm-helper-textarea').focus();
  const directFile = path.join(dir, 'vim-direct.txt');
  await direct.keyboard.type(`vim -Nu NONE -n -i NONE '${directFile}'`); await direct.keyboard.press('Enter');
  await wait(() => directReceived.join('').includes('[?1049h'), 'direct Vim entry'); await sleep(250);
  await direct.screenshot({path:path.join(dir,'paper-vim-standalone.png')});
  await direct.keyboard.press('i'); await direct.keyboard.insertText('direct-中文'); await direct.keyboard.press('Escape'); await direct.keyboard.type(':wq'); await direct.keyboard.press('Enter');
  await wait(() => fs.existsSync(directFile), 'direct Vim save'); assert.equal(fs.readFileSync(directFile, 'utf8'), 'direct-中文\n');
  directSent.length = 0; directReceived.length = 0;
  await direct.reload({waitUntil: 'domcontentloaded'}); await wait(() => directReceived.join('').includes('bash-'), 'direct replay'); await sleep(350);
  assert.deepEqual(directSent.filter(value => /\x1b(?:\[[?>][\d;]*[cy]|\[\d+;\d+R|\]1[012];)/.test(value)), []);
  await direct.locator('#gotty-theme-btn').click();
  await direct.locator('.font-family-item').filter({hasText:'JetBrains Mono'}).click();
  await wait(()=>fontLoaded(direct,'JetBrains Mono'),'standalone downloadable font');
  await wait(()=>direct.evaluate(()=>localStorage.getItem('gotty-font-family')==="'JetBrains Mono', monospace"),'standalone font saved');
  await direct.locator('.theme-item').filter({hasText:'Paper'}).click();
  const standaloneBackground=()=>direct.evaluate(()=>['body','#terminal','.xterm-viewport'].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor));
  assert.deepEqual(await standaloneBackground(),Array(3).fill('rgb(245, 245, 213)'));
  assert.equal(await direct.evaluate(()=>localStorage.getItem('gotty-theme')),'paper');
  const directFontRequests=[];direct.on('request',request=>{if(request.url().endsWith('.woff2'))directFontRequests.push(request.url());});
  await direct.route('**/*.woff2',route=>route.abort());await direct.reload({waitUntil:'domcontentloaded'});
  await wait(()=>fontLoaded(direct,'JetBrains Mono'),'standalone font cached reload');assert.deepEqual(directFontRequests,[]);
  assert.deepEqual(await standaloneBackground(),Array(3).fill('rgb(245, 245, 213)'),'standalone Paper background lost on reload');
  for(const width of [1280,320,375]){await direct.setViewportSize({width,height:800});await sleep(150);await direct.screenshot({path:path.join(dir,`paper-standalone-${width}.png`)});}
  const fontURL=fontRequests.find(url=>url.includes('dejavu-sans-mono'));
  const fontResponse=await page.request.get(fontURL);assert.match(fontResponse.headers()['cache-control'],/immutable/);assert.match(fontResponse.headers()['content-type'],/font\/woff2/);
  await direct.close(); await page.bringToFront();
  const noStorageContext=await browser.newContext();const noStorage=await noStorageContext.newPage();noStorage.on('pageerror',error=>errors.push(error.stack));
  await noStorage.addInitScript(()=>Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('Storage denied','SecurityError');}}));
  await noStorage.goto(directURL,{waitUntil:'domcontentloaded'});await wait(()=>fontLoaded(noStorage,'DejaVu Sans Mono'),'font loading without IndexedDB');
  await noStorage.locator('#gotty-theme-btn').click();await noStorage.locator('.font-family-item').filter({hasText:'Fira Code'}).click();await wait(()=>fontLoaded(noStorage,'Fira Code'),'optional font without IndexedDB');await noStorageContext.close();
  report('standaloneGoTTY', {vimSaved: true, replayRepliesSuppressed: true,cachedFontReload:true,storageDeniedFallback:true,paperPersisted:true,outerBackgroundMatches:true});
  await page.evaluate(() => {window.reviewOriginal = window.reviewTerm(); window.reviewOther = window.reviewTerm(1);});
  await page.evaluate(() => window.reviewSockets.find(socket => socket.url.includes('terminal-connections') && socket.readyState === 1)?.close());
  await wait(() => page.locator('.terminal-slot:not([hidden]) .terminal-clear-control').isDisabled(), 'transport disconnected');
  await terminalAction('刷新此终端');
  await wait(() => page.evaluate(() => window.reviewTerm() && window.reviewTerm() === window.reviewOriginal && window.reviewSockets.at(-1)?.readyState === 1), 'renderer retained and socket reconnected'); await ready();
  assert(await page.evaluate(() => window.reviewTerm(1) === window.reviewOther));
  await command('printf "AFTER=%s\\n" "$HUB_REFRESH_PROBE"');
  await wait(async () => (await snapshot())?.text.includes('AFTER=preserved'), 'shell state after terminal refresh');
  await command(`vim -Nu NONE -n -i NONE '${file}'`);
  await wait(async () => {const s = await snapshot(); return s?.type === 'alternate' && s.pending === 0;}, 'second Vim session');
  await page.keyboard.press('G'); await page.keyboard.press('o'); await page.keyboard.type('unsaved-before-refresh');
  await terminalAction('刷新此终端');
  await wait(async () => {const s = await snapshot(); return s?.type === 'alternate' && s.pending === 0 && s.text.includes('unsaved-before-refresh');}, 'restore active Vim');
  await page.locator('.terminal-slot:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.press('Escape'); await page.keyboard.type(':wq'); await page.keyboard.press('Enter');
  await wait(async () => (await snapshot())?.type === 'normal' && fs.readFileSync(file, 'utf8').includes('unsaved-before-refresh'), 'save preserved Vim session');
  report('terminalRefresh', {rendererRetained: true, disconnectedRecovery: true, otherPaneUnchanged: true, shellPreserved: true, unsavedVimPreserved: true});
  await renewSession(context); await page.reload({waitUntil:'domcontentloaded'}); await ready();
  await require('./split-regressions.cjs')({page,context,browser,hub,ids,devices,api,wait,sleep,dir,report,installInspection,start,errors});
  await renewSession(context); await page.reload({waitUntil:'domcontentloaded'}); await ready();
  await require('./overlay-regressions.cjs')({page,context,browser,hub,ids,api,wait,sleep,dir,report,start,port,installInspection,errors});
  await account('other-review'); await api('/me/preferences', {maximized: false, locale: 'zh-CN'}, 'PUT');
  await context.addCookies([{name: 'hub_session', value: cookie.split('=')[1], url: hub}]);
  await page.reload({waitUntil: 'domcontentloaded'});
  await wait(async () => !(await page.locator('.app').evaluate(element => element.classList.contains('workspace-loading'))), 'other account layout');
  assert.equal(await page.locator('.session-tab').count(),0);
  assert.equal(await page.locator('.real-terminal').count(), 0);
  dialog=await settingsDialog();assert.equal(await dialog.getByRole('spinbutton').inputValue(),'14');await dialog.getByRole('button',{name:'取消',exact:true}).last().click();assert.equal((await api('/me/terminal-settings')).settings,null);
  assert.deepEqual(errors, []); report('accountIsolation', {layout: true, terminals: true});
  report('browserErrors', errors);
})().catch(async error => {
  report('failure', {message: error.message, stack: error.stack}); report('browserErrors', errors);
  let index=0;
  for (const context of browser?.contexts() || []) for (const page of context.pages()) {
    const name=`failure-${index++}`;
    try {fs.writeFileSync(path.join(dir,`${name}.json`),JSON.stringify(await page.evaluate(()=>({snapshot:window.reviewSnapshot?.(),terminals:[...document.querySelectorAll('.real-terminal')].map((element,index)=>({id:element.closest('.terminal-slot')?.dataset.instanceId,snapshot:window.reviewSnapshot?.(index)})),inputs:window.splitInputs,sizes:window.splitSizes,sockets:window.reviewSockets?.map(socket=>({readyState:socket.readyState})),body:document.body.innerText})),null,2));await page.screenshot({path:path.join(dir,`${name}.png`),timeout:3000});} catch {}
  }
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close().catch(() => {});
  for (const child of children) {try {process.kill(-child.pid, 'SIGTERM');} catch {}}
  await sleep(1200);
  for (const child of children) {try {process.kill(-child.pid, 'SIGKILL');} catch {}}
  console.log('Artifacts:', dir);
});

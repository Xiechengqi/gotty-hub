// CI-only process checks; --ui also runs Chromium against the production binary.
// Never run either mode as a local deployment check. No screenshots are taken.
'use strict';
const assert = require('node:assert/strict');
assert(process.env.CI, 'Process/proxy regression checks must run in CI.');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const {spawn, execFileSync} = require('node:child_process');
const {createHash, randomBytes} = require('node:crypto');
const WebSocket = require('../frontend/node_modules/ws');
const binary = path.resolve(__dirname, '../target/debug/gotty-hub');
const browserRegression = process.argv.includes('--ui');
const adminPassword = 'CI stdin administrator password';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const secret = () => randomBytes(32).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-proxy-shutdown-'));
const sockets = new Set();
const children = new Set();
let proxy;
let base;
let backendPort;
let home;
let proxyMode = 'forwarded';

async function until(predicate, message, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(30);
  }
  throw Error(message);
}
async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function track(socket) {
  // The HTTP agent can reuse a socket for many requests. Track its lifetime
  // once, rather than accumulating error/close listeners on every request.
  if (sockets.has(socket)) return socket;
  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
  return socket;
}
function forwarded(headers) {
  // Strip client hints about the proxy itself in both modes. Host-only mode
  // models TLS offload that preserves Host but sends no forwarding headers.
  const clean = {...headers};
  delete clean['x-forwarded-proto'];
  delete clean['x-forwarded-host'];
  if (proxyMode === 'host-only') return clean;
  return {...clean, host: `127.0.0.1:${backendPort}`,
    'x-forwarded-proto': 'https', 'x-forwarded-host': headers.host};
}
async function startProxy() {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem'),
    '-subj', '/CN=localhost', '-days', '1'], {stdio: 'ignore'});
  proxy = https.createServer({key: fs.readFileSync(path.join(tmp, 'key.pem')),
    cert: fs.readFileSync(path.join(tmp, 'cert.pem'))}, (request, response) => {
    const upstream = http.request({host: '127.0.0.1', port: backendPort,
      path: request.url, method: request.method, headers: forwarded(request.headers)}, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on('socket', track);
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  proxy.on('connection', track);
  proxy.on('upgrade', (request, socket, head) => {
    track(socket);
    const upstream = track(net.connect(backendPort, '127.0.0.1'));
    upstream.on('connect', () => {
      const headers = Object.entries(forwarded(request.headers)).map(([key, value]) => `${key}: ${value}`).join('\r\n');
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  base = `https://127.0.0.1:${proxy.address().port}`;
}
function request(route, {body, session, method, origin = base, headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(base + route, {method: method ?? (payload === undefined ? 'GET' : 'POST'),
      rejectUnauthorized: false, agent: false, headers: {
        ...(origin === null ? {} : {origin}),
        ...(payload === undefined ? {} : {'content-type': 'application/json'}),
        ...(session ? {cookie: session.cookie, 'x-csrf-token': session.csrf} : {}), ...headers,
      }}, response => {
      let text = '';
      // Decode across chunk boundaries; bundles contain multi-byte UTF-8 text.
      response.setEncoding('utf8');
      response.on('data', data => text += data);
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers,
        text, data: text && (response.headers['content-type'] || '').includes('application/json') ? JSON.parse(text) : null}));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(Error('request timed out')));
    req.end(payload);
  });
}
async function login() {
  const result = await request('/api/v1/auth/password/login', {body: {username: 'admin', password: adminPassword},
    headers: {'x-forwarded-proto': 'http', 'x-forwarded-host': 'attacker.invalid'}});
  assert.equal(result.status, 200, 'HTTPS proxy login failed');
  assert.equal(result.data.hub_address, base);
  assert.match(result.headers['set-cookie'][0], /; Secure/);
  assert.equal(result.headers['strict-transport-security'], 'max-age=31536000');
  return {cookie: result.headers['set-cookie'][0].split(';')[0], csrf: result.data.csrf};
}
async function start(assets) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HUB_')));
  Object.assign(env, {HUB_HOME: home, HUB_LISTEN: `127.0.0.1:${backendPort}`, HUB_FIXTURE: 'preserved',
    HUB_ORIGIN: 'http://ignored-environment.invalid'});
  if (assets) env.HUB_ASSETS = assets;
  const child = spawn(binary, ['serve', '--password-stdin', '--origin', 'http://ignored-cli.invalid'],
    {env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe']});
  children.add(child);
  const state = {child, logs: '', exited: false};
  child.stdout.on('data', data => state.logs = (state.logs + data).slice(-65536));
  child.stderr.on('data', data => state.logs = (state.logs + data).slice(-65536));
  state.ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {state.exited = true; children.delete(child); resolve({code, signal});});
  });
  child.stdin.end(adminPassword + '\n');
  await until(async () => {
    assert(!state.exited, 'Hub exited before listening');
    try { return (await request('/readyz')).status === 200; } catch { return false; }
  }, 'Hub did not become ready');
  return state;
}
async function connect(route, headers, initial) {
  const ws = new WebSocket(base.replace('https:', 'wss:') + route, {rejectUnauthorized: false, headers});
  ws.messages = [];
  ws.on('message', data => ws.messages.push(data.toString()));
  ws.on('error', () => {});
  ws.closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  await bounded(new Promise((resolve, reject) => {ws.once('open', resolve); ws.once('error', reject);}), 6000, 'WSS upgrade timed out');
  if (initial) ws.send(JSON.stringify(initial));
  return ws;
}
async function device(registration, hello = true) {
  const ws = await connect('/connector/v1/connect', {'x-instance-id': registration.instance_id,
    authorization: `Bearer ${registration.credential}`}, hello ? {kind: 'hello', data: {protocol: 1, capabilities: {write: true, controls: true, files: true}}} : null);
  if (hello) {
    ws.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame.kind === 'open') {
        ws.send(JSON.stringify({kind: 'data', stream: frame.stream, data: '4' + JSON.stringify({'hub-config': {
          mobile_keys: true, restart_mode: 'exec', themes: {nord: {background:'#2e3440',foreground:'#d8dee9'}, light: {background:'#fff',foreground:'#222'}}
        }})}));
        ws.send(JSON.stringify({kind: 'data', stream: frame.stream, data: '73'}));
        ws.send(JSON.stringify({kind: 'data', stream: frame.stream,
          data: '1' + Buffer.from('proxy terminal connected').toString('base64')}));
      }
    });
    await until(() => ws.messages.some(text => JSON.parse(text).kind === 'hello_ack'), 'connector hello failed');
  }
  return ws;
}
async function terminal(session, registration, authenticate = true) {
  let auth;
  if (authenticate) {
    const result = await request(`/api/v1/instances/${registration.instance_id}/terminal-tickets`, {session, body: {}});
    assert.equal(result.status, 200);
    auth = {ticket: result.data.ticket};
  }
  const ws = await connect(`/api/v1/terminal-connections/${registration.instance_id}/ws`,
    {cookie: session.cookie, origin: base}, auth);
  if (authenticate) await until(() => ws.messages.some(text => text.startsWith('1')), 'WSS terminal relay failed');
  return ws;
}
async function events(session) {
  return bounded(new Promise((resolve, reject) => {
    const req = https.get(base + '/api/v1/events', {rejectUnauthorized: false, agent: false,
      headers: {cookie: session.cookie, origin: base}}, response => {
      assert.equal(response.statusCode, 200);
      const result = {ended: false, closed: new Promise(done => response.once('close', done))};
      response.on('end', () => {result.ended = response.complete;});
      response.on('error', reject);
      let text = '';
      response.on('data', data => {text += data; if (text.includes('event: instances')) resolve(result);});
    });
    req.on('error', reject);
  }), 6000, 'SSE did not send instances');
}
async function active(session, registration) {
  const connector = await device(registration);
  const browser = await terminal(session, registration);
  const sse = await events(session);
  // Both device and browser handshakes may also be idle when shutdown arrives.
  const idleDevice = await device(registration, false);
  const idleBrowser = await terminal(session, registration, false);
  return {connector, browser, sse, idleDevice, idleBrowser};
}
async function domainChanges(registration) {
  proxyMode = 'host-only';
  const connector = await device(registration);
  try {
    for (const host of ['first.invalid', 'changed.invalid:8443']) {
      const origin = `https://${host}`;
      const result = await request('/api/v1/auth/password/login', {origin, headers: {host},
        body: {username: 'admin', password: adminPassword}});
      assert.equal(result.status, 200, 'Host-only HTTPS proxy login failed after domain change');
      assert.equal(result.data.hub_address, origin);
      assert.match(result.headers['set-cookie'][0], /; Secure/);
      const session = {cookie: result.headers['set-cookie'][0].split(';')[0], csrf: result.data.csrf};
      const refreshed = await request('/api/v1/me', {session, origin: null,
        headers: {host, 'x-hub-origin': origin}});
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.data.hub_address, origin, 'Refresh lost the HTTPS public address');
      const ticket = await request(`/api/v1/instances/${registration.instance_id}/terminal-tickets`,
        {session, origin, headers: {host}, body: {}});
      assert.equal(ticket.status, 200);
      const route = `/api/v1/terminal-connections/${registration.instance_id}/ws`;
      const browser = await connect(route, {host, origin, cookie: session.cookie}, {ticket: ticket.data.ticket});
      await until(() => browser.messages.some(text => text.startsWith('1')), 'Host-only WSS terminal relay failed');
      browser.close();
      await bounded(browser.closed, 2000, 'Domain-switch terminal did not close');
      await assert.rejects(connect(route, {host, origin: 'https://foreign.invalid', cookie: session.cookie}), /403/);
      await assert.rejects(connect(route, {host, 'x-hub-origin': origin, cookie: session.cookie}), /403/);
    }
  } finally {
    connector.terminate();
    await connector.closed;
    proxyMode = 'forwarded';
  }
  console.log('PASS changed domains with Host-only TLS proxy, ignored legacy origins, HTTPS refresh, WSS and foreign/missing Origin rejection');
}
async function closed(streams, code) {
  const results = await bounded(Promise.all([streams.connector.closed, streams.browser.closed,
    streams.idleDevice.closed, streams.idleBrowser.closed, streams.sse.closed]), 4500, 'active streams did not close');
  for (const result of results.slice(0, 4)) assert.equal(result, code, 'incorrect shutdown close code');
  assert(streams.sse.ended, 'SSE must finish with EOF');
  assert(!streams.connector.messages.some(text => ['revoked', 'superseded'].includes(JSON.parse(text).kind)),
    'shutdown must not revoke a binding');
}
async function stop(state, signal) {
  const started = performance.now();
  state.child.kill(signal);
  const result = await bounded(state.ended, 5500, `${signal} did not exit within the process deadline`);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert(performance.now() - started < 5000, `${signal} exceeded 5 seconds`);
}
async function slowBody() {
  const socket = track(net.connect(backendPort, '127.0.0.1'));
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`POST /api/v1/auth/password/login HTTP/1.1\r\nHost: 127.0.0.1:${backendPort}\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{`);
  await sleep(150);
  return socket;
}
async function legacyResources() {
  const directory = path.join(tmp, 'legacy-ui');
  fs.cpSync(path.resolve(__dirname, '../frontend/dist'), directory, {recursive:true});
  let html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const files = [];
  for (const extension of ['css','js']) {
    const match = html.match(new RegExp('/assets/[^"\\s]+\\.' + extension));
    assert(match, 'production HTML must reference a hashed ' + extension);
    const original = match[0], legacy = `/assets/previous-12345678.${extension}`;
    fs.renameSync(path.join(directory, original), path.join(directory, legacy));
    html = html.replaceAll(original, legacy);
    files.push({path:legacy, data:fs.readFileSync(path.join(directory, legacy))});
  }
  fs.writeFileSync(path.join(directory, 'index.html'), html);
  const old = await start(directory);
  const response = await request('/');
  assert.equal(response.status, 200);
  const generation = response.headers['x-hub-assets'];
  await stop(old, 'SIGINT');
  return {html, generation, files};
}
async function resourceContracts(legacy) {
  const html = await request('/');
  assert.equal(html.status, 200);
  assert.match(html.headers['cache-control'], /no-cache.*must-revalidate/);
  assert.match(html.headers['content-type'], /text\/html/);
  const bootstrap = html.text.match(/<script id="hub-bootstrap">([\s\S]*?)<\/script>/);
  assert(bootstrap, 'production HTML must contain the recovery bootstrap');
  const scriptSources = html.headers['content-security-policy'].split(';').map(part => part.trim())
    .find(part => part.startsWith('script-src ')).split(/\s+/).slice(1);
  // Exact tokens: allow the SIXEL decoder's Wasm without granting JavaScript
  // eval or arbitrary inline scripts, regardless of source ordering.
  assert.deepEqual(new Set(scriptSources), new Set(["'self'", "'wasm-unsafe-eval'",
    "'sha256-" + createHash('sha256').update(bootstrap[1]).digest('base64') + "'"]));
  assert.equal((await request('/', {headers:{'if-none-match':html.headers.etag}})).status, 304);
  assert.equal((await request('/workspace')).status, 200);
  for (const extension of ['css','js']) {
    const asset = html.text.match(new RegExp('/assets/[^"\\s]+\\.' + extension))[0];
    const response = await request(asset);
    assert.equal(response.status, 200);
    assert.match(response.headers['cache-control'], /max-age=31536000, immutable/);
    assert.match(response.headers['content-type'], extension==='css'?/text\/css/:/javascript/);
    const head = await request(asset, {method:'HEAD'});
    assert.equal(head.headers['content-length'], response.headers['content-length']);
    assert.equal(head.text, '');
    assert.equal((await request(asset,{headers:{'if-none-match':'W/' + response.headers.etag}})).status, 304);
    const missing = await request(`/assets/missing.${extension}`);
    assert.equal(missing.status, 404);assert.equal(missing.text, '');assert.equal(missing.headers['cache-control'], 'no-store');
  }
  for (const file of legacy.files) {
    const response = await request(file.path);
    assert.equal(response.status, 200);
    assert.equal(response.headers['x-hub-asset-generation'], legacy.generation);
    assert.equal(response.text, file.data.toString());
  }
  console.log('PASS production HTTP cache/ETag/HEAD/MIME/404/CSP and retained original CSS/JS after resource generation change');
}
async function productionUI(registration, legacy) {
  await resourceContracts(legacy);
  const {chromium, expect} = require('../frontend/node_modules/@playwright/test');
  const browser = await chromium.launch();
  const connector = await device(registration);
  try {
    const context = await browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN',viewport:{width:1440,height:960}});
    await context.addInitScript(() => localStorage.setItem('gotty-hub.locale','zh-CN'));
    const login = await context.request.post(base + '/api/v1/auth/password/login', {
      headers:{origin:base}, data:{username:'admin',password:adminPassword}});
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    let pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(base);
    await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1);
    await expect(page.locator('.terminal-control.terminal-connections')).toContainText('3');
    assert.deepEqual(await page.evaluate(() => {
      const app=getComputedStyle(document.querySelector('.app'));
      const helper=getComputedStyle(document.querySelector('.xterm-helper-textarea'));
      return [app.display,helper.position,helper.opacity,helper.zIndex];
    }), ['flex','absolute','0','-5']);
    const terminal = await page.locator('.real-terminal').boundingBox();
    for (const [selector,top] of [['.terminal-connections',10],['.terminal-display-control',42],['.terminal-clear-control',74],['.terminal-upload-control',106],['.terminal-restart-control',138],['.terminal-hub-control',170]]) {
      const box=await page.locator(selector).boundingBox();assert(Math.abs(box.y-terminal.y-top)<2);assert.equal(box.height,28);assert(Math.abs(box.x+box.width-(terminal.x+terminal.width-10))<2);
    }
    await page.getByRole('button',{name:'显示设置',exact:true}).click();
    const display=page.getByRole('dialog',{name:'显示设置',exact:true});await expect(display).toBeVisible();
    const palette=await page.locator('.terminal-display-popover').boundingBox();
    assert(Math.abs(palette.y-terminal.y-42)<2);assert(Math.abs(palette.x+palette.width-(terminal.x+terminal.width-46))<2);
    await page.keyboard.press('Escape');await expect(display).not.toBeVisible();
    await page.locator('.terminal-connections').click();await expect(page.getByRole('dialog',{name:'分享管理',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'显示设置',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'分享管理',exact:true})).not.toBeVisible();await expect(display).toBeVisible();await page.keyboard.press('Escape');
    assert.deepEqual(pageErrors,[]);

    // New instances and membership changes must not overwrite the saved order.
    const extra = await request('/api/v1/instances/register',{body:{username:'admin',name:'ui-second',request_id:secret(),claim:secret()}});
    const second=await device(extra.data);
    await expect(page.locator('.sidebar .registered-instance')).toHaveCount(2);
    await page.locator('.sidebar .registered-instance').filter({hasText:'ui-second'}).click();
    await expect(page.locator('.session-tab')).toHaveCount(2);
    const order=scope=>page.locator(scope+' [data-instance-id]').evaluateAll(nodes=>nodes.map(node=>node.dataset.instanceId));
    const before=await order('.sidebar');
    assert.deepEqual(new Set(before),new Set([registration.instance_id,extra.data.instance_id]));
    await expect.poll(()=>order('.session-tabs-scroll')).toEqual(before);
    const openCount=()=>connector.messages.concat(second.messages).filter(text=>JSON.parse(text).kind==='open').length;
    await until(()=>openCount()>=2,'second terminal did not connect');const opens=openCount();
    await expect(page.locator('.terminal-slot:not([hidden]) .terminal-connections')).toContainText('3');
    async function keyboardMove(handle,direction) {
      const row=handle.locator('..');
      await handle.focus();await page.keyboard.press('Space');
      await expect(handle).toHaveAttribute('aria-pressed','true');
      // KeyboardSensor installs its document listener in a deferred timer;
      // aria-pressed can become true before that listener and rects are ready.
      // Yield through a timer and rendered frame before sending a direction.
      await page.evaluate(()=>new Promise(resolve=>setTimeout(()=>requestAnimationFrame(()=>resolve()),0)));
      await expect.poll(()=>row.evaluate(element=>element.style.transform),{message:'keyboard drag must initialize its collision geometry'}).not.toBe('');
      await handle.focus();await expect(handle).toBeFocused();
      await page.keyboard.press(direction);
      await expect.poll(()=>row.evaluate((element,key)=>{
        const matrix=new DOMMatrixReadOnly(element.style.transform);
        return key==='ArrowLeft'?-matrix.m41:matrix.m42;
      },direction),{message:'direction key must move the dragged instance before dropping'}).toBeGreaterThan(0);
      // A sortable handle is not a toggle button: dnd-kit removes this
      // attribute when idle rather than rendering aria-pressed="false".
      await page.keyboard.press('Space');await expect(handle).not.toHaveAttribute('aria-pressed');
      await expect(row).not.toHaveAttribute('data-dragging');
    }
    // Pick the last actual ID so this check also works with a restored order.
    const draggedId=before[1];
    const tabHandle=page.locator(`.session-tab[data-instance-id="${draggedId}"] .instance-sort-handle`);
    await keyboardMove(tabHandle,'ArrowLeft');
    await expect.poll(()=>order('.sidebar')).toEqual([...before].reverse());
    await expect.poll(()=>order('.session-tabs-scroll')).toEqual([...before].reverse());
    const moved=await order('.sidebar');assert.notDeepEqual(moved,before);
    // Move the same item in the sidebar to verify the opposite direction.
    const sideHandle=page.locator(`.sidebar [data-instance-id="${draggedId}"] .instance-sort-handle`);
    await keyboardMove(sideHandle,'ArrowDown');
    await expect.poll(()=>order('.sidebar')).toEqual(before);
    await expect.poll(()=>order('.session-tabs-scroll')).toEqual(before);
    await expect.poll(async()=>{const response=await context.request.get(base+'/api/v1/me/preferences',{headers:{'X-Hub-Origin':base}});return (await response.json()).instanceOrder;}).toEqual(before);
    assert.equal(openCount(),opens,'sorting must preserve mounted terminal connections');
    await page.reload();await expect.poll(()=>order('.session-tabs-scroll')).toEqual(before);
    second.terminate();await second.closed;
    await page.close();

    // CSS abort: the bundle may arrive, but no app/API/terminal may start until
    // the successful retry applies both app and xterm styles.
    for (const kind of ['css-once','css-timeout','css-permanent','js-permanent']) {
      const failure=await context.newPage();let count=0,unblock,allow=false,apiCalls=0;
      failure.on('request',request=>{if(request.url().includes('/api/v1/'))apiCalls++;});
      const pattern=kind.startsWith('css')?'**/assets/*.css*':'**/assets/*.js*';
      await failure.route(pattern,async route=>{
        count++;
        if(allow)return route.continue();
        if(kind==='css-once'){
          if(count===1)return route.abort();
          return new Promise(resolve=>{unblock=()=>{allow=true;resolve(route.continue());};});
        }
        if(kind==='css-timeout'){
          if(count===1)return new Promise(resolve=>{unblock=()=>resolve(route.abort().catch(()=>{}));});
          allow=true;return route.continue();
        }
        return route.abort();
      });
      const navigation=failure.goto(base+'/?preview=1',{waitUntil:'commit'});await navigation;
      if(kind==='css-once'){
        await until(()=>count>=2&&!!unblock,'stylesheet retry did not start');
        assert.equal(await failure.locator('#root').getAttribute('hidden'),'');assert.equal(apiCalls,0);unblock();
      }else if(kind==='css-timeout'){
        await until(()=>count>=2,'stylesheet timeout did not trigger recovery before DOMContentLoaded',13000);if(unblock)unblock();
      }else{
        await expect(failure.locator('#hub-boot[data-state=error]')).toBeVisible();
        assert.equal(count,3);assert.equal(apiCalls,0);
        await new Promise(resolve=>setTimeout(resolve,400));assert.equal(count,3,'resource retries must be bounded');
        allow=true;await failure.getByRole('button',{name:'重试',exact:true}).click();
      }
      await expect(failure.locator('.app')).toBeVisible();await expect(failure.locator('#hub-boot')).toBeHidden();
      assert.equal(await failure.locator('.app').evaluate(element=>getComputedStyle(element).display),'flex');
      await failure.close();
    }
    const stale=await context.newPage();
    const csp=(await request('/')).headers['content-security-policy'];
    await stale.route(base+'/?preview=1',route=>route.fulfill({status:200,contentType:'text/html',body:legacy.html,headers:{'content-security-policy':csp}}));
    await stale.goto(base+'/?preview=1');await expect(stale.locator('.app')).toBeVisible();await stale.close();
    await context.close();

    // Simulate the viewport events from an on-screen keyboard. No screenshot
    // or virtual keyboard automation is needed to assert the real DOM/input.
    const mobile=await browser.newContext({ignoreHTTPSErrors:true,isMobile:true,hasTouch:true,viewport:{width:375,height:812}});
    await mobile.addInitScript(()=>{
      localStorage.setItem('gotty-hub.locale','zh-CN');
      const vv=Object.assign(new EventTarget(),{height:812,offsetTop:0,offsetLeft:0,pageTop:0,pageLeft:0,scale:1,width:375});
      Object.defineProperty(window,'visualViewport',{configurable:true,value:vv});
    });
    assert.equal((await mobile.request.post(base+'/api/v1/auth/password/login',{headers:{origin:base},data:{username:'admin',password:adminPassword}})).status(),200);
    const phone=await mobile.newPage();await phone.goto(base);
    await expect(phone.locator('.xterm-helper-textarea')).toHaveCount(1);
    await phone.locator('.session-tab').filter({hasText:'proxy-ci'}).getByRole('button').filter({hasText:'proxy-ci'}).click();
    await expect(phone.locator('.terminal-slot:not([hidden]) .terminal-connections')).toContainText('3');
    await phone.locator('.terminal-slot:not([hidden]) .xterm-screen').tap();
    await phone.evaluate(()=>{const vv=window.visualViewport;vv.height=450;vv.dispatchEvent(new Event('resize'));});
    await expect(phone.locator('.terminal-mobile-keys button')).toHaveCount(16);
    await phone.getByRole('button',{name:'Ctrl',exact:true}).tap();await phone.keyboard.insertText('c');
    await until(()=>connector.messages.some(text=>{const f=JSON.parse(text);return f.kind==='data'&&typeof f.data==='string'&&f.data[0]==='1'&&Buffer.from(f.data.slice(1),'base64').toString()==='\x03';}),'mobile Ctrl+C did not reach the connector');
    assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await mobile.close();
    console.log('PASS production TLS browser layout, xterm CSS, anchored controls, synchronized/persisted sorting without reconnects, CSS/JS abort/timeout/retry, old documents and all 16 mobile keys');
  } finally {connector.terminate();await connector.closed;await browser.close();}
}

async function main() {
  home = path.join(tmp, 'home');
  fs.mkdirSync(home, {mode: 0o700});
  // Keep a different saved password to prove a consumed stdin override survives exec.
  fs.writeFileSync(path.join(home, 'config'), JSON.stringify({password: 'different saved password',
    origin: 'http://ignored-saved.invalid'}), {mode: 0o600});
  const portHolder = net.createServer();
  await new Promise(resolve => portHolder.listen(0, '127.0.0.1', resolve));
  backendPort = portHolder.address().port;
  await new Promise(resolve => portHolder.close(resolve));
  await startProxy();
  const legacy = browserRegression ? await legacyResources() : null;
  let state = await start();
  const session = await login();
  assert.equal((await request('/api/v1/auth/password/login', {origin: 'https://attacker.invalid',
    body: {username: 'admin', password: adminPassword}})).status, 403);
  const result = await request('/api/v1/instances/register', {body: {username: 'admin', name: 'proxy-ci', request_id: secret(), claim: secret()}});
  assert.equal(result.status, 200);
  const registration = result.data;
  if (browserRegression) {
    await productionUI(registration, legacy);
    await stop(state, 'SIGINT');
    return;
  }
  await domainChanges(registration);
  let streams = await active(session, registration);
  const listening = () => state.logs.split('Hub listening').length - 1;
  const before = listening();
  assert.equal((await request('/api/v1/admin/restart', {session, body: {}})).status, 200);
  await closed(streams, 1012);
  await until(() => listening() > before, 'administrator restart did not exec', 7000);
  assert(!state.exited, 'exec restart must retain the process');
  assert.equal((await request('/api/v1/me', {session})).status, 200, 'restart invalidated the session');
  await login();
  const cmdline = fs.readFileSync(`/proc/${state.child.pid}/cmdline`).toString();
  assert(cmdline.includes('serve') && !cmdline.includes('--password-stdin'));
  assert(fs.readFileSync(`/proc/${state.child.pid}/environ`).toString().includes('HUB_FIXTURE=preserved'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config'))).password, 'different saved password');
  console.log('PASS HTTPS proxy login, Secure cookie, public address, WSS/SSE, exec PID/args/env/stdin override and preserved session');

  streams = await active(session, registration);
  await Promise.all([stop(state, 'SIGINT'), closed(streams, 1001)]);
  state = await start();
  streams = await active(session, registration);
  await Promise.all([stop(state, 'SIGTERM'), closed(streams, 1001)]);
  console.log('PASS SIGINT/SIGTERM with active and idle WebSockets/SSE, bounded exit and unchanged device credentials');

  state = await start();
  const slow = await slowBody();
  await stop(state, 'SIGTERM');
  slow.destroy();
  assert(state.logs.includes('Connection drain exceeded 3 seconds'));
  console.log('PASS unfinished HTTP body cannot exceed the shutdown deadline');

  state = await start();
  const held = await slowBody();
  state.child.kill('SIGINT');
  await until(() => state.logs.includes('Shutdown signal received'), 'first SIGINT was not handled', 1000);
  assert(!state.exited, 'fixture did not keep the graceful drain open');
  const forcedAt = performance.now();
  state.child.kill('SIGINT');
  const forced = await bounded(state.ended, 1500, 'second SIGINT did not force exit');
  assert.equal(forced.code, 130);
  assert(performance.now() - forcedAt < 1000);
  held.destroy();
  console.log('PASS second SIGINT forces immediate process exit during drain');
}
main().catch(error => {console.error(error); process.exitCode = 1;}).finally(async () => {
  for (const child of children) child.kill('SIGKILL');
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  fs.rmSync(tmp, {recursive: true, force: true});
});

// CI-only process checks against the production binary, including asset
// contracts. Never run as a local deployment check. No screenshots are taken.
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
  const legacy = await legacyResources();
  let state = await start();
  const session = await login();
  assert.equal((await request('/api/v1/auth/password/login', {origin: 'https://attacker.invalid',
    body: {username: 'admin', password: adminPassword}})).status, 403);
  const result = await request('/api/v1/instances/register', {body: {username: 'admin', name: 'proxy-ci', request_id: secret(), claim: secret()}});
  assert.equal(result.status, 200);
  const registration = result.data;
  await resourceContracts(legacy);
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

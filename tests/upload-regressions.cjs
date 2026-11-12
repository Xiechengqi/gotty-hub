// Run through the real file chooser and GoTTY filesystem in the disposable
// workspace harness. UPLOAD_LEGACY=1 also exercises a pre-acknowledgment binary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

module.exports = async ({page, browser, hub, ids, api, wait, dir, report, installInspection, errors}) => {
  const legacy = process.env.UPLOAD_LEGACY === '1';
  const dialog = target => target.getByRole('dialog', {name: '上传文件', exact: true});
  async function choose(name, buffer, target = page) {
    const chooser = target.waitForEvent('filechooser');
    await target.locator('.terminal-slot:not([hidden]) .terminal-upload-control').click();
    await (await chooser).setFiles({name, mimeType: 'application/octet-stream', buffer});
    await dialog(target).waitFor();
  }
  async function completed(name, buffer, target = page) {
    await wait(async () => (await dialog(target).getByRole('status').textContent()).includes((legacy ? '已发送：' : '上传成功：') + name), 'named completion');
    assert.equal(await dialog(target).getByRole('progressbar').getAttribute('value'), '100');
    const file = path.join(dir, name);
    await wait(() => fs.existsSync(file) && fs.readFileSync(file).equals(buffer), 'uploaded bytes match');
    await dialog(target).getByRole('button', {name: '完成', exact: true}).click();
    await dialog(target).waitFor({state: 'hidden'});
  }
  const bytes = Buffer.from(Array.from({length: 256 * 1024 + 73}, (_, i) => i % 251));
  const name = '上传 文件.bin';
  await page.evaluate(id => {
    const ws = window.reviewSockets.find(socket => socket.url.includes(id) && socket.readyState === 1);
    const receive = ws.onmessage;
    window.uploadHeld = [];
    window.holdUpload = false;
    ws.onmessage = event => {
      if (window.holdUpload && String(event.data)[0] === 'd') window.uploadHeld.push(() => receive.call(ws, event));
      else receive.call(ws, event);
    };
    window.releaseUpload = () => {window.holdUpload = false; window.uploadHeld.splice(0).forEach(deliver => deliver());};
  }, ids[0]);
  if (!legacy) await page.evaluate(() => {window.holdUpload = true;});
  await choose(name, bytes);
  if (!legacy) {
    await wait(() => page.evaluate(() => window.uploadHeld.length > 0), 'first chunk written');
    assert.equal(await dialog(page).getByRole('progressbar').getAttribute('value'), '0', 'unacknowledged bytes counted as saved');
    assert((await dialog(page).textContent()).includes('正在上传'));
    assert(!fs.existsSync(path.join(dir, name)), 'partial file became visible');
    // Release one disk receipt, then pause again to inspect a real partial value.
    await page.evaluate(() => window.uploadHeld.shift()());
    await wait(() => page.evaluate(() => window.uploadHeld.length > 0), 'next chunk receipt');
    const percent = Number(await dialog(page).getByRole('progressbar').getAttribute('value'));
    assert(percent > 0 && percent < 100);
    await page.screenshot({path: path.join(dir, 'upload-progress.png')});
    await page.evaluate(() => window.releaseUpload());
  }
  await completed(name, bytes);
  const replacement = Buffer.from('second selection\n');
  await choose(name, replacement); await completed(name, replacement);
  await choose('empty.txt', Buffer.alloc(0)); await completed('empty.txt', Buffer.alloc(0));
  const cancelledChooser = page.waitForEvent('filechooser');
  await page.locator('.terminal-slot:not([hidden]) .terminal-upload-control').click();
  await (await cancelledChooser).setFiles([]);
  assert.equal(await dialog(page).count(), 0, 'cancelled chooser opened an upload');
  await page.locator('.terminal-slot:not([hidden]) .real-terminal').evaluate(element => {
    const data = new DataTransfer(); data.items.add(new File(['drag and drop'], 'dropped.txt'));
    element.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: data}));
  });
  await completed('dropped.txt', Buffer.from('drag and drop'));
  if (legacy) {
    report('legacyUploads', {chooser: true, repeatedName: true, emptyFile: true, cancelledChooser: true, drop: true, unverifiedCompletion: true, bytesMatch: true});
    return;
  }

  fs.mkdirSync(path.join(dir, 'blocked'));
  const retryBytes = Buffer.from('retry without selecting again');
  await choose('blocked', retryBytes);
  await dialog(page).getByRole('alert').waitFor();
  assert((await dialog(page).getByRole('alert').textContent()).includes('不是普通文件'));
  assert.notEqual(await dialog(page).getByRole('progressbar').getAttribute('value'), '100');
  await page.screenshot({path: path.join(dir, 'upload-error.png')});
  fs.rmdirSync(path.join(dir, 'blocked'));
  await dialog(page).getByRole('button', {name: '重试', exact: true}).click();
  await completed('blocked', retryBytes);

  for (const mode of ['cancel', 'disconnect']) {
    const filename = mode + '.bin', original = Buffer.from('original destination');
    fs.writeFileSync(path.join(dir, filename), original);
    await page.evaluate(() => {window.holdUpload = true;});
    await choose(filename, bytes);
    await wait(() => page.evaluate(() => window.uploadHeld.length > 0), 'pending upload before ' + mode);
    if (mode === 'cancel') {
      await dialog(page).getByRole('button', {name: '取消', exact: true}).click();
      await dialog(page).waitFor({state: 'hidden'});
    } else {
      await page.evaluate(id => window.reviewSockets.find(socket => socket.url.includes(id) && socket.readyState === 1).close(1000), ids[0]);
      await dialog(page).getByRole('alert').waitFor();
      assert((await dialog(page).getByRole('alert').textContent()).includes('连接已断开'));
      assert.notEqual(await dialog(page).getByRole('progressbar').getAttribute('value'), '100');
    }
    await page.evaluate(() => window.releaseUpload());
    await wait(() => !fs.readdirSync(dir).some(file => file.startsWith('.gotty-upload-')), mode + ' removes partial temporary file');
    assert(fs.readFileSync(path.join(dir, filename)).equals(original));
    if (mode === 'disconnect') {
      await wait(() => dialog(page).getByRole('button', {name: '重试', exact: true}).isEnabled(), 'reconnected retry');
      await dialog(page).getByRole('button', {name: '重试', exact: true}).click();
      await completed(filename, bytes);
    }
  }

  await page.setViewportSize({width: 320, height: 740});
  const mobileName = '手机上传-文件名显示测试.txt', mobileBytes = Buffer.from('mobile');
  await choose(mobileName, mobileBytes);
  await wait(async () => (await dialog(page).getByRole('status').textContent()).includes('上传成功：' + mobileName), 'mobile completion');
  const box = await dialog(page).boundingBox(); assert(box.x >= 0 && box.x + box.width <= 320);
  await page.screenshot({path: path.join(dir, 'upload-success-mobile.png')});
  await completed(mobileName, mobileBytes);

  for (const role of ['operator', 'observer']) {
    const member = await browser.newContext({viewport: {width: 1280, height: 800}});
    await member.addInitScript(installInspection);
    await member.addInitScript(() => localStorage.setItem('gotty-hub.locale', 'zh-CN'));
    const username = 'upload-' + role;
    const registration = await member.request.post(hub + '/api/v1/auth/register', {data: {username, password: 'upload-regression-password-123'}});
    assert(registration.ok());
    await api('/instances/' + ids[0] + '/grants', {username, role}, 'PUT');
    const target = await member.newPage(); target.on('pageerror', error => errors.push(error.stack));
    await target.goto(hub, {waitUntil: 'domcontentloaded'});
    await target.locator('.real-terminal').waitFor();
    if (role === 'operator') {
      await wait(() => target.locator('.terminal-upload-control').isEnabled(), 'operator upload ready');
      const data = Buffer.from('operator upload');
      await choose('operator.txt', data, target); await completed('operator.txt', data, target);
    } else assert.equal(await target.locator('.terminal-upload-control').count(), 0);
    await member.close();
  }
  report('uploads', {chooser: true, acknowledgedProgress: true, bytesHash: createHash('sha256').update(bytes).digest('hex'), namedSuccess: true, repeatedName: true, emptyFile: true, drop: true, failureAndRetry: true, cancelPreservesOriginal: true, disconnectPreservesOriginal: true, mobile: true, operator: true, observerHidden: true});
};

// Real clipboard -> xterm adapter -> Hub/standalone -> real disposable PTY.
// Receipt holding models a slow return path, without mocking terminal writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

module.exports = async ({page, context, browser, hub, ids, devices, directURL, api, wait, sleep, dir, report, installInspection, errors}) => {
  const legacy = process.env.PASTE_LEGACY === '1';
  const capture = path.join(dir, 'capture-paste.py');
  fs.writeFileSync(capture, String.raw`import os, sys, termios, tty, time
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
result = bytearray()
try:
    tty.setraw(fd)
    os.write(1, b'\x1b[?2004hPASTE_CAPTURE_READY\r\n')
    while True:
        data = os.read(fd, 4096)
        if not data: break
        result.extend(data)
        if b'\x1b[201~' in result: break
    start = result.find(b'\x1b[200~')
    end = result.find(b'\x1b[201~')
    if start != 0 or end < 0: raise RuntimeError('missing bracket pair')
    with open(sys.argv[1], 'wb') as f: f.write(result[6:end])
    if len(sys.argv) > 2: time.sleep(float(sys.argv[2]))
finally:
    termios.tcsetattr(fd, termios.TCSANOW, old)
    os.write(1, b'\x1b[?2004lPASTE_CAPTURE_DONE\r\n')
`);
  const area = target => target.locator(target === page ? '.terminal-slot:not([hidden]) .xterm-helper-textarea' : '.xterm-helper-textarea').first();
  const card = target => target.locator('.terminal-paste-card, .gotty-paste-card').first();
  async function probe(target, id) {
    await target.evaluate(id => {
      const ws = window.reviewSockets.findLast(socket => socket.readyState === 1 && (!id || socket.url.includes(id)));
      if (!ws) throw Error('No terminal socket');
      const receive = ws.onmessage, send = ws.send.bind(ws);
      window.pasteProbe = {ws, hold: false, held: [], sent: [], output: '', events: []};
      if(window.pasteProbeListener)document.removeEventListener('paste',window.pasteProbeListener,true);
      window.pasteProbeListener=event=>window.pasteProbe.events.push({length:event.clipboardData?.getData('text/plain').length,trusted:event.isTrusted});
      document.addEventListener('paste',window.pasteProbeListener,true);
      ws.send = data => {window.pasteProbe.sent.push(String(data)); return send(data);};
      ws.onmessage = event => {
        let data = String(event.data);
        if (data[0] === 'c') data = JSON.parse(data.slice(1)).data;
        if (data[0] === '1') window.pasteProbe.output = (window.pasteProbe.output + atob(data.slice(1))).slice(-100000);
        if (data[0] === 'e' && window.pasteProbe.hold && ['writing', 'done'].includes(JSON.parse(data.slice(1)).status)) window.pasteProbe.held.push(() => receive.call(ws, event));
        else receive.call(ws, event);
      };
      window.releasePaste = () => {window.pasteProbe.hold = false; window.pasteProbe.held.splice(0).forEach(deliver => deliver());};
    }, id);
  }
  async function command(target, text) {
    await area(target).focus(); await target.keyboard.type(text); await target.keyboard.press('Enter');
  }
  async function prepare(target, filename, tmux = false) {
    await target.evaluate(() => {window.pasteProbe.output = ''; window.pasteProbe.sent = [];});
    const cmd = `python3 '${capture}' '${path.join(dir, filename)}'`;
    await command(target, tmux ? `tmux -L paste-review-${process.pid} -f /dev/null new-session '${cmd.replaceAll("'", '"')}'` : cmd);
    await wait(() => target.evaluate(() => window.pasteProbe.output.includes('PASTE_CAPTURE_READY')), 'raw PTY capture ready');
    await sleep(100);
  }
  async function paste(target, text) {
    await target.bringToFront();
    await target.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(target.url()).origin});
    await target.evaluate(text => navigator.clipboard.writeText(text), text);
    await area(target).focus(); await target.keyboard.press('Control+Shift+V');
    await sleep(100);
    assert(await target.evaluate(()=>window.pasteProbe.events.at(-1)?.trusted),'native browser clipboard event was not delivered');
  }
  const normalize = text => Buffer.from(text.replace(/\r?\n/g, '\r'));
  async function written(target, filename, text) {
    await wait(() => fs.existsSync(path.join(dir, filename)), 'captured paste file');
    assert(fs.readFileSync(path.join(dir, filename)).equals(normalize(text)), 'PTY payload differs from clipboard');
    await wait(() => target.evaluate(() => window.pasteProbe.output.includes('PASTE_CAPTURE_DONE')), 'capture finished');
    await wait(() => card(target).count().then(count => count === 0), 'success dismisses itself');
  }
  await probe(page, ids[0]);
  // Split before pasting; the progress card must remain centered on the page.
  await page.locator(`.session-tab[data-instance-id="${ids[0]}"] .tab-trigger`).click({button:'right'});
  await page.locator('.tab-actions-menu').getByRole('button', {name:/分屏/}).click();
  await wait(() => page.locator('.terminal-slot:not([hidden])').count().then(n => n === 2), 'split view');
  await prepare(page, 'paste-full.bin');
  const text = ('large paste 中文🙂 with newline\r\n' + 'x'.repeat(120) + '\n').repeat(4000);
  const geometry = await page.evaluate(() => ({cols:window.reviewTerm().cols, rows:window.reviewTerm().rows, height:document.querySelector('.terminal-slot').getBoundingClientRect().height}));
  if (!legacy) await page.evaluate(() => {window.pasteProbe.hold = true;});
  await paste(page, text);
  if (!legacy) {
    await wait(() => page.evaluate(() => window.pasteProbe.held.length === 8), 'bounded initial paste window');
    assert.equal(Number(await card(page).locator('progress').getAttribute('value')), 0, 'unconfirmed PTY bytes were counted');
    const metrics = await page.evaluate(() => {const box=document.querySelector('.terminal-paste-card').getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2,width:innerWidth,height:innerHeight,focus:document.activeElement.classList.contains('xterm-helper-textarea'),cols:window.reviewTerm().cols,rows:window.reviewTerm().rows,terminalHeight:document.querySelector('.terminal-slot').getBoundingClientRect().height};});
    assert(Math.abs(metrics.x-metrics.width/2)<2 && Math.abs(metrics.y-metrics.height/2)<2, JSON.stringify(metrics));
    assert(metrics.focus, 'progress stole terminal focus'); assert.equal(metrics.cols,geometry.cols); assert.equal(metrics.rows,geometry.rows); assert.equal(metrics.terminalHeight,geometry.height);
    assert((await card(page).textContent()).includes('终端-01'));
    await page.evaluate(() => window.pasteProbe.held.shift()());
    await wait(async () => Number(await card(page).locator('progress').getAttribute('value')) > 0, 'confirmed partial progress');
    await page.screenshot({path:path.join(dir,'paste-centered-split.png')});
    await page.locator('.terminal-slot:not([hidden]) .xterm-helper-textarea').nth(1).focus();
    await page.keyboard.type("printf 'SIDE-%s\\n' OK"); await page.keyboard.press('Enter');
    await wait(()=>page.evaluate(()=>window.reviewSnapshot(1).text.includes('SIDE-OK')),'other pane stays interactive');
    assert.equal(await card(page).getAttribute('data-instance-id'),ids[0],'paste task followed terminal focus');
    await page.evaluate(() => window.releasePaste());
  } else {
    await card(page).waitFor(); assert((await card(page).textContent()).includes('未经远端确认'));
  }
  await written(page, 'paste-full.bin', text);
  report('pasteLargeHub', {bytes:normalize(text).length, hash:createHash('sha256').update(normalize(text)).digest('hex'), unicode:true, multiline:true, centeredInSplit:true, boundedWindow:!legacy, focusAndGeometryStable:!legacy, legacy});
  if (legacy) return;

  // Cancel after some real writes. Enter queued during paste must not execute.
  await prepare(page, 'paste-cancel.bin');
  await page.evaluate(() => {window.pasteProbe.hold=true;});
  await paste(page, 'cancel payload '.repeat(100000));
  await wait(() => page.evaluate(() => window.pasteProbe.held.length===8), 'cancel window');
  await page.keyboard.type('MUST_NOT_RUN'); await page.keyboard.press('Enter');
  await card(page).getByRole('button',{name:'停止',exact:true}).click();
  await wait(async () => (await card(page).getAttribute('data-paste-status')) === 'cancelled', 'server-confirmed stop');
  await wait(() => fs.existsSync(path.join(dir,'paste-cancel.bin')), 'cancel bracket cleanup');
  const cancelled=fs.readFileSync(path.join(dir,'paste-cancel.bin'));
  assert(cancelled.length>0&&cancelled.length<=8*4096); assert(!cancelled.includes('MUST_NOT_RUN'));
  assert(!(await page.evaluate(()=>window.pasteProbe.output)).includes('MUST_NOT_RUN'));
  await card(page).getByRole('button',{name:'关闭',exact:true}).click(); await page.evaluate(()=>window.releasePaste());

  await prepare(page, 'paste-disconnect.bin'); await page.evaluate(()=>{window.pasteProbe.hold=true;});
  await paste(page,'disconnect payload '.repeat(100000));
  await wait(()=>page.evaluate(()=>window.pasteProbe.held.length===8),'disconnect window');
  await page.evaluate(()=>window.pasteProbe.ws.close());
  await wait(async()=>(await card(page).getAttribute('data-paste-status'))==='error','disconnect error');
  await wait(()=>fs.existsSync(path.join(dir,'paste-disconnect.bin')),'disconnect bracket cleanup');
  await wait(()=>page.locator('.terminal-slot:not([hidden]) .terminal-clear-control').first().isEnabled(),'reconnected after paste');
  await sleep(300);
  const disconnected=fs.readFileSync(path.join(dir,'paste-disconnect.bin'));
  assert(disconnected.length<=8*4096);
  assert((await card(page).textContent()).includes('不会自动重发'));
  await card(page).getByRole('button',{name:'关闭',exact:true}).click();
  await probe(page,ids[0]);
  report('pasteStopAndDisconnect',{cancelledBytes:cancelled.length,disconnectedBytes:disconnected.length,closingBracket:true,noQueuedEnter:true,noAutomaticReplay:true});

  // Real Vim handles the whole paste as one bracketed insertion.
  const vimFile=path.join(dir,'paste-vim.txt');
  await page.evaluate(()=>{window.pasteProbe.output='';});
  await command(page,`vim -Nu NONE -n -i NONE '${vimFile}'`);
  await wait(()=>page.evaluate(()=>window.reviewSnapshot()?.type==='alternate'&&window.reviewSnapshot()?.pending===0),'Vim ready');
  await page.keyboard.press('i');
  const vimText=Array.from({length:3000},(_,i)=>`line ${i} 中文🙂 ${'v'.repeat(80)}`).join('\n');
  await paste(page,vimText);
  await wait(async()=> (await card(page).getAttribute('data-paste-status'))==='done','Vim PTY accepted');
  await page.keyboard.press('Escape');await page.keyboard.type(':wq');await page.keyboard.press('Enter');
  await wait(()=>fs.existsSync(vimFile)&&fs.readFileSync(vimFile,'utf8')===vimText+'\n','Vim saved full paste',30000);
  await wait(()=>card(page).count().then(n=>n===0),'Vim paste dismissed');
  await prepare(page,'paste-tmux.bin',true); const tmuxText='tmux 中文🙂\n'.repeat(5000);
  await paste(page,tmuxText); await written(page,'paste-tmux.bin',tmuxText);
  report('pasteApplications',{vimBytes:Buffer.byteLength(vimText),vimSaved:true,tmux:true});

  const direct=await context.newPage();direct.on('pageerror',error=>errors.push(error.stack));
  await direct.goto(directURL,{waitUntil:'domcontentloaded'});await direct.locator('.xterm-helper-textarea').waitFor();
  await wait(()=>direct.evaluate(()=>window.reviewSockets.some(socket=>socket.readyState===1)),'standalone socket');await sleep(300);
  await probe(direct);await prepare(direct,'paste-direct.bin');await direct.evaluate(()=>{window.pasteProbe.hold=true;});
  const ascii='0123456789abcdef'.repeat(65536);
  await paste(direct,ascii);await wait(()=>direct.evaluate(()=>window.pasteProbe.held.length===8),'standalone bounded window');
  assert.equal(Number(await card(direct).locator('progress').getAttribute('value')),0);
  await direct.screenshot({path:path.join(dir,'paste-centered-standalone.png')});
  await direct.evaluate(()=>window.releasePaste());await written(direct,'paste-direct.bin',ascii);
  await direct.close(); report('pasteStandalone',{bytes:ascii.length,exactPayload:true,confirmed:true});

  // Independent mobile browser, operator paste and observer input suppression.
  for(const role of ['operator','observer']){
    const member=await browser.newContext({viewport:{width:390,height:720},isMobile:true,hasTouch:true,deviceScaleFactor:2});
    await member.addInitScript(installInspection);const target=await member.newPage();target.on('pageerror',error=>errors.push(error.stack));
    const name=`paste-${role}`;const registration=await member.request.post(hub+'/api/v1/auth/register',{data:{username:name,password:'Disposable-paste-review-123!'}});assert(registration.ok());
    await api(`/instances/${ids[2]}/grants`,{username:name,role},'PUT');await target.goto(hub,{waitUntil:'domcontentloaded'});
    await target.locator('.real-terminal').waitFor();await wait(()=>target.evaluate(()=>window.reviewSockets.some(s=>s.readyState===1)),'member socket');await sleep(300);await probe(target,ids[2]);
    if(role==='operator'){
      await prepare(target,'paste-mobile.bin');await target.evaluate(()=>{window.pasteProbe.hold=true;});
      const mobileText='mobile 中文🙂\n'.repeat(7000);await paste(target,mobileText);await card(target).waitFor();
      await target.setViewportSize({width:390,height:420});await sleep(100);
      const bounds=await card(target).boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=391&&bounds.y>=0&&bounds.y+bounds.height<=421);
      await target.screenshot({path:path.join(dir,'paste-centered-mobile.png')});
      await target.evaluate(()=>window.releasePaste());await written(target,'paste-mobile.bin',mobileText);
    }else{
      await paste(target,'OBSERVER_CANNOT_PASTE');await sleep(100);
      assert.equal(await card(target).count(),0);
      assert(!(await target.evaluate(()=>window.pasteProbe.sent)).some(frame=>['1','5'].includes(frame[0])));
    }
    await member.close();
  }
  await page.bringToFront();report('pasteMobileAndPermissions',{mobileVisibleViewport:true,operator:true,observerBlocked:true});
};

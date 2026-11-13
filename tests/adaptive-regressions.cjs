// Disposable GoTTY + Hub + real Chromium only; never run in GitHub Actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function adaptiveRegression({page, context, browser, hub, ids, devices, wait, sleep, dir, report, installInspection, errors}) {
  const id = ids[1], device = devices[1];
  const slot = target => target.locator(`.terminal-slot[data-instance-id="${id}"]`);
  const state = async () => {
    const response = await fetch(device.url + '/-/terminal-state'); assert(response.ok);
    return response.json();
  };
  const snapshot = target => target.evaluate(id => {
    const nodes = [...document.querySelectorAll('.real-terminal')];
    return window.reviewSnapshot(nodes.findIndex(node => node.closest('.terminal-slot').dataset.instanceId === id));
  }, id);
  const ready = target => wait(async () => {
    const s = await snapshot(target);
    return s?.pending === 0 && s.text.trim() && await slot(target).locator('.xterm-host').getAttribute('data-replay-active') !== 'true';
  }, 'adaptive terminal ready');
  const select = async (target, selected = id) => {
    await target.locator(`.session-tab[data-instance-id="${selected}"] .tab-trigger`).click();
    if (selected === id) await ready(target);
  };
  const mobileContext = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await mobileContext.addCookies(await context.cookies());
  await mobileContext.addInitScript(installInspection);
  const mobile = await mobileContext.newPage(); mobile.on('pageerror',error=>errors.push(error.stack));
  try {
    await mobile.goto(hub,{waitUntil:'domcontentloaded'});await select(mobile);
    await wait(async()=> (await state()).leaderDevice==='mobile','phone elected first');
    const phoneGrid = await state(); assert(phoneGrid.activeCols <= 65);
    await select(page);
    await wait(async()=> (await state()).leaderDevice==='desktop' && (await state()).activeCols>phoneGrid.activeCols,'desktop automatically replaces mobile');
    const desktopGrid = await state();
    const equalGrid = (a,b) => a.activeCols===b.activeCols && a.activeRows===b.activeRows;
    await wait(async()=> (await snapshot(page)).cols===desktopGrid.activeCols && (await snapshot(mobile)).cols===desktopGrid.activeCols,'both render confirmed grid');
    const hint = await slot(page).locator('.terminal-connections').getAttribute('title');
    assert(hint.includes('共享网格') && hint.includes('本地可用') && hint.includes('桌面端'));
    await mobile.reload({waitUntil:'domcontentloaded'});await select(mobile);await sleep(1000);
    assert(equalGrid(await state(),desktopGrid),'mobile reload changed desktop grid');
    await mobile.setViewportSize({width:844,height:390});await sleep(900);
    assert(equalGrid(await state(),desktopGrid),'landscape phone changed desktop grid');
    const mobileRequest = await mobile.evaluate(id=>window.reviewSockets.find(socket=>socket.url.includes(id) && socket.readyState===1)?.reviewResize,id);
    assert.equal(mobileRequest.inputClass,'coarse');assert.equal(mobileRequest.deviceClass,'mobile');
    await mobile.setViewportSize({width:390,height:320});await sleep(900);
    assert(equalGrid(await state(),desktopGrid),'short mobile viewport changed desktop grid');
    report('adaptiveMobileFirst',{phoneCols:phoneGrid.activeCols,desktopCols:desktopGrid.activeCols,mobileRefresh:true,landscape:true,shortViewport:true,diagnostics:true});

    // Actual Hub tab visibility drives release, while the socket stays alive.
    const originalClient = desktopGrid.leaderClientId;
    await select(page,ids[0]);await sleep(500);
    assert.equal((await state()).leaderClientId,originalClient,'brief tab transition lost lease');
    await wait(async()=> (await state()).leaderDevice==='mobile','hidden desktop yields');
    await select(page);await wait(async()=> (await state()).leaderDevice==='desktop','visible desktop returns');
    await page.getByRole('button',{name:'设置',exact:true}).click();await sleep(3200);
    assert.equal((await state()).leaderDevice,'desktop','settings/focus loss relinquished control');
    await page.keyboard.press('Escape');
    report('adaptiveVisibility',{hiddenTabYields:true,returnRecovers:true,settingsKeepControl:true});

    // No browser user-input path is replaced. Suppress only dimension presence
    // packets to model a frozen page with an open transport.
    await page.evaluate(id=>{
      const socket=window.reviewSockets.find(socket=>socket.url.includes(id)&&socket.readyState===1);
      const original=socket.send.bind(socket);window.resumePresence=()=>{socket.send=original;};
      socket.send=data=>{if(typeof data==='string'&&data[0]==='3')return;return original(data);};
    },id);
    await wait(async()=> (await state()).controlReason==='adaptive-expired' && (await state()).leaderDevice==='mobile','frozen desktop lease expires',22000);
    await page.evaluate(()=>window.resumePresence());
    await wait(async()=> (await state()).leaderDevice==='desktop','renewed desktop returns');
    report('adaptivePresence',{frozenOpenSocketExpires:true,renewalRecovers:true});

    const beforeRefresh = await state();
    await page.reload({waitUntil:'domcontentloaded'});await select(page);await sleep(1000);
    assert(equalGrid(await state(),beforeRefresh),'desktop refresh changed grid');
    const file=path.join(dir,'adaptive-unsaved.txt');
    const input=()=>slot(page).locator('.xterm-helper-textarea');
    const command=async text=>{await input().focus();await page.keyboard.type(text);await page.keyboard.press('Enter');};
    await command(`printf 'ADAPTIVE-HISTORY\\n'`);
    await wait(async()=> (await snapshot(page)).text.includes('ADAPTIVE-HISTORY'),'history marker');
    await command(`vim -Nu NONE -n -i NONE '${file}'`);
    await wait(async()=> (await snapshot(page)).type==='alternate','Vim alternate screen');
    await sleep(400);await input().focus();await page.keyboard.press('i');await page.keyboard.insertText('未保存 adaptive🙂');
    await wait(async()=> (await snapshot(page)).text.includes('未保存 adaptive'),'Vim unsaved text');
    const vim=await snapshot(page);
    await page.reload({waitUntil:'domcontentloaded'});await select(page);
    // Replay parsing can finish before fonts, the double-frame fit and the
    // adaptive candidate window. Compare the restored screen on the settled
    // desktop grid, rather than a temporary initial 80x24 client request.
    await wait(async()=>{
      const current=await state(), restored=await snapshot(page);
      return current.leaderDevice==='desktop' && equalGrid(current,beforeRefresh) &&
        restored?.cols===beforeRefresh.activeCols && restored?.rows===beforeRefresh.activeRows && restored?.pending===0;
    },'Vim restored to the settled desktop grid');
    const restored=await snapshot(page);assert.equal(restored.text,vim.text);assert.deepEqual(restored.cursor,vim.cursor);
    await select(page,ids[0]);await wait(async()=> (await state()).leaderDevice==='mobile','Vim mobile fallback');
    await select(page);await wait(async()=> (await state()).leaderDevice==='desktop','Vim desktop restoration');
    await wait(async()=> (await snapshot(page)).text.includes('未保存 adaptive'),'Vim text after adaptive resize');
    await input().focus();await page.keyboard.insertText('继续');await page.keyboard.press('Escape');await page.keyboard.type(':wq');await page.keyboard.press('Enter');
    await wait(()=>fs.existsSync(file),'Vim save');assert.equal(fs.readFileSync(file,'utf8'),'未保存 adaptive🙂继续\n');
    await wait(async()=> (await snapshot(page)).type==='normal','normal buffer');
    assert((await snapshot(page)).text.includes('ADAPTIVE-HISTORY'),'history lost after alternate screen');
    report('adaptiveRecovery',{refreshStable:true,unsavedVim:true,cursorRestored:true,resizeThenSave:true,historyPreserved:true});

    // Mixed direct/Hub access uses the same server election and source metadata.
    const direct = await mobileContext.newPage();direct.on('pageerror',error=>errors.push(error.stack));
    await direct.goto(device.url,{waitUntil:'domcontentloaded'});await sleep(1800);
    assert.equal((await state()).leaderDevice,'desktop','direct mobile preempted Hub desktop');
    assert((await direct.locator('.connection-count').getAttribute('title')).includes('Shared grid'));
    await direct.close();
    // Keep an origin for the harness's localStorage initialization script.
    await page.goto(hub + '/healthz');
    await wait(async()=> (await state()).leaderDevice==='mobile' && (await state()).controlReason==='adaptive-disconnected','desktop disconnect grace expires');
    await page.goto(hub,{waitUntil:'domcontentloaded'});await select(page);
    await wait(async()=> (await state()).leaderDevice==='desktop','desktop returns after long disconnect');
    assert((await snapshot(page)).text.includes('ADAPTIVE-HISTORY'),'history lost after long disconnect');
    await page.screenshot({path:path.join(dir,'adaptive-desktop.png')});
    await mobile.screenshot({path:path.join(dir,'adaptive-mobile.png')});
    report('adaptiveDirect',{mixedAccess:true,sharedDiagnostics:true,longDisconnectFallback:true,desktopReturn:true});
  } finally { await mobileContext.close(); }
};

// Real Chromium, GoTTY PTY and Hub gateway; all processes are disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({page, context, browser, hub, ids, devices, api, wait, sleep, dir, report, installInspection, errors}) => {
  await api('/me/preferences', {opened:[ids[0]],instanceOrder:ids,active:ids[0],maximized:false,locale:'zh-CN'}, 'PUT');
  await api('/me/terminal-settings', {revision:0,settings:{schemaVersion:1,theme:'nord',fontSize:14,fontId:'dejavu-sans-mono'}}, 'PUT');
  await page.setViewportSize({width:1920,height:1080});
  const sameText = (actual,expected,label) => {if(actual===expected)return; let at=0;while(at<Math.min(actual.length,expected.length)&&actual[at]===expected[at])at++;fs.writeFileSync(path.join(dir,label+'-actual.txt'),actual);fs.writeFileSync(path.join(dir,label+'-expected.txt'),expected);throw Error(`${label}: lengths ${actual.length}/${expected.length}, difference ${at}, actual=${JSON.stringify(actual.slice(Math.max(0,at-30),at+90))}, expected=${JSON.stringify(expected.slice(Math.max(0,at-30),at+90))}`);};
  const snapshots = target => target.evaluate(() => window.reviewSnapshot());
  const settled = async target => wait(async () => {const s=await snapshots(target);return s?.pending===0 && s.text.length>0 && await target.locator('.xterm-host').getAttribute('data-replay-active')==='false' && await target.locator('.terminal-clear-control').isEnabled();}, 'terminal ready');
  const reload = async target => {await target.reload({waitUntil:'domcontentloaded'});await settled(target);};
  const command = async text => {await page.bringToFront();await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type(text);await page.keyboard.press('Enter');};
  const action = async (target,name) => {
    await target.bringToFront();
    await target.locator('.session-tab.selected .tab-trigger').click();
    const menu=target.locator('.tab-actions-menu');await menu.getByRole('button',{name,exact:true}).click();await menu.waitFor({state:'hidden'});
  };
  await reload(page);await sleep(600);
  const initial=await snapshots(page);assert(initial.cols>=180,`desktop grid too small: ${initial.cols}`);
  const mobileContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await mobileContext.addCookies(await context.cookies());await mobileContext.addInitScript(installInspection);
  const mobile=await mobileContext.newPage();mobile.on('pageerror',error=>errors.push(error.stack));
  await mobile.goto(hub,{waitUntil:'domcontentloaded'});await settled(mobile);await sleep(600);
  for(let i=0;i<2;i++) {await reload(mobile);await sleep(300);assert.equal((await snapshots(page)).cols,initial.cols,'mobile refresh stole desktop grid');}
  assert.equal((await snapshots(mobile)).cols,initial.cols,'viewer did not use the shared grid');
  const direct=await mobileContext.newPage(), directStates=[];
  direct.on('pageerror',error=>errors.push(error.stack));
  direct.on('websocket',socket=>socket.on('framereceived',frame=>{let text=String(frame.payload);if(text[0]==='c')text=JSON.parse(text.slice(1)).data;if(text[0]==='8')directStates.push(JSON.parse(text.slice(1)));}));
  await direct.goto(devices[0].url,{waitUntil:'domcontentloaded'});
  await wait(()=>directStates.some(state=>state.activeCols===initial.cols),'standalone viewer grid');
  await direct.reload({waitUntil:'domcontentloaded'});await sleep(500);
  assert.equal((await snapshots(page)).cols,initial.cols,'standalone refresh stole desktop grid');
  await action(mobile,'接管终端尺寸');await wait(async()=> (await snapshots(page)).cols<=65,'mobile explicit takeover');
  assert.equal((await snapshots(page)).cols,(await snapshots(mobile)).cols);
  await action(page,'接管终端尺寸');await wait(async()=> (await snapshots(page)).cols===initial.cols,'desktop explicit takeover');
  await reload(page);await sleep(600);assert.equal((await snapshots(page)).cols,initial.cols,'leader refresh lost size lease');
  report('sizeOwnership',{desktopCols:initial.cols,mobileRefreshStable:true,standaloneRefreshStable:true,explicitTakeover:true,leaderRefreshStable:true});

  // A retained transcript larger than the former 512 KiB replay window.
  const history=path.join(dir,'history.ansi');
  fs.writeFileSync(history,'\x1b[0m\x1b[2J\x1b[3J\x1b[H'+Array.from({length:3800},(_,i)=>`HISTORY-${String(i).padStart(4,'0')}-${'x'.repeat(160)}\r\n`).join(''));
  await command(`cat '${history}'`);
  await wait(async()=> {const s=await snapshots(page);return s?.pending===0&&s.text.includes('HISTORY-3799-');},'large transcript',30000);
  const before=await snapshots(page);fs.writeFileSync(path.join(dir,'history-before.json'),JSON.stringify(before));assert(before.text.includes('HISTORY-0000-'));
  assert(fs.statSync(history).size>512*1024);
  await page.evaluate(()=>{window.reviewOriginal=window.reviewTerm();window.reviewSocketCount=window.reviewSockets.length;});
  await action(page,'刷新此终端');
  await wait(()=>page.evaluate(()=>window.reviewSockets.length>window.reviewSocketCount&&window.reviewSockets.at(-1).readyState===1),'soft refresh transport');await settled(page);await sleep(200);
  assert(await page.evaluate(()=>window.reviewTerm()===window.reviewOriginal),'soft refresh replaced xterm');
  sameText((await snapshots(page)).text,before.text,'soft-refresh');
  await reload(page);const after=await snapshots(page);fs.writeFileSync(path.join(dir,'history-after.json'),JSON.stringify(after));
  assert(after.text.includes('HISTORY-0000-')&&after.text.includes('HISTORY-3799-'),'page refresh truncated retained transcript');
  sameText(after.text,before.text,'history-checkpoint');
  report('historyRecovery',{bytes:fs.statSync(history).size,lines:3800,softRefreshRetainsRenderer:true,pageRefreshPreservesTranscript:true});

  const fixture=path.join(dir,'state.ansi');
  fs.writeFileSync(fixture,'\x1b[0m\x1b[2J\x1b[H中文🙂 café é\r\n\x1b[31mRED\x1b[0m normal\r\n'+ 'C'.repeat(initial.cols-1)+'中尾\r\n'+'E'.repeat(initial.cols-1)+'🙂END\r\n'+'S'.repeat(initial.cols-1)+' 中SPACE\r\n'+ 'W'.repeat(initial.cols)+'CONTINUED\r\n');
  await command(`cat '${fixture}'`);await wait(async()=> (await snapshots(page)).text.includes('CONTINUED'),'unicode and wrapped output');
  const state=await snapshots(page);await reload(page);
  sameText((await snapshots(page)).text,state.text,'unicode-checkpoint');
  const file=path.join(dir,'vim-unsaved-dataflow.txt');
  await command(`vim -Nu NONE -n -i NONE '${file}'`);await wait(async()=> {const s=await snapshots(page);return s.type==='alternate'&&s.pending===0&&s.text.includes('[New]');},'Vim entry');
  await sleep(350);await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('i');await wait(async()=> (await snapshots(page)).text.includes('INSERT'),'Vim insert mode');await page.keyboard.insertText('未保存的内容🙂');
  await wait(async()=> (await snapshots(page)).text.includes('未保存的内容'),'Vim unsaved text');
  const vim=await snapshots(page);await reload(page);
  const restored=await snapshots(page);
  assert.equal(restored.type,'alternate');sameText(restored.text,vim.text,'vim-checkpoint');assert.deepEqual(restored.cursor,vim.cursor,'Vim cursor changed');
  await page.locator('.xterm-helper-textarea').focus();await page.keyboard.insertText('继续输入');await page.keyboard.press('Escape');await page.keyboard.type(':wq');await page.keyboard.press('Enter');
  await wait(()=>fs.existsSync(file),'Vim save after refresh');assert.equal(fs.readFileSync(file,'utf8'),'未保存的内容🙂继续输入\n');
  await wait(async()=> (await snapshots(page)).type==='normal','normal screen restored after Vim');
  report('terminalState',{unicode:true,longLine:true,alternateScreen:true,unsavedVim:true,cursorRestored:true,continuedInputSaved:true});
  // Reflow must preserve logical history across a deliberate narrow/wide handoff.
  const reflow=path.join(dir,'reflow.ansi');
  fs.writeFileSync(reflow,'\x1b[0m\x1b[2J\x1b[3J\x1b[H'+Array.from({length:1400},(_,i)=>`REFLOW-${String(i).padStart(4,'0')}-${'r'.repeat(160)}\r\n`).join('')+'C'.repeat(initial.cols-1)+'中尾\r\n'+'S'.repeat(initial.cols-1)+' 中SPACE\r\nREFLOW-END\r\n');
  await command(`cat '${reflow}'`);await wait(async()=> (await snapshots(page)).text.includes('REFLOW-END'),'reflow fixture');
  await action(mobile,'接管终端尺寸');await wait(async()=> (await snapshots(page)).cols<=65,'narrow history grid');await sleep(300);
  const narrow=await snapshots(page);await reload(page);sameText((await snapshots(page)).text,narrow.text,'narrow-history-checkpoint');
  await action(page,'接管终端尺寸');await wait(async()=> (await snapshots(page)).cols===initial.cols,'wide history grid');await sleep(300);
  const wide=await snapshots(page);await reload(page);sameText((await snapshots(page)).text,wide.text,'wide-history-checkpoint');
  assert(wide.text.includes('REFLOW-0000-')&&wide.text.includes('REFLOW-1399-'),'logical history was lost during reflow');
  report('historyReflow',{narrowCols:narrow.cols,wideCols:wide.cols,logicalLinesPreserved:1400});

  const limited=path.join(dir,'history-limit.ansi');
  fs.writeFileSync(limited,'\x1b[0m\x1b[2J\x1b[3J\x1b[H'+Array.from({length:5600},(_,i)=>`LIMIT-${String(i).padStart(4,'0')}\r\n`).join(''));
  await command(`cat '${limited}'`);await wait(async()=> (await snapshots(page)).text.includes('LIMIT-5599'),'history retention limit');
  await reload(page);
  const retained=await snapshots(page);
  assert(!retained.text.includes('LIMIT-0000')&&retained.text.includes('LIMIT-5599'),'history eviction did not retain the newest output');
  assert.equal(await page.locator('.xterm-host').getAttribute('data-history-truncated'),'true');
  await wait(async()=> (await page.locator('.terminal-message').textContent()).includes('历史保留上限'),'visible history eviction notice');
  report('historyLimit',{configuredLines:5000,newestOutputRetained:true,evictionVisible:true});

  await page.screenshot({path:path.join(dir,'dataflow-desktop.png')});await mobile.screenshot({path:path.join(dir,'dataflow-mobile.png')});
  await direct.close();await mobileContext.close();
};

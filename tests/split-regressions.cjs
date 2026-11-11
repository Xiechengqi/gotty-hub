// Loaded by workspace-regressions.cjs; all processes and identities are disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function compactWorkspaceRegression({page, browser, hub, ids, devices, api, wait, sleep, dir, report, installInspection, start, errors}) {
  const names = Object.fromEntries((await api('/instances')).map(i => [i.id, i.name]));
  const [a,b,c,d] = ids;
  const slot = id => page.locator('.terminal-slot[data-instance-id="'+id+'"]');
  const tab = id => page.locator('.session-tab[data-instance-id="'+id+'"] .tab-trigger');
  const order = () => page.locator('.session-tab').evaluateAll(elements => elements.map(e => e.dataset.instanceId));
  const pair = () => page.locator('.terminal-slot:not([hidden])').evaluateAll(elements => elements.map(e => ({id:e.dataset.instanceId,pane:e.dataset.pane})).sort((a,b) => a.pane.localeCompare(b.pane)));
  const expectPair = (left,right) => wait(async () => JSON.stringify(await pair()) === JSON.stringify([{id:left,pane:'left'},{id:right,pane:'right'}]),'adjacent pair '+names[left]+' / '+names[right]);
  const focused = () => page.evaluate(() => document.activeElement?.closest('.terminal-slot')?.dataset.instanceId);
  const expectFocus = id => wait(async () => await focused()===id && await page.locator('.session-tab.selected').getAttribute('data-instance-id')===id,'terminal focus '+names[id]);
  async function reveal() {await page.locator('.workspace-bar').waitFor();}
  async function menu(id) {await reveal(); await tab(id).scrollIntoViewIfNeeded(); await sleep(100); await tab(id).click(); const m=page.locator('.tab-actions-menu');await m.waitFor();return m;}
  async function action(id,name) {const m=await menu(id);await m.getByRole('button',{name,exact:typeof name==='string'}).click();await m.waitFor({state:'hidden'});}
  async function select(id) {await reveal();await tab(id).click({button:'right'});await expectFocus(id);}
  async function terminal(id) {return page.evaluate(id => window.reviewSnapshot([...document.querySelectorAll('.real-terminal')].findIndex(e=>e.closest('.terminal-slot').dataset.instanceId===id)),id);}
  async function identity() {assert(await page.evaluate(() => [...document.querySelectorAll('.real-terminal')].every((e,i)=>window.compactTerms[e.closest('.terminal-slot').dataset.instanceId]===window.reviewTerm(i)) && window.reviewSockets.length===window.compactSocketCount),'layout recreated terminal or WebSocket');}
  async function track() {await page.evaluate(() => {
    window.compactTerms=Object.fromEntries([...document.querySelectorAll('.real-terminal')].map((e,i)=>[e.closest('.terminal-slot').dataset.instanceId,window.reviewTerm(i)]));window.compactSocketCount=window.reviewSockets.length;
    window.splitInputs=[];window.splitSizes=[];
    for(const socket of window.reviewSockets){const send=socket.send.bind(socket);socket.send=data=>{if(typeof data==='string'&&data[0]==='1')window.splitInputs.push({url:socket.url,text:new TextDecoder().decode(Uint8Array.from(atob(data.slice(1)),c=>c.charCodeAt(0)))});if(typeof data==='string'&&data[0]==='3')window.splitSizes.push({url:socket.url,sent:data});send(data);};}
  });}
  async function contrast() {
    await wait(async()=>page.locator('.workspace-bar .session-name').evaluateAll(elements=>{
      const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
      const rgb=()=>[...ctx.getImageData(0,0,1,1).data].slice(0,3);
      const luminance=values=>{const v=values.map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4);return v[0]*.2126+v[1]*.7152+v[2]*.0722;};
      const terminal=getComputedStyle(document.querySelector('.terminal-slot:not([hidden]) .real-terminal')).backgroundColor;
      return elements.every(element=>{
        ctx.clearRect(0,0,1,1);ctx.fillStyle=terminal;ctx.fillRect(0,0,1,1);
        const layers=[];let parent=element;while(parent){layers.unshift(getComputedStyle(parent).backgroundColor);if(parent.classList.contains('workspace-bar'))break;parent=parent.parentElement;}
        for(const color of layers){ctx.fillStyle=color;ctx.fillRect(0,0,1,1);}const b=luminance(rgb());
        ctx.clearRect(0,0,1,1);ctx.fillStyle=getComputedStyle(element).color;ctx.fillRect(0,0,1,1);const a=luminance(rgb());
        return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;
      });
    }),'tab label contrast');
  }
  const me=await api('/me'), prefs=await api('/me/preferences');
  const legacy={...prefs,opened:ids,instanceOrder:ids,active:c,split:true,toolbarPinned:true,maximized:false};delete legacy.workspace;
  await api('/me/preferences',legacy,'PUT');
  await page.evaluate(id=>{localStorage.removeItem('gotty-hub:workspace:'+encodeURIComponent(id));localStorage.removeItem('gotty-hub:layout:'+encodeURIComponent(id));},me.id);
  await page.reload({waitUntil:'domcontentloaded'});await expectPair(a,c);await expectFocus(c);
  assert.equal(await page.locator('.sidebar,.topbar,.terminal-pane-heading,.instance-sort-handle').count(),0);
  assert.equal(Math.round((await page.locator('.workspace-bar').boundingBox()).height),32);
  await action(c,'退出分屏');
  // Undo migration's adjacency normalization, then create groups using the real menu.
  const reset={...legacy,active:a,split:false,workspace:{schemaVersion:3,opened:ids,order:ids,active:a,groups:[]}};
  await api('/me/preferences',reset,'PUT');await page.evaluate(id=>localStorage.removeItem('gotty-hub:workspace:'+encodeURIComponent(id)),me.id);
  await page.reload({waitUntil:'domcontentloaded'});await expectFocus(a);
  let m=await menu(ids.at(-1));assert(await m.getByRole('button',{name:/与右侧标签分屏/}).isDisabled());await page.keyboard.press('Escape');await m.waitFor({state:'hidden'});
  await action(b,/与右侧标签分屏/);await expectPair(b,c);await expectFocus(b);
  assert.equal(await page.locator('.workspace-tab-pair').count(),1);
  assert((await tab(b).textContent()).includes('左'));assert((await tab(c).textContent()).includes('右'));
  m=await menu(a);assert(await m.getByRole('button',{name:/与右侧标签分屏/}).isDisabled());await sleep(200);await page.screenshot({path:path.join(dir,'compact-tab-menu.png')});await page.keyboard.press('Escape');
  await select(d);assert.equal(await page.locator('.terminal-slot:not([hidden])').count(),1);
  await action(d,/与右侧标签分屏/);await expectPair(d,ids[4]);assert.equal(await page.locator('.workspace-tab-pair').count(),2);
  await select(b);await expectPair(b,c);
  await wait(async()=> (await terminal(b))?.pending===0 && (await terminal(c))?.pending===0,'pair ready');await track();
  const file=path.join(dir,'vim-compact.txt');
  await page.keyboard.type("vim -Nu NONE -n -i NONE '"+file+"'");await page.keyboard.press('Enter');
  await wait(async()=>(await terminal(b))?.type==='alternate' && (await terminal(b))?.pending===0,'Vim entry');
  await page.keyboard.press('i');await page.keyboard.insertText('split-中文-unsaved');await page.keyboard.press('Escape');
  await wait(async()=>(await terminal(b))?.pending===0 && (await terminal(b))?.text.startsWith('split-中文-unsaved'),'Vim first row');
  assert((await terminal(b)).cols>=60,'confirmed PTY minimum grid lost');
  assert(await slot(b).locator('.xterm-host').evaluate(e=>{e.scrollLeft=e.scrollWidth;const ok=e.scrollWidth>e.clientWidth&&e.scrollLeft>0;e.scrollLeft=0;return ok;}),'wide PTY cannot scroll');
  await slot(c).locator('.xterm-screen').click({position:{x:20,y:80}});await expectFocus(c);await page.keyboard.type('printf C_FOCUS_PROBE');await page.keyboard.press('Enter');
  await wait(async()=>(await terminal(c))?.text.includes('C_FOCUS_PROBE'),'right input');
  await select(b);await page.keyboard.press('A');await page.keyboard.insertText('-stillB');await page.keyboard.press('Escape');
  await wait(async()=>(await terminal(b))?.text.includes('unsaved-stillB'),'left input');
  assert(await page.evaluate(({b,c})=>{const input=id=>window.splitInputs.filter(f=>f.url.includes('/'+id+'/ws')).map(f=>f.text).join('');return input(b).includes('-stillB')&&!input(c).includes('-stillB')&&input(c).includes('C_FOCUS_PROBE')&&!input(b).includes('C_FOCUS_PROBE');},{b,c}));
  // Cancelling a drag must not send Escape to a live Vim or persist a move.
  const beforeCancel=await order();const inputCount=await page.evaluate(()=>window.splitInputs.length);
  for(const cancel of ['escape','blur']){
    await tab(b).scrollIntoViewIfNeeded();await sleep(250); // wait for the previous cancelled sort's return animation
    const from=await tab(b).boundingBox(),to=await tab(a).boundingBox();
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down({button:'right'});await page.mouse.move(to.x+8,to.y+to.height/2,{steps:10});
    await wait(async()=>await page.locator('[data-dragging=true]').count()===1,'drag activated');
    if(cancel==='escape')await page.keyboard.press('Escape');else await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await page.mouse.up({button:'right'});assert.deepEqual(await order(),beforeCancel);assert.equal(await page.locator('[data-dragging=true]').count(),0);
  }
  assert(await page.evaluate(count=>window.splitInputs.slice(count).every(frame=>/^\x1b\[[IO]$/.test(frame.text)),inputCount),'drag keystroke leaked to PTY');
  // Entire pair moves when dragging its right member with the right button.
  await tab(c).scrollIntoViewIfNeeded();const source=await tab(c).boundingBox(),target=await tab(a).boundingBox();
  await page.mouse.move(source.x+source.width/2,source.y+source.height/2);await page.mouse.down({button:'right'});
  await page.mouse.move(target.x+8,target.y+target.height/2,{steps:15});await sleep(150);await page.mouse.up({button:'right'});
  await wait(async()=>(await order())[0]===b && (await order())[1]===c,'whole group right drag');await expectPair(b,c);await identity();
  await action(c,'交换左右');await expectPair(c,b);await expectFocus(c);assert.deepEqual((await order()).slice(0,2),[c,b]);await identity();
  const divider=page.getByRole('separator',{name:'调整终端分屏宽度'});
  const bounds=await page.locator('.terminals').boundingBox(),handle=await divider.boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+100);await page.mouse.down();await page.mouse.move(bounds.x+4+(bounds.width-8)*0.6,handle.y+100,{steps:8});await page.mouse.up();
  await wait(async()=>Number(await divider.getAttribute('aria-valuenow'))===60,'pointer resize');
  await divider.focus();await page.keyboard.press('ArrowLeft');assert.equal(Number(await divider.getAttribute('aria-valuenow')),58);await page.keyboard.press('Enter');
  for(const key of ['Home','End']){await page.keyboard.press(key);assert((await page.locator('.terminal-slot:not([hidden])').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().width))).every(w=>w>=359.9));}await page.keyboard.press('Enter');await identity();
  await contrast();await page.screenshot({path:path.join(dir,'compact-paper-desktop.png')});
  // The navigation always overlays the full-height terminal. Menus do not resize it.
  await select(b);await sleep(300);
  const sizes=await page.evaluate(()=>window.splitSizes.length), height=(await page.locator('.terminals').boundingBox()).height;
  m=await menu(b);await sleep(900);
  assert.equal((await page.locator('.terminals').boundingBox()).height,height);assert.equal(await page.evaluate(()=>window.splitSizes.length),sizes);
  await page.keyboard.press('Escape');await m.waitFor({state:'hidden'});await slot(b).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Escape');assert(await page.locator('.workspace-bar').isVisible());await identity();await select(b);
  await page.route('**/api/v1/me/preferences',route=>route.request().method()==='PUT'?route.abort():route.continue());
  await divider.focus();for(let i=0;i<5;i++)await page.keyboard.press('ArrowRight');
  const cached=await page.evaluate(id=>JSON.parse(localStorage.getItem('gotty-hub:workspace:'+encodeURIComponent(id))),me.id);
  assert(cached.pending);assert.equal(cached.workspace.schemaVersion,3);assert.equal(cached.workspace.groups.length,2);
  assert(Math.abs(cached.workspace.groups.find(g=>g.left===c).ratio-0.6)<0.01);
  await page.reload({waitUntil:'domcontentloaded'});await expectPair(c,b);await expectFocus(b);assert.equal(Number(await divider.getAttribute('aria-valuenow')),60);assert.deepEqual(await order(),cached.workspace.order);
  await wait(async()=>(await terminal(b))?.type==='alternate'&&(await terminal(b))?.pending===0&&(await terminal(b))?.text.includes('unsaved'),'Vim reload');
  await page.keyboard.press('Escape');await page.keyboard.type(':wq');await page.keyboard.press('Enter');await wait(()=>fs.existsSync(file),'Vim save');assert(fs.readFileSync(file,'utf8').includes('split-中文-unsaved-stillB'));
  await page.unroute('**/api/v1/me/preferences');await select(c);await select(b);
  await wait(async()=>(await api('/me/preferences')).workspace?.groups?.length===2,'group persistence');
  for(const width of [320,375,414,768]){
    await page.setViewportSize({width,height:844});await sleep(200);
    assert.equal(await page.locator('.terminal-slot:not([hidden])').count(),1);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal page overflow');
    if(width===375){await select(a);}
    await page.screenshot({path:path.join(dir,'compact-'+width+'.png')});
  }
  await page.setViewportSize({width:1280,height:800});assert.equal(await page.locator('.terminal-slot:not([hidden])').count(),1,'unrelated mobile selection replaced group');
  await select(b);await expectPair(c,b);assert.equal(Number(await divider.getAttribute('aria-valuenow')),60);
  process.kill(-devices[2].child.pid,'SIGTERM');await wait(async()=>!(await api('/instances')).find(i=>i.id===c).online,'offline');await expectPair(c,b);
  await wait(()=>slot(c).locator('.terminal-empty').isVisible(),'named offline pane');assert((await slot(c).innerText()).includes(names[c]));
  await wait(()=>devices[2].child.exitCode!==null,'stopped');devices[2].child=start('gotty-compact-reconnect',process.env.GOTTY_BINARY,devices[2].args);
  await wait(()=>slot(c).locator('.terminal-clear-control').isEnabled(),'reconnect');await expectPair(c,b);await sleep(200);assert.equal(await focused(),b,'reconnect stole focus');
  await action(c,'关闭终端标签');assert.equal(await page.locator('.terminal-slot:not([hidden])').count(),1);await expectFocus(b);
  await page.locator('.add-instance').click();await page.getByRole('button',{name:/重新打开已关闭实例/}).click();await page.getByRole('option',{name:names[c],exact:true}).click();await expectFocus(c);assert.equal(await page.locator('.terminal-slot:not([hidden])').count(),1);
  const observer=await browser.newContext({viewport:{width:1280,height:800}});await observer.addInitScript(installInspection);await observer.addInitScript(()=>localStorage.setItem('gotty-hub.locale','zh-CN'));
  const username='compact-observer';const registration=await observer.request.post(hub+'/api/v1/auth/register',{data:{username,password:'compact-observer-password-123'}});assert(registration.ok());
  for(const id of [b,c])await api('/instances/'+id+'/grants',{username,role:'observer'},'PUT');
  const op=await observer.newPage();op.on('pageerror',e=>errors.push(e.stack));await op.goto(hub,{waitUntil:'domcontentloaded'});
  await wait(async()=>await op.locator('.session-tab').count()===2,'observer tabs');
  await op.locator('.session-tab .tab-trigger').first().click();assert.equal(await op.locator('.tab-actions-menu').getByRole('button',{name:'重启此 GoTTY…',exact:true}).count(),0);
  await op.locator('.tab-actions-menu').getByRole('button',{name:/与右侧标签分屏/}).click();await wait(async()=>await op.locator('.terminal-slot:not([hidden])').count()===2,'observer pair');
  assert.equal(await op.locator('.terminal-clear-control,.terminal-upload-control,.terminal-restart-control').count(),0);
  await api('/instances/'+c+'/grants/'+username,{},'DELETE');await wait(async()=>await op.locator('.terminal-slot:not([hidden])').count()===1&&await op.locator('.terminal-slot[data-instance-id="'+c+'"]').count()===0,'revocation dissolves group');await observer.close();await page.bringToFront();
  // Use real browser touch events: scrolling is distinct from a deliberate hold-and-drag.
  const touchContext=await browser.newContext({viewport:{width:375,height:844},hasTouch:true,isMobile:true});
  await touchContext.addCookies(await page.context().cookies(hub));const touch=await touchContext.newPage();touch.on('pageerror',e=>errors.push(e.stack));
  await touch.goto(hub,{waitUntil:'domcontentloaded'});
  await touch.locator('.session-tab').first().waitFor();await sleep(350);
  const touchOrder=()=>touch.locator('.session-tab').evaluateAll(es=>es.map(e=>e.dataset.tabId));
  const beforeTouch=await touchOrder();const cdp=await touchContext.newCDPSession(touch);
  const rows=touch.locator('.workspace-tab-unit');const from=await rows.first().boundingBox(),to=await rows.nth(2).boundingBox();
  const point={x:from.x+from.width/2,y:from.y+from.height/2};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await sleep(350);
  await wait(async()=>await touch.locator('[data-dragging=true]').count()===1,'long-press activation');
  for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x+(to.x+to.width/2-point.x)*i/8,y:point.y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await wait(async()=>JSON.stringify(await touchOrder())!==JSON.stringify(beforeTouch),'touch reorder');
  await touch.screenshot({path:path.join(dir,'compact-touch-tabs.png')});await touchContext.close();await page.bringToFront();
  // Restore a predictable workspace for the remaining full-suite checks.
  await wait(async()=>(await api('/me/preferences')).workspace?.opened.includes(c),'reopened persisted');
  await api('/me/preferences',reset,'PUT');await page.evaluate(id=>{localStorage.removeItem('gotty-hub:workspace:'+encodeURIComponent(id));localStorage.removeItem('gotty-hub:layout:'+encodeURIComponent(id));},me.id);
  await page.reload({waitUntil:'domcontentloaded'});await expectFocus(a);
  report('compactWorkspace',{singleToolbar:true,leftMenuRightSelect:true,cancelDragDoesNotReachPTY:true,touchLongPress:true,rightDragWholePair:true,adjacentOnly:true,multipleGroups:true,unrelatedTabPreservesGroups:true,atomicSwap:true,legacyMigration:true,focusAndInput:true,stableRenderersAndSockets:true,confirmedPTYGrid:true,unsavedVim:true,overlayDoesNotResize:true,escapePreserved:true,immediateReload:true,mobileRestoration:true,offlineIdentity:true,observerAndRevocation:true});
};

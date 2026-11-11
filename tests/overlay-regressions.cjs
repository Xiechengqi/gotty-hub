// Real UI checks using the disposable workspace harness.
const assert = require('node:assert/strict');
const path = require('node:path');
module.exports = async ({page, context, browser, hub, ids, api, wait, sleep, dir, report, start, port, installInspection, errors}) => {
  const names = Object.fromEntries((await api('/instances')).map(i => [i.id, i.name]));
  const tab = id => page.locator('.session-tab[data-instance-id="'+id+'"] .tab-trigger');
  const selected = () => page.locator('.session-tab.selected').getAttribute('data-instance-id');
  const opacity = () => page.locator('.workspace-bar').evaluate(e => Number(getComputedStyle(e).getPropertyValue('--hub-bar-opacity')));
  async function dismiss() {await page.keyboard.press('Escape');await page.locator('.tab-actions-menu').waitFor({state:'hidden'});}
  async function settings() {
    await page.getByRole('button',{name:'设置',exact:true}).click();
    const menu=page.getByRole('dialog',{name:'设置',exact:true});
    assert.equal(await menu.locator('.settings-account-name').innerText(),(await api('/me')).username);
    assert(await menu.locator('.settings-account-row .language-toggle').isVisible());
    assert.equal(await menu.getByRole('button',{name:'切换主题',exact:true}).count(),0);
    await menu.getByRole('button',{name:'终端设置',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'终端设置',exact:true});await dialog.waitFor();await page.waitForFunction(()=>!document.querySelector('[data-entering],[data-exiting]'));return dialog;
  }
  async function geometry() {
    return page.evaluate(() => {
      const bounds = e => {const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
      const tabs=[...document.querySelectorAll('.session-tab')].map(bounds);
      const buttons=[...document.querySelectorAll('.workspace-bar-actions>button')].map(bounds);
      return {tabs,buttons,terminal:bounds(document.querySelector('.terminals')),bar:bounds(document.querySelector('.workspace-bar')),width:innerWidth,height:visualViewport.height,overflow:document.documentElement.scrollWidth>innerWidth};
    });
  }
  async function checkGeometry() {
    const g=await geometry();assert.equal(g.buttons.length,2);
    assert(Math.abs(g.terminal.y)<1 && Math.abs(g.terminal.height-g.height)<1,JSON.stringify(g));
    assert(!g.overflow);assert(Math.max(...g.tabs.map(t=>t.width))-Math.min(...g.tabs.map(t=>t.width))<1,'tabs must share remaining width');
    assert(Math.abs(g.tabs[0].x)<1);assert(Math.abs(g.tabs.at(-1).x+g.tabs.at(-1).width-g.buttons[0].x)<1);
    assert(Math.abs(g.buttons[0].width-g.buttons[1].width)<1);assert(Math.abs(g.buttons[1].x+g.buttons[1].width-g.width)<1);
    return g;
  }
  assert.equal(await page.locator('.browse-instances,.more-tabs,.page-refresh,.pin-toolbar,.workspace-reveal,.instance-browser-list,.sidebar,.tab-close').count(),0);
  assert.equal(await page.locator('.session-tab').count(),ids.length);
  assert.equal(await page.locator('.real-terminal').count(),1,'unvisited tabs opened connections');
  await page.evaluate(()=>{window.overlayOriginal=window.reviewTerm();});
  await tab(ids[1]).click();await page.locator('.tab-actions-menu').waitFor();assert.equal(await selected(),ids[1]);await dismiss();
  await wait(()=>page.locator('.terminal-slot:not([hidden]) .terminal-clear-control').isEnabled(),'lazy terminal connects');
  await tab(ids[0]).click({button:'right'});assert.equal(await page.locator('.tab-actions-menu').count(),0);
  assert(await page.evaluate(()=>window.reviewTerm()===window.overlayOriginal));
  assert.equal(await page.locator('.real-terminal').count(),2);
  await checkGeometry();
  const initialOpacity=await opacity();
  await page.evaluate(()=>{window.overlayResizes=[];window.overlaySocketCount=window.reviewSockets.length;for(const socket of window.reviewSockets){const send=socket.send.bind(socket);socket.send=data=>{if(typeof data==='string'&&data[0]==='3')window.overlayResizes.push(data);send(data);};}});
  await sleep(300);const beforeSizes=await page.evaluate(()=>window.overlayResizes.length);
  let dialog=await settings(),slider=dialog.getByRole('slider');
  await slider.focus();await page.keyboard.press('Home');await wait(async()=>await opacity()===1,'opaque preview');
  await page.keyboard.press('End');await wait(async()=>await opacity()===0,'transparent preview');
  await dialog.getByRole('button',{name:'取消',exact:true}).last().click();await dialog.waitFor({state:'hidden'});assert.equal(await opacity(),initialOpacity);
  dialog=await settings();slider=dialog.getByRole('slider');await slider.focus();await page.keyboard.press('Home');
  for(let n=0;n<25;n++)await page.keyboard.press('ArrowRight');
  assert.equal(await opacity(),.75);
  await dialog.getByRole('button',{name:'保存并应用',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal((await api('/me/terminal-settings')).settings.tabBarTransparency,25);
  assert.equal(await page.evaluate(()=>window.reviewSockets.length),await page.evaluate(()=>window.overlaySocketCount));
  assert.equal(await page.evaluate(()=>window.overlayResizes.length),beforeSizes,'transparency resized the terminal');
  await page.reload({waitUntil:'domcontentloaded'});await wait(async()=>await opacity()===.75,'saved transparency');await checkGeometry();
  await page.route('**/api/v1/me/preferences',async route=>{if(route.request().method()==='GET')await sleep(700);await route.continue();});
  await page.reload({waitUntil:'domcontentloaded'});await wait(async()=>await page.locator('.workspace-bar').isVisible(),'restored workspace');await checkGeometry();await page.unroute('**/api/v1/me/preferences');
  // Closing stays closed across repeated SSE snapshots and reload; + restores it.
  const closed=ids[2];await tab(closed).click();await page.locator('.tab-actions-menu').getByRole('button',{name:'关闭终端标签',exact:true}).click();
  await wait(async()=>await page.locator('.session-tab').count()===ids.length-1,'closed tab');await sleep(1200);
  await page.reload({waitUntil:'domcontentloaded'});await wait(async()=>await page.locator('.session-tab').count()===ids.length-1,'closed state restored');
  await page.locator('.add-instance').click();const add=page.getByRole('dialog',{name:'添加实例',exact:true});await add.waitFor();
  assert.equal(await add.getByRole('textbox').count(),2);assert.equal(await add.getByRole('textbox',{name:'用户名',exact:true}).inputValue(),(await api('/me')).username);
  await add.getByRole('button',{name:'复制Hub 地址',exact:true}).click();await add.getByRole('status').waitFor();
  await add.getByRole('button',{name:/重新打开已关闭实例/}).click();await page.getByRole('option',{name:names[closed],exact:true}).click();
  await add.waitFor({state:'hidden'});await wait(async()=>await selected()===closed,'reopened selection');
  await tab(ids[0]).click({button:'right'});
  // An actual GoTTY registration appends one tab without moving focus or opening a socket.
  const gp=await port(), url='http://127.0.0.1:'+gp;
  const args=['--config','/dev/null','--address','127.0.0.1','--port',String(gp),'--hub-state-file',path.join(dir,'overlay-new.json'),'--permit-write','bash','--noprofile','--norc'];
  const child=start('gotty-overlay-new',process.env.GOTTY_BINARY,args);
  await wait(async()=>(await fetch(url+'/config.js')).ok,'new GoTTY');
  const socketCount=await page.evaluate(()=>window.reviewSockets.length);
  const joined=await fetch(url+'/-/hub',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({URL:hub,Username:(await api('/me')).username,Name:'新注册实例'})});assert(joined.ok);
  const added=(await joined.json()).instance_id;
  await wait(async()=>await page.locator('.session-tab').count()===ids.length+1,'automatic registered tab');assert.equal(await selected(),ids[0]);
  assert.equal(await page.evaluate(()=>window.reviewSockets.length),socketCount,'registration opened background connection');
  assert.equal(await page.locator('.session-tab').last().getAttribute('data-instance-id'),added);await checkGeometry();
  await api('/instances/'+added+'/binding',{},'DELETE');await wait(async()=>await page.locator('.session-tab').count()===ids.length,'unbound tab removed');
  process.kill(-child.pid,'SIGTERM');
  // Both languages keep the account and language control on the first row.
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'Switch to English',exact:true}).click();
  assert(await page.getByRole('button',{name:'切换为中文',exact:true}).isVisible());await page.getByRole('button',{name:'切换为中文',exact:true}).click();await page.keyboard.press('Escape');
  const layouts=[];
  for(const width of [320,375,414,768,1280]){
    await page.setViewportSize({width,height:844});await sleep(200);layouts.push(await checkGeometry());
    await tab(ids.at(-1)).click();assert.equal(await selected(),ids.at(-1));await dismiss();
    await page.screenshot({path:path.join(dir,'overlay-'+width+'.png')});
    dialog=await settings();const box=await dialog.boundingBox();assert(box.x>=0 && box.x+box.width<=width+1,'settings overflow');
    assert(await dialog.locator('.terminal-settings-themes button').evaluateAll(buttons=>buttons.every(b=>b.scrollWidth<=b.clientWidth+1)),'theme labels overflow');
    assert(await dialog.getByRole('slider').isVisible());await page.screenshot({path:path.join(dir,'overlay-settings-'+width+'.png')});
    await dialog.getByRole('button',{name:'取消',exact:true}).last().click();await dialog.waitFor({state:'hidden'});
  }
  await page.setViewportSize({width:844,height:390});await sleep(200);await checkGeometry();
  await page.setViewportSize({width:1280,height:800});await tab(ids[0]).click({button:'right'});
  const snapshot=await api('/me/terminal-settings');await api('/me/terminal-settings',{revision:snapshot.revision,settings:{...snapshot.settings,tabBarTransparency:50}},'PUT');
  await page.reload({waitUntil:'domcontentloaded'});await wait(async()=>await opacity()===.5,'restore default transparency');
  report('overlayWorkspace',{equalTabs:true,fullHeight:true,lazyConnections:true,leftMenuRightSelect:true,transparencyPreviewSaveCancel:true,noResizeOrReconnect:true,closeReopen:true,newRegistration:true,languageAccountRow:true,widths:layouts.map(v=>v.width)});
};

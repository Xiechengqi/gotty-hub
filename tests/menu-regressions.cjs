// Destructive actions run only against the disposable workspace harness.
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async ({page, browser, hub, ids, devices, api, wait, sleep, dir, report, installInspection, errors}) => {
  const [a,b,c] = ids, me=await api('/me'), preferences=await api('/me/preferences');
  const names=Object.fromEntries((await api('/instances')).map(i=>[i.id,i.name]));
  await api('/me/preferences',{...preferences,locale:'zh-CN',workspace:{schemaVersion:3,opened:ids,order:ids,active:a,groups:[]}},'PUT');
  await page.evaluate(id=>localStorage.removeItem('gotty-hub:workspace:'+encodeURIComponent(id)),me.id);
  await page.setViewportSize({width:1280,height:800});await page.reload({waitUntil:'domcontentloaded'});
  const tab=(id,target=page)=>target.locator('.session-tab[data-instance-id="'+id+'"] .tab-trigger');
  const slot=id=>page.locator('.terminal-slot[data-instance-id="'+id+'"]');
  const confirmation=page.getByRole('alertdialog',{name:'删除实例',exact:true});
  const deletes=[];page.on('request',r=>{if(r.method()==='DELETE'&&r.url().endsWith('/binding'))deletes.push(r.url());});
  async function menu(id,target=page) {await tab(id,target).click({button:'right'});const m=target.locator('.tab-actions-menu');await m.waitFor();return m;}
  async function openDelete(id) {const m=await menu(id);await m.getByRole('button',{name:'删除',exact:true}).click();await confirmation.waitFor();assert((await confirmation.textContent()).includes(names[id]));}
  async function confirmDelete(id) {await openDelete(id);await confirmation.getByRole('button',{name:'删除',exact:true}).click();await confirmation.waitFor({state:'hidden'});await wait(async()=>await tab(id).count()===0,'deleted tab removed');}
  async function dismiss() {await page.keyboard.press('Escape');await page.locator('.tab-actions-menu').waitFor({state:'hidden'});}
  await wait(()=>slot(a).locator('.terminal-clear-control').isEnabled(),'first terminal ready');
  let m=await menu(a);
  assert.deepEqual(await m.locator('.tab-menu-item').allTextContents(),['刷新','与右侧标签分屏 · '+names[b],'重启','删除']);
  assert.equal(await m.getByRole('separator').count(),0);
  assert.equal(await page.locator('.detail-banner,.grant-role-controls').count(),0);
  for(const label of ['实例设置','实例详情','接管终端尺寸','向左移动','向右移动','关闭终端标签','添加操作者','轮换设备凭据'])assert.equal(await page.getByRole('button',{name:label,exact:true}).count(),0);
  await sleep(250);await page.screenshot({path:path.join(dir,'menu-cleanup-desktop.png')});await dismiss();
  await page.setViewportSize({width:320,height:844});m=await menu(a);await sleep(250);
  const box=await m.boundingBox();assert(box.x>=0&&box.x+box.width<=320);await page.screenshot({path:path.join(dir,'menu-cleanup-mobile.png')});await dismiss();
  await page.setViewportSize({width:1280,height:800});
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'Switch to English',exact:true}).click();await page.keyboard.press('Escape');
  m=await menu(a);for(const label of ['Refresh','Restart','Delete'])assert(await m.getByRole('button',{name:label,exact:true}).isVisible());await dismiss();
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'切换为中文',exact:true}).click();await page.keyboard.press('Escape');

  // Removal stays owner-only for writable operators as well as observers.
  const members=[];
  for(const role of ['operator','observer']){
    const member=await browser.newContext({viewport:{width:1280,height:800}});await member.addInitScript(installInspection);
    await member.addInitScript(()=>localStorage.setItem('gotty-hub.locale','zh-CN'));
    const username='menu-'+role;
    const registration=await member.request.post(hub+'/api/v1/auth/register',{data:{username,password:'menu-regression-password-123'}});assert(registration.ok());
    const auth=await registration.json();await api('/instances/'+b+'/grants',{username,role},'PUT');
    const target=await member.newPage();target.on('pageerror',error=>errors.push(error.stack));await target.goto(hub,{waitUntil:'domcontentloaded'});
    await wait(async()=>await target.locator('.session-tab').count()===1,role+' tab');
    const actions=await menu(b,target);
    assert.equal(await actions.getByRole('button',{name:'删除',exact:true}).count(),0);
    assert.equal(await actions.getByRole('button',{name:'重启',exact:true}).count(),0);
    const denied=await member.request.delete(hub+'/api/v1/instances/'+b+'/binding',{data:{},headers:{'x-csrf-token':auth.csrf,'X-Hub-Origin':hub}});
    assert.equal(denied.status(),403,role+' must not bypass menu permissions');
    members.push({member,target});
  }
  await page.bringToFront();m=await menu(a);await m.getByRole('button',{name:/与右侧标签分屏/}).click();
  await wait(async()=>await page.locator('.terminal-slot:not([hidden])').count()===2,'pair before deletion');
  await wait(()=>slot(b).locator('.terminal-clear-control').isEnabled(),'second terminal ready');
  await page.evaluate(()=>{window.menuSurvivor=window.reviewTerm();window.menuSocket=window.reviewSockets.find(s=>s.readyState===1);});
  await openDelete(b);assert.equal(deletes.length,0,'opening confirmation sent DELETE');
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();await confirmation.waitFor({state:'hidden'});
  assert.equal(deletes.length,0);assert.equal(await page.locator('.terminal-slot:not([hidden])').count(),2);
  const binding='**/api/v1/instances/'+b+'/binding';
  await page.route(binding,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'database_error'})}));
  await openDelete(b);await confirmation.getByRole('button',{name:'删除',exact:true}).click();
  await wait(async()=>await confirmation.getByRole('alert').count()===1,'deletion failure visible');
  assert((await confirmation.getByRole('alert').innerText()).includes('服务暂时不可用'));
  assert((await api('/instances')).some(i=>i.id===b));assert.equal(await page.locator('.terminal-slot:not([hidden])').count(),2);
  await page.unroute(binding);await page.route(binding,async route=>{await sleep(700);await route.continue();});
  const before=deletes.length;await confirmation.getByRole('button',{name:'删除',exact:true}).click();
  await confirmation.getByRole('button',{name:'删除中…',exact:true}).click();
  await confirmation.waitFor({state:'hidden'});assert.equal(deletes.length,before+1,'pending delete submitted twice');await page.unroute(binding);
  await wait(async()=>await tab(b).count()===0&&await page.locator('.terminal-slot:not([hidden])').count()===1,'deleted pair member removed');
  assert.equal(await page.locator('.session-tab.selected').getAttribute('data-tab-id'),a);
  await wait(()=>page.evaluate(id=>document.activeElement?.closest('.terminal-slot')?.dataset.instanceId===id,a),'survivor focus');
  assert(await page.evaluate(()=>window.reviewTerm()===window.menuSurvivor&&window.menuSocket.readyState===1),'survivor terminal or socket recreated');
  assert(!(await api('/instances')).some(i=>i.id===b));
  for(const {member,target} of members){await wait(async()=>await target.locator('.session-tab,.real-terminal').count()===0,'member view revoked');await member.close();}
  await page.bringToFront();await page.reload({waitUntil:'domcontentloaded'});await wait(async()=>await page.locator('.session-tab').count()===ids.length-1,'deletion persists after reload');

  // Offline deletion is available without a live terminal renderer.
  process.kill(-devices[2].child.pid,'SIGTERM');await wait(async()=>!(await api('/instances')).find(i=>i.id===c).online,'offline device');
  m=await menu(c);await wait(()=>slot(c).locator('.terminal-empty').isVisible(),'offline view');
  await wait(()=>m.getByRole('button',{name:'刷新',exact:true}).isDisabled(),'offline refresh disabled');assert(await m.getByRole('button',{name:'删除',exact:true}).isEnabled());await dismiss();
  await confirmDelete(c);assert(!(await api('/instances')).some(i=>i.id===c));

  // Remove the remaining disposable fixtures, then delete the last tab in UI.
  for(const instance of await api('/instances'))if(instance.id!==a)await api('/instances/'+instance.id+'/binding',{},'DELETE');
  await wait(async()=>await page.locator('.session-tab').count()===1,'last tab');await confirmDelete(a);
  assert.equal(await page.locator('.real-terminal').count(),0);assert(await page.locator('.add-instance').isVisible());
  await page.reload({waitUntil:'domcontentloaded'});await wait(()=>page.locator('.terminal-empty').isVisible(),'empty workspace');
  assert.equal(await page.locator('.session-tab').count(),0);assert.deepEqual(await api('/instances'),[]);
  report('menuCleanup',{shortLabels:true,noDividers:true,noDetailsDrawer:true,ownerOnly:true,serverAuthorization:true,cancelSendsNothing:true,failureRetainsTabs:true,retryExactlyOnce:true,splitSurvivorPreserved:true,revokesOtherViewers:true,offlineDelete:true,lastTabDelete:true,reloadPersists:true});
};

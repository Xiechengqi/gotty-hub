const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({page, context, browser, hub, ids, devices, api, wait, sleep, dir, report, installInspection, start, errors}) => {
  const [a,b,c,d,e,f,g,h,i,j,k,l] = ids;
  const names = Object.fromEntries((await api('/instances')).map(instance => [instance.id, instance.name]));
  const tab = id => page.locator('.session-tab[data-tab-id="' + id + '"] .tab-trigger');
  const slot = id => page.locator('.terminal-slot[data-instance-id="' + id + '"]');
  const menu = page.locator('.tab-actions-menu');
  const picker = page.locator('.split-dialog');
  const layout = () => api('/me/workspace');
  const saved = async pattern => wait(async () => pattern((await layout()).units || []), 'saved workspace');
  const getGroup = async anchor => (await layout()).units.find(unit => unit.members?.[0] === anchor);
  const order = () => page.locator('.session-tab').evaluateAll(nodes => nodes.map(node => node.dataset.tabId));
  const active = () => page.locator('.terminal-slot[data-focused=true]').getAttribute('data-instance-id');
  const terminal = id => page.evaluate(id => {
    const nodes = [...document.querySelectorAll('.real-terminal')];
    return window.reviewSnapshot(nodes.findIndex(node => node.closest('.terminal-slot').dataset.instanceId === id));
  }, id);
  const ready = id => wait(async () => (await terminal(id))?.pending === 0 && await slot(id).locator('.terminal-clear-control').isEnabled(), 'terminal ready ' + names[id]);
  const visible = () => page.locator('.terminal-slot:not([hidden])').evaluateAll(nodes => nodes.map(node => node.dataset.instanceId));
  const expectVisible = expected => wait(async () => JSON.stringify((await visible()).sort()) === JSON.stringify([...expected].sort()), 'visible panes ' + expected.map(id => names[id]).join(','));
  const bounds = () => page.locator('.terminal-slot:not([hidden])').evaluateAll(nodes => nodes.map(node => {
    const {x,y,width,height} = node.getBoundingClientRect();
    return {id:node.dataset.instanceId,x,y,width,height};
  }));
  const sameSize = areas => {
    assert(areas.length > 0);
    for (const area of areas) {
      assert(Math.abs(area.width - areas[0].width) <= 1);
      assert(Math.abs(area.height - areas[0].height) <= 1);
      assert(area.width > 0 && area.height > 0);
    }
  };
  const open = async id => {
    await tab(id).click({button:'right'});
    await menu.waitFor();
  };
  const dismiss = async () => {
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'hidden'});
  };
  const create = async (id, members) => {
    await open(id);
    await menu.getByRole('button',{name:'新建分屏',exact:true}).click();
    await picker.waitFor();
    await picker.getByRole('textbox',{name:'搜索终端'}).fill(names[members[0]]);
    const checkbox = picker.getByRole('checkbox',{name:names[members[0]],exact:true});
    await checkbox.press('Space');
    assert(await checkbox.isChecked(), 'keyboard cannot select a split member');
    await picker.getByRole('textbox',{name:'搜索终端'}).clear();
    for (const member of members.slice(1)) await picker.locator('.split-choice').getByText(names[member],{exact:true}).click();
    await picker.getByRole('button',{name:/^新建分屏/}).click();
    await picker.waitFor({state:'hidden'});
    await expectVisible([id,...members]);
    await saved(units => units.some(unit => unit.members?.[0] === id && unit.members.length === members.length + 1));
    return (await getGroup(id)).id;
  };
  const menuAction = async (id, name) => {
    await open(id);
    await menu.getByRole('button',{name,exact:true}).click();
    await menu.waitFor({state:'hidden'});
  };

  await page.setViewportSize({width:1280,height:800});
  await saved(units => units.length > 0);
  const startingUnits = (await layout()).units;
  const legacy = startingUnits.find(unit => unit.members?.[0] === k);
  if (process.env.WORKSPACE_SUITE === 'split') {
    assert.deepEqual(legacy?.members,[k,l]);
    await tab(legacy.id).click();
    await expectVisible([k,l]);
    sameSize(await bounds());
    await menuAction(legacy.id,'解散分屏');
    await saved(units => !units.some(unit => unit.id === legacy.id));
  }
  await open(a);
  assert(await menu.getByRole('button',{name:'加入分屏',exact:true}).isDisabled());
  await menu.getByRole('button',{name:'新建分屏',exact:true}).click();
  await picker.locator('.split-choice').getByText(names[c],{exact:true}).click();
  const beforeCancelledSplit = await layout();
  await page.setViewportSize({width:727,height:800});
  await picker.waitFor({state:'hidden'});
  await page.setViewportSize({width:1280,height:800});
  assert.equal(await picker.count(),0);
  assert.deepEqual(await layout(),beforeCancelledSplit,'resizing committed an unfinished split');
  const first = await create(a,[c,e,g,i]);
  sameSize(await bounds());
  const widths = await page.locator('.workspace-tab-unit').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  assert(widths.every(width => Math.abs(width - widths[0]) <= 1), 'group gets one tab worth of space');
  assert.equal(await page.locator('.session-group-tab').count(),1);
  assert.equal(await page.locator('.session-tab').count(),ids.length - 4);

  await ready(a);
  await ready(c);
  const gridColors = () => page.locator('.split-grid').evaluate(grid => ({
    gutter: getComputedStyle(grid).backgroundColor,
    terminal: getComputedStyle(grid.querySelector('[data-focused="true"] .real-terminal')).backgroundColor,
  }));
  const cards = await page.locator('.terminal-slot:not([hidden])').evaluateAll(panes => panes.map(pane => {
    const badge = pane.querySelector('.pane-identity');
    const connections = pane.querySelector('.terminal-connections');
    const badgeBox = badge?.getBoundingClientRect();
    const connectionsBox = connections?.getBoundingClientRect();
    const gap = badgeBox && connectionsBox ? connectionsBox.top - badgeBox.bottom : -1;
    const overlaps = badgeBox && connectionsBox
      && badgeBox.left < connectionsBox.right && connectionsBox.left < badgeBox.right
      && badgeBox.top < connectionsBox.bottom && connectionsBox.top < badgeBox.bottom;
    const badgeColor = badge ? getComputedStyle(badge).backgroundColor : '';
    const channels = badgeColor.match(/[\d.]+/g)?.map(Number) ?? [];
    return {
      radius: parseFloat(getComputedStyle(pane).borderTopLeftRadius),
      border: getComputedStyle(pane, '::after').boxShadow,
      focusHue: /rgb\(\s*59,\s*130,\s*246|rgb\(\s*51,\s*146,\s*255/.test(getComputedStyle(pane, '::after').boxShadow),
      focused: pane.dataset.focused === 'true',
      hasStatusDot: !!badge?.querySelector('img.terminal-status'),
      gap,
      overlaps: !!overlaps,
      darkBadge: channels.length >= 4 && channels[0] === 0 && channels[1] === 0 && channels[2] === 0 && channels[3] > 0 && channels[3] < 1,
    };
  }));
  assert(cards.every(card => card.radius > 0 && card.border !== 'none' && card.hasStatusDot && !card.focusHue), 'each pane needs a quiet rounded border and status dot');
  assert(cards.every(card => card.darkBadge && !card.overlaps && card.gap >= 4), 'pane identity must match terminal controls and stay clear of the connection count');
  assert(cards.some(card => card.focused && cards.some(other => !other.focused && other.border !== card.border)));
  const colors = await gridColors();
  assert.equal(colors.gutter,colors.terminal,'grid gaps must use the active terminal background');
  if (process.env.WORKSPACE_SUITE === 'split') {
    let snapshot = await api('/me/terminal-settings');
    for (const [theme, expected] of [['nord','rgb(46, 52, 64)'],['paper','rgb(245, 245, 213)']]) {
      const settings = {...snapshot.settings,theme};
      snapshot = await api('/me/terminal-settings',{revision:snapshot.revision,settings},'PUT');
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await wait(async()=>{
        const current = await gridColors();
        return current.gutter === expected && current.terminal === expected;
      }, 'matching pane and gap theme ' + theme);
    }
  }

  const file = path.join(dir,'grid-vim.txt');
  await slot(a).locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('vim ' + file);
  await page.keyboard.press('Enter');
  await wait(async () => (await terminal(a))?.type === 'alternate','Vim alternate screen');
  await page.keyboard.press('i');
  await page.keyboard.insertText('equal-panes-unsaved');
  await wait(async () => (await terminal(a))?.text.includes('equal-panes-unsaved'),'Vim insert');
  await page.evaluate(id => {
    window.gridTerm = document.querySelector('.terminal-slot[data-instance-id="' + id + '"] .xterm');
    window.gridSockets = window.reviewSockets.filter(socket => socket.readyState === 1);
  },a);
  await open(b);
  await menu.getByRole('button',{name:/^加入分屏/}).click();
  await expectVisible([a,b,c,e,g,i]);
  await saved(units => units.find(u => u.id === first)?.members.at(-1) === b);
  assert.equal(await active(),b);
  const second = await create(d,[f]);
  await open(h);
  await menu.getByRole('button',{name:'加入分屏',exact:true}).click();
  await picker.getByRole('textbox',{name:'搜索分屏组'}).fill(names[a]);
  await picker.getByRole('button',{name:new RegExp(names[a])}).click();
  await expectVisible([a,b,c,e,g,h,i]);
  await saved(units => units.find(u => u.id === first)?.members.at(-1) === h);
  assert.equal(await active(),h);
  sameSize(await bounds());
  assert.equal(await page.locator('.session-group-tab').count(),2);

  const mobile = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await mobile.addCookies(await context.cookies(hub));
  await mobile.addInitScript(installInspection);
  const phone = await mobile.newPage();
  phone.on('pageerror',error=>errors.push(error.stack));
  const phoneWrites = [];
  phone.on('request',request=>{
    if (request.method() === 'PUT' && request.url().endsWith('/api/v1/me/workspace')) phoneWrites.push(request.url());
  });
  await phone.goto(hub,{waitUntil:'domcontentloaded'});
  const phoneTabs = phone.locator('.session-tab');
  const phoneOrder = target => target.locator('.session-tab').evaluateAll(nodes=>nodes.map(node=>node.dataset.tabId));
  await wait(async()=>await phoneTabs.count()===ids.length,'phone flat tabs');
  await wait(()=>phone.evaluate(()=>window.reviewSockets.some(socket=>socket.readyState===1)), 'phone terminal ready');
  assert.equal(await phone.evaluate(()=>window.reviewSockets.length),1,'phone started connections for hidden members');
  assert.equal(await phone.locator('.terminal-slot:not([hidden])').count(),1);
  const phoneTab = id => phoneTabs.filter({has:phone.locator('[aria-controls="terminal-pane-'+id+'"]')}).locator('.tab-trigger');
  const phoneStart = await phoneOrder(phone);
  const phoneSource = await phoneTab(l).boundingBox(), phoneTarget = await phoneTab(phoneStart[0]).boundingBox();
  await phone.mouse.move(phoneSource.x+phoneSource.width/2,phoneSource.y+phoneSource.height/2);
  await phone.mouse.down();
  await phone.mouse.move(phoneTarget.x+phoneTarget.width/2,phoneTarget.y+phoneTarget.height/2,{steps:8});
  await phone.mouse.up();
  await wait(async()=>(await phoneOrder(phone))[0]===l,'local phone reorder');
  const savedPhoneOrder = await phoneOrder(phone);
  await phoneTab(c).tap();
  await phoneTab(c).press('Shift+F10');
  const phoneMenu = phone.locator('.tab-actions-menu');
  await phoneMenu.waitFor();
  assert.equal(await phoneMenu.getByRole('button',{name:/分屏|同屏|按页/}).count(),0);
  await phone.keyboard.press('Escape');
  const desktopRefresh = phone.waitForResponse(response=>response.request().method()==='GET' && response.url().endsWith('/api/v1/me/workspace'));
  const beforeOrder = await order();
  const from = await tab(first).boundingBox(), to = await tab(second).boundingBox();
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);
  await page.mouse.down();
  await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:8});
  await page.mouse.up();
  await wait(async () => JSON.stringify(await order()) !== JSON.stringify(beforeOrder),'whole group reorder');
  await saved(units => units.findIndex(u => u.id === first) > units.findIndex(u => u.id === second));
  await desktopRefresh;
  assert.deepEqual(await phoneOrder(phone),savedPhoneOrder,'desktop reordering replaced phone order');
  assert.equal(await phone.locator('.terminal-slot[data-focused=true]').getAttribute('data-instance-id'),c);
  assert.equal(await active(),h,'phone operation changed desktop focus');
  assert.deepEqual(phoneWrites,[],'phone ordering wrote an account layout');
  await phone.close();
  const reopened = await mobile.newPage();
  await reopened.goto(hub,{waitUntil:'domcontentloaded'});
  await wait(async()=>(await phoneOrder(reopened)).length===ids.length,'reopened phone tabs');
  assert.deepEqual(await phoneOrder(reopened),savedPhoneOrder,'phone order did not survive reopening');
  await mobile.close();

  await page.setViewportSize({width:900,height:560});
  await menuAction(first,'按页查看');
  const pager = page.getByRole('group',{name:'分屏页码'});
  await pager.waitFor();
  const pageBounds = await bounds();
  sameSize(pageBounds);
  assert(pageBounds.length<7);
  const previousPage = pager.getByRole('button',{name:'上一页'});
  for (let step=0;step<7 && await previousPage.isEnabled();step++) await previousPage.click();
  await wait(async () => await active() === a,'focus first page');
  const originalPage = await bounds();
  sameSize(originalPage);
  assert(Math.abs(pageBounds[0].width-originalPage[0].width)<=1);
  assert(Math.abs(pageBounds[0].height-originalPage[0].height)<=1);
  await menuAction(first,'全部同屏');
  await expectVisible([a,b,c,e,g,h,i]);
  await page.setViewportSize({width:1280,height:800});

  const narrowViewports = [[320,720],[390,844],[844,390],[727,800],[1280,499]];
  for (const [width,height] of narrowViewports) {
    await page.setViewportSize({width,height});
    await expectVisible([a]);
    assert.equal(await page.locator('.session-group-tab,.workspace-pages,.split-grid').count(),0);
    assert.equal(await page.locator('.session-tab').count(),ids.length);
    await open(a);
    assert.equal(await menu.getByRole('button',{name:/新建分屏|加入分屏|解散分屏/}).count(),0);
    await dismiss();
  }
  const wideViewports = [[728,800],[1280,500],[744,1133],[768,1024]];
  for (const [width,height] of wideViewports) {
    await page.setViewportSize({width,height});
    await expectVisible([a,b,c,e,g,h,i]);
    sameSize(await bounds());
  }
  await page.evaluate(()=>{
    Object.defineProperty(visualViewport,'height',{configurable:true,value:380});
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await wait(async()=>Math.abs((await page.locator('.app').boundingBox()).height-380)<1,'visual viewport adjusted for keyboard');
  await expectVisible([a,b,c,e,g,h,i]);
  await page.evaluate(()=>{
    delete visualViewport.height;
    visualViewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(await page.locator('.session-group-tab').count(),2);
  assert(await page.evaluate(id => document.querySelector('.terminal-slot[data-instance-id="' + id + '"] .xterm') === window.gridTerm &&
    window.gridSockets.every(socket => socket.readyState === 1),a), 'layout remounted xterm or disconnected a terminal');
  await page.screenshot({path:path.join(dir,'equal-grid-tablet.png')});
  await page.setViewportSize({width:1280,height:800});
  await slot(a).locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.type(':wq');
  await page.keyboard.press('Enter');
  await wait(() => fs.existsSync(file),'Vim saved');
  assert.match(fs.readFileSync(file,'utf8'),/equal-panes-unsaved/);

  const fixture = devices[ids.indexOf(i)];
  process.kill(-fixture.child.pid, 'SIGTERM');
  await wait(() => fixture.child.exitCode !== null || fixture.child.signalCode !== null,'split member stopped');
  await slot(i).locator('.terminal-empty').waitFor();
  assert.equal(await slot(i).locator('.pane-offline-dot').getAttribute('aria-label'),'离线');
  await expectVisible([a,b,c,e,g,h,i]);
  assert.equal(await active(),a,'an offline group member moved focus');
  start('split-returning', process.env.GOTTY_BINARY, fixture.args);
  await ready(i);
  await saved(units => units.find(unit => unit.id === first)?.members.includes(i));
  assert.equal(await active(),a,'reconnecting a group member moved focus');

  // Concurrent updates from independent browser tabs may add members to different groups.
  const other = await context.newPage();
  other.on('pageerror',error=>errors.push(error.stack));
  await other.goto(hub,{waitUntil:'domcontentloaded'});
  await other.locator('.session-tab[data-tab-id="'+second+'"]').waitFor();
  const routePath = '**/api/v1/me/workspace';
  let delayOnce = true;
  await page.route(routePath,async route=>{
    if (delayOnce && route.request().method()==='PUT') {delayOnce=false;await sleep(900);}
    await route.continue();
  });
  await open(j);
  await menu.getByRole('button',{name:'加入分屏',exact:true}).click();
  await picker.getByRole('textbox').fill(names[a]);
  await picker.getByRole('button',{name:new RegExp(names[a])}).click();
  await other.locator('.session-tab[data-tab-id="'+k+'"] .tab-trigger').click({button:'right'});
  await other.locator('.tab-actions-menu').getByRole('button',{name:'加入分屏',exact:true}).click();
  await other.locator('.split-dialog').getByRole('textbox').fill(names[d]);
  await other.locator('.split-dialog').getByRole('button',{name:new RegExp(names[d])}).click();
  await saved(units => units.find(u => u.id === first)?.members.includes(j) && units.find(u => u.id === second)?.members.includes(k));
  await page.unroute(routePath);
  await other.close();

  await page.reload({waitUntil:'domcontentloaded'});
  await expectVisible([a,b,c,e,g,h,i,j]);
  assert.equal(await active(),j);
  assert.equal(await page.locator('.session-group-tab').count(),2);

  if (process.env.WEBKIT_EXECUTABLE) {
    const {webkit} = require(process.env.PLAYWRIGHT_MODULE || '../frontend/node_modules/playwright-core');
    const engine = await webkit.launch({headless:true,executablePath:process.env.WEBKIT_EXECUTABLE,env:process.env});
    try {
      const tablet = await engine.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
      await tablet.addCookies(await context.cookies(hub));
      const target = await tablet.newPage();
      target.on('pageerror',error=>errors.push(error.stack));
      await target.goto(hub,{waitUntil:'domcontentloaded'});
      const visiblePanes = target.locator('.terminal-slot:not([hidden])');
      await wait(async()=>await target.locator('.session-tab').count()===ids.length,'WebKit phone flat tabs');
      assert.equal(await visiblePanes.count(),1);
      await target.locator('.session-tab[data-tab-id="'+c+'"] .tab-trigger').tap();
      await target.locator('.terminal-slot[data-instance-id="'+c+'"] .terminal-clear-control').waitFor();
      await target.setViewportSize({width:744,height:1133});
      await wait(async()=>await visiblePanes.count()===8,'WebKit iPad mini grid');
      assert.equal(await target.locator('.session-group-tab').count(),2);
      sameSize(await visiblePanes.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON())));
      await target.setViewportSize({width:844,height:390});
      await wait(async()=>await visiblePanes.count()===1,'WebKit phone landscape');
      assert.equal(await visiblePanes.getAttribute('data-instance-id'),c);
      assert.equal(await target.locator('.session-group-tab').count(),0);
      report('splitWebKit',{portraitPhone:true,tabletMini:true,landscapePhone:true,focusPreserved:true});
    } finally {
      await engine.close();
    }
  }

  await open(first);
  await menu.getByRole('button',{name:'终端操作 · '+names[j],exact:true}).click();
  await menu.getByRole('button',{name:'移出分屏',exact:true}).click();
  await expectVisible([j]);
  await tab(first).click();
  await expectVisible([a,b,c,e,g,h,i]);
  await open(first);
  await menu.getByRole('button',{name:'终端操作 · '+names[c],exact:true}).click();
  assert(await menu.getByRole('button',{name:'刷新',exact:true}).isVisible());
  await dismiss();
  await menuAction(first,'解散分屏');
  await saved(units=>!units.some(unit=>unit.id===first));
  assert.equal(await page.locator('.session-group-tab').count(),1);
  // Restore a standalone layout for the shared harness's remaining checks.
  await menuAction(second,'解散分屏');
  await saved(units=>units.every(unit=>!unit.members));
  if (process.env.WORKSPACE_SUITE !== 'split') {
    // The combined suite opens a fresh page for the overlay checks, which
    // intentionally start from the original order and the first instance.
    const {revision} = await layout();
    await api('/me/workspace',{revision,writeId:randomBytes(16).toString('hex'),units:startingUnits},'PUT');
    await wait(async()=>JSON.stringify(await order())===JSON.stringify(startingUnits.map(unit=>unit.id)),'restore initial tab order');
    await tab(a).click();
    assert.equal(await active(),a);
  }
  assert.deepEqual(errors,[]);
  report('splitGrid',{legacyMigration:!!legacy,equalPanes:[2,5,6,7,8],equalTabs:true,roundedCards:true,matchingGutters:true,statusDots:true,joinTargets:true,paged:true,
    narrowViewports,wideViewports,visualKeyboard:true,phoneOrder:true,noPhoneLayoutWrites:true,unsavedVim:true,
    stableSockets:true,offlineMember:true,reload:true,concurrentEdits:true});
};

// Pixel geometry checks with disposable Hub/GoTTY/Chromium processes only.
// Run explicitly over SSH; UI tests must never be added to GitHub Actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function viewportRegression({page, context, browser, hub, ids, devices, api, wait, sleep, dir, report, installInspection, errors}) {
  const id=ids[0], device=devices[0];
  const tab=`.session-tab[data-instance-id="${id}"] .tab-trigger`;
  const host=`.terminal-slot[data-instance-id="${id}"] .xterm-host`;
  const state=async()=>{const r=await fetch(device.url+'/-/terminal-state');assert(r.ok);return r.json();};
  const grid=s=>[s.activeCols,s.activeRows];
  const snapshot=target=>target.evaluate(()=>window.reviewSnapshot());
  const ready=target=>wait(async()=>{
    const s=await snapshot(target);
    return s?.pending===0 && s.text.includes('bash-') && await target.locator(host).getAttribute('data-replay-active')!=='true';
  },'viewport parser ready');
  async function command(target,text){await target.locator(host+' .xterm-helper-textarea').focus();await target.keyboard.type(text);await target.keyboard.press('Enter');}
  const metrics=target=>target.evaluate(()=>{
    const h=document.querySelector('.terminal-slot:not([hidden]) .xterm-host'), t=window.reviewTerm();
    const r=h.getBoundingClientRect(), s=h.querySelector('.xterm-screen').getBoundingClientRect(), b=t.buffer.active;
    const cell=s.height/t.rows, y=s.top+(b.baseY+b.cursorY-b.viewportY)*cell;
    const keys=document.querySelector('.terminal-slot:not([hidden]) .terminal-mobile-keys')?.getBoundingClientRect();
    return {top:r.top,bottom:r.bottom-(parseFloat(getComputedStyle(h).paddingBottom)||0),cursorTop:y,cursorBottom:y+cell,
      outer:h.scrollTop,left:h.scrollLeft,inner:b.viewportY,base:b.baseY,rows:t.rows,cols:t.cols,type:b.type,
      screenHeight:s.height,hostHeight:h.clientHeight,following:h.dataset.viewportFollowing,keysTop:keys?.top,
      viewportTop:visualViewport.offsetTop,viewportBottom:visualViewport.offsetTop+visualViewport.height};
  });
  async function visible(target,label){
    await wait(async()=>{
      const m=await metrics(target);
      return m.cursorTop>=m.top-1 && m.cursorBottom<=m.bottom+1 && m.cursorTop>=m.viewportTop-1 &&
        m.cursorBottom<=m.viewportBottom+1 && (m.keysTop===undefined || m.cursorBottom<=m.keysTop+1);
    },label);
    return metrics(target);
  }
  await page.setViewportSize({width:1280,height:1100});
  await command(page,"for i in {1..180}; do printf 'VIEWPORT-LINE-%s\\n' \"$i\"; done");
  await wait(async()=>(await snapshot(page)).text.includes('VIEWPORT-LINE-180'),'desktop history');
  await wait(async()=>(await state()).activeRows>45,'tall desktop grid');
  const desktopGrid=grid(await state());
  const mobileContext=await browser.newContext({viewport:{width:390,height:600},isMobile:true,hasTouch:true});
  await mobileContext.addCookies(await context.cookies());await mobileContext.addInitScript(installInspection);
  const mobile=await mobileContext.newPage();mobile.on('pageerror',e=>errors.push(e.stack));
  let keyboardContext;
  try {
    await mobile.goto(hub,{waitUntil:'domcontentloaded'});await ready(mobile);
    const initial=await visible(mobile,'mobile last row visible after snapshot');
    assert(initial.screenHeight>initial.hostHeight+200);assert(initial.outer>200);
    assert.deepEqual(grid(await state()),desktopGrid);
    await mobile.reload({waitUntil:'domcontentloaded'});await ready(mobile);await visible(mobile,'mobile last row after reload');
    await mobile.setViewportSize({width:844,height:390});await visible(mobile,'landscape last row');
    await mobile.setViewportSize({width:390,height:600});await visible(mobile,'portrait last row');
    await command(page,'clear');await wait(async()=>(await snapshot(mobile)).cursor[1]<3,'clear parsed');
    const cleared=await visible(mobile,'clear follows cursor at top');assert(cleared.outer<50);
    await command(page,"for i in {1..100}; do printf 'MORE-LINES-%s\\n' \"$i\"; done");
    await wait(async()=>(await snapshot(mobile)).text.includes('MORE-LINES-100'),'new live output');await visible(mobile,'live bottom');
    report('viewportLive',{desktopGrid,mobileOuterScroll:initial.outer,initialReplay:true,reload:true,orientation:true,clear:true});

    // Real wheel navigation pauses following; output and tab focus do not pull
    // the phone out of history. Soft refresh retains both scroll layers.
    await mobile.mouse.move(180,250);await mobile.mouse.wheel(0,-400);
    await wait(async()=>(await metrics(mobile)).following==='false','history pauses following');await sleep(180);
    const history=await metrics(mobile);
    await command(page,"printf 'OUTPUT-WHILE-BROWSING\\n'");
    await wait(async()=>(await snapshot(mobile)).text.includes('OUTPUT-WHILE-BROWSING'),'output retained while browsing');await sleep(100);
    let after=await metrics(mobile);assert.equal(after.outer,history.outer);assert.equal(after.inner,history.inner);
    await mobile.locator(`.session-tab[data-instance-id="${ids[1]}"] .tab-trigger`).tap();
    await mobile.locator(tab).tap();await ready(mobile);await sleep(100);
    after=await metrics(mobile);assert.equal(after.following,'false');assert.equal(after.outer,history.outer);assert.equal(after.inner,history.inner);
    await mobile.locator(tab).click({button:'right'});
    await mobile.locator('.tab-actions-menu').getByRole('button',{name:'刷新',exact:true}).click();await ready(mobile);await sleep(250);
    after=await metrics(mobile);assert.equal(after.following,'false');assert.equal(after.outer,history.outer);
    await mobile.getByRole('button',{name:'回到输入位置',exact:true}).click();await visible(mobile,'return to input');
    assert.equal((await metrics(mobile)).following,'true');
    await mobile.mouse.move(180,250);await mobile.mouse.wheel(0,-300);
    await wait(async()=>(await metrics(mobile)).following==='false','pause before typing');
    await command(mobile,"printf 'MOBILE-INPUT-RESUMES\\n'");await visible(mobile,'local input resumes');
    assert.equal((await metrics(mobile)).following,'true');
    // Reproduce the independent outer-scroll case: the internal viewport is
    // still at its base and xterm would otherwise keep advancing with output.
    await mobile.locator(host).evaluate(h=>{
      h.dispatchEvent(new WheelEvent('wheel',{deltaY:-1}));h.scrollTop-=120;h.dispatchEvent(new Event('scroll'));
    });
    const outerOnly=await metrics(mobile);assert.equal(outerOnly.inner,outerOnly.base);
    await command(page,"printf 'OUTER-ANCHOR-1\\nOUTER-ANCHOR-2\\nOUTER-ANCHOR-3\\n'");
    await wait(async()=>(await snapshot(mobile)).text.includes('OUTER-ANCHOR-3'),'outer-scroll output parsed');await sleep(150);
    after=await metrics(mobile);assert.equal(after.inner,outerOnly.inner);assert.equal(after.outer,outerOnly.outer);
    await mobile.getByRole('button',{name:'回到输入位置',exact:true}).click();await visible(mobile,'outer anchor return');
    assert.deepEqual(grid(await state()),desktopGrid);
    report('viewportHistory',{wheel:true,newOutputPreservesPosition:true,outerOnlyBufferAnchor:true,tabSwitch:true,softRefresh:true,returnButton:true,typingResumes:true});

    // Vim uses the same full grid. Follow the real cursor rather than the
    // physical bottom of a screen full of blank rows.
    const file=path.join(dir,'viewport-vim.txt');fs.writeFileSync(file,Array.from({length:150},(_,i)=>`line ${i+1}`).join('\n')+'\n');
    await command(page,`vim -Nu NONE -n -i NONE +150 '${file}'`);
    await wait(async()=>(await snapshot(mobile)).type==='alternate','Vim shared alternate screen');
    await visible(mobile,'Vim bottom cursor');
    await page.keyboard.type('gg');await wait(async()=>(await snapshot(mobile)).cursor[1]===0,'Vim top cursor');
    const top=await visible(mobile,'Vim top row');assert(top.outer<2);
    await page.keyboard.type('G');await visible(mobile,'Vim returns to last row');
    await page.keyboard.type('i');await mobile.locator(host+' .xterm-helper-textarea').focus();
    await mobile.keyboard.insertText('移动端🙂');await visible(mobile,'Vim phone insertion');
    await mobile.keyboard.press('Escape');await mobile.keyboard.type(':wq');await mobile.keyboard.press('Enter');
    await wait(()=>fs.readFileSync(file,'utf8').includes('移动端🙂'),'Vim input saved');
    await wait(async()=>(await snapshot(mobile)).type==='normal','normal screen restored');await visible(mobile,'shell after Vim');
    report('viewportVim',{fullGrid:true,topCursor:true,bottomCursor:true,mobileInput:true,saved:true});

    // Native zoom changes the visual viewport, not application placement or
    // PTY dimensions. A separate page below controls keyboard animation.
    const cdp=await mobileContext.newCDPSession(mobile), beforeZoom=await mobile.locator('.app').boundingBox();
    await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});await sleep(300);
    assert.deepEqual(grid(await state()),desktopGrid);
    assert.equal((await mobile.locator('.app').boundingBox()).height,beforeZoom.height);
    await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});await visible(mobile,'after native zoom');
    await mobile.screenshot({path:path.join(dir,'viewport-mobile-live.png')});

    keyboardContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    await keyboardContext.addCookies(await context.cookies());await keyboardContext.addInitScript(installInspection);
    await keyboardContext.addInitScript(()=>{
      const vv=Object.assign(new EventTarget(),{height:844,width:390,offsetTop:0,offsetLeft:0,scale:1});
      Object.defineProperty(window,'visualViewport',{value:vv});window.viewportProbe=vv;
    });
    const keyboard=await keyboardContext.newPage();keyboard.on('pageerror',e=>errors.push(e.stack));
    await keyboard.goto(hub,{waitUntil:'domcontentloaded'});await ready(keyboard);
    await keyboard.locator(host+' .xterm-helper-textarea').focus();
    for(const [height,top] of [[600,0],[450,30],[380,70]]){
      await keyboard.evaluate(({height,top})=>{Object.assign(window.viewportProbe,{height,offsetTop:top});window.viewportProbe.dispatchEvent(new Event('resize'));window.viewportProbe.dispatchEvent(new Event('scroll'));},{height,top});
      await sleep(80);
    }
    await keyboard.locator('.terminal-mobile-keys').waitFor();
    const withKeys=await visible(keyboard,'cursor above keyboard and strip');
    assert.equal(withKeys.viewportTop,70);assert(withKeys.keysTop>=withKeys.bottom-1);
    await keyboard.locator('.terminal-mobile-keys').getByRole('button',{name:'Home',exact:true}).click();
    await visible(keyboard,'shortcut input visible');
    await keyboard.mouse.move(180,180);await keyboard.mouse.wheel(0,-250);
    await keyboard.getByRole('button',{name:'回到输入位置',exact:true}).click();
    await wait(async()=>{const m=await metrics(keyboard);return m.following==='true'&&m.keysTop!==undefined;},'Hub return retains keyboard focus');
    await visible(keyboard,'Hub return above shortcuts');
    await keyboard.screenshot({path:path.join(dir,'viewport-mobile-keyboard.png')});
    assert.deepEqual(grid(await state()),desktopGrid);
    await keyboard.evaluate(()=>{Object.assign(window.viewportProbe,{height:844,offsetTop:0});window.viewportProbe.dispatchEvent(new Event('resize'));});
    await keyboard.locator('.terminal-mobile-keys').waitFor({state:'hidden'});await visible(keyboard,'keyboard close');
    report('viewportKeyboard',{pannedTop:70,animatedResize:true,stripReservesHeight:true,cursorAboveStrip:true,shortcut:true,close:true,nativeZoom:true,desktopGridUnchanged:true});

    // Direct GoTTY and Hub are two renderers of the same session. The IME
    // textarea is synchronized to the rendered cursor cell by xterm itself.
    const direct=await keyboardContext.newPage();direct.on('pageerror',e=>errors.push(e.stack));
    await direct.goto(device.url,{waitUntil:'domcontentloaded'});await direct.locator('#terminal[data-replay-active=false]').waitFor();
    await direct.locator('.xterm-helper-textarea').focus();
    const directVisible=()=>direct.evaluate(()=>{
      const h=document.querySelector('#terminal'), r=h.getBoundingClientRect(), cursor=h.querySelector('.xterm-helper-textarea').getBoundingClientRect();
      const keys=document.querySelector('#gotty-mobile-keys:not([hidden])')?.getBoundingClientRect();
      return {visible:cursor.top>=r.top-1&&cursor.bottom<=r.bottom+1&&cursor.top>=visualViewport.offsetTop-1&&cursor.bottom<=visualViewport.offsetTop+visualViewport.height+1&&(keys===undefined||cursor.bottom<=keys.top+1),outer:h.scrollTop,following:h.dataset.viewportFollowing,
        top:r.top,bottom:r.bottom,cursorTop:cursor.top,cursorBottom:cursor.bottom,scrollHeight:h.scrollHeight,clientHeight:h.clientHeight,
        innerScroll:h.querySelector('.xterm').scrollTop,screen:h.querySelector('.xterm-screen').getBoundingClientRect().height,
        viewport:[visualViewport.offsetTop,visualViewport.height],style:h.getAttribute('style'),keys:keys?.top,focused:document.activeElement===h.querySelector('.xterm-helper-textarea')};
    });
    report('viewportDirectInitial',await directVisible());
    await wait(async()=>(await directVisible()).visible,'direct cursor cell visible');
    await direct.evaluate(()=>{Object.assign(window.viewportProbe,{height:380,offsetTop:70});window.viewportProbe.dispatchEvent(new Event('resize'));window.viewportProbe.dispatchEvent(new Event('scroll'));});
    await direct.locator('#gotty-mobile-keys:not([hidden])').waitFor();await wait(async()=>(await directVisible()).visible,'direct cursor above keyboard');
    report('viewportDirectKeyboard',await directVisible());
    await direct.mouse.move(180,200);await direct.mouse.wheel(0,-300);
    await direct.locator('.gotty-return-input:not([hidden])').waitFor();
    await direct.locator('.gotty-return-input').click();await sleep(250);report('viewportDirectReturn',await directVisible());
    await wait(async()=>{const m=await directVisible();return m.visible&&m.following==='true'&&m.keys!==undefined&&m.focused;},'direct return to input');
    await direct.screenshot({path:path.join(dir,'viewport-direct-keyboard.png')});
    assert.deepEqual(grid(await state()),desktopGrid);
    report('viewportStandalone',{sharedGrid:true,lastRowVisible:true,keyboard:true,returnButton:true,desktopUnchanged:true});
    await direct.close();
  } finally {await keyboardContext?.close();await mobileContext.close();}
};

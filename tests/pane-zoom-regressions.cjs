// Manual, remote-isolation browser regression; never invoked by GitHub Actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomBytes} = require('node:crypto');

module.exports = async ({page,context,browser,hub,ids,api,wait,dir,report,installInspection,errors}) => {
  const [a,b,c,d] = ids;
  const group = 'split-'+randomBytes(16).toString('hex');
  const original = await api('/me/workspace');
  await api('/me/workspace',{revision:original.revision,writeId:randomBytes(16).toString('hex'),
    units:[{id:group,members:[a,b,c,d]},...original.units.filter(unit=>!ids.slice(0,4).includes(unit.id))]},'PUT');
  const slot = (target,id=a) => target.locator('.terminal-slot[data-instance-id="'+id+'"]');
  const zoom = target => target.locator('[data-pane-zoomed=true]');
  const badge = (target,id=a) => slot(target,id).locator('.pane-identity');
  const snapshot = (target,id=a) => target.evaluate(id=>{
    const terminals=[...document.querySelectorAll('.real-terminal')];
    return window.reviewSnapshot(terminals.findIndex(node=>node.closest('.terminal-slot').dataset.instanceId===id));
  },id);
  const ready = (target,id=a) => wait(async()=>(await snapshot(target,id))?.pending===0
    &&await slot(target,id).locator('.terminal-clear-control').isEnabled(),'ready '+id);
  const openGroup = async target => {
    const tab=target.locator('.session-tab[data-tab-id="'+group+'"] .tab-trigger');
    await tab.waitFor();await tab.click();
    await wait(async()=>await target.locator('.terminal-slot:not([hidden])').count()===4,'four grid panes');
    await ready(target);
  };
  const type = async (target,text,id=a) => {await slot(target,id).locator('.xterm-helper-textarea').focus();await target.keyboard.type(text);};
  const command = async (target,text,id=a) => {await type(target,text,id);await target.keyboard.press('Enter');};
  const enlarged = async target => {
    await zoom(target).waitFor();
    await wait(()=>target.evaluate(()=>document.activeElement?.matches('.xterm-helper-textarea')
      &&!!document.activeElement.closest('[data-pane-zoomed=true]')),'enlarged terminal input focus');
  };
  const restored = async target => {
    await wait(async()=>await zoom(target).count()===0&&await target.locator('.pane-zoom-backdrop,.pane-zoom-close').count()===0,'restore grid');
    assert.equal(await target.locator('.workspace-bar').getAttribute('inert'),null);
  };
  const dismissBounds = target => target.locator('.pane-zoom-close').evaluate(button=>{
    const box=button.getBoundingClientRect(),pane=button.closest('.terminal-slot').getBoundingClientRect(),v=visualViewport;
    const background=getComputedStyle(button,'::before').backgroundColor,foreground=getComputedStyle(button).color;
    const color=value=>{const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3);};
    return {x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom,
      pane:{x:pane.x,y:pane.y,width:pane.width,height:pane.height},
      viewport:{x:v.offsetLeft,y:v.offsetTop,width:v.width,height:v.height},
      background,foreground,backgroundRGB:color(background),foregroundRGB:color(foreground),
      hit:button.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))};
  });
  const assertDismissBounds = geometry => {
    assert(geometry.width>=44&&geometry.height>=44,'dismiss target is too small');
    assert(geometry.y>=geometry.viewport.y&&geometry.x>=geometry.viewport.x,'dismiss button above/outside viewport');
    assert(geometry.right<=geometry.viewport.x+geometry.viewport.width+1&&geometry.bottom<=geometry.viewport.y+geometry.viewport.height+1,'dismiss button clipped');
    assert(geometry.bottom<geometry.pane.y,'dismiss button overlaps terminal content');
    assert(geometry.hit,'dismiss button is not reachable');
  };

  await openGroup(page);
  for(const id of [a,b,c,d])await ready(page,id);
  const saved = await api('/me/workspace');
  const writes=[];
  page.on('request',request=>{if(request.method()==='PUT'&&/\/me\/(workspace|preferences|terminal-settings)$/.test(new URL(request.url()).pathname))writes.push(request.url());});
  const file=path.join(dir,'zoom-vim.txt'),escapeFile=path.join(dir,'zoom-escape.txt');
  await command(page,'vim -Nu NONE -n '+file);
  await wait(async()=>(await snapshot(page))?.type==='alternate','Vim alternate buffer');
  await page.keyboard.press('i');await page.keyboard.insertText('pane-zoom-unsaved');
  await wait(async()=>(await snapshot(page))?.text.includes('pane-zoom-unsaved'),'unsaved Vim text');
  await command(page,'for n in $(seq 1 30); do printf "zoom-background-%s\\n" "$n"; sleep .2; done',b);
  await page.evaluate(()=>{
    window.zoomOriginal={panes:[...document.querySelectorAll('.terminal-slot:not([hidden])')].map(pane=>({id:pane.dataset.instanceId,box:pane.getBoundingClientRect().toJSON(),host:pane.querySelector('.xterm-host'),term:pane.querySelector('.xterm')})),sockets:window.reviewSockets.filter(socket=>socket.readyState===1)};
  });
  await badge(page).click();await enlarged(page);
  const desktopGeometry=await dismissBounds(page);assertDismissBounds(desktopGeometry);
  assert(desktopGeometry.pane.width>1000&&desktopGeometry.pane.height>600,'panel did not use the desktop viewport');
  assert.equal(await zoom(page).getAttribute('role'),'dialog');
  assert.equal(await zoom(page).getAttribute('aria-modal'),'true');
  assert.notEqual(await page.locator('.workspace-bar').getAttribute('inert'),null);
  assert.equal(await page.locator('.terminal-slot[inert]:not([hidden])').count(),3);
  const backdrop=await page.locator('.pane-zoom-backdrop').evaluate(node=>getComputedStyle(node).backdropFilter||getComputedStyle(node).webkitBackdropFilter);
  assert.match(backdrop,/blur\(8px\)/);
  assert(desktopGeometry.backgroundRGB.every(channel=>channel>200),'dismiss background must remain light');
  assert(desktopGeometry.foregroundRGB.every(channel=>channel<80),'dismiss icon needs a dark foreground');
  assert(await page.evaluate(id=>{
    const other=window.zoomOriginal.panes.filter(pane=>pane.id!==id);
    return other.every(pane=>{const now=document.querySelector('.terminal-slot[data-instance-id="'+pane.id+'"]').getBoundingClientRect();return ['x','y','width','height'].every(key=>Math.abs(now[key]-pane.box[key])<1);});
  },a),'background grid shifted during zoom');
  await wait(async()=>(await snapshot(page,b))?.text.includes('zoom-background-3'),'background output while modal');
  await page.keyboard.press('Escape');
  assert.equal(await zoom(page).count(),1,'Escape must not restore the grid');
  await page.keyboard.type(":call writefile(['terminal-escape-ok'], '"+escapeFile+"')");await page.keyboard.press('Enter');
  await wait(()=>fs.existsSync(escapeFile)&&fs.readFileSync(escapeFile,'utf8').includes('terminal-escape-ok'),'Escape reached Vim');
  assert.match(fs.readFileSync(escapeFile,'utf8'),/terminal-escape-ok/);
  await page.keyboard.press('A');await page.keyboard.insertText('-enlarged');
  await page.screenshot({path:path.join(dir,'pane-zoom-desktop.png')});
  await page.locator('.pane-zoom-close').click();await restored(page);
  await wait(()=>page.evaluate(id=>document.activeElement?.closest('.terminal-slot')?.dataset.instanceId===id,a),'restored input focus');
  await page.keyboard.insertText('-restored');await page.keyboard.press('Escape');
  await page.keyboard.type(':wq');await page.keyboard.press('Enter');
  await wait(()=>fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes('pane-zoom-unsaved-enlarged-restored'),'Vim save after restore');
  assert.match(fs.readFileSync(file,'utf8'),/pane-zoom-unsaved-enlarged-restored/);
  assert(await page.evaluate(()=>window.zoomOriginal.panes.every(pane=>pane.host===document.querySelector('.terminal-slot[data-instance-id="'+pane.id+'"] .xterm-host')
    &&pane.term===document.querySelector('.terminal-slot[data-instance-id="'+pane.id+'"] .xterm'))&&window.zoomOriginal.sockets.every(socket=>socket.readyState===1)),'zoom remounted a terminal or reconnected a socket');

  // The label is a toggle, and the backdrop must not activate the underlying tab.
  await badge(page).click();await enlarged(page);await badge(page).click();await restored(page);
  await badge(page).focus();await page.keyboard.press('Enter');await enlarged(page);
  await page.mouse.click(4,10);await restored(page);
  assert.equal(await page.locator('.terminal-slot[data-focused=true]').getAttribute('data-instance-id'),a);
  await badge(page).click();await enlarged(page);
  await slot(page).locator('.terminal-connections').click();
  await page.getByRole('dialog',{name:'分享管理',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog',{name:'分享管理',exact:true}).waitFor({state:'hidden'});
  assert.equal(await zoom(page).count(),1,'nested Escape dismissed the parent zoom');
  await page.locator('.pane-zoom-close').focus();await page.keyboard.press('Enter');await restored(page);
  assert.deepEqual(await api('/me/workspace'),saved,'zoom changed the persisted layout');
  assert.deepEqual(writes,[],'zoom wrote account preferences');

  // A real paste keeps running as its global controls enter/leave the modal scope.
  const capture=path.join(dir,'zoom-paste.py'),pasteFile=path.join(dir,'zoom-paste.bin');
  fs.writeFileSync(capture,String.raw`import os, sys, termios, tty
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
data = bytearray()
try:
    tty.setraw(fd)
    os.write(1, b'\x1b[?2004hZOOM_PASTE_READY\r\n')
    while b'\x1b[201~' not in data:
        data.extend(os.read(fd, 4096))
    with open(sys.argv[1], 'wb') as output:
        output.write(data[6:data.find(b'\x1b[201~')])
finally:
    termios.tcsetattr(fd, termios.TCSANOW, old)
    os.write(1, b'\x1b[?2004lZOOM_PASTE_DONE\r\n')
`);
  await command(page,'python3 '+capture+' '+pasteFile);
  await wait(async()=>(await snapshot(page))?.text.includes('ZOOM_PASTE_READY'),'paste capture');
  await page.evaluate(id=>{
    const socket=window.reviewSockets.findLast(socket=>socket.readyState===1&&socket.url.includes(id)),receive=socket.onmessage;
    window.zoomPasteHeld=[];
    socket.onmessage=event=>{let data=String(event.data);if(data[0]==='c')data=JSON.parse(data.slice(1)).data;
      if(data[0]==='e'&&['writing','done'].includes(JSON.parse(data.slice(1)).status))window.zoomPasteHeld.push(()=>receive.call(socket,event));
      else receive.call(socket,event);
    };
    window.finishZoomPaste=()=>{socket.onmessage=receive;window.zoomPasteHeld.splice(0).forEach(deliver=>deliver());};
  },a);
  await badge(page).click();await enlarged(page);
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:hub});
  await page.evaluate(()=>navigator.clipboard.writeText('large paste while enlarged '.repeat(50000)));
  await slot(page).locator('.xterm-helper-textarea').focus();await page.keyboard.press('Control+Shift+V');
  const progress=page.locator('.terminal-paste-card');
  await wait(()=>page.evaluate(()=>window.zoomPasteHeld.length===8),'bounded pending paste');
  await progress.getByRole('button',{name:'停止',exact:true}).focus();
  assert(await progress.getByRole('button',{name:'停止',exact:true}).evaluate(button=>button===document.activeElement),'paste controls excluded from modal focus');
  await page.locator('.pane-zoom-close').click();await restored(page);
  assert.equal(await progress.getAttribute('data-paste-status'),'running','restoring stopped a paste');
  await badge(page).click();await enlarged(page);
  await progress.getByRole('button',{name:'停止',exact:true}).focus();await page.keyboard.press('Enter');
  await wait(async()=>await progress.getAttribute('data-paste-status')==='cancelled','cancel paste inside zoom');
  await progress.getByRole('button',{name:'关闭',exact:true}).focus();await page.keyboard.press('Enter');
  await progress.waitFor({state:'hidden'});assert.equal(await zoom(page).count(),1);
  await page.evaluate(()=>window.finishZoomPaste());
  await wait(()=>fs.existsSync(pasteFile)&&fs.statSync(pasteFile).size>0,'cancelled paste written to PTY');
  await wait(async()=>(await snapshot(page))?.text.includes('ZOOM_PASTE_DONE'),'paste capture cleanup');
  await page.locator('.pane-zoom-close').click();await restored(page);

  await command(page,'for n in $(seq 1 500); do printf "ZOOM_HISTORY_%04d\\n" "$n"; done');
  await wait(async()=>(await snapshot(page))?.text.includes('ZOOM_HISTORY_0500'),'history output');
  const host=slot(page).locator('.xterm-host'),area=await host.boundingBox();
  await page.mouse.move(area.x+40,area.y+area.height/2);await page.mouse.wheel(0,-3000);
  await wait(async()=>await host.getAttribute('data-viewport-following')==='false','pause history following');
  const historyLine=()=>page.evaluate(id=>{
    const nodes=[...document.querySelectorAll('.real-terminal')],index=nodes.findIndex(node=>node.closest('.terminal-slot').dataset.instanceId===id);
    const term=window.reviewTerm(index),host=nodes[index].querySelector('.xterm-host');
    const row=term.buffer.active.viewportY+Math.floor(host.scrollTop/term._core._renderService.dimensions.css.cell.height);
    return term.buffer.active.getLine(row)?.translateToString(true);
  },a);
  const anchor=await historyLine();assert.match(anchor,/ZOOM_HISTORY_\d+/);
  await badge(page).click();await enlarged(page);
  await wait(async()=>await historyLine()===anchor,'history anchor after enlargement');
  assert.equal(await host.getAttribute('data-viewport-following'),'false');
  await page.locator('.pane-zoom-close').click();await restored(page);
  await wait(async()=>await historyLine()===anchor,'history anchor after restoration');
  assert.equal(await host.getAttribute('data-viewport-following'),'false');
  await slot(page).getByRole('button',{name:'回到输入位置',exact:true}).click();

  // Tablet touch, visual keyboard and small-screen fallback use real renderers.
  const tablet=await browser.newContext({viewport:{width:744,height:1133},hasTouch:true,isMobile:true});
  await tablet.addCookies(await context.cookies(hub));await tablet.addInitScript(installInspection);
  const touch=await tablet.newPage();touch.on('pageerror',error=>errors.push(error.stack));
  await touch.goto(hub,{waitUntil:'domcontentloaded'});await openGroup(touch);
  await badge(touch).tap();await enlarged(touch);assertDismissBounds(await dismissBounds(touch));
  await touch.screenshot({path:path.join(dir,'pane-zoom-tablet.png')});
  await touch.evaluate(()=>{
    Object.defineProperty(visualViewport,'height',{configurable:true,value:320});
    Object.defineProperty(visualViewport,'offsetTop',{configurable:true,value:90});
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await wait(async()=>{
    const box=await zoom(touch).boundingBox();
    return box.y>=90&&box.height>150&&box.y+box.height<=410;
  },'keyboard-safe zoom dimensions');
  assertDismissBounds(await dismissBounds(touch));
  await touch.locator('.pane-zoom-close').tap();await restored(touch);
  await touch.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'));});
  await badge(touch).tap();await enlarged(touch);
  for(const width of [320,375,414]){
    await touch.setViewportSize({width,height:844});
    await restored(touch);
    assert.equal(await touch.locator('.pane-identity').count(),0);
    assert.equal(await touch.locator('.terminal-slot:not([hidden])').count(),1);
    assert(await touch.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'phone has horizontal page overflow');
  }
  await touch.setViewportSize({width:768,height:1024});await openGroup(touch);
  assert.equal(await zoom(touch).count(),0,'small-screen transition retained zoom state');
  await tablet.close();

  let webkitVerified=false;
  if(process.env.WEBKIT_EXECUTABLE){
    const {webkit}=require(process.env.PLAYWRIGHT_MODULE||'../frontend/node_modules/playwright-core');
    const engine=await webkit.launch({headless:true,executablePath:process.env.WEBKIT_EXECUTABLE,env:process.env});
    try{
      const tablet=await engine.newContext({viewport:{width:768,height:1024},hasTouch:true,isMobile:true});
      await tablet.addCookies(await context.cookies(hub));await tablet.addInitScript(installInspection);
      const target=await tablet.newPage();target.on('pageerror',error=>errors.push(error.stack));
      await target.goto(hub,{waitUntil:'domcontentloaded'});await target.bringToFront();await openGroup(target);
      await target.evaluate(()=>{window.zoomFocusTrace=[];document.addEventListener('focusin',event=>window.zoomFocusTrace.push({tag:event.target.tagName,classes:event.target.className,id:event.target.closest?.('.terminal-slot')?.dataset.instanceId,at:performance.now()}),true);});
      await badge(target).tap();
      try{await enlarged(target);}catch(error){
        fs.writeFileSync(path.join(dir,'webkit-focus.json'),JSON.stringify(await target.evaluate(()=>({focus:document.activeElement.outerHTML,documentFocused:document.hasFocus(),trace:window.zoomFocusTrace,dialogs:[...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=listbox]')].map(node=>({label:node.getAttribute('aria-label'),inPlace:node.dataset.inPlaceModal,exiting:!!node.closest('[data-exiting]')}))})),null,2));
        await target.screenshot({path:path.join(dir,'webkit-focus.png')});throw error;
      }
      assertDismissBounds(await dismissBounds(target));
      await target.keyboard.press('Escape');assert.equal(await zoom(target).count(),1);
      await target.screenshot({path:path.join(dir,'pane-zoom-webkit.png')});
      await target.locator('.pane-zoom-close').tap();await restored(target);
      await badge(target).tap();await enlarged(target);await badge(target).tap();await restored(target);
      webkitVerified=true;
    }finally{await engine.close();}
  }

  // Temporary state must not survive reload or an externally removed group.
  await badge(page).click();await enlarged(page);await page.reload({waitUntil:'domcontentloaded'});await openGroup(page);
  assert.equal(await zoom(page).count(),0,'reload restored temporary zoom');
  await badge(page).click();await enlarged(page);
  const latest=await api('/me/workspace');
  await api('/me/workspace',{revision:latest.revision,writeId:randomBytes(16).toString('hex'),units:latest.units.flatMap(unit=>unit.id===group?unit.members.map(id=>({id})):unit)},'PUT');
  await restored(page);assert.equal(await page.locator('.terminal-slot:not([hidden])').count(),1);
  assert.deepEqual(errors,[]);
  report('paneZoom',{desktop:true,tablet:true,closeOutside:true,labelToggle:true,backdrop:true,escapeToVim:true,nestedPopover:true,
    noLayoutWrites:true,stableNodesAndSockets:true,liveBackground:true,unsavedVim:true,pasteAcrossZoom:true,historyAnchor:true,keyboardSafe:true,phoneWidths:[320,375,414],webkit:webkitVerified,reload:true,groupRemoval:true,desktopGeometry});
};

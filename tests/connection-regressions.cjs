// Explicit SSH-only browser checks against disposable services. Never run in CI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function connectionRegression({page,context,browser,hub,ids,devices,directURL,wait,sleep,dir,report,installInspection,errors}) {
  const id=ids[0], endpoint=`/api/v1/terminal-connections/${id}/ws`;
  const host=`.terminal-slot[data-instance-id="${id}"] .xterm-host`;
  const ready=target=>wait(async()=>{
    const s=await target.evaluate(()=>window.reviewSnapshot());
    return s?.pending===0 && s.text.includes('bash-') && await target.locator(host).getAttribute('data-replay-active')==='false' && await target.locator('.terminal-slot:not([hidden]) .terminal-clear-control').isEnabled();
  },'connection initialized');
  const socketCount=target=>target.evaluate(endpoint=>window.reviewSockets.filter(s=>new URL(s.url).pathname===endpoint).length,endpoint);
  const command=async(target,text)=>{await target.locator(host+' .xterm-helper-textarea').focus();await target.keyboard.type(text);await target.keyboard.press('Enter');};
  const refresh=async target=>{
    await target.locator(`.session-tab[data-instance-id="${id}"] .tab-trigger`).click({button:'right'});
    await target.locator('.tab-actions-menu').getByRole('button',{name:'刷新',exact:true}).click();
  };
  const makeContext=async(engine,options={})=>{
    const value=await engine.newContext({viewport:{width:1024,height:768},...options});
    await value.addCookies(await context.cookies());await value.addInitScript(installInspection);return value;
  };
  const attach=target=>target.on('pageerror',error=>errors.push(error.stack));
  const restrictSocket=target=>target.evaluate(hub=>{
    const meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';
    meta.content=`connect-src ${hub}/api/v1/me ${hub}/api/v1/me/ ${hub}/api/v1/instances ${hub}/api/v1/instances/ ${hub}/api/v1/events`;
    document.head.appendChild(meta);
  },hub);
  const csp=(await page.request.get(hub)).headers()['content-security-policy'];
  const authority=new URL(hub).host;
  assert(csp.includes(`connect-src 'self' ws://${authority} wss://${authority}`));
  assert(!csp.split(/\s+/).includes("'unsafe-eval'"));
  report('connectionCsp',{explicitAuthority:true,noWildcard:true});

  const slowContext=await makeContext(browser), slow=await slowContext.newPage();attach(slow);
  let release, requests=0;
  const gate=new Promise(resolve=>{release=resolve;});
  try {
    await slow.route(`**/api/v1/instances/${id}/terminal-tickets`,async route=>{requests++;await gate;await route.continue();});
    await slow.goto(hub,{waitUntil:'domcontentloaded'});
    await wait(()=>requests===1,'delayed ticket request');
    await slow.evaluate(()=>{window.dispatchEvent(new Event('pageshow'));window.dispatchEvent(new Event('online'));});
    await sleep(5500);
    assert.equal(await socketCount(slow),0,'socket opened before ticket was available');
    assert.equal(requests,1,'lifecycle events duplicated a pending authorization');
    release();await ready(slow);assert.equal(await socketCount(slow),1);
    await command(slow,"printf 'SLOW-TICKET-%s\\n' OK");
    await wait(async()=>(await slow.evaluate(()=>window.reviewSnapshot())).text.includes('SLOW-TICKET-OK'),'input after slow authorization');
    await slow.evaluate(()=>{window.dispatchEvent(new Event('pageshow'));window.dispatchEvent(new Event('online'));});
    await sleep(3400);assert.equal(await socketCount(slow),1,'resume probe closed a healthy connection');
    // A soft reconnect retains committed output and can accept input again.
    await slow.evaluate(endpoint=>window.reviewSockets.find(s=>new URL(s.url).pathname===endpoint&&s.readyState===1).close(),endpoint);
    await wait(async()=>(await socketCount(slow))===2,'ordinary disconnect recovery');await ready(slow);
    assert((await slow.evaluate(()=>window.reviewSnapshot())).text.includes('SLOW-TICKET-OK'));
    await command(slow,"printf 'RECOVERED-%s\\n' OK");
    await wait(async()=>(await slow.evaluate(()=>window.reviewSnapshot())).text.includes('RECOVERED-OK'),'input after reconnect');
    report('connectionSlowAuthorization',{delayMs:5500,socketCreatedAfterTicket:true,pendingResumeSafe:true,healthyResumeSafe:true,historyRetained:true,inputRecovered:true});
  } finally {release();await slowContext.close();}

  const blockedContext=await makeContext(browser), blocked=await blockedContext.newPage();attach(blocked);
  try {
    await blocked.goto(hub,{waitUntil:'domcontentloaded'});await ready(blocked);
    const before=await socketCount(blocked);
    // Restrict only the WS endpoint after login. HTTP diagnostics/tickets stay
    // reachable, so a failed HTTP login cannot masquerade as this regression.
    await restrictSocket(blocked);
    await refresh(blocked);
    await wait(async()=>/浏览器安全策略阻止|browser security policy/.test(await blocked.locator('.terminal-message').innerText()),'explicit CSP diagnostic');
    const after=await socketCount(blocked);assert(after<=before+1);
    await blocked.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('pageshow'));document.dispatchEvent(new Event('resume'));});
    await sleep(6500);assert.equal(await socketCount(blocked),after,'permanent CSP error kept reconnecting');
    assert.match(await blocked.locator('.terminal-message').innerText(),/已停止自动重连|Automatic reconnect stopped/);
    await refresh(blocked);
    await wait(async()=>(await socketCount(blocked))>after,'manual refresh retries CSP-blocked connection');
    await blocked.screenshot({path:path.join(dir,'connection-policy-diagnostic.png')});
    report('connectionPolicyFailure',{realBrowserViolation:true,actionableMessage:true,automaticRetryStopped:true,lifecycleCannotBypass:true,manualRetry:true});
  } finally {await blockedContext.close();}

  if(process.env.WEBKIT_EXECUTABLE){
    const {webkit}=require(process.env.PLAYWRIGHT_MODULE||'../frontend/node_modules/playwright-core');
    const engine=await webkit.launch({headless:true,executablePath:process.env.WEBKIT_EXECUTABLE,env:{...process.env}});
    let tabletContext;
    try {
      tabletContext=await makeContext(engine,{viewport:{width:1024,height:768},isMobile:true,hasTouch:true,deviceScaleFactor:2});
      const tablet=await tabletContext.newPage();attach(tablet);
      await tablet.goto(hub,{waitUntil:'domcontentloaded'});await ready(tablet);
      await command(tablet,"printf 'WEBKIT-TABLET-%s\\n' OK");
      await wait(async()=>(await tablet.evaluate(()=>window.reviewSnapshot())).text.includes('WEBKIT-TABLET-OK'),'WebKit tablet input');
      await tablet.evaluate(()=>{window.dispatchEvent(new Event('pageshow'));window.dispatchEvent(new Event('online'));});
      await sleep(3400);assert.equal(await socketCount(tablet),1);
      await refresh(tablet);await wait(async()=>(await socketCount(tablet))===2,'WebKit refresh');await ready(tablet);
      assert((await tablet.evaluate(()=>window.reviewSnapshot())).text.includes('WEBKIT-TABLET-OK'));
      const direct=await tabletContext.newPage();attach(direct);
      await direct.goto(directURL,{waitUntil:'domcontentloaded'});await direct.locator('#terminal[data-replay-active=false]').waitFor();
      const marker=path.join(dir,'direct-webkit-ok');
      await direct.locator('.xterm-helper-textarea').focus();await direct.keyboard.type(`printf 'DIRECT-WEBKIT-%s\\n' OK > '${marker}'`);await direct.keyboard.press('Enter');
      await wait(()=>fs.readFileSync(marker,'utf8')==='DIRECT-WEBKIT-OK\n','direct GoTTY WebKit input');
      await tablet.screenshot({path:path.join(dir,'connection-webkit-tablet.png')});
      await restrictSocket(tablet);await refresh(tablet);
      await wait(async()=>/浏览器安全策略阻止|browser security policy/.test(await tablet.locator('.terminal-message').innerText()),'WebKit CSP diagnostic');
      const count=await socketCount(tablet);
      await tablet.evaluate(()=>{window.dispatchEvent(new Event('pageshow'));window.dispatchEvent(new Event('online'));});
      await sleep(3400);assert.equal(await socketCount(tablet),count);
      report('connectionWebKit',{tabletTouch:true,hubInput:true,resume:true,refresh:true,historyRetained:true,directInput:true,policyRetryStopped:true,physicalIPad:false});
    } finally {await tabletContext?.close();await engine.close();}
  }
};

const fs=require('node:fs');const assert=require('node:assert/strict');
const {chromium}=require('../frontend/node_modules/@playwright/test');
const hub=process.env.HUB_TEST_URL||'http://127.0.0.1:8088';
const gotty=process.env.GOTTY_TEST_URL||'http://127.0.0.1:8091';
const maildir=process.env.HUB_TEST_MAIL||'/tmp/gotty-hub-e2e-mail';
const state=process.env.GOTTY_TEST_STATE||'/tmp/gotty-hub-device/hub.json';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function mail(to,purpose){for(let i=0;i<100;i++){for(const name of (fs.existsSync(maildir)?fs.readdirSync(maildir).sort((a,b)=>parseInt(b)-parseInt(a)):[])){const v=JSON.parse(fs.readFileSync(`${maildir}/${name}`));if(v.to===to&&v.text.includes(`Hub ${purpose}:`))return v.text.match(/: (\d{6})/)[1]}await sleep(100)}throw Error('mail timeout')}
async function request(url,body,headers={},method='POST'){const r=await fetch(url,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();if(!r.ok)throw Error(`${r.status} ${text}`);return text?JSON.parse(text):null}
(async()=>{
 const admin=fs.readFileSync(state+'.admin','utf8').trim();const local={'X-GoTTY-Hub-Admin':admin};
 let binding=fs.existsSync(state)?JSON.parse(fs.readFileSync(state)):{};
 if(!binding.instance_id){
  await request(gotty+'/-/hub',{Action:'enroll',URL:hub,Name:'integration-terminal',Email:'owner@example.test'},local);
  await sleep(1200);const code=await mail('owner@example.test','enrollment');
  await request(gotty+'/-/hub',{Action:'confirm',Code:code},local);
 }
 for(let i=0;i<100;i++){binding=await request(gotty+'/-/hub',undefined,local,'GET');if(binding.online)break;await sleep(200)}assert(binding.online);
 const browser=await chromium.launch();const page=await browser.newPage({locale:'zh-CN'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let output='';page.on('websocket',ws=>ws.on('framereceived',({payload})=>{const s=String(payload);if(s[0]==='1')output+=Buffer.from(s.slice(1),'base64').toString('utf8')}));
 await page.goto(hub);await page.getByRole('textbox',{name:'邮箱',exact:true}).fill('owner@example.test');await page.getByRole('button',{name:'获取验证码',exact:true}).click();
 await sleep(1200);await page.getByLabel('邮箱验证码',{exact:true}).fill(await mail('owner@example.test','login'));await page.getByRole('button',{name:'验证并登录',exact:true}).click();
 await page.locator('.xterm-helper-textarea').waitFor({state:'attached'});for(let i=0;i<100&&!output.length;i++)await sleep(100);assert(output.length,'PTY not ready');await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type("printf '\\110\\125\\102\\137\\117\\113\\012'");await page.keyboard.press('Enter');
 for(let i=0;i<100&&!output.includes('HUB_OK');i++)await sleep(100);
 assert(output.includes('HUB_OK'),'real PTY roundtrip missing');
 // Real rz/sz run inside the remote PTY; no local file proxy is involved.
 await page.keyboard.type('rz -y');await page.keyboard.press('Enter');
 await page.getByRole('heading',{name:'文件传输',exact:true}).waitFor();
 await page.locator('input[type=file]').setInputFiles({name:'hub-transfer.txt',mimeType:'text/plain',buffer:Buffer.from('HUB_TRANSFER_CONTENT\n')});
 await page.getByRole('button',{name:'开始',exact:true}).click();
 await page.getByRole('heading',{name:'文件传输',exact:true}).waitFor({state:'hidden'});
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('sz hub-transfer.txt');await page.keyboard.press('Enter');
 await page.getByRole('heading',{name:'文件传输',exact:true}).waitFor();
 const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'开始',exact:true}).click();
 const download=await downloaded;assert.equal(fs.readFileSync(await download.path(),'utf8'),'HUB_TRANSFER_CONTENT\n');
 await page.getByRole('heading',{name:'文件传输',exact:true}).waitFor({state:'hidden'});
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('rz -y');await page.keyboard.press('Enter');
 await page.getByRole('heading',{name:'文件传输',exact:true}).waitFor();await page.getByRole('button',{name:'取消',exact:true}).last().click();
 await page.getByRole('heading',{name:'文件传输',exact:true}).waitFor({state:'hidden'});
 const connected=page.locator('.session-tab .terminal-status');assert.equal(await connected.count(),1);
 await page.getByRole('button',{name:'关闭终端标签 integration-terminal',exact:true}).click();await sleep(1500);assert.equal(await page.locator('.session-tab').count(),0,'closed tab reopened by events');
 await sleep(800);await page.reload();await page.locator('.registered-instance').waitFor();await sleep(1500);assert.equal(await page.locator('.session-tab').count(),0,'closed workspace not restored');
 await page.getByRole('button',{name:'账号与安全',exact:true}).click();await page.getByText('有效登录会话:',{exact:false}).waitFor();await page.keyboard.press('Escape');
 await page.setViewportSize({width:375,height:812});await page.getByRole('button',{name:'打开实例导航',exact:true}).first().click();await page.locator('[role=dialog] .registered-instance').click();await page.locator('.xterm-helper-textarea').waitFor({state:'attached'});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'real mobile workspace overflows');
 await page.getByRole('button',{name:'最大化工作区',exact:true}).click();await page.getByRole('button',{name:'恢复工作区',exact:true}).waitFor();await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS enrollment, OTP, real xterm/PTY roundtrip, status, ZMODEM upload/download/cancel, tab close/restore, account sessions, mobile real terminal/maximize, runtime errors');
})().catch(e=>{console.error(e);process.exit(1)});

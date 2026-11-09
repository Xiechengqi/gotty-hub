const {assert,fs,hub,sleep,api,login}=require('./client.cjs');
const {chromium}=require('../frontend/node_modules/@playwright/test');
(async()=>{
 const owner=JSON.parse(fs.readFileSync(process.env.GOTTY_TEST_STATE+'.test-session'));
 const me=await api(owner,'/me');assert.equal(me.data.is_admin,true);
 const other=await login('non-admin@example.test');assert.equal((await api(other,'/me')).data.is_admin,false);
 for(const path of ['/admin/dashboard','/admin/logs','/admin/version','/admin/upgrade'])assert.equal((await api(other,path)).status,403,path);
 for(const path of ['/admin/restart','/admin/upgrade'])assert.equal((await api(other,path,{})).status,403,path);
 const stats=await api(owner,'/admin/dashboard');assert.equal(stats.status,200);assert(stats.data.users>=2&&stats.data.online===1);
 const logs=await api(owner,'/admin/logs');assert.equal(logs.status,200);assert(!logs.data.text.includes('test-key'));assert(logs.data.text.length<=140000);
 const browser=await chromium.launch();const context=await browser.newContext({locale:'zh-CN'});const [name,value]=owner.cookie.split('=');await context.addCookies([{name,value,url:hub}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(hub);await page.getByRole('button',{name:'账号与安全',exact:true}).click();await page.getByRole('button',{name:'管理后台',exact:true}).click();await page.getByRole('heading',{name:'管理后台',exact:true}).waitFor();await page.getByText('注册实例',{exact:true}).waitFor();
 await page.getByRole('button',{name:'系统日志',exact:true}).click();await page.getByText('最近 128 KiB',{exact:false}).waitFor();await page.setViewportSize({width:375,height:812});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'admin overflows mobile');
 await page.getByRole('button',{name:'升级与重启',exact:true}).click();await page.getByRole('button',{name:'重启系统',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).last().click();assert.equal(await page.getByRole('button',{name:'确认',exact:true}).count(),0);
 // Simulate an installed update: Linux /proc/self/exe now references a deleted inode.
 const binary=process.env.HUB_TEST_BINARY;fs.copyFileSync(binary,binary+'.new');fs.chmodSync(binary+'.new',0o755);fs.renameSync(binary+'.new',binary);
 await page.getByRole('button',{name:'重启系统',exact:true}).click();await page.getByRole('button',{name:'确认',exact:true}).click();await sleep(4500);
 let ready=false;for(let i=0;i<150;i++){try{const r=await api(owner,'/admin/dashboard');if(r.status===200&&r.data.online===1&&r.data.uptime_seconds<15){ready=true;break}}catch{}await sleep(100)}assert(ready,'admin restart failed to recover service and device');
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS admin role/denials, dashboard/log privacy, admin mobile UI, restart confirmation and atomic binary replacement + actual exec/reconnect');
})().catch(e=>{console.error(e);process.exit(1)});

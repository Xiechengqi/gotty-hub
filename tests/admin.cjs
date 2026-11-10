const {assert,fs,hub,sleep,api,login}=require('./client.cjs');
(async()=>{
 const owner=await login('admin');
 const me=await api(owner,'/me');assert.equal(me.data.is_admin,true);
 const other=await login('non-admin');assert.equal((await api(other,'/me')).data.is_admin,false);
 for(const path of ['/admin/dashboard','/admin/logs','/admin/version','/admin/upgrade'])assert.equal((await api(other,path)).status,403,path);
 for(const path of ['/admin/restart','/admin/upgrade'])assert.equal((await api(other,path,{})).status,403,path);
 const stats=await api(owner,'/admin/dashboard');assert.equal(stats.status,200);assert(stats.data.users>=2&&stats.data.online===1);
 const logs=await api(owner,'/admin/logs');assert.equal(logs.status,200);assert(!logs.data.text.includes(process.env.HUB_PASSWORD));assert(logs.data.text.length<=140000);
 // Simulate an installed update: Linux /proc/self/exe now references a deleted inode.
 const binary=process.env.HUB_TEST_BINARY;fs.copyFileSync(binary,binary+'.new');fs.chmodSync(binary+'.new',0o755);fs.renameSync(binary+'.new',binary);
 assert.equal((await api(owner,'/admin/restart',{})).status,200);await sleep(4500);
 let ready=false;for(let i=0;i<150;i++){try{const r=await api(owner,'/admin/dashboard');if(r.status===200&&r.data.online===1&&r.data.uptime_seconds<15){ready=true;break}}catch{}await sleep(100)}assert(ready,'admin restart failed to recover service and device');
 console.log('PASS admin role/denials, dashboard/log privacy and atomic binary replacement + actual exec/reconnect');
})().catch(e=>{console.error(e);process.exit(1)});

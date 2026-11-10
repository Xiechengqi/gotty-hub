const {assert,hub,sleep,login,api,connect}=require('./client.cjs');
const gotty=process.env.GOTTY_TEST_URL||'http://127.0.0.1:8091';
// GoTTY's local Hub binding endpoint, the same one its "接入 Hub" panel posts to.
async function bind(body){const r=await fetch(gotty+'/-/hub',{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body&&JSON.stringify(body)});return {status:r.status,data:await r.json()}}
(async()=>{
 const unknown=await bind({URL:hub,Username:'unknown-user'});
 assert.equal(unknown.status,404);assert.equal(unknown.data.error,'user_not_found');
 assert.equal((await bind()).data.instance_id,'','unknown user must not create a binding');
 const owner=await login('owner');
 const bound=await bind({URL:hub,Username:'owner'});
 assert.equal(bound.status,200,'GoTTY rejected the Hub binding');
 let binding;for(let i=0;i<100;i++){binding=(await bind()).data;if(binding.online)break;await sleep(200)}assert(binding.online&&binding.instance_id,'GoTTY did not connect to Hub');
 const {data:instances}=await api(owner,'/instances');assert.equal(instances.length,1);assert.equal(instances[0].id,binding.instance_id);
 let id;for(let i=0;i<100;i++){id=(await api(owner,'/instances')).data.find(x=>x.online)?.id;if(id)break;await sleep(100)}assert(id,'instance not online in Hub');
 const ticket=(await api(owner,`/instances/${id}/terminal-tickets`,{})).data.ticket;const ws=await connect(owner,id,ticket);
 let output='';ws.on('message',data=>{const s=String(data);if(s[0]==='1')output+=Buffer.from(s.slice(1),'base64').toString('utf8')});
 for(let i=0;i<100&&!output.length;i++)await sleep(100);assert(output.length,'PTY not ready');
 ws.send('1'+Buffer.from("printf '\\110\\125\\102\\137\\117\\113\\012'\n").toString('base64'));
 for(let i=0;i<100&&!output.includes('HUB_OK');i++)await sleep(100);assert(output.includes('HUB_OK'),'real PTY roundtrip missing');ws.close();
 const sessions=await api(owner,'/me/sessions');assert.equal(sessions.status,200);assert(sessions.data.sessions.length>=1);
 console.log('PASS GoTTY Hub binding API, unknown username, registration, password login, real PTY roundtrip, account sessions');
})().catch(e=>{console.error(e);process.exit(1)});

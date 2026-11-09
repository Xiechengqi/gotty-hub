const {fs,assert,WebSocket,hub,sleep,login,api,connect,closes}=require('./client.cjs');
const state=process.env.GOTTY_TEST_STATE;const sessionFile=state+'.test-session';const stage=process.argv[2];
(async()=>{
 let owner;if(fs.existsSync(sessionFile))owner=JSON.parse(fs.readFileSync(sessionFile));else{owner=await login('owner@example.test');fs.writeFileSync(sessionFile,JSON.stringify(owner),{mode:0o600})}
 let id;for(let i=0;i<300;i++){const rows=(await api(owner,'/instances')).data;id=rows.find(x=>x.online)?.id;if(id)break;await sleep(100)}assert(id,'device did not reconnect');
 const ticket=(await api(owner,`/instances/${id}/terminal-tickets`,{})).data.ticket;const ws=await connect(owner,id,ticket);await sleep(200);
 if(stage==='rotate'){
  const before=JSON.parse(fs.readFileSync(state)).credential;
  assert.equal((await api(owner,`/instances/${id}/credentials/rotate`,{})).status,200);await closes(ws);
  for(let i=0;i<100&&JSON.parse(fs.readFileSync(state)).credential===before;i++)await sleep(100);
  assert.notEqual(JSON.parse(fs.readFileSync(state)).credential,before);console.log('PASS credential rotation persisted and active streams revoked');
 }else if(stage==='watch'){
  fs.writeFileSync(state+'.watch-ready','ready');await Promise.race([new Promise(resolve=>ws.once('close',resolve)),sleep(10000).then(()=>{throw Error('disconnect not propagated')})]);console.log('PASS transport shutdown propagated to active terminal');
 }else if(stage==='online'){
  let out='';ws.on('message',data=>{if(String(data)[0]==='1')out+=Buffer.from(String(data).slice(1),'base64').toString()});ws.send('1'+Buffer.from("printf '\\122\\105\\103\\117\\126\\105\\122\\105\\104\\012'\n").toString('base64'));
  for(let i=0;i<100&&!out.includes('RECOVERED');i++)await sleep(100);assert(out.includes('RECOVERED'));ws.close();console.log('PASS restarted device/Hub resumes authenticated real PTY access');
 }else if(stage==='unbind'){
  assert.equal((await api(owner,`/instances/${id}/binding`,{},'DELETE')).status,200);await closes(ws);
  for(let i=0;i<100&&JSON.parse(fs.readFileSync(state)).instance_id;i++)await sleep(100);assert(!JSON.parse(fs.readFileSync(state)).instance_id);
  assert.equal((await api(owner,`/instances/${id}/terminal-tickets`,{})).status,403);console.log('PASS unbind closes streams and erases local binding');
 }else throw Error('unknown stage');
})().catch(e=>{console.error(e);process.exit(1)});

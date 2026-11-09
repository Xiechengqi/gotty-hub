const fs=require('node:fs'),assert=require('node:assert/strict'),WebSocket=require('../frontend/node_modules/ws');
const fixture=JSON.parse(fs.readFileSync(process.argv[2]));const duration=Number(process.env.HUB_LOAD_SECONDS||1800);const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const sockets=[];let bytes=0,closed=0;
 for(let i=0;i<50;i++)for(let j=0;j<2;j++){
  const id=`load-${i}`;const r=await fetch(fixture.url+`/api/v1/instances/${id}/terminal-tickets`,{method:'POST',headers:{cookie:`hub_session=${fixture.session}`,'x-csrf-token':fixture.csrf,'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);const {ticket}=await r.json();
  const ws=new WebSocket(fixture.url.replace('http','ws')+`/api/v1/terminal-connections/${id}/ws`,{headers:{origin:fixture.url,cookie:`hub_session=${fixture.session}`}});
  await new Promise((resolve,reject)=>{ws.once('error',reject);ws.once('open',resolve)});sockets.push(ws);ws.on('close',()=>closed++);ws.on('message',data=>{if(data[0]===49)bytes+=Buffer.from(String(data).slice(1),'base64').length});
  ws.send(JSON.stringify({ticket}));ws.send('3'+JSON.stringify({columns:100,rows:35}));
  if(j===0&&i<10)ws.send('1'+Buffer.from('while true; do head -c 65536 /dev/zero; sleep 1; done\n').toString('base64'));
 }
 const started=Date.now();while(Date.now()-started<duration*1000){await sleep(1000);if(closed)throw Error(`${closed} unexpected socket closes`)}
 assert(bytes>=10*65536*duration,'throughput below target');for(const s of sockets)s.close();
 fs.writeFileSync(process.argv[3],JSON.stringify({devices:50,terminalConnections:100,activeOutputDevices:10,seconds:duration,receivedBytes:bytes,unexpectedCloses:closed},null,2));
 console.log('PASS multi-instance load',duration+'s',bytes+' bytes');
})().catch(e=>{console.error(e);process.exit(1)});

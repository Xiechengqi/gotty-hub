const fs=require('node:fs'),assert=require('node:assert/strict');
const WebSocket=require('../frontend/node_modules/ws');
const hub=process.env.HUB_TEST_URL,maildir=process.env.HUB_TEST_MAIL;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function login(email){
 const old=new Set(fs.readdirSync(maildir));
 const response=await fetch(hub+'/api/v1/auth/otp/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const {challenge}=await response.json();
 let code;for(let i=0;i<100&&!code;i++){for(const name of fs.readdirSync(maildir)){if(old.has(name))continue;const m=JSON.parse(fs.readFileSync(`${maildir}/${name}`));if(m.to===email&&m.text.includes('Hub login:'))code=m.text.match(/: (\d{6})/)[1]}if(!code)await sleep(100)}assert(code);
 const r=await fetch(hub+'/api/v1/auth/otp/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challenge,code})});assert.equal(r.status,200);const user=await r.json();const cookie=r.headers.get('set-cookie').split(';')[0];
 const replay=await fetch(hub+'/api/v1/auth/otp/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challenge,code})});assert.equal(replay.status,400,'OTP replay accepted');
 return {cookie,csrf:user.csrf};
}
async function api(s,path,body,method){const r=await fetch(hub+'/api/v1'+path,{method:method??(body===undefined?'GET':'POST'),headers:{cookie:s.cookie,'content-type':'application/json','x-csrf-token':s.csrf},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();return {status:r.status,data}}
async function connect(s,id,ticket,channel='terminal'){return new Promise((resolve,reject)=>{const ws=new WebSocket(hub.replace('http','ws')+`/api/v1/terminal-connections/${id}/ws`,{headers:{cookie:s.cookie,origin:hub}});ws.once('error',reject);ws.once('open',()=>{ws.send(JSON.stringify({ticket,channel}));resolve(ws)})})}
async function closes(ws){if(ws.readyState===WebSocket.CLOSED)return;await Promise.race([new Promise(r=>ws.once('close',r)),sleep(2500).then(()=>{throw Error('revocation timeout')})])}

module.exports={fs,assert,WebSocket,hub,maildir,sleep,login,api,connect,closes};

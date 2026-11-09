const fs=require('node:fs'),assert=require('node:assert/strict');
const WebSocket=require('../frontend/node_modules/ws');
const hub=process.env.HUB_TEST_URL;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const userPassword='integration password 123';
async function login(username,password=username==='admin'?process.env.HUB_PASSWORD:userPassword){
 const headers={'content-type':'application/json'};
 if(username!=='admin'){
  const registration=await fetch(hub+'/api/v1/auth/register',{method:'POST',headers,body:JSON.stringify({username,password})});
  assert([200,409].includes(registration.status),'registration failed: '+registration.status);
  if(registration.status===200){const user=await registration.json();return {cookie:registration.headers.get('set-cookie').split(';')[0],csrf:user.csrf}}
 }
 const response=await fetch(hub+'/api/v1/auth/password/login',{method:'POST',headers,body:JSON.stringify({username,password})});
 assert.equal(response.status,200,'login failed for '+username);const user=await response.json();
 return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:user.csrf};
}
async function api(s,path,body,method){const r=await fetch(hub+'/api/v1'+path,{method:method??(body===undefined?'GET':'POST'),headers:{cookie:s.cookie,'content-type':'application/json','x-csrf-token':s.csrf},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();return {status:r.status,data}}
async function connect(s,id,ticket,channel='terminal'){return new Promise((resolve,reject)=>{const ws=new WebSocket(hub.replace('http','ws')+`/api/v1/terminal-connections/${id}/ws`,{headers:{cookie:s.cookie,origin:hub}});ws.once('error',reject);ws.once('open',()=>{ws.send(JSON.stringify({ticket,channel}));resolve(ws)})})}
async function closes(ws){if(ws.readyState===WebSocket.CLOSED)return;await Promise.race([new Promise(r=>ws.once('close',r)),sleep(2500).then(()=>{throw Error('revocation timeout')})])}

module.exports={fs,assert,WebSocket,hub,sleep,userPassword,login,api,connect,closes};

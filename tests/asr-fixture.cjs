// Local deterministic backend fixture; never records microphone audio.
const {WebSocketServer}=require('../frontend/node_modules/ws');
const server=new WebSocketServer({host:'127.0.0.1',port:Number(process.argv[2])});
server.on('connection',socket=>{let bytes=0;socket.on('message',(data,binary)=>{if(binary)bytes+=data.length;else if(String(data)==='Done')socket.send(JSON.stringify({segment:0,text:bytes?'fixture transcript':'empty audio'}))})});
process.on('SIGTERM',()=>server.close(()=>process.exit()));

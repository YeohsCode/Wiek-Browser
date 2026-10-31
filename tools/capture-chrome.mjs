#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import WebSocket from 'ws';
const data=resolve(process.argv[2]||'data');
const out=resolve(process.argv[3]||'reports/vek-browser.png');
const runtime=JSON.parse(await readFile(join(data,'runtime.json'),'utf8'));
const socket=new WebSocket(`ws://127.0.0.1:${runtime.port}/rpc?token=${encodeURIComponent(runtime.token)}`);
try {
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)});
 const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('UI capture timed out')),10000);
  socket.on('message',raw=>{const msg=JSON.parse(String(raw));if(msg.id!==1)return;clearTimeout(timer);msg.error?reject(new Error(msg.error.message)):resolve(msg.result)});
  socket.send(JSON.stringify({id:1,method:'captureChrome',args:[]}));
 });
 await mkdir(dirname(out),{recursive:true});await writeFile(out,Buffer.from(result.data,'base64'));
 console.log(out);
} finally {socket.close();setTimeout(()=>socket.terminate(),100).unref()}

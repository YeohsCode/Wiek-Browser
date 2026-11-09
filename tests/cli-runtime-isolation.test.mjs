import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {createServer} from 'node:net';
const execute=promisify(execFile),root=resolve(import.meta.dirname,'..');
test('CLI retains explicit Wiek workspace/state overrides and ignores retired settings without another browser',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wiek-cli-isolation-'));
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const methods=[];
 server.on('connection',socket=>socket.on('message',bytes=>{
  const call=JSON.parse(bytes);methods.push(call.method);
  assert.equal(call.method,'getBrowserVersion');
  socket.send(JSON.stringify({id:call.id,result:{currentVersion:'fixture',updateAvailable:false}}));
 }));
 try{
  await writeFile(join(dir,'runtime.json'),JSON.stringify({pid:process.pid,port:server.address().port,token:'temporary-fixture',browserInstanceId:'fixture'}));
  const workspace=join(dir,'explicit-workspace');await mkdir(workspace);
  const state=join(dir,'explicit-state');
  const program="console.log(JSON.stringify({isolationMarker:true,runtime:typeof globalThis.wiek,retired:Object.hasOwn(globalThis,'ego'),state:process.env.WIEK_BROWSER_STATE_DIR,workspace:process.env.WIEK_BROWSER_AGENT_WORKSPACE}))";
  const env={...process.env,WIEK_DATA_DIR:dir,WIEK_BROWSER_STATE_DIR:state,WIEK_BROWSER_AGENT_WORKSPACE:workspace,EGO_BROWSER_STATE_DIR:'/unavailable',EGO_BROWSER_AGENT_WORKSPACE:'/unavailable'};
  const result=await execute(process.execPath,[join(root,'cli/wiek-browser.mjs'),'nodejs','-e',program],{env,timeout:10000});
  const value=result.stdout.split('\n').flatMap(line=>{try{const item=JSON.parse(line);return item.isolationMarker?[item]:[];}catch{return [];}})[0];
  assert.deepEqual(value,{isolationMarker:true,runtime:'object',retired:false,state,workspace});
  assert.deepEqual(methods,['getBrowserVersion']);
 }finally{for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
test('an alive but unresponsive host never triggers a second browser startup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wiek-cli-unresponsive-')),sockets=new Set();
 const server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await writeFile(join(dir,'runtime.json'),JSON.stringify({pid:process.pid,port:server.address().port,token:'fixture',browserInstanceId:'fixture'}));
  const result=await execute(process.execPath,[join(root,'cli/wiek-browser.mjs'),'nodejs','-e','console.log("must not execute")'],{env:{...process.env,WIEK_DATA_DIR:dir,WIEK_ELECTRON_PATH:'/must-not-start-a-second-browser'},timeout:8000}).then(()=>null,error=>error);
  assert.equal(result.code,1);assert.match(result.stderr,/already running.*not responding/);assert.doesNotMatch(result.stderr,/ENOENT|did not start/);assert.doesNotMatch(result.stdout,/must not execute/);
 }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

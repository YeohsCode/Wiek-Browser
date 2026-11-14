import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import serviceModule from '../app/local-server-service.cjs';
import workspaceModule from '../app/workspace-service.cjs';
const {createLocalServerService,createNativeServerProbe,parseListeners}=serviceModule;
const trusted={interactive:true},ctx={root:'/project',project:{id:'project'}},pid=700001;
function fixture(options={}){
  let timestamp=1000,records=[{pid,uid:process.getuid(),ppid:1,started:'1:42',executable:'/bin/node',cwd:'/project',zombie:false}],listeners=[{pid,address:'127.0.0.1',port:4123}],signals=[];
  const probe={available:true,listeners:async()=>listeners,inspect:async ids=>{
    const rows=records.filter(row=>ids.includes(row.pid));
    if(ids.includes(process.pid)&&!rows.some(row=>row.pid===process.pid))rows.push({pid:process.pid,ppid:1,uid:process.getuid(),started:'1:1',cwd:'/host',executable:'/app/Host',zombie:false});
    return rows;
  }};
  const service=createLocalServerService({probe,now:()=>timestamp,pause:async()=>{timestamp+=100;},signal:(id,signal)=>{signals.push({id,signal});records=[];},...options});
  return {service,probe,signals,setTime:value=>timestamp=value,get records(){return records;},set records(value){records=value;},get listeners(){return listeners;},set listeners(value){listeners=value;},act:(suffix,payload={},context=ctx,authority=trusted)=>service.dispatch('workspace:servers:'+suffix,payload,context,authority)};
}
test('listener parser handles duplicates, bracketed IPv6 and refuses malformed endpoints',()=>{
  assert.deepEqual(parseListeners('p42\ncnode\nn*:8080\nn*:8080\nn[::1]:8081\nn127.0.0.1:0\nn127.0.0.1:70000\npNaN\nn*:1234'),[{pid:42,name:'node',address:'*',port:8080},{pid:42,name:'node',address:'::1',port:8081}]);
});
test('listing is read-only, project-scoped, and exposes only derived loopback URLs',async()=>{
  const f=fixture();f.records.push({...f.records[0],pid:pid+1,cwd:'/project-other'});f.listeners.push({pid:pid+1,address:'127.0.0.1',port:9000},{pid,address:'192.0.2.1',port:7000});
  const result=await f.act('list',{},ctx,{});assert.equal(result.servers.length,1);assert.deepEqual(result.servers[0].urls,['http://127.0.0.1:4123/']);assert.equal(result.automaticProbes,false);assert.deepEqual(f.signals,[]);f.service.close();
});
test('review and explicit confirmation are required; the review is single-use',async()=>{
  const f=fixture();await assert.rejects(f.act('prepare-stop',{pid},ctx,{}),/controls/);
  const review=await f.act('prepare-stop',{pid});assert.deepEqual(f.signals,[]);
  await assert.rejects(f.act('stop',{reviewId:review.reviewId}),/explicitly confirm/);
  assert.equal((await f.act('stop',{reviewId:review.reviewId,confirm:true})).stopped,true);
  await assert.rejects(f.act('stop',{reviewId:review.reviewId,confirm:true}),/expired/);
  assert.deepEqual(f.signals,[{id:pid,signal:'SIGTERM'}]);
});
test('reviews are bound to project id and canonical root and cannot cross scope',async()=>{
  const f=fixture(),review=await f.act('prepare-stop',{pid});
  for(const context of [{...ctx,project:{id:'other'}},{...ctx,root:'/another'}])await assert.rejects(f.act('stop',{reviewId:review.reviewId,confirm:true},context),/another project/);
  assert.deepEqual(f.signals,[]);assert.equal((await f.act('stop',{reviewId:review.reviewId,confirm:true})).stopped,true);
});
test('expired and cancelled reviews never send a signal',async()=>{
  const f=fixture();let review=await f.act('prepare-stop',{pid});f.setTime(31000);await assert.rejects(f.act('stop',{reviewId:review.reviewId,confirm:true}),/expired/);
  review=await f.act('prepare-stop',{pid});await f.act('cancel',{reviewId:review.reviewId});await assert.rejects(f.act('stop',{reviewId:review.reviewId,confirm:true}),/expired/);assert.deepEqual(f.signals,[]);
});
for(const [name,mutate]of [
  ['birth identity',f=>f.records[0].started='2:42'],['working directory',f=>f.records[0].cwd='/project/subfolder'],['executable',f=>f.records[0].executable='/other/node'],['listener set',f=>f.listeners.push({pid,address:'*',port:5000})],['listener removal',f=>f.listeners=[]],
])test(`changed ${name} invalidates a review without stopping a process`,async()=>{
  const f=fixture(),review=await f.act('prepare-stop',{pid});mutate(f);await assert.rejects(f.act('stop',{reviewId:review.reviewId,confirm:true}),/changed/);assert.deepEqual(f.signals,[]);
});
test('the last identity read catches a process replacement after listener discovery',async()=>{
  const f=fixture(),review=await f.act('prepare-stop',{pid});let inspections=0;const inspect=f.probe.inspect;
  f.probe.inspect=async ids=>{const result=await inspect(ids);if(++inspections===2)return result.map(row=>({...row,started:'999:0'}));return result;};
  await assert.rejects(f.act('stop',{reviewId:review.reviewId,confirm:true}),/identity changed/);assert.deepEqual(f.signals,[]);
});
test('current host, its ancestors and unknown runtimes cannot be stopped',async()=>{
  const f=fixture();f.records.push({...f.records[0],pid:process.pid,ppid:pid});
  assert.equal((await f.act('list')).servers[0].isStoppable,false);await assert.rejects(f.act('prepare-stop',{pid}),/protected/);
  f.records=f.records.filter(row=>row.pid!==process.pid).map(row=>({...row,executable:'/usr/bin/sshd'}));await assert.rejects(f.act('prepare-stop',{pid}),/protected/);assert.deepEqual(f.signals,[]);
});
test('a process ignoring termination stays running; no force stop or group signal is sent',async()=>{
  let f;f=fixture({settleMs:200,signal:(id,signal)=>f.signals.push({id,signal})});const review=await f.act('prepare-stop',{pid});
  const result=await f.act('stop',{reviewId:review.reviewId,confirm:true});assert.equal(result.stopped,false);assert.match(result.message,/still running/);assert.deepEqual(f.signals,[{id:pid,signal:'SIGTERM'}]);
});
test('service close invalidates reviews without terminating any server',async()=>{
  const f=fixture(),review=await f.act('prepare-stop',{pid});f.service.close();await assert.rejects(f.act('stop',{reviewId:review.reviewId,confirm:true}),/closed/);assert.deepEqual(f.signals,[]);
});
test('unavailable ancestor identity disables stopping rather than guessing ownership',async()=>{
  const f=fixture();f.records.push({...f.records[0],pid:process.pid,ppid:pid+100});
  assert.equal((await f.act('list')).servers[0].isStoppable,false);
  await assert.rejects(f.act('prepare-stop',{pid}),/protected/);assert.deepEqual(f.signals,[]);
});
test('native probe uses bounded literal argv and rejects nonmatching process identities',async()=>{
  const calls=[];const probe=createNativeServerProbe({platform:'darwin',run:async(command,args,options)=>{calls.push({command,args,input:options?.input});return command.endsWith('lsof')?{code:0,out:'p42\ncnode\nn*:4000\n'}:{code:0,out:JSON.stringify([{pid:43,ppid:1,uid:process.getuid(),started:'1:2',cwd:'/project',executable:'/bin/node',zombie:false}])};}});
  assert.equal((await probe.listeners())[0].port,4000);assert.equal(calls[0].command,'/usr/sbin/lsof');assert.equal(calls[0].args.includes('-nP'),true);await assert.rejects(probe.inspect([42]),/identity response/);
});
test('titles require a trusted local action and the exact listed process, fingerprint and URL',async()=>{
  const reads=[],f=fixture({fetchTitle:async url=>{reads.push(url);return {title:'Fixture',status:'read'};}});
  const row=(await f.act('list')).servers[0],payload={pid:row.pid,fingerprint:row.fingerprint,url:row.urls[0]};
  assert.deepEqual(reads,[]);
  await assert.rejects(f.act('title',payload,ctx,{}),/controls/);
  for(const changed of [{...payload,pid:pid+1},{...payload,fingerprint:'stale'},{...payload,url:'http://192.0.2.1/'},{...payload,url:payload.url+'admin'}])await assert.rejects(f.act('title',changed),/changed/);
  assert.deepEqual(reads,[]);assert.equal((await f.act('title',payload)).title,'Fixture');
  assert.deepEqual(reads,[row.urls[0]]);f.service.close();
});
for(const [name,mutate]of [
  ['process identity',f=>{f.records[0].started='2:42';}],
  ['listening endpoints',f=>{f.listeners.push({pid,address:'*',port:5000});}],
  ['project membership',f=>{f.records[0].cwd='/elsewhere';}],
])test(`a title is discarded when ${name} changes during its HTTP read`,async()=>{
  let f;f=fixture({fetchTitle:async()=>{mutate(f);return {title:'Stale',status:'read'};}});
  const row=(await f.act('list')).servers[0];await assert.rejects(f.act('title',{pid,fingerprint:row.fingerprint,url:row.urls[0]}),/changed/);f.service.close();
});
test('title reads are bounded and service close cancels all owned reads without stopping processes',async()=>{
  const signals=[],f=fixture({fetchTitle:async(_url,{signal})=>new Promise((_resolve,reject)=>{signals.push(signal);signal.addEventListener('abort',()=>reject(Error('Read cancelled')),{once:true});})});
  const row=(await f.act('list')).servers[0],payload={pid,fingerprint:row.fingerprint,url:row.urls[0]};
  const reads=Array.from({length:4},()=>assert.rejects(f.act('title',payload),/cancelled|closed/));
  await assert.rejects(f.act('title',payload),/Too many/);
  while(signals.length<4)await new Promise(resolve=>setImmediate(resolve));
  f.service.close();await Promise.all(reads);assert.equal(signals.every(signal=>signal.aborted),true);assert.deepEqual(f.signals,[]);
});
test('late title completions after service close never produce a successful result',async()=>{
  let complete,started;const entered=new Promise(resolve=>started=resolve),f=fixture({fetchTitle:async()=>{started();return new Promise(resolve=>complete=resolve);}});
  const row=(await f.act('list')).servers[0],read=assert.rejects(f.act('title',{pid,fingerprint:row.fingerprint,url:row.urls[0]}),/closed/);
  await entered;f.service.close();complete({title:'Late',status:'read'});await read;
});
test('actual temporary TCP servers are discovered by native identity and only the reviewed project process stops',{skip:process.platform!=='darwin'},async t=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'wiek-local-services-')),project=path.join(base,'project $literal'),other=path.join(base,'other');await fs.mkdir(project);await fs.mkdir(other);
  const children=[];t.after(async()=>{for(const child of children)if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await once(child,'close');}await fs.rm(base,{recursive:true,force:true});});
  async function server(cwd){const child=spawn(process.execPath,['-e',"const http=require('http');const s=http.createServer((q,r)=>r.end('Public fixture'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"],{cwd,stdio:['ignore','pipe','pipe']});children.push(child);const [chunk]=await once(child.stdout,'data');return {child,port:Number(chunk.toString().trim())};}
  const mine=await server(project),foreign=await server(other),service=workspaceModule.createWorkspaceService({projects:()=>[{id:'p',path:project}]});t.after(()=>service.close());
  const found=await service.dispatch('workspace:servers:list',{projectId:'p'});assert.ok(found.servers.some(row=>row.pid===mine.child.pid&&row.ports.some(p=>p.port===mine.port)));assert.equal(found.servers.some(row=>row.pid===foreign.child.pid),false);
  const review=await service.dispatch('workspace:servers:prepare-stop',{projectId:'p',pid:mine.child.pid},trusted);
  const exited=once(mine.child,'close');const stopped=await service.dispatch('workspace:servers:stop',{projectId:'p',reviewId:review.reviewId,confirm:true},trusted);await exited;
  assert.equal(stopped.stopped,true);assert.equal(foreign.child.exitCode,null);assert.equal(foreign.child.signalCode,null);
  assert.equal((await service.dispatch('workspace:servers:list',{projectId:'p'})).servers.some(row=>row.pid===mine.child.pid),false);
});


test('explicit bulk identification reads at most twelve project endpoints and tolerates a failed title', async () => {
  const visited=[];
  const f=fixture({fetchTitle:async url=>{
    visited.push(url);
    if(url.includes(':5001'))throw new Error('disconnected');
    return {status:'read',title:'Fixture'};
  }});
  f.listeners=Array.from({length:15},(_,index)=>({pid,address:'127.0.0.1',port:5000+index}));
  await f.act('list',{},ctx,{});
  assert.deepEqual(visited,[]);
  await assert.rejects(f.act('identify',{},ctx,{}),/controls/);
  const result=await f.act('identify');
  assert.equal(result.attemptedTitles,12);
  assert.equal(visited.length,12);
  assert.equal(Object.keys(result.servers[0].titles).length,11);
  assert.equal(result.servers[0].urls.length,15);
  assert.deepEqual(f.signals,[]);
});

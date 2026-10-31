import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createAgentService}=require('../app/agent-service.cjs');
const {createWorkspaceService}=require('../app/workspace-service.cjs');
const {createTurnCheckpoints}=require('../app/turn-checkpoints.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,source,{git=true,protocol='cli',enabled=true}={}){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'vek-turn-')),repo=path.join(base,'project'),dataDir=path.join(base,'state');await fs.mkdir(repo);await fs.writeFile(path.join(repo,'note.txt'),'base\n');
  const gitRun=(...args)=>execFileSync('git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  if(git){gitRun('init','-q');gitRun('config','user.name','Vek fixture');gitRun('config','user.email','fixture@localhost');gitRun('config','core.hooksPath','/dev/null');gitRun('add','--','note.txt');gitRun('commit','-qm','fixture');}
  const script=path.join(base,'provider.cjs');await fs.writeFile(script,source);
  let agent,workspace,coordinator;
  const open=()=>{
    agent=createAgentService({dataDir,turnCheckpoints:{before:args=>coordinator.before(args),after:args=>coordinator.after(args),locked:id=>coordinator.locked(id),dispatch:(...args)=>coordinator.dispatch(...args)}});
    workspace=createWorkspaceService({projects:()=>agent.snapshot().projects});
    coordinator=createTurnCheckpoints({dataDir,workspace,projects:()=>agent.snapshot().projects,isRunning:p=>{const snapshot=agent.snapshot(),ids=new Set(snapshot.projects.filter(row=>row.path===p.path).map(row=>row.id));return snapshot.threads.some(row=>ids.has(row.projectId)&&row.status==='running');}});
    agent.recoverFileChanges(coordinator.records());
  };
  const close=async()=>{await agent.close();coordinator.close();await workspace.close();};open();t.after(async()=>{await close();await fs.rm(base,{recursive:true,force:true});});
  let snapshot=await agent.dispatch('agents:projects:create',{path:repo,name:'Fixture'});const projectId=snapshot.projects.at(-1).id;
  snapshot=await agent.dispatch('agents:providers:configure',{command:process.execPath,args:[script],name:'Local fixture',protocol,inputMode:'stdin'});const providerId=snapshot.providers.at(-1).id;
  snapshot=await agent.dispatch('agents:threads:create',{projectId,providerId,title:'Turn fixture'});const id=snapshot.threads.at(-1).id;
  if(enabled)await agent.dispatch('agents:projects:checkpoints',{id:projectId,enabled:true});
  async function settled(){for(let n=0;n<600;n++){const thread=await agent.dispatch('agents:threads:read',{id});if(thread.status!=='running')return thread;await delay(20);}throw new Error('Turn did not settle');}
  return{repo,dataDir,projectId,providerId,id,gitRun,get agent(){return agent;},get workspace(){return workspace;},get coordinator(){return coordinator;},settled,close,open};
}
const edit="const fs=require('node:fs'),cp=require('node:child_process');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync('note.txt','staged\\n');cp.execFileSync('git',['add','--','note.txt']);fs.writeFileSync('note.txt','unstaged\\n');fs.writeFileSync('fresh.bin',Buffer.from([0,1,2,3]));console.log('Actual edit complete');});";
test('real provider turn records before/after, staged and worktree diff, explicit restore and protection',async t=>{
  const f=await fixture(t,edit);await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Edit fixture'});const thread=await f.settled(),run=thread.runs.at(-1);
  assert.equal(run.status,'completed');assert.equal(run.fileChanges.status,'complete');assert.ok(run.executedAt);assert.equal(run.fileChanges.runId,run.id);assert.equal(run.fileChanges.threadId,f.id);
  const diff=await f.agent.dispatch('agents:changes:diff',{id:f.id,runId:run.id});assert.match(diff.stagedDiff,/\+staged/);assert.match(diff.worktreeDiff,/\+unstaged/);assert.ok(diff.changes.some(row=>row.path==='fresh.bin'&&row.worktree));
  assert.equal(f.gitRun('show',':note.txt'),'staged\n');
  const preview=await f.agent.dispatch('agents:changes:preview',{id:f.id,runId:run.id});
  await assert.rejects(f.agent.dispatch('agents:changes:restore',{id:f.id,runId:run.id,expectedState:preview.expectedState}),/confirm/i);
  const restored=await f.agent.dispatch('agents:changes:restore',{id:f.id,runId:run.id,expectedState:preview.expectedState,confirm:true});
  assert.equal(await fs.readFile(path.join(f.repo,'note.txt'),'utf8'),'base\n');assert.equal(f.gitRun('show',':note.txt'),'base\n');await assert.rejects(fs.access(path.join(f.repo,'fresh.bin')));
  const backupPreview=await f.workspace.dispatch('workspace:git:checkpoint:preview',{projectId:f.projectId,id:restored.backupCheckpoint.id});
  await f.workspace.dispatch('workspace:git:checkpoint:restore',{projectId:f.projectId,id:restored.backupCheckpoint.id,expectedState:backupPreview.expectedState,confirm:true});assert.equal(await fs.readFile(path.join(f.repo,'note.txt'),'utf8'),'unstaged\n');assert.equal(f.gitRun('show',':note.txt'),'staged\n');
  const span=await f.agent.dispatch('agents:changes:diff',{id:f.id,scope:'thread'});assert.equal(span.scope,'thread-span');assert.match(span.notice,/intervening work/);
  await f.close();f.open();assert.equal((await f.agent.dispatch('agents:changes:list',{id:f.id})).records[0].lastRestore.backupId,restored.backupCheckpoint.id);
});
test('failed provider changes are captured, and stale or cross-turn restore previews are refused',async t=>{
  const f=await fixture(t,"process.stdin.resume();process.stdin.on('end',()=>{require('fs').writeFileSync('note.txt','failed edit');process.exit(2);});");
  await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Fail after edit'});const first=(await f.settled()).runs.at(-1);assert.equal(first.status,'failed');assert.equal(first.fileChanges.status,'complete');
  const preview=await f.agent.dispatch('agents:changes:preview',{id:f.id,runId:first.id});await fs.writeFile(path.join(f.repo,'note.txt'),'external edit');
  await assert.rejects(f.agent.dispatch('agents:changes:restore',{id:f.id,runId:first.id,expectedState:preview.expectedState,confirm:true}),/changed|preview/i);assert.equal(await fs.readFile(path.join(f.repo,'note.txt'),'utf8'),'external edit');
  await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Second run'});const second=(await f.settled()).runs.at(-1);
  const secondPreview=await f.agent.dispatch('agents:changes:preview',{id:f.id,runId:second.id});await assert.rejects(f.agent.dispatch('agents:changes:restore',{id:f.id,runId:first.id,expectedState:secondPreview.expectedState,confirm:true}),/changed|preview/i);
});
test('stop and graceful shutdown wait for actual provider termination and snapshot finalization',async t=>{
  const f=await fixture(t,"require('fs').writeFileSync('note.txt','running edit');setInterval(()=>{},1000);");
  await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Wait'});for(let n=0;n<200;n++){if(await fs.readFile(path.join(f.repo,'note.txt'),'utf8')==='running edit')break;await delay(20);}
  await f.agent.dispatch('agents:threads:stop',{id:f.id});let run=(await f.settled()).runs.at(-1);assert.equal(run.status,'stopped');assert.equal(run.fileChanges.status,'complete');
  await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Wait again'});for(let n=0;n<200;n++){if((await f.agent.dispatch('agents:threads:read',{id:f.id})).runs.at(-1).executedAt)break;await delay(20);}await f.close();f.open();run=(await f.settled()).runs.at(-1);assert.equal(run.status,'interrupted');assert.equal(run.fileChanges.status,'complete');
});
test('unsupported before capture prevents provider launch; disabled project preserves ordinary CLI behavior',async t=>{
  const f=await fixture(t,"require('fs').writeFileSync('launched','yes');console.log('ran');",{git:false});
  await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Try'});let run=(await f.settled()).runs.at(-1);assert.equal(run.status,'failed');assert.equal(run.executedAt,undefined);assert.equal(run.fileChanges.status,'failed');await assert.rejects(fs.access(path.join(f.repo,'launched')));
  await f.agent.dispatch('agents:projects:checkpoints',{id:f.projectId,enabled:false});await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Run without capture'});run=(await f.settled()).runs.at(-1);assert.equal(run.status,'completed');assert.equal(await fs.readFile(path.join(f.repo,'launched'),'utf8'),'yes');
});
test('after capture failure retains known before snapshot without claiming a complete diff',async t=>{
  const f=await fixture(t,"require('fs').writeFileSync('huge.bin',Buffer.alloc(3*1024*1024));console.log('wrote oversized file');");await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Write'});const run=(await f.settled()).runs.at(-1);
  assert.equal(run.status,'completed');assert.equal(run.fileChanges.status,'partial');assert.ok(run.fileChanges.before);assert.equal(run.fileChanges.after,null);assert.match(run.fileChanges.error,/2 MiB/);await assert.rejects(f.agent.dispatch('agents:changes:diff',{id:f.id,runId:run.id}),/Both before and after/);
});
test('project concurrency, configuration and restore leases cannot overlap a protected turn',async t=>{
  const f=await fixture(t,"setInterval(()=>{},1000);");await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Stay running'});
  let snapshot=await f.agent.dispatch('agents:threads:create',{projectId:f.projectId,providerId:f.providerId,title:'Other'});const other=snapshot.threads.at(-1).id;
  await assert.rejects(f.agent.dispatch('agents:threads:prompt',{id:other,prompt:'Overlap'}),/protected turn/);await assert.rejects(f.agent.dispatch('agents:projects:checkpoints',{id:f.projectId,enabled:false}),/Finish project/);
  await assert.rejects(f.coordinator.withRestoreLease(f.projectId,()=>Promise.resolve()),/finish before restoring/);await f.agent.dispatch('agents:threads:stop',{id:f.id});
  let release;const held=f.coordinator.withRestoreLease(f.projectId,()=>new Promise(resolve=>release=resolve));await assert.rejects(f.agent.dispatch('agents:threads:prompt',{id:other,prompt:'During restore'}),/restore is active/);release();await held;
});
test('interrupted associations recover conservatively; import and fork do not acquire snapshot authority',async t=>{
  const f=await fixture(t,edit);await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Edit'});const run=(await f.settled()).runs.at(-1);
  const exported=JSON.parse((await f.agent.dispatch('agents:export',{metadataOnly:true})).exportData.content);let snapshot=await f.agent.dispatch('agents:import',{data:exported});const imported=snapshot.threads.at(-1);assert.equal(imported.runs[0].fileChanges,undefined);await assert.rejects(f.agent.dispatch('agents:changes:preview',{id:imported.id,runId:run.id}),/No local/);
  snapshot=await f.agent.dispatch('agents:threads:fork',{id:f.id,title:'Fork'});assert.equal(snapshot.threads.at(-1).runs.length,0);
  await f.close();const statePath=path.join(f.dataDir,'turn-checkpoints/state.json'),state=JSON.parse(await fs.readFile(statePath,'utf8'));state.records[0].status='capturing-after';state.records[0].after=null;await fs.writeFile(statePath,JSON.stringify(state));f.open();
  const record=(await f.agent.dispatch('agents:changes:list',{id:f.id})).records[0];assert.equal(record.status,'interrupted');assert.equal(record.after,null);assert.ok((await f.agent.dispatch('agents:changes:preview',{id:f.id,runId:run.id})).expectedState);
  assert.equal((await f.agent.dispatch('agents:threads:read',{id:f.id})).runs[0].fileChanges.status,'interrupted');
});
test('HEAD changes keep immutable diff available but prevent history-changing restoration',async t=>{
  const f=await fixture(t,"require('fs').writeFileSync('note.txt','new committed data');require('child_process').execFileSync('git',['-c','commit.gpgsign=false','commit','-am','provider commit']);");await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Commit'});const run=(await f.settled()).runs.at(-1);
  const diff=await f.agent.dispatch('agents:changes:diff',{id:f.id,runId:run.id});assert.equal(diff.headChanged,true);assert.match(diff.worktreeDiff,/new committed data/);await assert.rejects(f.agent.dispatch('agents:changes:preview',{id:f.id,runId:run.id}),/HEAD changed/);
});
test('stopping during before-capture never launches a provider and retains the known snapshot',async t=>{
  const f=await fixture(t,"require('fs').writeFileSync('should-not-launch','bad');");let release,entered;
  const began=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),capture=f.coordinator.before;
  f.coordinator.before=async args=>{entered();await gate;return capture(args);};
  await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Stop while preparing'});await began;
  const stopping=f.agent.dispatch('agents:threads:stop',{id:f.id});release();await stopping;const run=(await f.settled()).runs.at(-1);
  assert.equal(run.status,'stopped');assert.equal(run.fileChanges.status,'cancelled');assert.ok(run.fileChanges.before);assert.equal(run.executedAt,undefined);await assert.rejects(fs.access(path.join(f.repo,'should-not-launch')));
});
test('native thread and turn IDs bind real wire events to immutable file snapshots once',async t=>{
  const source=`const rl=require('readline').createInterface({input:process.stdin});const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'native-local-thread'}}});if(m.method==='turn/start'){require('fs').writeFileSync('note.txt','native fixture edit');send({id:m.id,result:{turn:{id:'native-local-turn'}}});send({method:'turn/started',params:{turn:{id:'native-local-turn'}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});}});rl.on('close',()=>process.exit(0));`;
  const f=await fixture(t,source,{protocol:'codex-app-server'});await f.agent.dispatch('agents:threads:prompt',{id:f.id,prompt:'Native fixture'});const thread=await f.settled(),run=thread.runs.at(-1);
  assert.equal(run.status,'completed');assert.equal(run.nativeThreadId,'native-local-thread');assert.equal(run.nativeTurnId,'native-local-turn');assert.equal(run.fileChanges.nativeTurnId,'native-local-turn');assert.equal(run.fileChanges.status,'complete');
  const before=(await f.workspace.dispatch('workspace:git:checkpoint:list',{projectId:f.projectId})).checkpoints.length;await f.coordinator.after({thread,run});assert.equal((await f.workspace.dispatch('workspace:git:checkpoint:list',{projectId:f.projectId})).checkpoints.length,before);
  assert.match((await f.agent.dispatch('agents:changes:diff',{id:f.id,runId:run.id})).worktreeDiff,/native fixture edit/);
});
test('actual host-process hard stop recovers the known before snapshot without inventing after state',async t=>{
  const f=await fixture(t,"const fs=require('fs');fs.writeFileSync('child.pid',String(process.pid));fs.writeFileSync('note.txt','crash-time edit');setInterval(()=>{},1000);");await f.close();
  const worker=path.join(f.repo,'..','crash-host.cjs'),agentPath=require.resolve('../app/agent-service.cjs'),workspacePath=require.resolve('../app/workspace-service.cjs'),coordinatorPath=require.resolve('../app/turn-checkpoints.cjs');
  await fs.writeFile(worker,`const {createAgentService}=require(${JSON.stringify(agentPath)}),{createWorkspaceService}=require(${JSON.stringify(workspacePath)}),{createTurnCheckpoints}=require(${JSON.stringify(coordinatorPath)});let c;const a=createAgentService({dataDir:${JSON.stringify(f.dataDir)},turnCheckpoints:{before:x=>c.before(x),after:x=>c.after(x),locked:id=>c.locked(id)}});const w=createWorkspaceService({projects:()=>a.snapshot().projects});c=createTurnCheckpoints({dataDir:${JSON.stringify(f.dataDir)},workspace:w,projects:()=>a.snapshot().projects});a.recoverFileChanges(c.records());a.dispatch('agents:threads:prompt',{id:${JSON.stringify(f.id)},prompt:'Crash fixture'}).catch(error=>{console.error(error);process.exit(2)});setInterval(()=>{},1000);`);
  const host=spawn(process.execPath,[worker],{stdio:'ignore'});let providerPid;
  t.after(()=>{try{host.kill('SIGKILL');}catch{}if(providerPid)try{process.kill(-providerPid,'SIGKILL');}catch{}});
  for(let n=0;n<300;n++){try{providerPid=Number(await fs.readFile(path.join(f.repo,'child.pid'),'utf8'));if(providerPid)break;}catch{}await delay(20);}assert.ok(providerPid>0);
  const exited=new Promise(resolve=>host.once('exit',resolve));host.kill('SIGKILL');await exited;try{process.kill(-providerPid,'SIGKILL');}catch{}providerPid=null;f.open();
  const run=(await f.settled()).runs.at(-1);assert.equal(run.status,'interrupted');assert.equal(run.fileChanges.status,'interrupted');assert.ok(run.fileChanges.before);assert.equal(run.fileChanges.after,null);assert.equal(await fs.readFile(path.join(f.repo,'note.txt'),'utf8'),'crash-time edit');
  assert.ok((await f.agent.dispatch('agents:changes:preview',{id:f.id,runId:run.id})).expectedState);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
const {createAgentService}=createRequire(import.meta.url)('../app/agent-service.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,match){for(let i=0;i<400;i++){const value=read();if(match(value))return value;await delay(10);}throw Error('Automation fixture timed out: '+JSON.stringify(read()));}
async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'vek-modes-')),provider=join(dir,'provider.cjs');
 await writeFile(provider,`let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{if(text.includes('[slow]')){console.log('READY');setTimeout(()=>console.log('DONE:'+text),2000);}else console.log(text);});`);
 let service=createAgentService({dataDir:dir,autoSchedule:false,discoverProviders:false,...options});
 t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
 await service.dispatch('agents:providers:configure',{id:'fixture',name:'Fixture',command:process.execPath,args:[provider],modelArgs:['{model}'],inputMode:'stdin'});
 await service.dispatch('agents:projects:create',{name:'Fixture project',path:dir});
 const projectId=service.snapshot().projects[0].id;
 await service.dispatch('agents:threads:create',{projectId,providerId:'fixture',title:'Source'});
 const sourceId=service.snapshot().threads[0].id;
 const act=(action,payload={})=>service.dispatch('agents:'+action,payload);
 return {dir,sourceId,projectId,provider,get service(){return service;},act,state:()=>service.snapshot(),async reopen(){await service.close();service=createAgentService({dataDir:dir,autoSchedule:false,discoverProviders:false,...options});},async create(mode='heartbeat',extra={}){await act('automations:create',{threadId:sourceId,name:'Fixture task',prompt:'AUTOMATION_REQUEST',kind:'interval',intervalMs:60000,status:'paused',executionMode:mode,...extra});return service.snapshot().automations.at(-1).id;},async run(id){await act('automations:run',{id});return until(()=>service.snapshot().automations.find(a=>a.id===id),a=>!service.snapshot().runningCount).then(a=>service.snapshot().threads.find(t=>t.id===a.lastRunThreadId));}};
}
test('legacy mode defaults to heartbeat; invalid mode/closed-app edits are atomic',async t=>{
 const f=await fixture(t);const id=await f.create(undefined);const before=f.state().automations[0];assert.equal(before.executionMode,'heartbeat');assert.equal(before.closedAppAllowed,false);
 for(const value of [{executionMode:'fork'},{closedAppAllowed:'true'}])await assert.rejects(f.act('automations:update',{id,...value}));assert.deepEqual(f.state().automations[0],before);
 await f.reopen();assert.equal(f.state().automations[0].executionMode,'heartbeat');
});
test('standalone creates a fresh thread per run without source history/attachments/native identity',async t=>{
 const f=await fixture(t);await f.act('threads:prompt',{id:f.sourceId,prompt:'SOURCE_PRIVATE_HISTORY'});await until(f.state,s=>s.runningCount===0);await writeFile(join(f.dir,'attachment.txt'),'SOURCE_ATTACHMENT');await f.act('attachments:add',{id:f.sourceId,path:join(f.dir,'attachment.txt')});await f.act('threads:model',{id:f.sourceId,model:'fixture-model'});
 const id=await f.create('standalone',{memory:'EXPLICIT_MEMORY'});const first=await f.run(id),second=await f.run(id);
 assert.notEqual(first.id,second.id);for(const thread of [first,second]){assert.notEqual(thread.id,f.sourceId);assert.equal(thread.runs.length,1);assert.equal(thread.messages.length,2);assert.ok(thread.runs[0].stdout.includes('EXPLICIT_MEMORY'));assert.ok(!thread.runs[0].stdout.includes('SOURCE_PRIVATE_HISTORY'));assert.ok(!thread.runs[0].stdout.includes('SOURCE_ATTACHMENT'));assert.deepEqual(thread.attachments,[]);assert.equal(thread.nativeThreadId,undefined);assert.equal(thread.model,'fixture-model');}
 assert.equal(f.state().threads.find(t=>t.id===f.sourceId).runs.length,1);
});
test('dedicated owns one clean conversation and continues it across restart',async t=>{
 const f=await fixture(t);const id=await f.create('dedicated');const first=await f.run(id);assert.equal(first.messages.length,2);assert.equal(f.state().automations[0].ownedThreadId,first.id);await f.reopen();const second=await f.run(id);assert.equal(second.id,first.id);assert.equal(second.runs.length,2);assert.equal(second.messages.length,4);assert.equal(f.state().threads.find(t=>t.id===f.sourceId).messages.length,0);
});
test('dedicated conversation rejects independent prompt/steer/edit/model/attachment/delete writers',async t=>{
 const f=await fixture(t);const id=await f.create('dedicated'),thread=await f.run(id);
 for(const [action,payload]of [['threads:prompt',{prompt:'manual'}],['control:steer',{prompt:'manual'}],['threads:model',{model:''}],['attachments:add',{path:join(f.dir,'not-read')}],['threads:rollback',{messageId:thread.messages[0].id}],['threads:delete',{}]])await assert.rejects(f.act(action,{id:thread.id,...payload}),e=>e.error_code==='VEK_AGENT_AUTOMATION_OWNED');
 assert.equal(f.state().threads.find(t=>t.id===thread.id).runs.length,1);await assert.rejects(f.act('automations:create',{threadId:thread.id,prompt:'nested',kind:'interval',intervalMs:1000}),/user conversation/);
});
test('heartbeat appends to the supplied thread with its existing conversation',async t=>{
 const f=await fixture(t);await f.act('threads:prompt',{id:f.sourceId,prompt:'EXISTING_CONTEXT'});await until(f.state,s=>!s.runningCount);const id=await f.create('heartbeat');const thread=await f.run(id);assert.equal(thread.id,f.sourceId);assert.equal(thread.runs.length,2);assert.match(thread.runs[1].stdout,/EXISTING_CONTEXT/);assert.equal(f.state().automations[0].ownedThreadId,undefined);
});
test('one definition cannot overlap standalone runs; capacity failure leaves no empty owned thread',async t=>{
 const f=await fixture(t,{maxConcurrentRuns:1});const id=await f.create('standalone',{prompt:'[slow]'});await f.act('automations:run',{id});await until(f.state,s=>s.threads.some(t=>t.runs.at(-1)?.stdout.includes('READY')));await f.act('automations:run',{id});assert.equal(f.state().automations[0].lastOutcome,'skipped-overlap');assert.equal(f.state().automations[0].runCount,1);
 const other=await f.create('dedicated');await f.act('automations:run',{id:other});assert.equal(f.state().automations[1].lastOutcome,'skipped-capacity');assert.equal(f.state().automations[1].ownedThreadId,undefined);assert.equal(f.state().threads.length,2);await f.act('automations:stop',{id});
});
test('Stop pauses future ticks and terminates the generated run, not its template',async t=>{
 const f=await fixture(t);const id=await f.create('standalone',{prompt:'[slow]'});await f.act('automations:run',{id});await until(f.state,s=>s.threads.some(t=>t.runs.at(-1)?.stdout.includes('READY')));const ownId=f.state().automations[0].lastRunThreadId;await f.act('automations:stop',{id});const state=f.state();assert.equal(state.automations[0].status,'paused');assert.equal(state.runningCount,0);assert.equal(state.threads.find(t=>t.id===ownId).runs[0].status,'stopped');assert.equal(state.threads.find(t=>t.id===f.sourceId).runs.length,0);
});
test('Delete stops an active dedicated run and releases its retained conversation',async t=>{
 const f=await fixture(t);const id=await f.create('dedicated',{prompt:'[slow]'});await f.act('automations:run',{id});await until(f.state,s=>s.threads.some(t=>t.runs.at(-1)?.stdout.includes('READY')));const ownId=f.state().automations[0].ownedThreadId;await f.act('automations:delete',{id});assert.equal(f.state().automations.length,0);assert.equal(f.state().runningCount,0);assert.equal(f.state().threads.find(t=>t.id===ownId).automationOwnerId,undefined);await f.act('threads:prompt',{id:ownId,prompt:'MANUAL_AFTER_RELEASE'});await until(f.state,s=>!s.runningCount);assert.equal(f.state().threads.find(t=>t.id===ownId).runs.length,2);
});
test('changing mode is blocked while active; an idle change releases the old dedicated thread',async t=>{
 const f=await fixture(t);const id=await f.create('dedicated',{prompt:'[slow]'});await f.act('automations:run',{id});const before=f.state().automations[0];await assert.rejects(f.act('automations:update',{id,executionMode:'standalone'}),/Stop/);assert.deepEqual(f.state().automations[0],before);await f.act('automations:stop',{id});await f.act('automations:update',{id,executionMode:'standalone',prompt:'NEW_MODE'});assert.equal(f.state().automations[0].ownedThreadId,undefined);assert.equal(f.state().threads.find(t=>t.id===before.ownedThreadId).automationOwnerId,undefined);assert.notEqual((await f.run(id)).id,before.ownedThreadId);
});
test('imports retain transcript data but never inherit owned binding or closed-app consent',async t=>{
 const f=await fixture(t);const id=await f.create('dedicated',{closedAppAllowed:true});await f.run(id);const exported=JSON.parse((await f.act('export')).exportData.content);const originalIds=new Set(f.state().automations.map(a=>a.id));await f.act('import',{data:exported});const imported=f.state().automations.find(a=>!originalIds.has(a.id));assert.equal(imported.status,'paused');assert.equal(imported.closedAppAllowed,false);assert.equal(imported.ownedThreadId,undefined);assert.equal(f.state().runningCount,0);const template=f.state().threads.find(t=>t.id===imported.threadId),provider=f.state().providers.find(p=>p.id===template.providerId);assert.equal(provider.enabled,false);await f.act('providers:configure',{...provider,enabled:true});const fresh=await f.run(imported.id);assert.equal(fresh.runs.length,1);assert.equal(fresh.automationOwnerId,imported.id);
});
test('scheduled reservation precedes generated thread creation and never replays after reopen',async t=>{
 const observed=[];const f=await fixture(t,{onChange:s=>observed.push(s)});const id=await f.create('standalone',{kind:'at',at:new Date().toISOString(),status:'active'});f.service.runDueOnce();await until(f.state,s=>!s.runningCount);const reserved=observed.find(s=>s.automations.some(a=>a.id===id&&a.lastOutcome==='reserved'));assert.equal(reserved.threads.length,1);assert.equal(reserved.automations[0].nextRunAt,null);await f.reopen();assert.deepEqual(f.service.runDueOnce().attempted,[]);assert.equal(f.state().threads.length,2);
});
test('deleting a template stops linked generated runs and releases their history',async t=>{
 const f=await fixture(t);const id=await f.create('dedicated',{prompt:'[slow]'});await f.act('automations:run',{id});const ownId=f.state().automations[0].ownedThreadId;await f.act('threads:delete',{id:f.sourceId});assert.equal(f.state().automations.length,0);assert.equal(f.state().runningCount,0);assert.equal(f.state().threads.length,1);assert.equal(f.state().threads[0].id,ownId);assert.equal(f.state().threads[0].automationOwnerId,undefined);
});
test('closed-app opt-in refuses native protocols and defaults to off for every mode',async t=>{
 const f=await fixture(t);await f.act('providers:configure',{id:'fixture',name:'Native fixture not executed',command:process.execPath,args:[],protocol:'codex-app-server',inputMode:'stdin'});await assert.rejects(f.create('standalone',{closedAppAllowed:true}),/plain CLI/);assert.equal(f.state().automations.length,0);await f.create('dedicated');assert.equal(f.state().automations[0].closedAppAllowed,false);
});

test('an archived or missing dedicated conversation is reported and never silently replaced',async t=>{
 const f=await fixture(t);const id=await f.create('dedicated'),thread=await f.run(id);await f.act('threads:archive',{id:thread.id});await f.act('automations:run',{id});assert.equal(f.state().automations[0].lastOutcome,'failed');assert.match(f.state().automations[0].lastError,/archived/);assert.equal(f.state().threads.length,2);await f.service.close();const file=join(f.dir,'agents/state.json'),state=JSON.parse(await readFile(file,'utf8'));state.threads=state.threads.filter(t=>t.id!==thread.id);await writeFile(file,JSON.stringify(state));await f.reopen();await f.act('automations:run',{id});assert.equal(f.state().automations[0].lastOutcome,'failed');assert.equal(f.state().automations[0].ownedThreadId,thread.id);assert.equal(f.state().threads.length,1);
});
test('Pause preserves the current generated run while Stop explicitly cancels it',async t=>{
 const f=await fixture(t);const id=await f.create('dedicated',{prompt:'[slow]'});await f.act('automations:run',{id});await until(f.state,s=>s.threads.some(t=>t.runs.at(-1)?.stdout.includes('READY')));await f.act('automations:pause',{id});assert.equal(f.state().runningCount,1);assert.equal(f.state().automations[0].status,'paused');await until(f.state,s=>!s.runningCount);assert.equal(f.state().threads.at(-1).runs[0].status,'completed');assert.equal(f.state().automations[0].status,'paused');
});

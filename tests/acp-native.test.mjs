import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const {createAgentService}=createRequire(import.meta.url)('../app/agent-service.cjs');
const {catalogue}=createRequire(import.meta.url)('../app/acp-session.cjs');
const peer=await readFile(new URL('./fixtures/acp-peer.cjs',import.meta.url),'utf8');
async function wait(read,match){const end=Date.now()+7000;while(Date.now()<end){const v=await read();if(match(v))return v;await new Promise(r=>setTimeout(r,15));}throw Error('Timeout '+JSON.stringify(await read()));}
async function fixture(t,args=[],options={}){
 const directory=await mkdtemp(join(tmpdir(),'vek-acp-')),script=join(directory,'peer.cjs'),auditPath=join(directory,'audit.jsonl');await writeFile(script,peer);
 const make=()=>createAgentService({dataDir:directory,...options,runContext:()=>({env:{VEK_ACP_AUDIT:auditPath},promptPrefix:'Scoped context'})});let service=make();
 t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true})});
 const config={id:'acp-fixture',name:'ACP fixture',command:process.execPath,args:[script,...args],protocol:'opencode-acp',inputMode:'stdin'};
 await service.dispatch('agents:providers:configure',config);await service.dispatch('agents:projects:create',{name:'Fixture',path:directory});
 await service.dispatch('agents:threads:create',{projectId:service.snapshot().projects[0].id,providerId:config.id,title:'ACP QA'});const id=service.snapshot().threads[0].id;
 return {directory,config,id,get service(){return service},thread:()=>service.snapshot().threads.find(x=>x.id===id),audit:async()=>{try{return(await readFile(auditPath,'utf8')).trim().split('\n').map(JSON.parse)}catch{return[]}},prompt:text=>service.dispatch('agents:threads:prompt',{id,prompt:text}),settled:()=>wait(()=>service.snapshot().threads.find(x=>x.id===id),x=>!['running','discovering'].includes(x.status)),restart:async()=>{await service.close();service=make()}};
}
test('ACP model discovery sends no prompt or run, persists actual models, then loads without replaying history',async t=>{
 const f=await fixture(t);await f.service.dispatch('agents:threads:discover-models',{id:f.id});const found=await f.settled();
 assert.equal(found.status,'idle');assert.equal(found.modelDiscovery.status,'completed');assert.equal(found.runs.length,0);assert.equal(found.messages.length,0);assert.deepEqual(found.nativeCatalog.models.map(x=>x.id),['fixture/a','fixture/b']);
 assert.equal((await f.audit()).some(x=>x.method==='session/prompt'),false);
 await f.service.dispatch('agents:threads:model',{id:f.id,model:'fixture/b'});await f.restart();await f.prompt('First actual turn');const done=await f.settled();assert.equal(done.status,'completed');
 assert.equal(done.runs[0].stdout.includes('REPLAY'),false);assert.equal(done.runs[0].toolEvents.some(x=>x.id==='replayed'),false);
 const wire=await f.audit();assert.ok(wire.some(x=>x.method==='session/load'));assert.equal(wire.find(x=>x.method==='session/set_config_option').params.value,'fixture/b');assert.equal(wire.filter(x=>x.method==='session/prompt').length,1);
 await assert.rejects(f.service.dispatch('agents:threads:model',{id:f.id,model:'unknown'}),/observed/);
});
test('ACP first prompt after discovery retains copied local history and later prompts send only new text',async t=>{
 const f=await fixture(t);await f.service.dispatch('agents:threads:model',{id:f.id,model:'missing'});await f.prompt('Earlier local history');await f.settled();
 await f.service.dispatch('agents:threads:model',{id:f.id,model:''});await f.service.dispatch('agents:threads:discover-models',{id:f.id});await f.settled();
 await f.prompt('Continue copied text');assert.equal((await f.settled()).status,'completed');assert.match((await f.audit()).find(x=>x.method==='session/prompt').params.prompt[0].text,/Earlier local history/);
 await f.prompt('Only latest');await f.settled();assert.equal((await f.audit()).filter(x=>x.method==='session/prompt').at(-1).params.prompt[0].text.includes('Earlier local history'),false);
});
test('ACP actual chunks/attachments/tools/child evidence/usage survive restart with a scoped resume prompt',async t=>{
 const f=await fixture(t),png=join(f.directory,'image.png'),pdf=join(f.directory,'document.pdf'),txt=join(f.directory,'context.md');
 await writeFile(png,Buffer.from('89504e470d0a1a0a','hex'));await writeFile(pdf,'%PDF-1.4\nfixture');await writeFile(txt,'Actual attachment 世界');await f.service.dispatch('agents:attachments:add',{id:f.id,paths:[png,pdf,txt]});
 await f.prompt('Original request');const done=await f.settled(),run=done.runs[0];assert.equal(done.status,'completed');assert.match(run.stdout,/Hello 世界/);assert.equal(run.stdout.includes('Child-only'),false);
 assert.match(run.toolEvents[0].result,/Actual tool output/);assert.match(run.toolEvents[0].result,/Diff note.txt/);assert.equal(run.toolEvents[0].status,'completed');assert.equal(run.subagents[0].messages[0].content,'Child-only answer');assert.equal(run.subagents[0].status,'unresolved');assert.equal(run.toolEvents[1].status,'unresolved');assert.equal(run.usage.inputTokens,12);assert.equal(run.usage.sessionCostUsd,0.005);assert.deepEqual(run.contextUsage,{used:32,size:4096});
 const wire=await f.audit(),prompt=wire.find(x=>x.method==='session/prompt').params.prompt;assert.deepEqual(prompt.map(x=>x.type),['text','image','resource','resource']);assert.equal(prompt[1].data,Buffer.from('89504e470d0a1a0a','hex').toString('base64'));assert.match(prompt[3].resource.text,/Actual attachment/);
 assert.deepEqual(wire.find(x=>x.method==='initialize').params.clientCapabilities,{fs:{readTextFile:false,writeTextFile:false},terminal:false,auth:{terminal:false}});
 await f.restart();assert.equal(f.thread().runs[0].toolEvents[0].status,'completed');await f.prompt('Second request');assert.equal((await f.settled()).status,'completed');const second=(await f.audit()).filter(x=>x.method==='session/prompt')[1].params.prompt[0].text;assert.match(second,/Second request/);assert.equal(second.includes('Original request'),false);
});
test('ACP approvals select once options only, never persistent grants, and reject unavailable accept',async t=>{
 const f=await fixture(t);
 for(const [marker,decision,optionId] of [['approval','accept','once'],['approval','decline','reject'],['always-only','decline','reject']]){
  await f.prompt('['+marker+']');const pending=await wait(f.thread,x=>x.runs.at(-1).approvals?.[0]?.status==='pending'),a=pending.runs.at(-1).approvals[0];
  if(marker==='always-only'){assert.equal(a.canAccept,false);await assert.rejects(f.service.dispatch('agents:control:approval',{id:f.id,approvalId:a.id,decision:'accept'}),/single-use/);}
  await f.service.dispatch('agents:control:approval',{id:f.id,approvalId:a.id,decision});assert.equal((await f.settled()).status,'completed');assert.equal((await f.audit()).filter(x=>x.id==='permission-one').at(-1).result.outcome.optionId,optionId);
 }
});
test('ACP stop cancels pending permissions and emits native cancellation without an automatic grant',async t=>{
 const f=await fixture(t);await f.prompt('[approval]');await wait(f.thread,x=>x.runs[0].approvals?.[0]?.status==='pending');await f.service.dispatch('agents:control:stop',{id:f.id});assert.equal(f.thread().status,'stopped');
 const wire=await f.audit();assert.deepEqual(wire.find(x=>x.id==='permission-one').result,{outcome:{outcome:'cancelled'}});assert.ok(wire.some(x=>x.method==='session/cancel'));assert.equal(f.thread().runs[0].approvals[0].status,'expired');
});
test('ACP discovery occupies the project lease, is cancellable before initialize, and creates no history',async t=>{
 const f=await fixture(t,['--slow-init']);await f.service.dispatch('agents:threads:discover-models',{id:f.id});
 await assert.rejects(f.service.dispatch('agents:providers:configure',f.config),/runs|active/i);await assert.rejects(f.prompt('Must not send'),/already running/);
 await assert.rejects(f.service.dispatch('agents:control:steer',{id:f.id,prompt:'Do not queue during discovery'}),/discovery/);assert.equal(f.thread().pendingFollowUps?.length||0,0);
 await f.service.dispatch('agents:threads:create',{projectId:f.thread().projectId,providerId:f.config.id,title:'Other'});const other=f.service.snapshot().threads.at(-1).id;
 await assert.rejects(f.service.dispatch('agents:threads:prompt',{id:other,prompt:'Conflict'}),/protected turn/);
 await f.service.dispatch('agents:control:stop',{id:f.id});assert.equal(f.thread().status,'idle');assert.equal(f.thread().modelDiscovery.status,'cancelled');assert.equal(f.thread().runs.length,0);assert.equal((await f.audit()).some(x=>x.method==='session/prompt'),false);
});
test('ACP grouped model catalogue explicitly marks truncation across groups',()=>{
 const groups=Array.from({length:2},(_,g)=>({group:'group'+g,options:Array.from({length:200},(_,i)=>({value:`model/${g}/${i}`,name:`Model ${i}`}))}));
 const result=catalogue({configOptions:[{id:'model',category:'model',type:'select',currentValue:'model/0/0',options:groups}]});assert.equal(result.models.length,256);assert.equal(result.truncated,true);assert.equal(result.currentModelId,'model/0/0');
});
test('ACP legacy model setter is used only when advertised',async t=>{
 const f=await fixture(t,['--legacy']);await f.service.dispatch('agents:threads:model',{id:f.id,model:'fixture/b'});await f.prompt('Legacy');assert.equal((await f.settled()).status,'completed');const wire=await f.audit();assert.ok(wire.some(x=>x.method==='session/set_model'&&x.params.modelId==='fixture/b'));assert.equal(wire.some(x=>x.method==='session/set_config_option'),false);
});
test('ACP rejects stale and unconfirmed model selection before prompt',async t=>{
 const f=await fixture(t);await f.service.dispatch('agents:threads:model',{id:f.id,model:'unknown'});await f.prompt('No model');let done=await f.settled();assert.equal(done.status,'failed');assert.match(done.runs[0].error,/absent/);assert.equal((await f.audit()).some(x=>x.method==='session/prompt'),false);
 await f.service.dispatch('agents:providers:configure',{...f.config,args:[...f.config.args,'--reject-model']});await f.service.dispatch('agents:threads:model',{id:f.id,model:'fixture/b'});await f.prompt('Wrong confirmation');done=await f.settled();assert.equal(done.status,'failed');assert.match(done.runs.at(-1).error,/confirm/);assert.equal((await f.audit()).some(x=>x.method==='session/prompt'),false);
});
for(const [marker,pattern] of [['disconnect',/before turn completed/],['malformed',/JSON|Unexpected/],['oversize',/4 MiB/],['wrong-session',/different session/],['unknown-stop',/recognized stop/]])test('ACP '+marker+' fails without fabricated completion',async t=>{
 const f=await fixture(t);await f.prompt('['+marker+']');const done=await f.settled();assert.equal(done.status,'failed');assert.match(done.runs[0].error,pattern);
});
test('ACP rejects a wrong protocol version and unsupported attachment capabilities before prompt',async t=>{
 const f=await fixture(t,['--bad-version']);await f.prompt('Version');assert.equal((await f.settled()).status,'failed');assert.equal((await f.audit()).some(x=>x.method==='session/new'),false);
 await f.service.dispatch('agents:providers:configure',{...f.config,args:[f.config.args[0],'--no-attachments']});const file=join(f.directory,'context.md');await writeFile(file,'Actual file');await f.service.dispatch('agents:attachments:add',{id:f.id,paths:[file]});await f.prompt('Attachment');assert.match((await f.settled()).runs.at(-1).error,/advertise support/);assert.equal((await f.audit()).some(x=>x.method==='session/prompt'),false);
});
test('ACP declines filesystem delegation and bounds actual display output',async t=>{
 const f=await fixture(t,[],{maxOutputBytes:128});await f.prompt('[client-method]');assert.equal((await f.settled()).status,'completed');assert.equal((await f.audit()).find(x=>x.id==='fs-one').error.code,-32601);
 await f.prompt('x'.repeat(500));const run=(await f.settled()).runs.at(-1);assert.equal(run.truncated,true);assert.ok(Buffer.byteLength(run.stdout)<=128);
});
test('ACP changed provider/import/export cannot transfer native session or model catalogue authority',async t=>{
 const f=await fixture(t);await f.prompt('Original');await f.settled();assert.ok(f.thread().nativeThreadId);
 const data=JSON.parse((await f.service.dispatch('agents:export')).exportData.content);assert.equal(data.threads[0].nativeThreadId,undefined);assert.equal(data.threads[0].nativeCatalog,undefined);assert.equal(data.threads[0].nativeContextSent,undefined);await f.service.dispatch('agents:import',{data});const imported=f.service.snapshot().threads.at(-1);assert.equal(imported.nativeThreadId,undefined);assert.equal(imported.nativeCatalog,undefined);
 await f.service.dispatch('agents:providers:configure',{...f.config,args:[...f.config.args,'changed']});assert.equal(f.thread().nativeCatalog,undefined);await f.prompt('Changed');await f.settled();assert.equal((await f.audit()).filter(x=>x.method==='session/new').length,2);
});
test('ACP preflights combined actual attachment bytes before creating a run or spawning',async t=>{
 const f=await fixture(t),files=[join(f.directory,'a.txt'),join(f.directory,'b.txt')];for(const file of files)await writeFile(file,'x'.repeat(13*1024*1024));await f.service.dispatch('agents:attachments:add',{id:f.id,paths:files});await assert.rejects(f.prompt('Too large'),/24 MiB/);assert.equal(f.thread().runs.length,0);assert.equal((await f.audit()).length,0);
});

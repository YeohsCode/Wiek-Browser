import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { createAgentService } = createRequire(import.meta.url)('../app/agent-service.cjs');
const { claudeLaunch } = createRequire(import.meta.url)('../app/claude-session.cjs');

// Own protocol peer, never a model and never the user's Claude config/history.
const peer=await readFile(new URL('./fixtures/claude-peer.cjs',import.meta.url),'utf8');
async function wait(read, match) { const end=Date.now()+7000; while(Date.now()<end){const v=await read();if(match(v))return v;await new Promise(r=>setTimeout(r,15));}throw Error('Timed out: '+JSON.stringify(await read())); }
async function fixture(t,options={}) {
 const directory=await mkdtemp(join(tmpdir(),'vek-claude-')),script=join(directory,'peer.cjs'),auditPath=join(directory,'audit.jsonl');
 await writeFile(script,peer);
 const make=()=>createAgentService({dataDir:directory,...options,runContext:()=>({env:{VEK_CLAUDE_AUDIT:auditPath},promptPrefix:'Scoped browser context'})});
 let service=make();
 t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
 const config={id:'claude-fixture',name:'Claude wire fixture',command:process.execPath,args:[script],protocol:'claude-stream-json',inputMode:'stdin'};
 await service.dispatch('agents:providers:configure',config);
 await service.dispatch('agents:projects:create',{name:'Fixture',path:directory});
 await service.dispatch('agents:threads:create',{projectId:service.snapshot().projects[0].id,providerId:config.id,title:'Claude native QA',model:'fixture-only'});
 const id=service.snapshot().threads[0].id;
 return {directory,config,id,get service(){return service},thread:()=>service.snapshot().threads.find(x=>x.id===id),
   audit:async()=>{try{return(await readFile(auditPath,'utf8')).trim().split('\n').map(JSON.parse)}catch{return[]}},
   prompt:text=>service.dispatch('agents:threads:prompt',{id,prompt:text}),
   settled:()=>wait(()=>service.snapshot().threads.find(x=>x.id===id),x=>x.status!=='running'),
   restart:async()=>{await service.close();service=make();},
 };
}

test('Claude native streams UTF-8 once, records tools/usage, attaches actual image/PDF/text, resumes after restart',async t=>{
 const f=await fixture(t);
 const png=join(f.directory,'image.png'),pdf=join(f.directory,'document.pdf'),txt=join(f.directory,'context.md');
 await writeFile(png,Buffer.from('89504e470d0a1a0a','hex'));await writeFile(pdf,'%PDF-1.4\nfixture');await writeFile(txt,'Attachment body 世界');
 await f.service.dispatch('agents:attachments:add',{id:f.id,paths:[png,pdf,txt]});
 await f.prompt('First prompt');const first=await f.settled();assert.equal(first.status,'completed');
 assert.match(first.runs[0].stdout,/Hello 世界/);assert.equal((first.runs[0].stdout.match(/Hello/g)||[]).length,1);assert.equal(first.runs[0].stdout.includes('hidden subagent'),false);
 assert.equal(first.runs[0].toolEvents.length,1);assert.equal(first.runs[0].toolEvents[0].name,'Read');assert.equal(first.runs[0].usage.inputTokens,20);assert.equal(first.runs[0].usage.cachedInputTokens,3);
 assert.equal(first.runs[0].nativeThreadId,first.nativeThreadId);assert.ok(first.runs[0].nativeUserMessageId);assert.equal(first.runs[0].nativeTurnId,undefined);assert.equal(first.runs[0].usage.sessionCostUsd,0.004);
 const audit=await f.audit(),input=audit.find(x=>x.type==='user'),args=audit.find(x=>x.argv).argv;
 assert.deepEqual(input.message.content.map(x=>x.type),['text','image','document','text']);assert.equal(input.message.content[1].source.data,Buffer.from('89504e470d0a1a0a','hex').toString('base64'));assert.match(input.message.content[3].text,/Attachment body 世界/);
 assert.ok(args.includes('--model=fixture-only'));assert.ok(args.includes('--permission-prompt-tool'));assert.ok(args.includes('stdio'));assert.equal(args.includes('--dangerously-skip-permissions'),false);
 await f.restart();await f.prompt('Second prompt');assert.equal((await f.settled()).status,'completed');
 const again=await f.audit();assert.ok(again.filter(x=>x.argv)[1].argv.includes('--resume='+first.nativeThreadId));
 const second=again.filter(x=>x.type==='user')[1].message.content[0].text;assert.match(second,/Second prompt/);assert.equal(second.includes('First prompt'),false);
});

test('Claude approvals are request-scoped explicit accept/decline and preserve the exact original input',async t=>{
 const f=await fixture(t);
 for(const decision of ['decline','accept']){
  await f.prompt('[approval]');const pending=await wait(f.thread,x=>x.runs.at(-1).approvals?.[0]?.status==='pending');const approval=pending.runs.at(-1).approvals[0];
  assert.equal((await f.audit()).filter(x=>x.type==='control_response').length,decision==='decline'?0:1);
  await assert.rejects(f.service.dispatch('agents:control:approval',{id:f.id,approvalId:approval.id,decision:'acceptForSession'}),/accept, decline, or cancel/);
  await f.service.dispatch('agents:control:approval',{id:f.id,approvalId:approval.id,decision});
  const settled=await f.settled();assert.match(settled.runs.at(-1).stdout,new RegExp('Decision: '+(decision==='accept'?'allow':'deny')));
  await assert.rejects(f.service.dispatch('agents:control:approval',{id:f.id,approvalId:approval.id,decision}),/No verified/);
 }
 const result=(await f.audit()).filter(x=>x.type==='control_response').at(-1).response.response;
 assert.deepEqual(result,{behavior:'allow',updatedInput:{command:'printf fixture-only',other:'<literal>'}});
});

test('Claude cancelled permissions expire without a response and duplicate request identities fail closed',async t=>{
 const f=await fixture(t);await f.prompt('[cancelled-approval]');
 const expired=await wait(f.thread,x=>x.runs[0].approvals?.[0]?.status==='expired');
 await assert.rejects(f.service.dispatch('agents:control:approval',{id:f.id,approvalId:expired.runs[0].approvals[0].id,decision:'accept'}),/No verified/);
 assert.equal((await f.settled()).status,'completed');assert.equal((await f.audit()).some(x=>x.type==='control_response'),false);
 await f.prompt('[duplicate-request]');const failed=await f.settled();assert.equal(failed.status,'failed');assert.match(failed.runs.at(-1).error,/repeated/);
});

test('Claude steering is an honest queued follow-up, stop interrupts, and approval cancel stops the turn',async t=>{
 const f=await fixture(t);await f.prompt('[slow]');await wait(f.audit,x=>x.some(v=>v.type==='user'));
 await f.service.dispatch('agents:control:steer',{id:f.id,prompt:'Queued next turn'});assert.equal(f.thread().pendingFollowUps.length,1);
 await f.service.dispatch('agents:control:stop',{id:f.id});assert.equal(f.thread().status,'stopped');assert.equal(f.thread().pendingFollowUps.length,0);assert.equal(f.thread().runs.length,1);
 assert.ok((await f.audit()).some(x=>x.request?.subtype==='interrupt'));
 await f.prompt('[approval]');const pending=await wait(f.thread,x=>x.runs.at(-1).approvals?.[0]?.status==='pending');
 await f.service.dispatch('agents:control:approval',{id:f.id,approvalId:pending.runs.at(-1).approvals[0].id,decision:'cancel'});assert.equal(f.thread().status,'stopped');
});

for(const [marker,pattern] of [['disconnect',/before turn completed/],['malformed',/JSON|Unexpected/],['oversize',/4 MiB/],['wrong-session',/different session/],['failure',/Fixture failed/]])test('Claude '+marker+' cannot become successful completion',async t=>{
 const f=await fixture(t);await f.prompt('['+marker+']');const result=await f.settled();assert.equal(result.status,'failed');assert.match(result.runs[0].error,pattern);
});

test('Claude edit/fork/import and changed executable arguments cannot reuse native session authority',async t=>{
 const f=await fixture(t);await f.prompt('Original');const first=await f.settled();
 await f.service.dispatch('agents:threads:edit',{id:f.id,messageId:first.messages[0].id,content:'Edited'});await f.prompt('After edit');await f.settled();
 assert.ok((await f.audit()).filter(x=>x.argv)[1].argv.some(x=>x.startsWith('--session-id=')));
 await f.service.dispatch('agents:providers:configure',{...f.config,args:[f.config.args[0],'extra-unused']});await f.prompt('Changed configuration');await f.settled();
 assert.ok((await f.audit()).filter(x=>x.argv)[2].argv.some(x=>x.startsWith('--session-id=')));
 const exported=JSON.parse((await f.service.dispatch('agents:export')).exportData.content);assert.equal(exported.threads[0].nativeThreadId,undefined);assert.equal(exported.threads[0].nativeSessionBinding,undefined);
 await f.service.dispatch('agents:import',{data:exported});const imported=f.service.snapshot().threads.find(x=>x.id!==f.id);assert.equal(imported.nativeThreadId,undefined);
 assert.equal(f.service.snapshot().providers.find(x=>x.id===imported.providerId).protocol,'claude-stream-json');assert.equal(f.service.snapshot().providers.find(x=>x.id===imported.providerId).enabled,false);
});

test('Claude launch preflights combined attachments and rejects conflicting protocol flags',()=>{
 for(const arg of ['--resume=somewhere','--dangerously-skip-permissions','--settings','--model=other','-p','--tools='])assert.throws(()=>claudeLaunch({args:[arg],attachments:[]}),/owns session/);
 assert.throws(()=>claudeLaunch({args:[],attachments:[],resumeId:'--bad'}),/resume id/);
});


test('Claude oversized combined attachments fail before spawn and leave no fabricated run',async t=>{
 const f=await fixture(t),a=join(f.directory,'a.txt'),b=join(f.directory,'b.txt');
 await writeFile(a,'a'.repeat(13*1024*1024));await writeFile(b,'b'.repeat(13*1024*1024));
 await f.service.dispatch('agents:attachments:add',{id:f.id,paths:[a,b]});
 await assert.rejects(f.prompt('Too large'),/24 MiB/);assert.equal(f.thread().runs.length,0);assert.equal((await f.audit()).length,0);
});

test('Claude output shares the actual byte budget and immediate cancellation sends no user prompt',async t=>{
 const f=await fixture(t,{maxOutputBytes:128});await f.prompt('x'.repeat(400));const done=await f.settled();assert.equal(done.status,'completed');assert.equal(done.runs[0].truncated,true);assert.ok(Buffer.byteLength(done.runs[0].stdout)<=128);
 const previous=(await f.audit()).filter(x=>x.type==='user').length;
 await f.prompt('Cancelled before initialize completes');await f.service.dispatch('agents:control:stop',{id:f.id});assert.equal(f.thread().status,'stopped');assert.equal((await f.audit()).filter(x=>x.type==='user').length,previous);
});


test('real Claude wire retains parallel block tools/results and child lifecycle without polluting main answer',async t=>{
 const f=await fixture(t);await f.prompt('[activity]');const done=await f.settled(),run=done.runs[0];
 assert.equal(done.status,'completed');assert.equal(run.toolEvents.find(x=>x.id==='parallel-one').result,'Actual tool output');assert.equal(run.toolEvents.find(x=>x.id==='parallel-two').status,'failed');assert.equal(run.toolEvents.find(x=>x.id==='nested').parentToolUseId,'agent-peer');
 const child=run.subagents.find(x=>x.id==='agent-peer');assert.equal(child.status,'completed');assert.equal(child.summary,'Child reviewed');assert.equal(child.messages.filter(x=>x.role==='assistant').length,1);assert.equal(run.stdout.includes('Child-only'),false);
 assert.equal((await f.audit()).find(x=>x.request?.subtype==='initialize').request.forwardSubagentText,true);
 await f.restart();assert.equal(f.thread().runs[0].subagents.find(x=>x.id==='agent-peer').status,'completed');
 const exported=JSON.parse((await f.service.dispatch('agents:export')).exportData.content);await f.service.dispatch('agents:import',{data:exported});assert.equal(f.service.snapshot().threads.at(-1).runs[0].toolEvents.find(x=>x.id==='parallel-one').result,'Actual tool output');
});

test('real Claude stop settles pending subagent activity as interrupted',async t=>{
 const f=await fixture(t);await f.prompt('[activity-slow]');await wait(f.thread,x=>x.runs[0].subagents?.some(v=>v.id==='agent-peer'&&v.status==='running'));
 await f.service.dispatch('agents:control:stop',{id:f.id});const run=f.thread().runs[0];assert.equal(run.status,'stopped');assert.equal(run.subagents.find(x=>x.id==='agent-peer').status,'interrupted');assert.equal(run.toolEvents.find(x=>x.id==='parallel-one').status,'completed');
});

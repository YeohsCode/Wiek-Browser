import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createAgentService}=require('../app/agent-service.cjs'),{parseHistory,selectBranch,readHistory}=require('../app/claude-history.cjs');
function history(){
 const session=randomUUID(),ids=Object.fromEntries(['u','a','b','ra','rb','u2','answer','other','side'].map(key=>[key,randomUUID()]));
 const entry=(key,parent,type,content,extra={})=>({uuid:ids[key],parentUuid:parent?ids[parent]:null,sessionId:session,type,message:{role:type,content},...extra});
 const rows=[entry('u',null,'user','Original request'),entry('a','u','assistant',[{type:'text',text:'Working'},{type:'tool_use',id:'a',name:'Read',input:{file_path:'/never-read-this'}}],{message:{id:'api-parallel',role:'assistant',content:[{type:'text',text:'Working'},{type:'tool_use',id:'a',name:'Read',input:{file_path:'/never-read-this'}}]}}),entry('b','a','assistant',[{type:'tool_use',id:'b',name:'Bash',input:{command:'never execute'}}],{message:{id:'api-parallel',role:'assistant',content:[{type:'tool_use',id:'b',name:'Bash',input:{command:'never execute'}}]}}),entry('ra','a','user',[{type:'tool_result',tool_use_id:'a',content:'Read result'}]),entry('rb','b','user',[{type:'tool_result',tool_use_id:'b',is_error:true,content:'Fixture error'}]),entry('u2','rb','user',[{type:'text',text:'Continue here'},{type:'image',source:{type:'file',path:'/never-follow-image'}},{type:'document',source:{type:'file',path:'/never-follow-pdf'}}]),entry('answer','u2','assistant','Selected final answer'),entry('other','u','assistant','Alternative answer'),entry('side',null,'assistant','Excluded sidechain',{isSidechain:true,sessionId:randomUUID()}),{type:'file-history-snapshot',snapshot:{path:'/never-follow-snapshot'}}];
 return {session,ids,rows,bytes:()=>Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n')};
}
async function fixture(t){
 const dir=await fs.mkdtemp(join(tmpdir(),'vek-history-')),file=join(dir,'session.jsonl'),h=history();await fs.writeFile(file,h.bytes());
 const service=createAgentService({dataDir:join(dir,'data')});t.after(async()=>{await service.close();await fs.rm(dir,{recursive:true,force:true})});
 let s=await service.dispatch('agents:providers:configure',{id:'peer',name:'History test peer',command:process.execPath,args:[resolve('tests/fixtures/claude-peer.cjs'),'--vek-audit='+join(dir,'wire.jsonl')],inputMode:'stdin',protocol:'claude-stream-json'});
 s=await service.dispatch('agents:projects:create',{name:'Imported project',path:dir});const projectId=s.projects.at(-1).id;
 return {dir,file,h,service,projectId,preview:async()=> (await service.dispatch('agents:claude:preview',{path:file})).claudeImportPreview,import:async token=>service.dispatch('agents:claude:import',{token,leafId:h.ids.answer,projectId,providerId:'peer'})};
}
async function settled(service,id){for(let i=0;i<400;i++){const thread=await service.dispatch('agents:threads:read',{id});if(thread.status!=='running')return thread;await new Promise(r=>setTimeout(r,15));}throw Error('Timeout')}

test('Claude selected chain recovers parallel tool results without sibling answer/sidechain contamination',()=>{
 const h=history(),p=parseHistory(h.bytes()),chosen=selectBranch(p,h.ids.answer);
 assert.equal(p.branches.length,2);assert.equal(p.excluded,1);assert.equal(chosen.attachmentsOmitted,2);
 assert.match(chosen.messages.map(x=>x.content).join('\n'),/Selected final answer/);assert.equal(chosen.messages.some(x=>/Alternative|sidechain/.test(x.content)),false);
 assert.equal(chosen.activity.toolEvents.find(x=>x.id==='a').result,'Read result');assert.equal(chosen.activity.toolEvents.find(x=>x.id==='b').status,'failed');
 assert.equal(chosen.messages.filter(x=>x.role==='user').length,2);assert.equal(chosen.messages.some(x=>x.content.includes('/never-follow')),false);
 assert.equal(selectBranch(p,h.ids.other).activity.toolEvents,undefined);
});

test('Claude parent links define ordering even when selected source lines are reordered',()=>{
 const h=history();h.rows.reverse();const chosen=selectBranch(parseHistory(h.bytes()),h.ids.answer);
 assert.equal(chosen.messages[0].content,'Original request');assert.equal(chosen.messages.at(-1).content,'Selected final answer');
});

test('Claude import is read-only, explicit and inert; continuation starts own session then resumes it',async t=>{
 const f=await fixture(t),before=await fs.readFile(f.file),p=await f.preview();assert.equal(p.branches.length,2);
 assert.equal(f.service.snapshot().threads.length,0);const branch=await f.service.dispatch('agents:claude:branch',{token:p.token,leafId:f.h.ids.answer});assert.match(branch.claudeBranchPreview.text,/Selected final answer/);
 const imported=await f.import(p.token),thread=imported.threads.find(x=>x.id===imported.importedThreadId);
 assert.equal(thread.nativeThreadId,undefined);assert.equal(thread.runs.length,0);assert.equal(thread.claudeHistory.sessionId,f.h.session);assert.equal(thread.claudeHistory.activity.toolEvents.length,2);assert.deepEqual(await fs.readFile(f.file),before);
 await assert.rejects(f.import(p.token),/unavailable/);
 await f.service.dispatch('agents:threads:prompt',{id:thread.id,prompt:'New owned turn'});const first=await settled(f.service,thread.id);assert.equal(first.status,'completed');assert.notEqual(first.nativeThreadId,f.h.session);
 await f.service.dispatch('agents:threads:prompt',{id:thread.id,prompt:'Follow-up'});assert.equal((await settled(f.service,thread.id)).nativeThreadId,first.nativeThreadId);
 const wire=(await fs.readFile(join(f.dir,'wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);const args=wire.filter(x=>x.argv);
 assert.ok(args[0].argv.includes('--session-id='+first.nativeThreadId));assert.ok(args[1].argv.includes('--resume='+first.nativeThreadId));assert.match(wire.find(x=>x.type==='user').message.content[0].text,/Original request/);
});

test('Claude source mutation, replacement inode and symlink after preview cannot silently change import',async t=>{
 const f=await fixture(t),p=await f.preview();await fs.appendFile(f.file,'{}\n');await assert.rejects(f.import(p.token),/changed since preview/);assert.equal(f.service.snapshot().threads.length,0);
 await fs.writeFile(f.file,f.h.bytes());const p2=await f.preview();await fs.rename(f.file,f.file+'.old');await fs.writeFile(f.file,f.h.bytes());await assert.rejects(f.import(p2.token),/changed since preview/);
 await fs.unlink(f.file);await fs.symlink(f.file+'.old',f.file);await assert.rejects(f.preview(),/ELOOP/);assert.equal(f.service.snapshot().threads.length,0);
});

test('Claude preview tokens are ephemeral, capped, discarded and expire without importing',async t=>{
 const f=await fixture(t),previews=[];for(let i=0;i<4;i++)previews.push(await f.preview());await assert.rejects(f.preview(),/maximum four/);
 await f.service.dispatch('agents:claude:discard',{token:previews[0].token});await assert.rejects(f.import(previews[0].token),/unavailable/);const p=await f.preview();
 const original=Date.now;try{Date.now=()=>original()+16*60*1000;await assert.rejects(f.import(p.token),/expired/);}finally{Date.now=original;}
 assert.equal(f.service.snapshot().threads.length,0);
});

test('Claude history rejects bad tail/UTF-8, cycles, conflicting UUIDs, mixed sessions and unknown branches',()=>{
 const h=history();assert.throws(()=>parseHistory(Buffer.concat([h.bytes(),Buffer.from('{')])),/incomplete tails/);assert.throws(()=>parseHistory(Buffer.from([255])),/UTF-8/);
 const cycle=history();cycle.rows[0].parentUuid=cycle.ids.answer;assert.throws(()=>parseHistory(cycle.bytes()),/cycle/);
 const duplicate=history();duplicate.rows.push({...duplicate.rows[0],message:{role:'user',content:'Conflicting'}});assert.throws(()=>parseHistory(duplicate.bytes()),/conflicting duplicate/);
 const mixed=history();mixed.rows[1].sessionId=randomUUID();assert.throws(()=>parseHistory(mixed.bytes()),/exactly one/);
 assert.throws(()=>selectBranch(parseHistory(h.bytes()),randomUUID()),/listed/);
});

test('Claude history compaction/missing parents remain explicit boundaries; duplicate identical entries do not duplicate text',()=>{
 const h=history();h.rows[0].parentUuid=randomUUID();h.rows.push(h.rows[0]);const p=parseHistory(h.bytes());assert.equal(p.missingParents,1);assert.ok(p.skipped>=2);assert.equal(selectBranch(p,h.ids.answer).messages.filter(x=>x.content==='Original request').length,1);
});

test('Claude history file/frame limits reject before importing or executing',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,' '.repeat(32*1024*1024+1));assert.throws(()=>readHistory(f.file),/32 MiB/);
 assert.throws(()=>parseHistory(Buffer.from(JSON.stringify({type:'metadata',text:'x'.repeat(4*1024*1024)}))),/4 MiB/);
 assert.equal(f.service.snapshot().threads.length,0);
 assert.throws(()=>parseHistory(Buffer.from(Array(20001).fill('{}').join('\n'))),/20000 lines/);
});

test('Claude imported display activity survives native archive roundtrip with no source resume or file recovery rights',async t=>{
 const f=await fixture(t),p=await f.preview();await f.import(p.token);
 const archive=JSON.parse((await f.service.dispatch('agents:export')).exportData.content);archive.threads[0].nativeThreadId=randomUUID();archive.threads[0].nativeSessionBinding='untrusted';archive.threads[0].claudeHistory.activity.toolEvents[0].arbitraryReadPath='/never-read';
 const next=await f.service.dispatch('agents:import',{data:archive}),copied=next.threads.at(-1);
 assert.equal(copied.nativeThreadId,undefined);assert.equal(copied.nativeSessionBinding,undefined);assert.equal(copied.runs.length,0);assert.equal(copied.claudeHistory.activity.toolEvents[0].arbitraryReadPath,undefined);assert.equal(copied.claudeHistory.activity.toolEvents[0].result,'Read result');
 assert.equal(createHash('sha256').update(await fs.readFile(f.file)).digest('hex'),p.sha256);
});

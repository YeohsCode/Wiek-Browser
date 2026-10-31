import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {createCatalogService}=require('../app/catalog-service.cjs');
const {createVoiceService}=require('../app/voice-service.cjs');
const {inspectProfile,readProfile,createCredentialVault}=require('../app/profile-import.cjs');
const {createBrowserGateway}=require('../app/mcp-service.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'vek-review-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('catalog never supplies stale project file after symlink replacement or other-project selection',async t=>{
 const root=await fixture(t),home=path.join(root,'home'),a=path.join(root,'a'),b=path.join(root,'b'),file=path.join(a,'.agents/skills/sample/SKILL.md');await fs.mkdir(path.dirname(file),{recursive:true});await fs.mkdir(b);await fs.mkdir(home);await fs.writeFile(file,'Original instruction');
 const service=createCatalogService({dataDir:root,homeDir:home,projects:()=>[{id:'a',path:a},{id:'b',path:b}]});const id=service.snapshot('a').entries[0].id;
 await assert.rejects(service.dispatch('catalog:select',{threadId:'other',projectId:'b',ids:[id]}),/scope|available|enabled/);
 await service.dispatch('catalog:select',{threadId:'t',projectId:'a',ids:[id]});
 const secret=path.join(root,'private.txt');await fs.writeFile(secret,'PRIVATE OUTSIDE CONTENT');await fs.unlink(file);await fs.symlink(secret,file);
 assert.equal(service.promptForThread({id:'t',projectId:'a'}).includes('PRIVATE OUTSIDE CONTENT'),false);
 await assert.rejects(service.dispatch('catalog:read',{id}),/changed|unavailable|Refresh/);
});
test('catalog bounds complete UTF-8 context including source headers',async t=>{
 const root=await fixture(t),home=path.join(root,'home'),file=path.join(home,'.agents/skills/sample/SKILL.md');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'中'.repeat(5000));
 const service=createCatalogService({dataDir:root,homeDir:home});const id=service.snapshot().entries[0].id;await service.dispatch('catalog:select',{threadId:'t',ids:[id]});assert.throws(()=>service.promptForThread({id:'t'}),/12000.*byte|12.*KiB/);
});
test('voice close is terminal and snapshot applies history retention without a special list call',async t=>{
 const root=await fixture(t),script=path.join(root,'voice.cjs');await fs.writeFile(script,"console.log('retained transcript')");
 const service=createVoiceService({dataDir:root});await service.dispatch('voice:configure',{command:process.execPath,args:[script,'{audio}']});await service.dispatch('voice:settings:update',{keepAudio:true,historyRetentionDays:1});const input={audio:Buffer.from('fixture'),mime:'audio/wav'};await service.dispatch('voice:transcribe',input);
 const now=Date.now;Date.now=()=>now()+2*86400000;try{assert.equal(service.snapshot().history.length,0);assert.deepEqual(await fs.readdir(path.join(root,'voice-recordings')),[])}finally{Date.now=now}
 await service.close();await assert.rejects(service.dispatch('voice:transcribe',input),/closed/);assert.equal(service.snapshot().running,false);
});
test('voice stop and close await child shutdown and prevent replacement transcription',async t=>{
 const root=await fixture(t),script=path.join(root,'slow.cjs');await fs.writeFile(script,"setInterval(()=>{},1000)");const service=createVoiceService({dataDir:root});await service.dispatch('voice:configure',{command:process.execPath,args:[script,'{audio}']});const input={audio:Buffer.from('fixture'),mime:'audio/wav'},work=service.dispatch('voice:transcribe',input);const rejected=assert.rejects(work,/stopped/);const closing=service.close();await assert.rejects(service.dispatch('voice:transcribe',input),/closed/);await closing;await rejected;assert.equal(service.snapshot().running,false);assert.deepEqual(await fs.readdir(path.join(root,'voice-tmp')),[]);
});
test('profile import rejects a symlinked Network directory and URL authority injection in cookies',async t=>{
 const root=await fixture(t),profile=path.join(root,'profile'),outside=path.join(root,'outside');await fs.mkdir(profile);await fs.mkdir(outside);await fs.writeFile(path.join(profile,'Bookmarks'),JSON.stringify({roots:{}}));
 const db=path.join(outside,'Cookies');execFileSync('/usr/bin/sqlite3',[db,"CREATE TABLE meta(key,value);INSERT INTO meta VALUES('version','24');CREATE TABLE cookies(host_key,name,value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite);INSERT INTO cookies VALUES('good.test@evil.test','session','secret',X'','/',0,1,0,1);"]);
 await fs.symlink(outside,path.join(profile,'Network'));assert.equal((await inspectProfile(profile)).files['Network/Cookies'],false);assert.equal((await readProfile({directory:profile,cookies:true})).cookies.length,0);
 await fs.unlink(path.join(profile,'Network'));await fs.mkdir(path.join(profile,'Network'));await fs.copyFile(db,path.join(profile,'Network','Cookies'));const result=await readProfile({directory:profile,cookies:true});assert.equal(result.cookies.length,0);assert.ok(result.warnings.some(w=>/host|domain/i.test(w.reason)));
});
test('vault rejects non-HTTP origins and remains unchanged after disk persistence failure',async t=>{
 const root=await fixture(t),vault=createCredentialVault({dataDir:root,encrypt:value=>Buffer.from(value),decrypt:value=>value.toString()});assert.throws(()=>vault.import([{origin:'file:///tmp/a',password:'private'}]),/HTTP|origin/);assert.equal(vault.list().length,0);
 vault.import([{origin:'https://fixture.test',username:'a',password:'old'}]);const id=vault.list()[0].id;await fs.rm(path.join(root,'credentials.json'));await fs.mkdir(path.join(root,'credentials.json'));assert.throws(()=>vault.import([{origin:'https://fixture.test',username:'a',password:'new'}]));assert.equal(vault.forOrigin(id,'https://fixture.test').password,'old');
});
test('browser snapshot accepts only an optional string target in resolved thread scope',async()=>{
 let received;const gateway=createBrowserGateway({callbacks:{snapshot:async input=>{received=input;return {content:'ok'}}},resolveScope:async s=>({...s,browserSpaceId:7})});assert.equal(gateway.tools()[0].inputSchema.properties.targetId.type,'string');await gateway.call('browser.snapshot',{targetId:'tab-1',options:{viewport:true}},{scope:{projectId:'p',threadId:'t'}});assert.equal(received.arguments.targetId,'tab-1');assert.equal(received.scope.browserSpaceId,7);await assert.rejects(gateway.call('browser.snapshot',{targetId:7},{scope:{projectId:'p',threadId:'t'}}),/targetId/);await assert.rejects(gateway.call('browser.snapshot',{spaceId:9},{scope:{projectId:'p',threadId:'t'}}),/arguments/);
});
test('voice keeps multibyte transcripts intact across process stdout chunk boundaries',async t=>{
 const root=await fixture(t),script=path.join(root,'unicode.cjs');await fs.writeFile(script,"const value=Buffer.from('中文 transcription');process.stdout.write(value.subarray(0,1));setTimeout(()=>process.stdout.write(value.subarray(1)),30)");const service=createVoiceService({dataDir:root});t.after(()=>service.close());await service.dispatch('voice:configure',{command:process.execPath,args:[script,'{audio}']});assert.equal((await service.dispatch('voice:transcribe',{audio:Buffer.from('fixture'),mime:'audio/wav'})).text,'中文 transcription');
});

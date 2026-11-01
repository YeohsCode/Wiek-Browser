import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{captureProfileTabs}=require('../app/profile-web-storage.cjs');
const origin='https://fixture.test',url=origin+'/current';
function fake({changed=false,partitioned=false,closed=false,entries=[['key','value']]}={}) {let frames=0;return {getURL:()=>url,getTitle:()=> 'Fixture',executeJavaScriptInIsolatedWorld:async()=>{if(closed)throw new Error('closed');const area=require('../app/profile-storage-data.cjs').encodeArea(origin,entries);return {local:area.entries,session:area.entries};},debugger:{sendCommand:async(method)=>{if(closed)throw new Error('closed');if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'frame',loaderId:changed&&frames++?'new':'old',url,securityOrigin:origin}}};if(method==='Storage.getStorageKeyForFrame')return {storageKey:origin+'/'+(partitioned?'^0other':'')};if(method==='DOMStorage.getDOMStorageItems')return {entries};throw new Error('Unexpected mutation: '+method)}}};}
const space=wc=>[{name:'Fixture',activeTab:'a',tabs:[{id:'a',webContents:wc}]}];
test('web storage capture is opt-in and sends no CDP commands by default',async()=>{const wc=fake();wc.debugger.sendCommand=()=>{throw new Error('must not be read')};const result=await captureProfileTabs(space(wc));assert.equal(result.spaces[0].tabs.length,1);assert.equal(Object.hasOwn(result,'webStorage'),false);assert.equal(Object.hasOwn(result.spaces[0].tabs[0],'sessionStorage'),false);});
test('navigated, closed and partitioned tabs retain only their URL with explicit skipped-storage warnings',async()=>{for(const options of [{changed:true},{closed:true},{partitioned:true}]){const result=await captureProfileTabs(space(fake(options)),{includeWebStorage:true});assert.equal(result.spaces[0].tabs.length,1);assert.equal(result.webStorage.localStorage.length,0);assert.equal(Object.hasOwn(result.spaces[0].tabs[0],'sessionStorage'),false);assert.equal(result.warnings.length,1);}});
test('oversized storage is omitted without corrupting the portable tab inventory',async()=>{const result=await captureProfileTabs(space(fake({entries:[['large','x'.repeat(600000)]]})),{includeWebStorage:true});assert.equal(result.spaces[0].tabs[0].url,url);assert.equal(result.webStorage.localStorage.length,0);assert.match(result.warnings[0],/oversized/);});
test('cancelled capture yields no partially assembled archive',async()=>{const c=new AbortController();c.abort();await assert.rejects(captureProfileTabs(space(fake()),{includeWebStorage:true,signal:c.signal}),/cancelled/);});
test('actual Electron migrates two tab sessions before site scripts, with no bootstrap network and bounded failure cleanup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vek-profile-storage-')),env={...process.env,VEK_STORAGE_TEST_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
 try{const child=spawn(require('electron'),[join(import.meta.dirname,'fixtures/profile-storage-electron.cjs')],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),30000),code=await new Promise(r=>child.once('close',r));clearTimeout(timer);assert.equal(code,0,output);assert.match(output,/"ok":true/);assert.match(output,/"bootstrapNetworkRequests":0/);process.stdout.write(output.split('\n').filter(v=>v.startsWith('{')).join('\n')+'\n');}finally{await rm(dir,{recursive:true,force:true})}
});
test('actual application exports and restores through trusted IPC and passphrase UI; cancellations create no profile',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vek-archive-host-')),env={...process.env,VEK_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
 try{const child=spawn(require('electron'),[join(import.meta.dirname,'fixtures/profile-archive-host.cjs')],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),30000),code=await new Promise(r=>child.once('close',r));clearTimeout(timer);assert.equal(code,0,output);assert.match(output,/"actualApplicationIPC":true/);process.stdout.write(output.split('\n').filter(v=>v.startsWith('{')).join('\n')+'\n');}finally{await rm(dir,{recursive:true,force:true})}
});

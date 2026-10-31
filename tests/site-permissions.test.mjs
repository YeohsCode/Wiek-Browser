import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createSitePermissions,originOf,capabilities}=createRequire(import.meta.url)('../app/site-permissions.cjs');
const makeContents=(id=1,url='https://top.test/page')=>({id,url,destroyed:false,getURL(){return this.url;},isDestroyed(){return this.destroyed;}});
const input=(contents,extra={})=>({profileId:'p1',contents,permission:'notifications',details:{requestingUrl:contents?.getURL()},...extra});
const request=(service,value)=>new Promise(resolve=>service.request(value,resolve));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('origins and capabilities do not widen opaque frames or media requests',()=>{
  assert.equal(originOf('https://example.test:443/path?q=secret'),'https://example.test');
  for(const value of ['file:///tmp/a','about:blank','data:text/plain,a','blob:https://x.test/a','https://u:p@x.test','invalid'])assert.equal(originOf(value),null);
  assert.deepEqual(capabilities('media',{mediaTypes:['audio','video','audio']}),['camera','microphone']);
  assert.deepEqual(capabilities('media',{mediaType:'unknown'}),[]);assert.deepEqual(capabilities('fileSystem'),[]);
});
test('persistent decisions isolate profile, embedding origin, requester and device',async()=>{
  let prompts=0;const service=createSitePermissions({prompt:async()=>{prompts++;return 'block-once';}}),wc=makeContents();
  service.set({profileId:'p1',origin:'https://top.test',requestingOrigin:'https://frame.test',permission:'microphone',decision:'allow'});
  const media=input(wc,{permission:'media',details:{securityOrigin:'https://frame.test',mediaType:'audio',mediaTypes:['audio']}});
  assert.equal(service.check(media),true);assert.equal(await request(service,media),true);
  assert.equal(service.check({...media,profileId:'p2'}),false);
  assert.equal(service.check({...media,details:{securityOrigin:'https://other.test',mediaType:'audio'}}),false);
  assert.equal(service.check({...media,details:{securityOrigin:'https://frame.test',mediaType:'video'}}),false);
  wc.url='https://other.test';assert.equal(service.check(media),false);wc.url='https://top.test';
  assert.equal(await request(service,{...media,details:{securityOrigin:'https://frame.test',mediaTypes:['audio','video']}}),false);assert.equal(prompts,1);service.close();
});
test('allow once expires on real document invalidation; callbacks deduplicate',async()=>{
  let resolvePrompt,prompts=0;const service=createSitePermissions({prompt:()=>{prompts++;return new Promise(resolve=>resolvePrompt=resolve);}}),wc=makeContents();
  const a=request(service,input(wc)),b=request(service,input(wc));await tick();assert.equal(prompts,1);resolvePrompt('allow-once');assert.deepEqual(await Promise.all([a,b]),[true,true]);
  assert.equal(service.check(input(wc)),true);assert.equal(service.snapshot().rules.length,0);
  service.invalidate(wc);assert.equal(service.check(input(wc)),false);service.close();
});
test('stale prompts after navigation/close/timeout do not grant or persist',async()=>{
  let resolvePrompt;const service=createSitePermissions({prompt:()=>new Promise(resolve=>resolvePrompt=resolve)}),wc=makeContents();
  const pending=request(service,input(wc));await tick();wc.url='https://new.test';service.invalidate(wc);assert.equal(await pending,false);resolvePrompt('allow');await tick();assert.equal(service.snapshot().rules.length,0);
  const closing=request(service,input(wc));await tick();service.close();assert.equal(await closing,false);resolvePrompt('allow');await tick();assert.equal(service.snapshot().rules.length,0);
  const timeout=createSitePermissions({timeoutMs:10,prompt:()=>new Promise(()=>{})});const timed=request(timeout,input(wc));await new Promise(resolve=>setTimeout(resolve,25));assert.equal(await timed,false);timeout.close();
});
test('persistent block overrides active once grants and pending prompt answers',async()=>{
  let resolvePrompt;const wc=makeContents(),service=createSitePermissions({prompt:()=>new Promise(resolve=>resolvePrompt=resolve)});
  const pending=request(service,input(wc));await tick();service.set({profileId:'p1',origin:'https://top.test',permission:'notifications',decision:'block'});resolvePrompt('allow');assert.equal(await pending,false);assert.equal(service.check(input(wc)),false);
  service.set({profileId:'p1',origin:'https://top.test',permission:'notifications',decision:'ask'});const once=request(service,input(wc));await tick();resolvePrompt('allow-once');assert.equal(await once,true);
  service.set({profileId:'p1',origin:'https://top.test',permission:'notifications',decision:'block'});assert.equal(service.check(input(wc)),false);service.reset('p1','https://top.test/path');assert.equal(service.check(input(wc)),false);service.close();
});
test('legacy migration is conservative and saved snapshots survive restart',async()=>{
  let saved;const service=createSitePermissions({legacy:{p1:{'https://top.test':{notifications:true,media:true,geolocation:false},'file://':{notifications:true}}},onChange:rules=>saved=rules});
  assert.equal(service.snapshot().rules.length,2);assert.equal(service.snapshot().rules.some(row=>row.permission==='microphone'),false);
  service.set({profileId:'p1',origin:'https://top.test',permission:'camera',decision:'block'});const restored=createSitePermissions({initial:saved});assert.deepEqual(restored.snapshot(),service.snapshot());
  const snapshot=restored.snapshot();snapshot.rules[0].decision='block';assert.notDeepEqual(snapshot,restored.snapshot());service.close();restored.close();
});
test('opaque, unknown, absent and destroyed requesting documents are denied without prompting',async()=>{
  let prompts=0;const service=createSitePermissions({prompt:async()=>{prompts++;return 'allow';}}),wc=makeContents();
  for(const value of [input(wc,{permission:'display-capture'}),input(wc,{details:{securityOrigin:'null',requestingUrl:'https://top.test'}}),input(wc,{details:{}}),input(null,{details:{requestingUrl:'https://top.test'}})])assert.equal(await request(service,value),false);
  wc.destroyed=true;assert.equal(await request(service,input(wc)),false);assert.equal(prompts,0);service.close();
});
test('prompt failures deny once and invalid rules cannot mutate the store',async()=>{
  const service=createSitePermissions({prompt:async()=>{throw new Error('dialog closed');}}),wc=makeContents();
  assert.equal(await request(service,input(wc)),false);
  for(const rule of [{origin:'file:///tmp/a',permission:'notifications',decision:'allow'}, {origin:'https://x.test',permission:'media',decision:'allow'},{origin:'https://x.test',permission:'notifications',decision:'yes'}])assert.throws(()=>service.set({profileId:'p1',...rule}));
  assert.equal(service.snapshot().rules.length,0);service.close();assert.throws(()=>service.set({profileId:'p1',origin:'https://x.test',permission:'camera',decision:'allow'}));
});
test('an expired prompt cannot grant, erase or strand a newer request with the same key',async()=>{
  const answers=[];const service=createSitePermissions({timeoutMs:30,prompt:()=>new Promise(resolve=>answers.push(resolve))}),wc=makeContents();
  const old=request(service,input(wc));await new Promise(resolve=>setTimeout(resolve,45));assert.equal(await old,false);
  const current=request(service,input(wc));await tick();answers[0]('allow');await tick();assert.equal(service.snapshot().rules.length,0);
  answers[1]('allow-once');assert.equal(await current,true);assert.equal(service.snapshot().rules.length,0);service.close();
});
test('ask/reset explicitly cancel pending dialogs and cannot be undone by their stale answers',async()=>{
  for(const mode of ['ask','reset']){
    let answer;const service=createSitePermissions({prompt:()=>new Promise(resolve=>answer=resolve)}),wc=makeContents();
    const pending=request(service,input(wc));await tick();
    if(mode==='ask')service.set({profileId:'p1',origin:'https://top.test',permission:'notifications',decision:'ask'});else service.reset('p1','https://top.test');
    assert.equal(await pending,false);answer('allow');await tick();assert.equal(service.snapshot().rules.length,0);service.close();
  }
});
test('an explicit opaque requesting origin wins over a historical frame URL',()=>{
  const service=createSitePermissions(),wc=makeContents();service.set({profileId:'p1',origin:'https://top.test',requestingOrigin:'https://frame.test',permission:'notifications',decision:'allow'});
  assert.equal(service.check(input(wc,{requestingOrigin:'null',details:{requestingUrl:'https://frame.test/page',isMainFrame:false}})),false);service.close();
});

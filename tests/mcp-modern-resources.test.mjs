import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url),root=process.env.VEK_MCP_APP_ROOT||path.resolve(import.meta.dirname,'..');
const {HttpClient,createMcpService}=require(path.join(root,'app/mcp-service.cjs')),{createFixture}=require('./fixtures/modern-mcp-server.cjs');
const uri='fixture:///notes',pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,predicate){for(let i=0;i<200;i++){const v=read();if(predicate(v))return v;await pause(5);}assert.fail('MCP fixture condition timed out');}
async function setup(t,settings={}){const f=await createFixture(settings),client=new HttpClient({config:{url:f.url,allowInsecureHttp:true,protocolVersion:'2026-07-28'},timeoutMs:300});t.after(async()=>{await client.stop();await f.close();});await client.start();return {...f,client};}
test('modern resources use per-request envelope, pagination, inert text and binary without legacy traffic',async t=>{
 const f=await setup(t,{listMode:'paged'});assert.equal((await f.client.listResources()).length,2);assert.equal((await f.client.listResources({templates:true}))[0].uriTemplate,'fixture:///entry/{id}');assert.match((await f.client.readResource(uri)).contents[0].text,/离线内容.*<script>/);assert.equal((await f.client.readResource('fixture:///binary')).contents[0].blob,'AAEC');
 for(const c of f.calls){assert.equal(c.method,'POST');assert.equal(c.headers['mcp-protocol-version'],'2026-07-28');assert.equal(c.headers['mcp-session-id'],undefined);assert.equal(c.headers['mcp-method'],c.message.method);assert.deepEqual(c.message.params._meta['io.modelcontextprotocol/clientCapabilities'],{});}assert.equal(f.calls.find(c=>c.message.method==='resources/read').headers['mcp-name'],uri);
 assert.equal(f.calls.some(c=>['initialize','resources/subscribe','resources/unsubscribe'].includes(c.message.method)),false);
});
test('explicit modern list and URI streams correlate acknowledgment and only mark changes without rereading',async t=>{
 const f=await setup(t,{listenMode:'early-update'});await f.client.listResources();await f.client.listTools();assert.equal(f.streams.size,0);await f.client.watchLists(true);await f.client.setResourceSubscription(uri,true);assert.equal(f.client.resourceSubscriptions.get(uri).revision,1);assert.equal(f.client.resourceSubscriptions.get(uri).status,'subscribed');
 f.emit('notifications/resources/updated',{uri});f.emit('notifications/resources/list_changed');f.emit('notifications/tools/list_changed');await until(()=>f.client.resourceSubscriptions.get(uri).revision,v=>v===2);assert.equal(f.client.resources,null);assert.equal(f.client.tools,null);assert.equal(f.calls.some(c=>c.message.method==='resources/read'),false);
 const read=await f.client.readResource(uri);assert.equal(read.stale,false);assert.equal(f.client.resourceSubscriptions.get(uri).readRevision,2);
 await f.client.setResourceSubscription(uri,false);await f.client.watchLists(false);await until(()=>f.streams.size,v=>v===0);assert.equal(f.client.resourceSubscriptions.size,0);assert.equal(f.calls.some(c=>c.message.method==='notifications/cancelled'),false);
});
test('concurrent modern read remains stale when an update arrives before its response',async t=>{
 const f=await setup(t,{readMode:'hold'});await f.client.setResourceSubscription(uri,true);const reading=f.client.readResource(uri);await until(()=>f.held.size,v=>v===1);f.emit('notifications/resources/updated',{uri});await until(()=>f.client.resourceSubscriptions.get(uri).revision,v=>v===1);[...f.held][0]();const r=await reading;assert.equal(r.stale,true);assert.equal(r.revision,0);assert.equal(f.client.resourceSubscriptions.get(uri).readRevision,0);
});
test('modern lists are explicitly refreshed without reusing stale protocol caches',async t=>{
 const f=await setup(t);await f.client.listResources();await f.client.listResources();await f.client.listTools();await f.client.listTools();assert.equal(f.calls.filter(c=>c.message.method==='resources/list').length,2);assert.equal(f.calls.filter(c=>c.message.method==='tools/list').length,2);
});
for(const mode of ['early','wrongid','wrongfilter'])test('modern subscription rejects '+mode+' before accepting any update',async t=>{
 const f=await setup(t,{listenMode:mode});await assert.rejects(f.client.setResourceSubscription(uri,true),/before acknowledgment|ID mismatch|unrequested/);assert.equal(f.client.resourceSubscriptions.get(uri).status,'lost');assert.equal(f.calls.filter(c=>c.message.method==='subscriptions/listen').length,1);await until(()=>f.streams.size,v=>v===0);
});
test('server acknowledgment may decline a requested subscription without leaving an active stream',async t=>{
 const f=await setup(t,{listenMode:'subset'});const entry=await f.client.setResourceSubscription(uri,true);assert.equal(entry.status,'unsupported');await until(()=>f.streams.size,v=>v===0);assert.equal(f.client.notificationStreams.size,0);await f.client.setResourceSubscription(uri,false);assert.equal(f.client.resourceSubscriptions.size,0);
});
test('unrequested notification or wrong stream metadata loses only that stream and never refetches',async t=>{
 const f=await setup(t);await f.client.watchLists(true);await f.client.setResourceSubscription(uri,true);const stream=[...f.streams].find(s=>s.message.params.notifications.resourceSubscriptions);f.notification(stream,'notifications/tools/list_changed');await until(()=>f.client.resourceSubscriptions.get(uri).status,v=>v==='lost');assert.equal(f.client.listStream.status,'subscribed');assert.equal(f.client.state,'connected');assert.equal(f.calls.some(c=>c.message.method==='resources/read'),false);
 const lists=[...f.streams].find(s=>s.message.params.notifications.toolsListChanged);f.event(lists,{method:'notifications/resources/list_changed',params:{_meta:{'io.modelcontextprotocol/subscriptionId':-1}}});await until(()=>f.client.listStream.status,v=>v==='lost');
});
test('graceful completion and abrupt loss remain visible with no automatic replay or relisten',async t=>{
 const f=await setup(t);await f.client.setResourceSubscription(uri,true);let stream=[...f.streams][0];f.event(stream,{id:stream.message.id,result:{resultType:'complete',_meta:{'io.modelcontextprotocol/subscriptionId':stream.message.id}}});await until(()=>f.client.resourceSubscriptions.get(uri).status,v=>v==='closed');assert.equal(f.client.resourceSubscriptions.get(uri).revision,1);
 await f.client.setResourceSubscription(uri,true);await until(()=>f.streams.size,v=>v===1);stream=[...f.streams][0];stream.res.destroy();await until(()=>f.client.resourceSubscriptions.get(uri).status,v=>v==='lost');await pause(30);assert.equal(f.calls.filter(c=>c.message.method==='subscriptions/listen').length,2);assert.ok(f.client.resourceSubscriptions.get(uri).revision>1);
});
test('ack timeout and AbortSignal close pending HTTP streams without cancellation notifications',async t=>{
 const f=await setup(t,{listenMode:'noack'});const pending=f.client.setResourceSubscription(uri,true);await assert.rejects(f.client.setResourceSubscription(uri,true),/already changing/);await assert.rejects(pending,e=>e.error_code==='VEK_MCP_TIMEOUT');await until(()=>f.streams.size,v=>v===0);
 const abort=new AbortController(),reading=f.client.setResourceSubscription(uri,true,{signal:abort.signal});const rejection=assert.rejects(reading,e=>e.error_code==='VEK_MCP_CANCELLED');await until(()=>f.streams.size,v=>v===1);abort.abort();await rejection;await until(()=>f.streams.size,v=>v===0);assert.equal(f.calls.some(c=>c.message.method==='notifications/cancelled'),false);
});
test('stream lives beyond request timeout and supports over a thousand bounded events',async t=>{
 const f=await setup(t);await f.client.setResourceSubscription(uri,true);await pause(330);assert.equal(f.client.resourceSubscriptions.get(uri).status,'subscribed');const s=[...f.streams][0];for(let i=0;i<1100;i++)f.notification(s,'notifications/resources/updated',{uri});await until(()=>f.client.resourceSubscriptions.get(uri).revision,v=>v===1100);assert.equal(f.client.resourceSubscriptions.get(uri).status,'subscribed');
});
test('malformed UTF-8 and oversized subscription frames close safely without poisoning the client',async t=>{
 const f=await setup(t);await f.client.setResourceSubscription(uri,true);[...f.streams][0].res.write(Buffer.from([0xff]));await until(()=>f.client.resourceSubscriptions.get(uri).status,v=>v==='lost');await f.client.setResourceSubscription(uri,true);[...f.streams][0].res.write('data: '+ 'x'.repeat(f.client.maxMessageBytes+1));await until(()=>f.client.resourceSubscriptions.get(uri).status,v=>v==='lost');assert.equal((await f.client.listResources()).length,2);
});
test('capability and stream capacity limits reject locally; explicit cancellation frees capacity',async t=>{
 const absent=await setup(t,{capabilities:{resources:{}}});await assert.rejects(absent.client.watchLists(true),/advertise/);await assert.rejects(absent.client.setResourceSubscription(uri,true),/advertise/);assert.equal(absent.calls.length,1);
 const f=await setup(t);for(let i=0;i<16;i++)await f.client.setResourceSubscription('fixture:///'+i,true);const before=f.calls.length;await assert.rejects(f.client.setResourceSubscription('fixture:///extra',true),/limit/);assert.equal(f.calls.length,before);assert.match((await f.client.readResource(uri)).contents[0].text,/离线内容/);await f.client.setResourceSubscription('fixture:///0',false);await f.client.setResourceSubscription('fixture:///extra',true);assert.equal(f.client.notificationStreams.size,16);
});
test('MRTR inputs and missing complete discriminant never become successful resource content',async t=>{
 const f=await setup(t,{readMode:'input'});await assert.rejects(f.client.readResource(uri),e=>e.error_code==='VEK_MCP_UNSUPPORTED_CAPABILITY');f.settings.readMode='missing-type';await assert.rejects(f.client.readResource(uri),/result type/);assert.equal(f.calls.filter(c=>c.message.method==='resources/read').length,2);
});
test('scope isolation, disconnect and restart clear streams without persisting resource contents',async t=>{
 const f=await createFixture(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'vek-modern-service-'));const service=createMcpService({dataDir:dir,requestTimeoutMs:500,resolveScope:async s=>s.projectId==='p'?{...s,projectPath:dir}:null});t.after(async()=>{await service.close();await f.close();await fs.rm(dir,{recursive:true,force:true});});
 const scope={projectId:'p',threadId:'one'},s=await service.dispatch('mcp:integrations:save',{name:'Modern offline',transport:'http',url:f.url,allowInsecureHttp:true,protocolVersion:'2026-07-28',scope}),id=s.integrations[0].id,call=(verb,extra={})=>service.dispatch(verb,{integrationId:id,scope,uri,...extra});
 await call('mcp:subscriptions:watch');await call('mcp:resources:subscribe');await call('mcp:resources:read');await assert.rejects(call('mcp:subscriptions:watch',{scope:{projectId:'p',threadId:'other'}}),/outside/);const disk=await fs.readFile(path.join(dir,'mcp/state.json'),'utf8');assert.ok(!disk.includes('离线内容'));assert.ok(!disk.includes('resourceSubscriptions'));assert.equal(service.snapshot().connections[0].notificationStreams.lists.status,'subscribed');await service.dispatch('mcp:integrations:disconnect',{id,scope});await until(()=>f.streams.size,v=>v===0);await call('mcp:resources:list');assert.equal(service.snapshot().connections[0].notificationStreams.lists,null);assert.equal(service.snapshot().connections[0].resourceSubscriptions.length,0);assert.equal(f.calls.filter(c=>c.message.method==='subscriptions/listen').length,2);
});
test('partial acknowledged list filter permits only its honored types',async t=>{
 const f=await setup(t,{ackFilter:{resourcesListChanged:true}});await f.client.watchLists(true);assert.deepEqual(f.client.subscriptionSnapshot().lists.notifications,{resourcesListChanged:true});f.notification([...f.streams][0],'notifications/tools/list_changed');await until(()=>f.client.listStream.status,v=>v==='lost');
});
test('notification race rejects an outdated modern tool list and a subsequent explicit refresh succeeds',async t=>{
 const f=await setup(t,{holdTools:true});await f.client.watchLists(true);const listing=f.client.listTools(),reject=assert.rejects(listing,/changed during listing/);await until(()=>f.held.size,v=>v===1);f.emit('notifications/tools/list_changed');await until(()=>f.client.toolListRevision,v=>v===1);[...f.held][0]();await reject;assert.equal(f.client.tools,null);f.settings.holdTools=false;assert.equal((await f.client.listTools()).length,3);
});
test('modern one-off responses cannot deliver unsolicited notifications',async t=>{
 const f=await setup(t,{unsolicited:true});await assert.rejects(f.client.listTools(),/explicit subscription/);assert.equal(f.client.notificationStreams.size,0);assert.equal(f.calls.filter(c=>c.message.method==='tools/list').length,1);
});
test('HTTP subscription authorization failure is surfaced once without retries',async t=>{
 const f=await setup(t,{listenHttpStatus:401});let failures=0;f.client.onAuthorizationFailure=status=>{assert.equal(status,401);failures++;};await assert.rejects(f.client.setResourceSubscription(uri,true),e=>e.error_code==='VEK_MCP_HTTP_AUTH');assert.equal(failures,1);assert.equal(f.calls.filter(c=>c.message.method==='subscriptions/listen').length,1);assert.equal(f.client.notificationStreams.size,0);
});

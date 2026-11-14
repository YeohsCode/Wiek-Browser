import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const {StdioClient,createMcpService}=createRequire(import.meta.url)('../app/mcp-service.cjs');
const fixture=resolve(import.meta.dirname,'fixtures/modern-stdio-mcp.cjs'),uri='fixture:///notes';
async function client(t,args=[],timeoutMs=500){const c=new StdioClient({config:{command:process.execPath,args:[fixture,...args],protocolVersion:'2026-07-28'},cwd:tmpdir(),timeoutMs});t.after(()=>c.stop());await c.start();return c;}
const control=(c,action,args={})=>c.request('tools/call',{name:'control',arguments:{action,...args}});
const inspect=async c=>JSON.parse((await control(c,'inspect')).content[0].text);
const emit=(c,method,params={})=>control(c,'emit',{method,params});
test('modern stdio discovers without initialization and sends metadata on every request',async t=>{const c=await client(t);await c.listTools();assert.equal(c.info.serverInfo.name,'Modern stdio fixture');const x=await inspect(c);assert.equal(x.calls[0].method,'server/discover');assert.equal(x.calls.some(v=>['initialize','notifications/initialized'].includes(v.method)),false);for(const row of x.calls.filter(v=>Object.hasOwn(v,'id'))){assert.equal(row.params._meta['io.modelcontextprotocol/protocolVersion'],'2026-07-28');assert.deepEqual(row.params._meta['io.modelcontextprotocol/clientCapabilities'],{});}});
test('modern stdio keeps interleaved list/resource streams scoped and invalidates only explicit lists',async t=>{const c=await client(t);await c.listTools();await c.listPrompts();await c.listResources();await c.watchLists(true);await c.setResourceSubscription(uri,true);assert.equal((await inspect(c)).streams,2);await emit(c,'notifications/prompts/list_changed');assert.equal(c.prompts,null);assert.ok(c.tools);await emit(c,'notifications/resources/updated',{uri});assert.equal(c.resourceSubscriptions.get(uri).revision,1);assert.equal(c.listStream.status,'subscribed');await emit(c,'notifications/tools/list_changed');assert.equal(c.tools,null);await c.watchLists(false);assert.equal(c.resourceSubscriptions.get(uri).status,'subscribed');await c.setResourceSubscription(uri,false);assert.equal((await inspect(c)).streams,0);const calls=(await inspect(c)).calls;assert.ok(calls.some(row=>row.method==='notifications/cancelled'));assert.equal(calls.some(row=>['resources/subscribe','resources/unsubscribe'].includes(row.method)),false);});
test('modern stdio ignores unsolicited list changes and unregistered subscription ids',async t=>{const c=await client(t);await c.listTools();await c.listPrompts();const revision=c.promptListRevision;await control(c,'unsolicited');assert.equal(c.promptListRevision,revision);assert.ok(c.prompts);assert.ok(c.tools);});
for(const mode of ['--before-ack','--extra-filter','--silent-ack'])test('modern stdio rejects invalid subscription establishment '+mode,async t=>{const c=await client(t,[mode],100);await assert.rejects(c.watchLists(true),/before acknowledgment|unrequested|timed out/);assert.equal(c.notificationStreams.size,0);assert.equal(c.state,'connected');});
test('modern stdio enforces acknowledged partial filters and preserves unrelated resource subscription',async t=>{const c=await client(t,['--partial-filter']);await c.watchLists(true);assert.deepEqual(c.listStream.accepted,{promptsListChanged:true});await control(c,'wrong-stream');assert.equal(c.listStream.status,'lost');assert.equal(c.state,'connected');});
test('modern stdio graceful stream close invalidates caches and requires explicit resubscribe',async t=>{const c=await client(t);await c.listPrompts();await c.watchLists(true);await control(c,'close-streams');assert.equal(c.listStream.status,'closed');assert.equal(c.prompts,null);assert.equal(c.notificationStreams.size,0);await c.watchLists(true);assert.equal(c.listStream.status,'subscribed');});
test('modern stdio sends request cancellation and never replays late results',async t=>{const c=await client(t);const controller=new AbortController(),pending=c.request('tools/call',{name:'control',arguments:{action:'slow'}},{signal:controller.signal});controller.abort();await assert.rejects(pending,e=>e.error_code==='VEK_MCP_CANCELLED');assert.ok((await inspect(c)).calls.some(row=>row.method==='notifications/cancelled'));});
test('modern stdio refuses server-initiated requests without exposing roots',async t=>{const c=await client(t);await assert.rejects(control(c,'server-request'),/cannot initiate/);assert.equal(c.state,'disconnected');});
test('modern stdio rejects malformed discovery without legacy fallback',async t=>{const c=new StdioClient({config:{command:process.execPath,args:[fixture,'--bad-discovery'],protocolVersion:'2026-07-28'},cwd:tmpdir(),timeoutMs:100});t.after(()=>c.stop());await assert.rejects(c.start(),/discovery/);assert.equal(c.state,'disconnected');});
test('modern stdio rejects a tool-list notification race instead of caching outdated definitions',async t=>{const c=await client(t,['--list-race']);await c.watchLists(true);await assert.rejects(c.listTools(),/changed during/);assert.equal(c.tools,null);});
test('modern stdio service configuration, prompt reads and notification state stay in scope and out of persistence',async t=>{const dir=await mkdtemp(join(tmpdir(),'wiek-modern-stdio-'));const service=createMcpService({dataDir:dir,resolveScope:async scope=>({...scope,projectPath:dir})});t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});const scope={projectId:'p',threadId:'one'},other={projectId:'q',threadId:'two'};await service.dispatch('mcp:integrations:save',{name:'Modern stdio',command:process.execPath,args:[fixture],protocolVersion:'2026-07-28',scope});const id=service.snapshot().integrations[0].id;assert.equal(service.snapshot().integrations[0].protocolVersion,'2026-07-28');const prompts=await service.dispatch('mcp:prompts:list',{integrationId:id,scope});assert.equal(prompts.prompts.length,2);const preview=await service.dispatch('mcp:prompts:get',{integrationId:id,scope,name:'summary',arguments:{subject:'fixture'}});assert.match(preview.messages[0].content.text,/PRIVATE_PROMPT/);await assert.rejects(service.dispatch('mcp:prompts:get',{integrationId:id,scope:other,name:'summary'}),/outside/);await service.dispatch('mcp:subscriptions:watch',{integrationId:id,scope});assert.equal(service.snapshot().connections[0].notificationStreams.lists.notifications.promptsListChanged,true);assert.equal((await readFile(join(dir,'mcp/state.json'),'utf8')).includes('PRIVATE_PROMPT'),false);await assert.rejects(service.dispatch('mcp:integrations:save',{name:'Bad',command:process.execPath,args:[fixture],scope,protocolVersion:'future'}),/protocol version/);});

test('modern stdio rejects malformed UTF-8 without accepting partial response text',async t=>{const c=await client(t);await assert.rejects(control(c,'invalid-utf8'),/UTF-8/);assert.equal(c.state,'disconnected');});
test('modern stdio input-required results are allowed only for explicitly interactive tool requests',async t=>{const c=await client(t);await assert.rejects(control(c,'input'),e=>e.error_code==='VEK_MCP_UNSUPPORTED_CAPABILITY');const result=await c.request('tools/call',{name:'control',arguments:{action:'input'}},{allowInput:true});assert.equal(result.resultType,'input_required');assert.equal(result.requestState,'PRIVATE_CONTINUATION');const resumed=await c.request('tools/call',{name:'control',arguments:{action:'input'},requestState:result.requestState,inputResponses:{ask:{action:'accept',content:{value:'reviewed'}}}},{allowInput:true});assert.equal(resumed.content[0].text,'Reviewed form accepted');});

test('modern stdio resource continuation keeps subscriptions and completes only after explicit review',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'wiek-resource-stdio-'));
 const service=createMcpService({dataDir:dir,resolveScope:async scope=>({...scope,projectPath:dir})});
 t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
 const scope={projectId:'p'},ui={interactive:true};
 await service.dispatch('mcp:integrations:save',{name:'Resource fixture',command:process.execPath,args:[fixture,'--resource-input'],protocolVersion:'2026-07-28',scope});
 const integrationId=service.snapshot().integrations[0].id;
 await service.dispatch('mcp:resources:subscribe',{integrationId,scope,uri});
 const task=await service.dispatch('mcp:resources:readInteractive',{integrationId,scope,uri},ui);
 let waiting;
 for(let attempt=0;attempt<100&&!waiting?.inputReview;attempt++){
   waiting=await service.dispatch('mcp:tasks:read',{id:task.id,scope});
   if(!waiting.inputReview)await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(waiting.status,'awaiting_input');
 await service.dispatch('mcp:tasks:respond',{id:task.id,scope,reviewId:waiting.inputReview.id,responses:{ask:{action:'accept',content:{}}}},ui);
 const done=await service.dispatch('mcp:tasks:wait',{id:task.id,scope,timeoutMs:3000});
 assert.equal(done.status,'completed');
 assert.deepEqual(done.result.contents,[{uri,text:'fixture resource'}]);
 assert.equal(service.snapshot().connections[0].resourceSubscriptions[0].status,'subscribed');
});

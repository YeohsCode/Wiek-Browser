import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const root = process.env.VEK_MCP_APP_ROOT || resolve(import.meta.dirname, '..');
const { createMcpService } = createRequire(import.meta.url)(join(root, 'app/mcp-service.cjs'));

for (const mode of ['server', 'retry']) {
  test(`session HTTP URL elicitation via ${mode} requires scoped desktop review`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'wiek-mcp-url-'));
    const opened = [], calls = [], responses = [];
    const address = 'https://fixture.example/authorization?state=public-fixture';
    const params = { mode: 'url', elicitationId: 'fixture-url', message: 'Authorize fixture', url: address };
    let wire;
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') { res.writeHead(405).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks));
      const json = (fields, status = 200) => res.writeHead(status, {'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0', id:message.id, ...fields}));
      if (message.method === 'initialize') {
        assert.deepEqual(message.params.capabilities.elicitation, {url:{}});
        return json({result:{protocolVersion:'2025-11-25',serverInfo:{name:'Fixture'},capabilities:{tools:{}}}});
      }
      if (message.method === 'tools/list') return json({result:{tools:[{name:'fixture',inputSchema:{type:'object'}}]}});
      if (message.method === 'tools/call') {
        calls.push(message);
        if (calls.length > 1) return json({result:{content:[{type:'text',text:'done'}]}});
        if (mode === 'retry') return json({error:{code:-32042,message:'Open fixture',data:{elicitations:[params]}}});
        wire = { res, id:message.id };
        res.writeHead(200, {'content-type':'text/event-stream'});
        res.write('data: '+JSON.stringify({jsonrpc:'2.0',id:'peer-1',method:'elicitation/create',params})+'\n\n');
        return;
      }
      res.writeHead(202).end();
      if (message.id === 'peer-1') {
        responses.push(message);
        wire.res.end('data: '+JSON.stringify({jsonrpc:'2.0',id:wire.id,result:{content:[{type:'text',text:'done'}]}})+'\n\n');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const scope = {projectId:'p',threadId:'one'};
    const service = createMcpService({dataDir:dir,resolveScope:async value=>({...value,projectPath:dir}),openInputUrl:async url=>opened.push(url)});
    t.after(async () => {
      await service.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(dir,{recursive:true,force:true});
    });
    const ui = {interactive:true};
    const { integrations:[integration] } = await service.dispatch('mcp:integrations:save',{name:'Fixture',transport:'http',url:`http://127.0.0.1:${server.address().port}/mcp`,allowInsecureHttp:true,scope});
    const task = await service.dispatch('mcp:tools:call',{name:'fixture',integrationId:integration.id,arguments:{unchanged:true},scope},ui);
    let review;
    for (let i=0; i<150 && !review; i++) {
      review=service.snapshot().tasks.find(row=>row.id===task.id).inputReview;
      if (!review) await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(review?.mode,mode);
    assert.equal(JSON.stringify(review).includes(address),false);
    const payload = {id:task.id,scope,reviewId:review.id,inputId:'fixture-url',responses:{'fixture-url':{action:'accept'}}};
    await assert.rejects(service.dispatch('mcp:tasks:inputUrlDetails',payload), /MCP panel/);
    await assert.rejects(service.dispatch('mcp:tasks:inputUrlDetails',{...payload,scope:{...scope,threadId:'two'}},ui),/outside/);
    assert.deepEqual((await service.dispatch('mcp:tasks:inputUrlDetails',payload,ui)).urls,[{id:'fixture-url',url:address}]);
    await assert.rejects(service.dispatch('mcp:tasks:respond',payload,ui), /Open the requested address/);
    assert.deepEqual(opened,[]);
    await service.dispatch('mcp:tasks:openInputUrl',payload,ui);
    assert.deepEqual(opened,[address]);
    assert.equal(calls.length,1);
    assert.equal(responses.length,0);
    await service.dispatch('mcp:tasks:respond',payload,ui);
    const done=await service.dispatch('mcp:tasks:wait',{id:task.id,scope});
    assert.equal(done.status,'completed');
    if (mode === 'retry') {
      assert.equal(calls.length,2);
      assert.notEqual(calls[0].id,calls[1].id);
      assert.deepEqual(calls[0].params,calls[1].params);
    } else {
      assert.equal(calls.length,1);
      assert.deepEqual(responses,[{jsonrpc:'2.0',id:'peer-1',result:{action:'accept'}}]);
    }
    assert.ok(!(await readFile(join(dir,'mcp/state.json'),'utf8')).includes(address));
  });
}

test('session stdio returns a user decline to the originating server request', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wiek-mcp-stdio-url-'));
  const script = `
    const readline = require('node:readline');
    let toolId;
    const send = message => console.log(JSON.stringify({jsonrpc:'2.0',...message}));
    readline.createInterface({input:process.stdin}).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') send({id:message.id,result:{protocolVersion:'2025-11-25',serverInfo:{name:'Fixture'},capabilities:{tools:{}}}});
      if (message.method === 'tools/list') send({id:message.id,result:{tools:[{name:'fixture',inputSchema:{type:'object'}}]}});
      if (message.method === 'tools/call') {
        toolId = message.id;
        send({id:'reverse',method:'elicitation/create',params:{mode:'url',elicitationId:'fixture',url:'https://fixture.example/path',message:'Review'}});
      }
      if (message.id === 'reverse') send({id:toolId,result:{content:[{type:'text',text:message.result?.action||'unexpected'}]}});
    });
  `;
  const scope = {projectId:'p'};
  const service = createMcpService({dataDir:dir,resolveScope:async value=>({...value,projectPath:dir}),openInputUrl:async()=>assert.fail('Decline cannot open a URL')});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const {integrations:[integration]}=await service.dispatch('mcp:integrations:save',{name:'Fixture',command:process.execPath,args:['-e',script],scope});
  const ui = {interactive:true};
  const task=await service.dispatch('mcp:tools:call',{name:'fixture',integrationId:integration.id,scope},ui);
  let review;
  for(let i=0;i<150&&!review;i++){
    review=service.snapshot().tasks.find(row=>row.id===task.id).inputReview;
    if(!review)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(review?.mode,'server');
  await service.dispatch('mcp:tasks:respond',{id:task.id,scope,reviewId:review.id,responses:{fixture:{action:'decline'}}},ui);
  assert.deepEqual((await service.dispatch('mcp:tasks:wait',{id:task.id,scope})).result.content,[{type:'text',text:'decline'}]);
});

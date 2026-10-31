import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { createAgentService } = createRequire(import.meta.url)('../app/agent-service.cjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vek-native-agent-'));
  const script = join(directory, 'native-fixture.cjs'), auditPath = join(directory, 'requests.jsonl');
  await writeFile(script, `
    const readline=require('node:readline');const fs=require('node:fs');const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    let timer,active=false,turn='turn-fixture',thread='thread-fixture';
    const finish=(text,status='completed')=>{if(!active)return;active=false;clearTimeout(timer);if(text){send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,itemId:'item',delta:text}});send({method:'item/completed',params:{item:{type:'agentMessage',id:'item',text}}});}send({method:'thread/tokenUsage/updated',params:{tokenUsage:{last:{inputTokens:31,outputTokens:9,cachedInputTokens:4}}}});send({method:'turn/completed',params:{turn:{id:turn,status}}});};
    const lines=readline.createInterface({input:process.stdin});
    lines.on('line',line=>{const data=JSON.parse(line);fs.appendFileSync(process.env.VEK_NATIVE_AUDIT,JSON.stringify(data)+'\\n');
      if(data.method==='initialize')send({id:data.id,result:{userAgent:'local-fake'}});
      else if(data.method==='thread/start'||data.method==='thread/resume')send({id:data.id,result:{thread:{id:thread}}});
      else if(data.method==='turn/start'){active=true;const text=data.params.input.map(x=>x.text).join('');send({id:data.id,result:{turn:{id:turn,status:'inProgress'}}});send({method:'turn/started',params:{turn:{id:turn}}});
        if(text.includes('[disconnect]'))process.exit(0);
        else if(text.includes('[malformed]'))process.stdout.write('not JSON\\n');
        else if(text.includes('[approval]'))send({id:'approval-fixture',method:'item/commandExecution/requestApproval',params:{command:'node test-only-fixture',cwd:process.cwd(),reason:'Fixture approval; no command is executed'}});
        else if(text.includes('[slow-native]'))timer=setTimeout(()=>finish('Finished slow native turn'),3000);
        else finish('Native response: '+text);
      }else if(data.method==='turn/steer'){send({id:data.id,result:{turnId:turn}});finish('Native steered response: '+data.params.input[0].text);}
      else if(data.method==='turn/interrupt'){send({id:data.id,result:{}});finish('', 'interrupted');}
      else if(data.id==='approval-fixture'&&data.result)finish('Approval result: '+data.result.decision);
    });
    lines.on('close',()=>{clearTimeout(timer);process.exit(0);});
  `);
  const service = createAgentService({ dataDir: directory, runContext: () => ({ env: { VEK_NATIVE_AUDIT: auditPath }, promptPrefix: 'Local browser instructions' }) });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.dispatch('agents:providers:configure', { id: 'native-test', name: 'Native protocol fixture', command: process.execPath, args: [script], inputMode: 'stdin', protocol: 'codex-app-server' });
  await service.dispatch('agents:projects:create', { name: 'Native test', path: directory });
  await service.dispatch('agents:threads:create', { projectId: service.snapshot().projects[0].id, providerId: 'native-test', title: 'Native session', model: 'fixture-only-model' });
  const threadId = service.snapshot().threads[0].id;
  return { service, directory, threadId, thread: () => service.snapshot().threads[0], audit: async () => { try { return (await readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse); } catch { return []; } } };
}
async function waitFor(read, matches) { const deadline = Date.now() + 6000; while (Date.now() < deadline) { const value = await read(); if (matches(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); } throw new Error('Native fixture wait timed out: ' + JSON.stringify(await read())); }

test('opt-in native provider performs initialize/start/delta/usage and resumes the actual returned thread id', async (t) => {
  const f = await fixture(t);
  const imagePath = join(f.directory, 'user-image.png'), textPath = join(f.directory, 'user-text.md');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a5XQAAAAASUVORK5CYII=', 'base64')); await writeFile(textPath, 'Selected text');
  await f.service.dispatch('agents:attachments:add', { id: f.threadId, paths: [imagePath, textPath] });
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: 'First native user turn' });
  const first = await waitFor(f.thread, thread => thread.status === 'completed');
  assert.equal(first.nativeThreadId, 'thread-fixture');
  assert.equal((first.runs[0].stdout.match(/Native response:/g) || []).length, 1);
  assert.equal(first.runs[0].usage.source, 'native-provider-event');
  assert.equal(first.runs[0].usage.inputTokens, 31);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: 'Second native user turn' });
  await waitFor(f.thread, thread => thread.status === 'completed');
  const audit = await f.audit();
  assert.equal(audit.filter(entry => entry.method === 'initialize').length, 2);
  assert.equal(audit.find(entry => entry.method === 'thread/start').params.sandbox, 'read-only');
  assert.equal(audit.find(entry => entry.method === 'thread/start').params.model, 'fixture-only-model');
  const firstInput = audit.find(entry => entry.method === 'turn/start').params.input;
  assert.deepEqual(firstInput.map(item => item.type), ['text', 'localImage']);
  assert.equal(firstInput[1].path, first.attachments[0].storedPath); assert.ok(firstInput[0].text.includes('text/markdown'));
  assert.equal(audit.find(entry => entry.method === 'thread/resume').params.threadId, 'thread-fixture');
  const second = audit.filter(entry => entry.method === 'turn/start')[1].params.input[0].text;
  assert.match(second, /Second native user turn/); assert.equal(second.includes('First native user turn'), false);
});

test('native steering uses turn/steer within the same run and interrupt stops a real protocol process', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[slow-native]' });
  await f.service.dispatch('agents:control:steer', { id: f.threadId, prompt: 'Real accepted steering' });
  await waitFor(f.thread, thread => thread.status === 'completed');
  assert.equal(f.thread().runs.length, 1); assert.match(f.thread().runs[0].stdout, /Real accepted steering/);
  assert.equal((await f.audit()).find(entry => entry.method === 'turn/steer').params.expectedTurnId, 'turn-fixture');
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[slow-native]' });
  await waitFor(f.audit, audit => audit.filter(entry => entry.method === 'turn/start').length === 2);
  await f.service.dispatch('agents:control:stop', { id: f.threadId });
  assert.equal(f.thread().status, 'stopped'); assert.ok((await f.audit()).some(entry => entry.method === 'turn/interrupt'));
});

test('native approval requests wait for an explicit limited decision and never auto-approve', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[approval]' });
  const thread = await waitFor(f.thread, thread => thread.runs[0].approvals?.[0]?.status === 'pending');
  const approvalId = thread.runs[0].approvals[0].id;
  assert.equal((await f.audit()).some(entry => entry.id === 'approval-fixture'), false);
  await assert.rejects(f.service.dispatch('agents:control:approval', { id: f.threadId, approvalId, decision: 'acceptForSession' }), /accept, decline, or cancel/);
  await f.service.dispatch('agents:control:approval', { id: f.threadId, approvalId, decision: 'decline' });
  await waitFor(f.thread, thread => thread.status === 'completed');
  assert.equal(f.thread().runs[0].approvals[0].status, 'declined');
  assert.deepEqual((await f.audit()).find(entry => entry.id === 'approval-fixture').result, { decision: 'decline' });
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[approval]' });
  const again = await waitFor(f.thread, thread => thread.runs[1].approvals?.[0]?.status === 'pending');
  await f.service.dispatch('agents:control:approval', { id: f.threadId, approvalId: again.runs[1].approvals[0].id, decision: 'accept' });
  await waitFor(f.thread, thread => thread.status === 'completed');
  assert.match(f.thread().runs[1].stdout, /Approval result: accept/);
});

test('a native disconnect without turn/completed is a failure rather than a fake successful reply', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[disconnect]' });
  const thread = await waitFor(f.thread, thread => thread.status === 'failed');
  assert.match(thread.runs[0].error, /before turn completed/); assert.equal(thread.messages.some(message => message.role === 'assistant'), false);
});

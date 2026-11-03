import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { createAgentService, nextCronAt } = createRequire(import.meta.url)('../app/agent-service.cjs');

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vek-agent-service-'));
  const providerPath = join(directory, 'fake provider.cjs');
  await writeFile(providerPath, `
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => input += data);
    process.stdin.on('end', () => {
      const text = process.argv[2] || input;
      if (text.includes('[usage]')) console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:23,output_tokens:5,cached_input_tokens:7}}));
      else if (text.includes('[context]')) console.log((process.env.VEK_PROBE_CONTEXT || 'missing') + ':' + text);
      else if (text.includes('[brief]')) setTimeout(() => console.log('Brief actual reply: ' + text), 120);
      else if (text.includes('[slow]')) { console.log('started'); setTimeout(() => console.log('finished'), 2000); }
      else if (text.includes('[flood]')) { process.stdout.write('x'.repeat(8192)); process.stderr.write('y'.repeat(8192)); }
      else if (text.includes('[fail]')) { console.error('fake failure detail'); process.exitCode = 7; }
      else { console.log('actual fake provider output: ' + text); console.error('local diagnostic'); }
    });
  `);
  let service = createAgentService({ dataDir: directory, ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.dispatch('agents:providers:configure', { id: 'fake', name: 'Test provider', command: process.execPath, args: [providerPath], inputMode: 'stdin' });
  await service.dispatch('agents:projects:create', { name: 'Test project', path: directory });
  const projectId = service.snapshot().projects[0].id;
  await service.dispatch('agents:threads:create', { projectId, providerId: 'fake', title: 'Thread one' });
  const threadId = service.snapshot().threads[0].id;
  return { directory, providerPath, projectId, threadId, get service() { return service; }, reopen() { service = createAgentService({ dataDir: directory, ...options }); return service; } };
}

async function waitFor(read, matches, description = 'condition') {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { const value = read(); if (matches(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(read())}`);
}
const currentThread = (f) => f.service.snapshot().threads.find(thread => thread.id === f.threadId);

test('real child stdout/stderr, literal input, conversation and private atomic persistence', async (t) => {
  const f = await fixture(t);
  const literal = 'hello $(touch should-not-exist) `echo nope` ; <b>literal</b>';
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: literal });
  const thread = await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.equal(thread.runs[0].exitCode, 0);
  assert.match(thread.messages[1].content, /actual fake provider output:/);
  assert.ok(thread.messages[1].content.includes(literal));
  assert.match(thread.runs[0].stderr, /local diagnostic/);
  await f.service.dispatch('agents:threads:rename', { id: f.threadId, title: 'Renamed' });
  assert.equal((await f.service.dispatch('agents:threads:read', { id: f.threadId })).title, 'Renamed');
  assert.equal((await stat(join(f.directory, 'agents'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'agents/state.json'))).mode & 0o777, 0o600);
  assert.throws(() => createAgentService({ dataDir: f.directory }), /Another Agent service/);
  const copy = f.service.snapshot(); copy.threads[0].messages.length = 0;
  assert.equal(currentThread(f).messages.length, 2);
  await f.service.close(); f.reopen();
  assert.equal(currentThread(f).title, 'Renamed');
  assert.equal(currentThread(f).messages.length, 2);
});

test('argv template passes one literal argument and never invokes a shell', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:providers:configure', { id: 'fake', name: 'Argv provider', command: process.execPath, args: [f.providerPath, '{prompt}'], inputMode: 'argv' });
  const prompt = 'quoted " value; $(no-shell)';
  await f.service.dispatch('agents:threads:prompt', { threadId: f.threadId, prompt });
  const thread = await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.ok(thread.runs[0].stdout.includes(prompt));
  await assert.rejects(f.service.dispatch('agents:providers:configure', { name: 'No env', command: process.execPath, args: [], env: { TOKEN: 'hidden' } }), /environment overrides/);
  await assert.rejects(f.service.dispatch('agents:projects:create', { path: './relative' }), /absolute/);
});

test('stop, concurrency and overlap checks operate on actual provider processes', async (t) => {
  const f = await fixture(t, { maxConcurrentRuns: 1 });
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[slow]' });
  await waitFor(() => currentThread(f), thread => thread.runs[0].stdout.includes('started'));
  await assert.rejects(f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: 'overlap' }), { error_code: 'VEK_AGENT_OVERLAP' });
  await f.service.dispatch('agents:threads:create', { projectId: f.projectId, providerId: 'fake' });
  const other = f.service.snapshot().threads.find(thread => thread.id !== f.threadId);
  await assert.rejects(f.service.dispatch('agents:threads:prompt', { id: other.id, prompt: 'capacity' }), { error_code: 'VEK_AGENT_CAPACITY' });
  await f.service.dispatch('agents:threads:stop', { id: f.threadId });
  assert.equal(currentThread(f).status, 'stopped');
  assert.equal(f.service.snapshot().runningCount, 0);
  assert.equal(currentThread(f).runs[0].stdout.includes('finished'), false);
});

test('bounded output and failure status retain real diagnostics without invented replies', async (t) => {
  const f = await fixture(t, { maxOutputBytes: 512 });
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[flood]' });
  const thread = await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.equal(thread.runs[0].truncated, true);
  assert.ok(Buffer.byteLength(thread.runs[0].stdout + thread.runs[0].stderr) <= 512);
  await f.service.dispatch('agents:threads:create', { projectId: f.projectId, providerId: 'fake' });
  const failedId = f.service.snapshot().threads.at(-1).id;
  await f.service.dispatch('agents:threads:prompt', { id: failedId, prompt: '[fail]' });
  const failed = await waitFor(() => f.service.snapshot().threads.at(-1), thread => thread.status === 'failed');
  assert.equal(failed.runs[0].exitCode, 7);
  assert.match(failed.runs[0].stderr, /fake failure detail/);
  assert.equal(failed.messages.some(message => message.role === 'assistant'), false);
  await f.service.dispatch('agents:providers:configure', { id: 'missing', name: 'Missing', command: '/not/a/real/provider', args: [] });
  await f.service.dispatch('agents:threads:create', { projectId: f.projectId, providerId: 'missing' });
  await assert.rejects(f.service.dispatch('agents:threads:prompt', { id: f.service.snapshot().threads.at(-1).id, prompt: 'hello' }), { error_code: 'VEK_AGENT_PROVIDER_UNAVAILABLE' });
});

test('at schedule survives restart and executes exactly once while service is active', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:automations:create', { name: 'Once', threadId: f.threadId, prompt: 'scheduled local fake', kind: 'at', at: new Date(Date.now() + 350).toISOString() });
  await f.service.close(); f.reopen();
  const automation = await waitFor(() => f.service.snapshot().automations[0], automation => automation.status === 'completed');
  assert.ok(['started', 'completed'].includes(automation.lastOutcome));
  await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.equal(currentThread(f).runs.length, 1);
  await f.service.close(); f.reopen();
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(currentThread(f).runs.length, 1);
});

test('interval pause/resume/update/stop defers overlap without queuing duplicate work', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:automations:create', { name: 'Repeating', threadId: f.threadId, prompt: '[slow]', kind: 'interval', intervalMs: 50, status: 'paused' });
  const id = f.service.snapshot().automations[0].id;
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(currentThread(f).runs.length, 0);
  await f.service.dispatch('agents:automations:resume', { id });
  await waitFor(() => f.service.snapshot().automations[0], automation => automation.deferred?.reason === 'This automation has an active run');
  assert.equal(currentThread(f).runs.length, 1);
  await f.service.dispatch('agents:automations:stop', { id });
  assert.equal(currentThread(f).status, 'stopped');
  assert.equal(f.service.snapshot().automations[0].status, 'paused');
  await f.service.dispatch('agents:automations:update', { id, prompt: 'manual local fake', intervalMs: 10000 });
  await f.service.dispatch('agents:automations:run', { id });
  await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  await f.service.dispatch('agents:automations:delete', { id });
  assert.equal(f.service.snapshot().automations.length, 0);
});

test('uncleanly persisted running state becomes interrupted and is never silently resumed', async (t) => {
  const f = await fixture(t);
  await f.service.close();
  const file = join(f.directory, 'agents/state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.threads[0].status = 'running'; state.threads[0].activeRunId = 'crashed';
  state.threads[0].runs.push({ id: 'crashed', status: 'running', stdout: 'partial', stderr: '', startedAt: new Date().toISOString() });
  await writeFile(file, JSON.stringify(state));
  f.reopen();
  assert.equal(currentThread(f).status, 'interrupted');
  assert.equal(currentThread(f).runs[0].status, 'interrupted');
  assert.equal(currentThread(f).activeRunId, undefined);
  assert.equal(f.service.snapshot().runningCount, 0);
  assert.match(currentThread(f).messages[0].content, /not been resumed/);
});

test('archive/pin/notes/markers/goals persist and branches have independent honest transcripts', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: 'Original conversation' });
  await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  const source = currentThread(f), messageId = source.messages[0].id;
  await f.service.dispatch('agents:threads:pin', { id: f.threadId });
  await f.service.dispatch('agents:threads:archive', { id: f.threadId });
  await f.service.dispatch('agents:threads:notes', { id: f.threadId, notes: 'Local notes <script>literal</script>' });
  await f.service.dispatch('agents:threads:goal', { id: f.threadId, goal: 'Track this goal', status: 'complete' });
  await f.service.dispatch('agents:threads:marker:add', { id: f.threadId, messageId, label: 'Important' });
  assert.equal(currentThread(f).pinned, true); assert.equal(currentThread(f).archived, true);
  assert.equal(currentThread(f).goal.status, 'complete');
  await f.service.dispatch('agents:threads:fork', { id: f.threadId, messageId, title: 'Independent fork' });
  const fork = f.service.snapshot().threads.at(-1);
  assert.equal(fork.messages.length, 1); assert.equal(fork.runs.length, 0); assert.equal(fork.parentThreadId, f.threadId);
  assert.notEqual(fork.messages[0].id, messageId);
  await f.service.dispatch('agents:threads:sidechat', { id: f.threadId, title: 'Side discussion' });
  const sidechat = f.service.snapshot().threads.at(-1);
  assert.equal(sidechat.kind, 'sidechat'); assert.equal(sidechat.messages.length, 2);
  assert.equal(currentThread(f).messages.length, 2);
  await f.service.close(); f.reopen();
  assert.equal(currentThread(f).markers[0].label, 'Important'); assert.match(currentThread(f).notes, /literal/);
  await f.service.dispatch('agents:threads:marker:remove', { id: f.threadId, markerId: currentThread(f).markers[0].id });
  await f.service.dispatch('agents:threads:unpin', { id: f.threadId });
  await f.service.dispatch('agents:threads:unarchive', { id: f.threadId });
  assert.equal(currentThread(f).markers.length, 0); assert.equal(currentThread(f).pinned, false); assert.equal(currentThread(f).archived, false);
});

test('edit/resend/rollback preserve revisions and never claim to undo project files', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'project-file.txt'), 'unchanged file');
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: 'First text' });
  await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  const firstId = currentThread(f).messages[0].id;
  await f.service.dispatch('agents:threads:edit', { id: f.threadId, messageId: firstId, content: 'Edited text' });
  assert.equal(currentThread(f).messages.length, 1); assert.equal(currentThread(f).messages[0].content, 'Edited text');
  assert.equal(currentThread(f).revisions[0].messages[0].content, 'First text');
  await f.service.dispatch('agents:threads:resend', { id: f.threadId, messageId: firstId, content: 'Resent text' });
  await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.equal(currentThread(f).messages.length, 2); assert.match(currentThread(f).messages[1].content, /Resent text/);
  await f.service.dispatch('agents:threads:rollback', { id: f.threadId, messageId: currentThread(f).messages[0].id });
  assert.equal(currentThread(f).messages.length, 1); assert.equal(currentThread(f).revisions.length, 3);
  assert.equal(await readFile(join(f.directory, 'project-file.txt'), 'utf8'), 'unchanged file');
});

test('native JSON import is transactional, remaps ids, and cannot activate imported commands or schedules', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: 'Exported actual transcript' });
  await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  await f.service.dispatch('agents:threads:marker:add', { id: f.threadId, messageId: currentThread(f).messages[0].id, label: 'Export bookmark' });
  await f.service.dispatch('agents:automations:create', { threadId: f.threadId, prompt: 'Should not run from import', kind: 'interval', intervalMs: 10000, status: 'paused' });
  const exported = await f.service.dispatch('agents:export');
  const bundle = JSON.parse(exported.exportData.content);
  assert.equal(bundle.format, 'vek-agent-export');
  assert.equal(bundle.providers.some(provider => 'env' in provider), false);
  const before = f.service.snapshot().threads.length;
  await f.service.dispatch('agents:import', { data: exported.exportData.content });
  const imported = f.service.snapshot().threads.at(-1);
  assert.equal(f.service.snapshot().threads.length, before + 1); assert.notEqual(imported.id, f.threadId);
  assert.equal(imported.messages[0].content, currentThread(f).messages[0].content);
  assert.equal(imported.markers[0].messageId, imported.messages[0].id);
  assert.equal(f.service.snapshot().providers.find(provider => provider.id === imported.providerId).enabled, false);
  assert.equal(f.service.snapshot().automations.at(-1).status, 'paused');
  await assert.rejects(f.service.dispatch('agents:threads:prompt', { id: imported.id, prompt: 'Do not execute' }), { error_code: 'VEK_AGENT_PROVIDER_UNAVAILABLE' });
  const count = f.service.snapshot().projects.length;
  bundle.threads[0].messages[0].role = 'invalid';
  await assert.rejects(f.service.dispatch('agents:import', { data: bundle }), /Invalid imported message/);
  assert.equal(f.service.snapshot().projects.length, count);
  await assert.rejects(f.service.dispatch('agents:import', { data: '../not-native.zip' }), /not valid JSON/);
});

test('UTC cron validates real calendar dates, weekday ranges and day/weekday OR semantics', async () => {
  assert.equal(nextCronAt('0 9 * * 1-5', Date.parse('2026-10-30T09:00:00Z')), '2026-11-02T09:00:00.000Z');
  assert.equal(nextCronAt('*/15 * * * *', Date.parse('2026-10-30T12:01:01Z')), '2026-10-30T12:15:00.000Z');
  assert.equal(nextCronAt('0 0 29 2 *', Date.parse('2026-10-30T00:00:00Z')), '2028-02-29T00:00:00.000Z');
  assert.equal(nextCronAt('0 0 1 * 1', Date.parse('2026-10-30T00:00:00Z')), '2026-11-01T00:00:00.000Z');
  assert.throws(() => nextCronAt('61 * * * *'), /out of range/);
  assert.throws(() => nextCronAt('invalid cron'), /five fields/);
});

test('heartbeat memory, run/stop limits, and proposals require explicit real-process execution', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:automations:create', { threadId: f.threadId, prompt: 'Heartbeat check', kind: 'heartbeat', intervalMs: 60, memory: 'Remember local progress', maxRuns: 1 });
  await waitFor(() => f.service.snapshot().automations[0], automation => automation.status === 'completed');
  await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.equal(currentThread(f).runs.length, 1); assert.match(currentThread(f).runs[0].stdout, /Remember local progress/);
  assert.equal(f.service.snapshot().automations[0].stopReason, 'Run limit reached');
  await f.service.dispatch('agents:proposals:create', { threadId: f.threadId, title: 'Manual proposal', prompt: 'Only after approval' });
  assert.equal(currentThread(f).runs.length, 1);
  const proposal = f.service.snapshot().proposals[0]; assert.equal(proposal.source, 'manual');
  await f.service.dispatch('agents:proposals:accept', { proposalId: proposal.id });
  await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.equal(currentThread(f).runs.length, 2); assert.equal(f.service.snapshot().proposals[0].status, 'accepted');
  await assert.rejects(f.service.dispatch('agents:proposals:accept', { proposalId: proposal.id }), /already been decided/);
  await f.service.dispatch('agents:proposals:create', { threadId: f.threadId, prompt: 'Reject me' });
  await f.service.dispatch('agents:proposals:reject', { proposalId: f.service.snapshot().proposals.at(-1).id });
  assert.equal(currentThread(f).runs.length, 2);
});

test('root-owned runContext injects only VEK namespace and a transient prompt prefix', async (t) => {
  const f = await fixture(t, { runContext: ({ thread }) => ({ env: { VEK_PROBE_CONTEXT: thread.id }, promptPrefix: 'ROOT-OWNED LOCAL BROWSER INSTRUCTIONS' }) });
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[context]' });
  const thread = await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.ok(thread.runs[0].stdout.includes(f.threadId)); assert.match(thread.runs[0].stdout, /ROOT-OWNED LOCAL BROWSER INSTRUCTIONS/);
  assert.equal(thread.messages[0].content, '[context]');
  const bad = await fixture(t, { runContext: () => ({ env: { API_KEY: 'not-permitted' } }) });
  await assert.rejects(bad.service.dispatch('agents:threads:prompt', { id: bad.threadId, prompt: 'hello' }), /VEK_\*/);
  assert.equal(currentThread(bad).messages.length, 0);
  const tooLong = await fixture(t, { runContext: () => ({ env: {}, promptPrefix: 'x'.repeat(32769) }) });
  await assert.rejects(tooLong.service.dispatch('agents:threads:prompt', { id: tooLong.threadId, prompt: 'hello' }), /32768/);
  assert.equal(currentThread(tooLong).messages.length, 0);
});

test('model catalogue is user configured and usage comes only from actual structured output', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:providers:configure', { id: 'fake', name: 'Usage fixture', command: process.execPath, args: [f.providerPath], inputMode: 'stdin', models: ['local-test-model'], modelArgs: [], usageFormat: 'codex-jsonl' });
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[usage]' });
  const thread = await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.deepEqual(thread.runs[0].usage, { inputTokens: 23, outputTokens: 5, cachedInputTokens: 7, source: 'provider-event' });
  await f.service.dispatch('agents:threads:model', { id: f.threadId, model: 'local-test-model' });
  await assert.rejects(f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: 'hello' }), /modelArgs/);
  assert.deepEqual(f.service.snapshot().providers.find(provider => provider.id === 'fake').models, ['local-test-model']);
});

test('multi-agent create/read/list/wait expose real parent/child process state with bounded waiting', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:control:create', { parentThreadId: f.threadId, title: 'Working child', prompt: '[slow]' });
  const child = f.service.snapshot().threads.at(-1);
  assert.equal(child.parentThreadId, f.threadId); assert.equal(child.kind, 'agent');
  assert.equal((await f.service.dispatch('agents:control:read', { id: child.id })).status, 'running');
  assert.equal((await f.service.dispatch('agents:control:list')).threads.length, 2);
  const timed = await f.service.dispatch('agents:control:wait', { ids: [child.id], timeoutMs: 10 });
  assert.equal(timed.waitResult.reason, 'timeout'); assert.equal(timed.waitResult.threads[0].status, 'running');
  const waiting = f.service.dispatch('agents:control:wait', { ids: [child.id], timeoutMs: 5000 });
  await f.service.dispatch('agents:control:stop', { id: child.id });
  const done = await waiting; assert.equal(done.waitResult.reason, 'settled'); assert.equal(done.waitResult.threads[0].status, 'stopped');
});

test('plain CLI steering queues a next turn and stop cancels queued work honestly', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[slow]' });
  await f.service.dispatch('agents:control:steer', { id: f.threadId, prompt: 'A queued follow-up' });
  assert.equal(currentThread(f).pendingFollowUps.length, 1);
  assert.equal(currentThread(f).messages.length, 1);
  await f.service.dispatch('agents:control:stop', { id: f.threadId });
  assert.equal(currentThread(f).pendingFollowUps.length, 0); assert.equal(currentThread(f).runs.length, 1);
  await assert.rejects(f.service.dispatch('agents:control:approval', { id: f.threadId, approvalId: 'none', decision: 'accept' }), { error_code: 'VEK_AGENT_UNSUPPORTED' });
  await f.service.dispatch('agents:threads:create', { projectId: f.projectId, providerId: 'fake' });
  const nextId = f.service.snapshot().threads.at(-1).id;
  await f.service.dispatch('agents:threads:prompt', { id: nextId, prompt: '[brief]' });
  await f.service.dispatch('agents:control:steer', { id: nextId, prompt: 'Actually executed queued turn' });
  const next = await waitFor(() => f.service.snapshot().threads.at(-1), thread => thread.runs.length === 2 && thread.status === 'completed');
  assert.match(next.runs[1].stdout, /Actually executed queued turn/); assert.equal(next.pendingFollowUps.length, 0);
});

test('handoff creates a destination with copied real context and does not pretend to transfer a native session', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: 'Source context' });
  await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  await f.service.dispatch('agents:control:handoff', { fromThreadId: f.threadId, title: 'Destination', prompt: 'Continue the source work' });
  const destinationId = f.service.snapshot().threads.at(-1).id;
  const destination = await waitFor(() => f.service.snapshot().threads.at(-1), thread => thread.status === 'completed');
  assert.equal(currentThread(f).handoffTargetId, destinationId); assert.equal(destination.parentThreadId, f.threadId);
  assert.match(destination.runs[0].stdout, /Source context/); assert.match(destination.messages[0].content, /not native session transfer/);
});

test('closing the service releases outstanding waiters and interrupts owned running children', async (t) => {
  const f = await fixture(t);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: '[slow]' });
  const waiting = f.service.dispatch('agents:control:wait', { ids: [f.threadId], timeoutMs: 60000 });
  await f.service.close();
  assert.equal((await waiting).waitResult.reason, 'closed'); assert.equal(currentThread(f).status, 'interrupted');
});

test('selected text/image files are copied privately, attached to actual prompts, detached recoverably and restored after restart', async (t) => {
  const f = await fixture(t), textPath = join(f.directory, 'selected notes.md'), imagePath = join(f.directory, 'selected image.png');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a5XQAAAAASUVORK5CYII=', 'base64');
  await writeFile(textPath, 'ACTUAL_SELECTED_FILE_CONTENT'); await writeFile(imagePath, image);
  await f.service.dispatch('agents:attachments:add', { id: f.threadId, paths: [textPath, imagePath] });
  const attachments = currentThread(f).attachments; assert.equal(attachments.length, 2);
  assert.equal(await readFile(attachments[0].storedPath, 'utf8'), 'ACTUAL_SELECTED_FILE_CONTENT');
  assert.deepEqual(await readFile(attachments[1].storedPath), image);
  assert.notEqual(attachments[0].storedPath, textPath);
  assert.equal((await stat(join(f.directory, 'agents/attachments', f.threadId))).mode & 0o777, 0o700);
  assert.equal((await stat(attachments[0].storedPath)).mode & 0o777, 0o600);
  await f.service.dispatch('agents:threads:prompt', { id: f.threadId, prompt: 'Inspect my selected files' });
  const thread = await waitFor(() => currentThread(f), thread => thread.status === 'completed');
  assert.equal(thread.messages[0].attachments.length, 2); assert.ok(thread.runs[0].stdout.includes(attachments[0].storedPath));
  assert.match(thread.runs[0].stdout, /contents have not been assumed read/);
  assert.equal(thread.runs[0].stdout.includes('ACTUAL_SELECTED_FILE_CONTENT'), false);
  await f.service.dispatch('agents:attachments:remove', { id: f.threadId, attachmentId: attachments[0].id });
  assert.equal(await readFile(textPath, 'utf8'), 'ACTUAL_SELECTED_FILE_CONTENT'); assert.equal(await readFile(attachments[0].storedPath, 'utf8'), 'ACTUAL_SELECTED_FILE_CONTENT');
  await f.service.close(); f.reopen();
  assert.ok(currentThread(f).attachments[0].detachedAt);
  await f.service.dispatch('agents:attachments:restore', { id: f.threadId, attachmentId: attachments[0].id });
  assert.equal(currentThread(f).attachments[0].detachedAt, undefined);
  const read = await f.service.dispatch('agents:attachments:read', { id: f.threadId, attachmentId: attachments[0].id }); assert.equal(read.attachmentData.storedPath, attachments[0].storedPath);
  await f.service.dispatch('agents:threads:fork', { id: f.threadId });
  const fork = f.service.snapshot().threads.at(-1); assert.equal(fork.attachments.length, 2); assert.notEqual(fork.attachments[0].storedPath, attachments[0].storedPath); assert.equal(await readFile(fork.attachments[0].storedPath, 'utf8'), 'ACTUAL_SELECTED_FILE_CONTENT');
});

test('attachment type, 20 MiB size, ten-active count and transactional batch limits are real', async (t) => {
  const f = await fixture(t), textPath = join(f.directory, 'safe.txt'), badPath = join(f.directory, 'binary.bin'), largePath = join(f.directory, 'large.txt');
  await writeFile(textPath, 'safe'); await writeFile(badPath, Buffer.from([0, 1, 2]));
  await assert.rejects(f.service.dispatch('agents:attachments:add', { id: f.threadId, paths: [textPath, badPath] }), /Binary attachments/);
  assert.equal(currentThread(f).attachments.length, 0); assert.deepEqual(await readdir(join(f.directory, 'agents/attachments', f.threadId)), []);
  await writeFile(largePath, Buffer.alloc(20 * 1024 * 1024 + 1, 65));
  await assert.rejects(f.service.dispatch('agents:attachments:add', { id: f.threadId, path: largePath }), /20 MiB/);
  await f.service.dispatch('agents:attachments:add', { id: f.threadId, paths: Array(10).fill(textPath) });
  await assert.rejects(f.service.dispatch('agents:attachments:add', { id: f.threadId, path: textPath }), /ten active/);
  const first = currentThread(f).attachments[0]; await f.service.dispatch('agents:attachments:remove', { id: f.threadId, attachmentId: first.id });
  await f.service.dispatch('agents:attachments:add', { id: f.threadId, path: textPath });
  await assert.rejects(f.service.dispatch('agents:attachments:restore', { id: f.threadId, attachmentId: first.id }), /ten active/);
  await assert.rejects(f.service.dispatch('agents:attachments:add', { id: f.threadId, path: '../relative.txt' }), /absolute/);
});

test('native archives carry real attachment bytes, remap owned paths, and reject forged external attachment imports', async (t) => {
  const f = await fixture(t), textPath = join(f.directory, 'portable.txt'); await writeFile(textPath, 'Portable actual bytes');
  await f.service.dispatch('agents:attachments:add', { id: f.threadId, path: textPath });
  const exported = await f.service.dispatch('agents:export'), bundle = JSON.parse(exported.exportData.content);
  assert.equal(bundle.threads[0].attachments[0].storedPath, undefined); assert.equal(Buffer.from(bundle.threads[0].attachments[0].inlineBase64, 'base64').toString(), 'Portable actual bytes');
  await f.service.dispatch('agents:import', { data: exported.exportData.content });
  const imported = f.service.snapshot().threads.at(-1), source = currentThread(f).attachments[0];
  assert.notEqual(imported.attachments[0].storedPath, source.storedPath); assert.equal(await readFile(imported.attachments[0].storedPath, 'utf8'), 'Portable actual bytes');
  const before = f.service.snapshot().threads.length;
  const forged = structuredClone(bundle); delete forged.threads[0].attachments[0].inlineBase64; forged.threads[0].attachments[0].storedPath = '/etc/passwd';
  await assert.rejects(f.service.dispatch('agents:import', { data: forged }), /never an external storedPath/); assert.equal(f.service.snapshot().threads.length, before);
  const tooLarge = structuredClone(bundle); tooLarge.threads[0].attachments[0].bytes = 20 * 1024 * 1024 + 1;
  await assert.rejects(f.service.dispatch('agents:import', { data: tooLarge }), /size/);
  const tooMany = structuredClone(bundle); tooMany.threads[0].attachments = Array.from({ length: 11 }, () => structuredClone(bundle.threads[0].attachments[0]));
  await assert.rejects(f.service.dispatch('agents:import', { data: tooMany }), /count/);
});

test('archive total limits fail explicitly and metadata-only fallback never pretends omitted files exist', async (t) => {
  const f = await fixture(t), file = join(f.directory, 'twenty-mib.txt'); await writeFile(file, Buffer.alloc(20 * 1024 * 1024, 65));
  await f.service.dispatch('agents:attachments:add', { id: f.threadId, paths: [file, file] });
  await assert.rejects(f.service.dispatch('agents:export'), /32 MiB/);
  const exported = await f.service.dispatch('agents:export', { metadataOnly: true });
  const bundle = JSON.parse(exported.exportData.content); assert.equal(bundle.threads[0].attachments[0].available, false); assert.equal(bundle.threads[0].attachments[0].inlineBase64, undefined);
  await f.service.dispatch('agents:import', { data: exported.exportData.content });
  const imported = f.service.snapshot().threads.at(-1); assert.equal(imported.attachments[0].available, false);
  await assert.rejects(f.service.dispatch('agents:attachments:read', { id: imported.id, attachmentId: imported.attachments[0].id }), /unavailable/);
});

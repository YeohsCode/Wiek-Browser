import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAgentService, nextCronAt } = require('../app/agent-service.cjs');
const NY = 'America/New_York';
const next = (cron, after, zone = NY) => nextCronAt(cron, Date.parse(after), zone);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, predicate) { const deadline = performance.now() + 5000; while (performance.now() < deadline) { const value = read(); if (predicate(value)) return value; await sleep(10); } throw new Error('Scheduler condition timed out: ' + JSON.stringify(read())); }

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vek-timezone-'));
  let service = createAgentService({ dataDir: directory, ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.dispatch('agents:providers:configure', { id: 'timezone-fixture', name: 'Local test process', command: process.execPath, args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("actual local timezone fixture"))'], inputMode: 'stdin' });
  await service.dispatch('agents:projects:create', { path: directory, name: 'Timezone fixture' });
  await service.dispatch('agents:threads:create', { projectId: service.snapshot().projects[0].id, providerId: 'timezone-fixture', title: 'Timezone fixture' });
  return { directory, get service() { return service; }, threadId: service.snapshot().threads[0].id, reopen() { service = createAgentService({ dataDir: directory, ...options }); }, async stored() { return JSON.parse(await readFile(join(directory, 'agents/state.json'), 'utf8')); }, async store(state) { await writeFile(join(directory, 'agents/state.json'), JSON.stringify(state)); } };
}

test('New York spring gap skips nonexistent 02:30 while minute cron moves directly to 03:00', () => {
  assert.equal(next('30 2 * * *', '2026-03-07T07:29:59Z'), '2026-03-07T07:30:00.000Z');
  assert.equal(next('30 2 * * *', '2026-03-07T07:30:00Z'), '2026-03-09T06:30:00.000Z');
  assert.equal(next('30 2 * * *', '2026-03-08T06:59:59Z'), '2026-03-09T06:30:00.000Z');
  assert.equal(next('* * * * *', '2026-03-08T06:59:30Z'), '2026-03-08T07:00:00.000Z');
  assert.equal(next('0 3 * * *', '2026-03-08T06:59:59Z'), '2026-03-08T07:00:00.000Z');
});

test('New York fall fold returns only the earlier 01:30 and never schedules a repeated logical minute', () => {
  assert.equal(next('30 1 * * *', '2026-11-01T04:00:00Z'), '2026-11-01T05:30:00.000Z');
  assert.equal(next('30 1 * * *', '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z');
  assert.equal(next('30 1 * * *', '2026-11-01T06:00:00Z'), '2026-11-02T06:30:00.000Z');
  assert.equal(next('30 1 * * *', '2026-11-01T06:29:59Z'), '2026-11-02T06:30:00.000Z');
  assert.equal(next('* * * * *', '2026-11-01T05:59:30Z'), '2026-11-01T07:00:00.000Z');
  assert.equal(next('* * * * *', '2026-11-01T06:00:00Z'), '2026-11-01T07:00:00.000Z');
});

test('calendar filters use the selected local day; fractional offsets, non-hour DST and leap dates remain valid', () => {
  assert.equal(next('0 9 * * 1-5', '2026-10-30T15:00:00Z', 'Asia/Shanghai'), '2026-11-02T01:00:00.000Z');
  assert.equal(next('0 9 * * *', '2026-10-30T00:00:00Z', 'Asia/Kathmandu'), '2026-10-30T03:15:00.000Z');
  assert.equal(next('45 1 * * *', '2026-04-04T13:00:00Z', 'Australia/Lord_Howe'), '2026-04-04T14:45:00.000Z');
  assert.equal(next('45 1 * * *', '2026-04-04T14:46:00Z', 'Australia/Lord_Howe'), '2026-04-05T15:15:00.000Z');
  assert.equal(next('0 0 * * *', '2011-12-29T10:00:00Z', 'Pacific/Apia'), '2011-12-30T10:00:00.000Z');
  assert.equal(next('0 0 29 2 *', '2026-10-30T00:00:00Z'), '2028-02-29T05:00:00.000Z');
  assert.equal(nextCronAt('*/15 * * * *', Date.parse('2026-10-30T12:01:00Z')), '2026-10-30T12:15:00.000Z');
});

test('invalid zones/timestamps and impossible calendar expressions return bounded explicit errors', () => {
  for (const zone of ['Planet/Mars', '../UTC', '+05:00', '', null]) assert.throws(() => nextCronAt('* * * * *', Date.parse('2026-01-01'), zone), { error_code: 'VEK_AGENT_INVALID_REQUEST' });
  assert.throws(() => nextCronAt('* * * * *', NaN, NY), /valid timestamp/);
  assert.throws(() => nextCronAt('* * * * *', Infinity, NY), /valid timestamp/);
  const start = performance.now();
  assert.throws(() => next('0 0 31 2 *', '2026-01-01T00:00:00Z'), /within five years/);
  assert.ok(performance.now() - start < 2000, 'impossible calendar search is bounded by local dates');
});

test('timezone persists across pause/restart, resume skips the second fold, and invalid edits are atomic', async (t) => {
  let clock = Date.parse('2026-11-01T04:00:00Z'); t.mock.method(Date, 'now', () => clock);
  const f = await fixture(t);
  await f.service.dispatch('agents:automations:create', { threadId: f.threadId, prompt: 'Local scheduled test', kind: 'cron', cron: '30 1 * * *', timeZone: NY, status: 'paused' });
  const original = f.service.snapshot().automations[0], id = original.id;
  assert.equal(original.nextRunAt, '2026-11-01T05:30:00.000Z'); assert.equal(original.dstPolicy, 'skip-missing-first-occurrence');
  await assert.rejects(f.service.dispatch('agents:automations:update', { id, timeZone: 'Planet/Mars' }), /IANA timezone/);
  await assert.rejects(f.service.dispatch('agents:automations:update', { id, cron: '0 0 31 2 *' }), /within five years/);
  assert.deepEqual(f.service.snapshot().automations[0], original);
  await f.service.close(); f.reopen(); assert.equal(f.service.snapshot().automations[0].timeZone, NY); assert.equal(f.service.snapshot().automations[0].status, 'paused');
  clock = Date.parse('2026-11-01T06:15:00Z');
  await f.service.dispatch('agents:automations:resume', { id });
  assert.equal(f.service.snapshot().automations[0].nextRunAt, '2026-11-02T06:30:00.000Z');
  await f.service.dispatch('agents:automations:pause', { id }); await sleep(30);
  assert.equal(f.service.snapshot().threads[0].runs.length, 0);
});

test('persisted duplicate fold minute is skipped after restart without starting any provider', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-01T06:31:00Z'));
  const f = await fixture(t);
  await f.service.dispatch('agents:automations:create', { threadId: f.threadId, prompt: 'Do not duplicate', kind: 'cron', cron: '30 1 * * *', timeZone: NY, status: 'paused' });
  await f.service.close(); const state = await f.stored();
  Object.assign(state.automations[0], { status: 'active', nextRunAt: '2026-11-01T06:30:00.000Z', lastScheduledMinute: `${NY}|2026-11-01T01:30` }); await f.store(state); f.reopen();
  const automation = await waitFor(() => f.service.snapshot().automations[0], item => item.lastOutcome === 'skipped-duplicate-minute');
  assert.equal(automation.nextRunAt, '2026-11-02T06:30:00.000Z'); assert.equal(f.service.snapshot().threads[0].runs.length, 0);
});

test('scheduled reservation is persisted before spawn and successful local process output remains real', async (t) => {
  const observed = []; const f = await fixture(t, { onChange: snapshot => observed.push(snapshot) });
  await f.service.dispatch('agents:automations:create', { threadId: f.threadId, prompt: 'One local process', kind: 'at', at: new Date().toISOString() });
  await waitFor(() => f.service.snapshot().threads[0], thread => thread.status === 'completed');
  const reservation = observed.find(snapshot => snapshot.automations[0]?.lastOutcome === 'reserved');
  assert.ok(reservation); assert.equal(reservation.automations[0].nextRunAt, null); assert.equal(reservation.threads[0].runs.length, 0);
  const run = f.service.snapshot().threads[0].runs[0]; assert.ok(run.automationReservationId); assert.match(run.stdout, /actual local timezone fixture/);
});

test('crash reservation recovery restores run count/maxRuns and never replays a reserved command', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-02T06:31:00Z'));
  const f = await fixture(t); await f.service.dispatch('agents:automations:create', { threadId: f.threadId, prompt: 'No replay', kind: 'cron', cron: '30 1 * * *', timeZone: NY, status: 'paused', maxRuns: 1 }); await f.service.close();
  const state = await f.stored(), automation = state.automations[0], thread = state.threads[0];
  Object.assign(automation, { status: 'active', nextRunAt: '2026-11-02T06:30:00.000Z', lastOutcome: 'reserved', lastReservationId: 'reservation-fixture', runCount: 0 });
  thread.status = 'running'; thread.runs.push({ id: 'run-fixture', automationId: automation.id, automationReservationId: 'reservation-fixture', status: 'running', startedAt: '2026-11-01T05:30:00.000Z', stdout: 'Actual interrupted prefix', stderr: '' });
  await f.store(state); f.reopen();
  await waitFor(() => f.service.snapshot().automations[0], item => item.status === 'completed');
  const restored = f.service.snapshot(); assert.equal(restored.automations[0].runCount, 1); assert.equal(restored.automations[0].stopReason, 'Run limit reached');
  assert.equal(restored.threads[0].runs.length, 1); assert.equal(restored.threads[0].runs[0].status, 'interrupted');
});

test('invalid saved timezone is paused and provider failure policy still pauses a real failed fixture run', async (t) => {
  const f = await fixture(t); await f.service.dispatch('agents:automations:create', { threadId: f.threadId, prompt: 'Local failure', kind: 'cron', cron: '0 9 * * *', timeZone: NY, status: 'paused', stopOnFailure: true });
  const id = f.service.snapshot().automations[0].id;
  await f.service.dispatch('agents:providers:configure', { id: 'timezone-fixture', name: 'Failing local fixture', command: process.execPath, args: ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(7))'], inputMode: 'stdin' });
  await f.service.dispatch('agents:automations:run', { id }); await waitFor(() => f.service.snapshot().threads[0], thread => thread.status === 'failed');
  assert.equal(f.service.snapshot().automations[0].status, 'paused');
  await f.service.close(); const state = await f.stored(); state.automations[0].timeZone = 'Planet/Mars'; state.automations[0].status = 'active'; await f.store(state); f.reopen();
  assert.equal(f.service.snapshot().automations[0].status, 'paused'); assert.equal(f.service.snapshot().automations[0].nextRunAt, null); assert.match(f.service.snapshot().automations[0].lastError, /IANA timezone/);
});

test('exhausting the bounded future window runs the valid due occurrence once and pauses without crashing', async (t) => {
  let clock = Date.parse('2096-02-29T04:59:59.999Z'); t.mock.method(Date, 'now', () => clock);
  const f = await fixture(t);
  await f.service.dispatch('agents:automations:create', { threadId: f.threadId, prompt: 'Only local fixture', kind: 'cron', cron: '0 0 29 2 *', timeZone: NY });
  clock = Date.parse('2096-02-29T05:00:00Z');
  await waitFor(() => f.service.snapshot().threads[0], thread => thread.status === 'completed');
  const snapshot = f.service.snapshot();
  assert.equal(snapshot.threads[0].runs.length, 1); assert.equal(snapshot.automations[0].status, 'paused');
  assert.equal(snapshot.automations[0].nextRunAt, null); assert.match(snapshot.automations[0].lastScheduleError, /within five years/);
  await f.service.dispatch('agents:automations:update', { id: snapshot.automations[0].id, cron: '0 0 * * *' });
  assert.equal(f.service.snapshot().automations[0].lastScheduleError, undefined); assert.equal(f.service.snapshot().automations[0].stopReason, undefined);
});

test('real Electron cron editor submits a selected IANA timezone and displays the DST rule', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vek-timezone-ui-')), script = join(directory, 'probe.cjs');
  const source = `const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});try{await window.loadURL('data:text/html,<main id="root"></main>');await window.webContents.executeJavaScript(fs.readFileSync(${JSON.stringify(resolve(new URL('../app/agent-panel.js', import.meta.url).pathname))},'utf8'));const result=await window.webContents.executeJavaScript('('+${JSON.stringify(async function probe() {
    const seed = { providers: [], projects: [{ id: 'p', name: 'Fixture', path: '/test' }], threads: [{ id: 't', projectId: 'p', providerId: 'fake', title: 'Timezone fixture', status: 'idle', messages: [], runs: [] }], automations: [] }, calls = [];
    VekAgentPanel.mount(document.querySelector('#root'), async (method, payload) => { calls.push({ method, payload }); if (method === 'agents:automations:create') seed.automations.push({ ...payload, id: 'a', status: 'paused', nextRunAt: '2026-11-01T05:30:00Z' }); return structuredClone(seed); }); VekAgentPanel.update(seed);
    const click = label => { const node = [...document.querySelectorAll('button')].find(item => item.textContent === label); if (!node) throw Error('Missing control: ' + label); node.click(); };
    click('Automations'); click('New automation'); const kind = document.querySelector('[data-focus="editor-kind"]'); kind.value = 'cron'; kind.onchange();
    const zone = document.querySelector('[data-focus="editor-timeZone"]'); const offered = [...zone.options].some(item => item.value === 'America/New_York'); zone.value = 'America/New_York'; zone.oninput();
    const prompt = document.querySelector('[data-focus="editor-prompt"]'); prompt.value = 'No real task'; prompt.oninput(); const cron = document.querySelector('[data-focus="editor-cron"]'); cron.value = '30 1 * * *'; cron.oninput();
    const notice = document.body.textContent.includes('Repeated clock minutes run once at their first occurrence'); await document.querySelector('.va-dialog').onsubmit({ preventDefault() {} });
    return { offered, notice, call: calls.find(item => item.method === 'agents:automations:create'), card: document.body.textContent.includes('America/New_York') && document.body.textContent.includes('first occurrence only') };
  }.toString())}+')()');assert.equal(result.offered,true);assert.equal(result.notice,true);assert.equal(result.call.payload.timeZone,'America/New_York');assert.equal(result.card,true);console.log('SCHEDULER_TIMEZONE_UI_PASS');window.destroy();app.exit(0);}catch(error){console.error(error.stack);window.destroy();app.exit(1);}});`;
  try { await writeFile(script, source); const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; const child = spawn(require('electron'), [script], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value); const timer = setTimeout(() => child.kill('SIGKILL'), 25000); const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); clearTimeout(timer); assert.equal(code, 0, output); assert.match(output, /SCHEDULER_TIMEZONE_UI_PASS/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

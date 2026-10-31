import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { createActionRecorder } = createRequire(import.meta.url)('../app/action-recorder.cjs');
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/a5XQAAAAASUVORK5CYII=';
const imageSize = Buffer.from(pngBase64, 'base64').length;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vek-recorder-'));
  let page = { targetId: 'page-one', url: 'https://example.test/path', title: 'Local fixture' }, calls = 0;
  let recorder;
  const create = () => recorder = createActionRecorder({ dataDir: directory, minCaptureIntervalMs: 0, activePage: () => page, capture: async value => { calls++; assert.equal(value.targetId, 'page-one'); return { pngBase64 }; }, ...options });
  create();
  t.after(async () => { await recorder.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get recorder() { return recorder; }, get calls() { return calls; }, set page(value) { page = value; }, reopen: create, event: extra => ({ targetId: 'page-one', url: 'https://example.test/path', kind: 'click', x: 20, y: 30, box: { x: 10, y: 15, width: 30, height: 20 }, selector: '#fixture-button', ...extra }) };
}

test('recording is off by default and can capture only the explicitly selected current target', async (t) => {
  const f = await fixture(t);
  assert.equal(f.recorder.snapshot().recording, false);
  assert.deepEqual(await f.recorder.record(f.event()), { accepted: false, reason: 'off' });
  assert.equal(f.calls, 0);
  await assert.rejects(f.recorder.dispatch('recorder:start', { targetId: 'other-page' }), /current page/);
  await f.recorder.dispatch('recorder:start', { name: 'Explicit recording' });
  assert.equal((await f.recorder.record(f.event({ targetId: 'other-page' }))).reason, 'different-target');
  f.page = { targetId: 'other-page', url: 'https://other.test/' };
  assert.equal((await f.recorder.record(f.event())).reason, 'different-target');
  assert.equal(f.calls, 0);
  await f.recorder.dispatch('recorder:stop'); assert.equal(f.recorder.snapshot().recording, false);
});

test('typed values, clipboard text, password/payment events and secret URL components never persist', async (t) => {
  const f = await fixture(t);
  const secret = 'SENTINEL_PRIVATE_INPUT_91827';
  await f.recorder.dispatch('recorder:start');
  for (const input of [
    f.event({ kind: 'key', key: 's', value: secret }),
    f.event({ kind: 'key', key: 'e', altKey: true, value: secret }),
    f.event({ kind: 'key', key: 'Enter', target: { type: 'password', value: secret } }),
    f.event({ kind: 'key', key: 'Tab', target: { tagName: 'INPUT', autocomplete: 'cc-number' }, value: secret }),
    f.event({ target: { tagName: 'INPUT', name: 'cardNumber' }, value: secret }),
    f.event({ kind: 'key', key: 'Enter', sensitive: true, target: { opaque: true } }),
  ]) assert.equal((await f.recorder.record(input)).accepted, false);
  const captured = await f.recorder.record(f.event({ kind: 'key', key: 'a', ctrlKey: true, selector: `input[value="${secret}"]`, value: secret, text: secret, inputData: secret, clipboard: secret, url: `https://user:${secret}@example.test/path?token=${secret}#${secret}`, target: { value: secret } }));
  assert.equal(captured.event.key, 'A'); assert.deepEqual(captured.event.modifiers, ['ctrl']); assert.equal(captured.event.selector, undefined);
  assert.equal(captured.event.url, 'https://example.test/path');
  const id = f.recorder.snapshot().activeSessionId;
  const file = await readFile(join(f.directory, 'recordings', `${id}.json`), 'utf8');
  assert.equal(file.includes(secret), false); assert.equal(file.includes('clipboard'), false); assert.equal(f.calls, 1);
});

test('concurrent event feeds serialize capture, reserve event slots, and enforce automatic event stop', async (t) => {
  let active = 0, maximum = 0;
  const f = await fixture(t, { maxEvents: 3, capture: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return { pngBase64 }; } });
  await f.recorder.dispatch('recorder:start');
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.recorder.record(f.event({ x: i }))));
  assert.equal(results.filter(result => result.accepted).length, 3); assert.equal(maximum, 1);
  const state = f.recorder.snapshot(), session = state.sessions[0];
  assert.equal(session.events.length, 3); assert.equal(state.recording, false); assert.equal(session.stopReason, 'event-limit');
  assert.equal(session.imageBytes, imageSize * 3);
  assert.equal((await stat(join(f.directory, 'recordings'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'recordings/images'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'recordings/images', session.id))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'recordings', `${session.id}.json`))).mode & 0o777, 0o600);
});

test('capture rate, per-image limit, total image limit and invalid image responses are enforced', async (t) => {
  const limited = await fixture(t, { minCaptureIntervalMs: 10000 });
  await limited.recorder.dispatch('recorder:start');
  await limited.recorder.record(limited.event());
  const skipped = await limited.recorder.record(limited.event({ kind: 'scroll', deltaY: 40 }));
  assert.equal(skipped.event.screenshotStatus, 'rate-limited'); assert.equal(limited.calls, 1);
  const imageLimited = await fixture(t, { maxImageBytes: 8 });
  await imageLimited.recorder.dispatch('recorder:start');
  assert.equal((await imageLimited.recorder.record(imageLimited.event())).event.screenshotStatus, 'image-limit-or-invalid');
  const totalLimited = await fixture(t, { maxTotalImageBytes: imageSize });
  await totalLimited.recorder.dispatch('recorder:start'); await totalLimited.recorder.record(totalLimited.event());
  assert.equal((await totalLimited.recorder.record(totalLimited.event())).event.screenshotStatus, 'total-limit'); assert.equal(totalLimited.calls, 1);
  const invalid = await fixture(t, { capture: async () => ({ pngBase64: Buffer.from('not a png').toString('base64') }) });
  await invalid.recorder.dispatch('recorder:start'); assert.equal((await invalid.recorder.record(invalid.event())).event.screenshotStatus, 'image-limit-or-invalid');
  const caps = await fixture(t, { maxEvents: 999, maxImageBytes: 99 * 1024 * 1024, maxTotalImageBytes: 999 * 1024 * 1024 });
  assert.equal(caps.recorder.snapshot().limits.maxEvents, 200); assert.equal(caps.recorder.snapshot().limits.maxImageBytes, 5 * 1024 * 1024); assert.equal(caps.recorder.snapshot().limits.maxTotalImageBytes, 50 * 1024 * 1024);
});

test('soft deletion and restoration survive restart with the same screenshot and native export', async (t) => {
  const f = await fixture(t);
  await f.recorder.dispatch('recorder:start', { name: '<script>literal title</script>' });
  const recorded = await f.recorder.record(f.event());
  await f.recorder.dispatch('recorder:stop');
  await f.recorder.dispatch('recorder:delete', { id: recorded.sessionId });
  assert.ok(f.recorder.snapshot().sessions[0].deletedAt);
  await f.recorder.close(); f.reopen();
  assert.ok(f.recorder.snapshot().sessions[0].deletedAt);
  await f.recorder.dispatch('recorder:restore', { id: recorded.sessionId });
  const restored = await f.recorder.dispatch('recorder:read', { id: recorded.sessionId, eventId: recorded.event.id });
  assert.equal(restored.preview.pngBase64, pngBase64); assert.equal(restored.deletedAt, undefined);
  const exported = await f.recorder.dispatch('recorder:export', { id: recorded.sessionId });
  const bundle = JSON.parse(exported.exportData.content);
  assert.equal(bundle.format, 'vek-action-recording'); assert.equal(bundle.recording.events[0].pngBase64, pngBase64);
  assert.equal(bundle.recording.name, '<script>literal title</script>');
  const files = await readdir(join(f.directory, 'recordings/images', recorded.sessionId)); assert.equal(files.length, 1);
});

test('close drains accepted geometry without starting queued screenshots and times out a hung capture', async (t) => {
  let captures = 0;
  const f = await fixture(t, { capture: async () => { captures++; await new Promise(resolve => setTimeout(resolve, 30)); return { pngBase64 }; } });
  await f.recorder.dispatch('recorder:start');
  const records = Array.from({ length: 10 }, () => f.recorder.record(f.event()));
  await new Promise(resolve => setTimeout(resolve, 5)); await f.recorder.close(); await Promise.all(records);
  assert.equal(captures, 1); assert.equal(f.recorder.snapshot().sessions[0].events.length, 10);
  assert.equal(f.recorder.snapshot().sessions[0].imageBytes, 0);
  assert.equal(f.recorder.snapshot().sessions[0].status, 'interrupted'); assert.equal(f.recorder.snapshot().recording, false);
  const hung = await fixture(t, { captureTimeoutMs: 20, capture: async () => new Promise(() => {}) });
  await hung.recorder.dispatch('recorder:start'); const record = hung.recorder.record(hung.event());
  await new Promise(resolve => setTimeout(resolve, 5)); const started = Date.now(); await hung.recorder.close();
  assert.ok(Date.now() - started < 500); assert.equal((await record).event.screenshotStatus, 'capture-failed');
  await assert.rejects(hung.recorder.dispatch('recorder:start'), /closed/);
});

test('a persisted interrupted recording reopens off and observer failures never corrupt capture', async (t) => {
  const f = await fixture(t, { onChange: () => { throw new Error('observer failure'); } });
  await f.recorder.dispatch('recorder:start'); const result = await f.recorder.record(f.event()); await f.recorder.close();
  const file = join(f.directory, 'recordings', `${result.sessionId}.json`), data = JSON.parse(await readFile(file, 'utf8'));
  data.status = 'recording'; delete data.endedAt; await writeFile(file, JSON.stringify(data));
  f.reopen(); assert.equal(f.recorder.snapshot().recording, false); assert.equal(f.recorder.snapshot().sessions[0].status, 'interrupted');
  assert.equal(f.recorder.snapshot().sessions[0].stopReason, 'app-restart');
  assert.deepEqual(await f.recorder.record(f.event()), { accepted: false, reason: 'off' });
  assert.equal((await f.recorder.dispatch('recorder:read', { id: result.sessionId })).events.length, 1);
});

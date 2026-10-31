import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMcpService, createBrowserGateway } = require('../app/mcp-service.cjs');
const fixture = resolve(import.meta.dirname, 'fixtures/fake-mcp-server.cjs');
const scope = { projectId: 'p1', threadId: 't1' }, secondScope = { projectId: 'p1', threadId: 't2' }, otherScope = { projectId: 'p2', threadId: 't3' };
async function harness(options = {}) {
 const dir = await fs.mkdtemp(join(tmpdir(), 'vek-mcp-test-'));
 const resolver = async s => s.projectId === 'p1' && ['t1', 't2', undefined].includes(s.threadId) || s.projectId === 'p2' && s.threadId === 't3' ? { ...s, projectPath: dir, browserSpaceId: s.threadId === 't1' ? 7 : 8 } : null;
 const service = createMcpService({ dataDir: dir, resolveScope: resolver, requestTimeoutMs: 700, ...options });
 const save = async (extra = {}) => { const next = await service.dispatch('mcp:integrations:save', { name: 'Fixture', command: process.execPath, args: [fixture], scope: { projectId: 'p1' }, ...extra }); return next.integrations.at(-1).id; };
 const call = async (id, name, args = {}, s = scope, timeoutMs) => { const task = await service.dispatch('mcp:tools:call', { integrationId: id, name, arguments: args, scope: s, ...(timeoutMs ? { timeoutMs } : {}) }); return service.dispatch('mcp:tasks:wait', { id: task.id, scope: s, timeoutMs: 3000 }); };
 return { dir, resolver, service, save, call, close: async () => { await service.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}
const value = task => JSON.parse(task.result.content[0].text);

test('MCP stdio initializes, paginates tools, isolates thread processes and answers roots/list', async () => {
 const h = await harness(); try {
  const id = await h.save(); const tools = await h.service.dispatch('mcp:tools:list', { integrationId: id, scope }); assert.equal(tools.tools.length, 6);
  const first = value(await h.call(id, 'inspect')); const second = value(await h.call(id, 'inspect', {}, secondScope)); assert.equal(first.counter, 1); assert.equal(second.counter, 1); assert.notEqual(first.pid, second.pid); assert.equal(first.cwd, await fs.realpath(h.dir)); assert.ok(first.rootUri.startsWith('file:'));
  assert.equal((await h.call(id, 'inspect')).status, 'completed');
  await assert.rejects(h.call(id, 'echo', {}, otherScope), /outside/);
  await assert.rejects(h.service.dispatch('mcp:integrations:connect', { id, scope: { projectId: 'p1', threadId: 'missing' } }), /scope/);
  const privateId = await h.save({ name: 'Thread only', scope });
  await assert.rejects(h.service.dispatch('mcp:integrations:connect', { id: privateId, scope: secondScope }), /outside/);
 } finally { await h.close(); }
});

test('known credential values are transient, redacted in results/keys and never forwarded implicitly', async () => {
 const secret = 'private"credential\\value'; process.env.PARENT_SECRET = 'parent-credential';
 const h = await harness({ resolveCredential: async ref => ref === 'keychain:fixture' ? secret : undefined }); try {
  const id = await h.save({ credentialRefs: { TEST_TOKEN: 'keychain:fixture' } }); const task = await h.call(id, 'echo', { greeting: 'hello' }); assert.equal(task.status, 'completed');
  assert.ok(JSON.stringify(task).includes('[redacted]')); assert.ok(!JSON.stringify(task).includes(secret));
  assert.equal(value(await h.call(id, 'inspect')).parentSecret, null);
  await new Promise(r => setTimeout(r, 15)); const state = h.service.snapshot(); assert.ok(!JSON.stringify(state).includes(secret)); assert.match(state.connections[0].stderr, /not retained/);
  const disk = await fs.readFile(join(h.dir, 'mcp/state.json'), 'utf8'); assert.ok(!disk.includes(JSON.stringify(secret).slice(1, -1))); assert.equal(value(task).credential, '[redacted]'); assert.equal(value(task)['[redacted]'], 'key'); assert.ok(!disk.includes('parent-credential')); assert.ok(disk.includes('keychain:fixture'));
  await assert.rejects(h.save({ env: { TEST_TOKEN: secret } }), /references/);
  await assert.rejects(h.save({ credentialRefs: { TEST_TOKEN: secret } }), /provider:name/);
 } finally { delete process.env.PARENT_SECRET; await h.close(); }
});

test('MCP tool tasks time out, cancel, reject foreign reads and ignore late replies', async () => {
 const h = await harness(); try {
  const id = await h.save(); await h.service.dispatch('mcp:tools:list', { integrationId: id, scope });
  const pending = await h.service.dispatch('mcp:tasks:create', { integrationId: id, name: 'slow', arguments: { ms: 2000 }, scope, timeoutMs: 2000 });
  await new Promise(r => setTimeout(r, 20)); await assert.rejects(h.service.dispatch('mcp:tasks:read', { id: pending.id, scope: secondScope }), /outside/);
  assert.equal((await h.service.dispatch('mcp:tasks:cancel', { id: pending.id, scope })).status, 'cancelled');
  assert.equal((await h.call(id, 'slow', { ms: 2000 }, scope, 50)).status, 'timed_out');
  assert.ok(value(await h.call(id, 'inspect')).cancelled >= 2);
  await assert.rejects(h.service.dispatch('mcp:tasks:create', { integrationId: id, name: 'echo', scope, timeoutMs: -1 }), /between/);
  assert.equal(h.service.snapshot().tasks.filter(t => t.status === 'running').length, 0);
 } finally { await h.close(); }
});

test('malformed and oversized MCP stdout fail pending tasks; unknown tools are rejected', async () => {
 const h = await harness(); try {
  for (const name of ['invalid', 'huge', 'exit']) { const id = await h.save({ name }); const task = await h.call(id, name); assert.equal(task.status, 'failed'); assert.match(task.error, /Malformed|size limit|exited/); }
  const id = await h.save({ name: 'Valid' }); assert.equal((await h.call(id, 'missing')).status, 'failed');
 } finally { await h.close(); }
});

test('invalid initialize versions and initialization timeouts disconnect cleanly', async () => {
 const h = await harness({ requestTimeoutMs: 100 }); try {
  const bad = await h.save({ args: [fixture, '--bad-version'] }); await assert.rejects(h.service.dispatch('mcp:integrations:connect', { id: bad, scope }), /initialize/);
  const slow = await h.save({ args: [fixture, '--no-initialize'] }); await assert.rejects(h.service.dispatch('mcp:integrations:connect', { id: slow, scope }), /timed out/);
  assert.equal(h.service.snapshot().connections.length, 0);
 } finally { await h.close(); }
});

test('closing MCP records interrupted tasks and releases the persistent store lock', async () => {
 const h = await harness(); try {
  assert.throws(() => createMcpService({ dataDir: h.dir, resolveScope: h.resolver }), /Another MCP service/);
  const id = await h.save(); const task = await h.service.dispatch('mcp:tasks:create', { integrationId: id, name: 'slow', arguments: { ms: 2000 }, scope }); await new Promise(r => setTimeout(r, 40));
  await h.service.close(); const disk = JSON.parse(await fs.readFile(join(h.dir, 'mcp/state.json'))); assert.equal(disk.tasks.find(t => t.id === task.id).status, 'interrupted');
  await assert.rejects(h.service.dispatch('mcp:snapshot'), /closed/);
  const restored = createMcpService({ dataDir: h.dir, resolveScope: h.resolver }); assert.equal(restored.snapshot().tasks.at(-1).status, 'interrupted'); await restored.close();
 } finally { await h.close(); }
});

async function post(url, body, token, headers = {}) { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) }); return { status: response.status, data: response.status === 202 ? null : await response.json() }; }
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
test('loopback gateway pairs once, binds scopes, forwards real tools and revokes tokens', async () => {
 const calls = []; const gateway = createBrowserGateway({ callbacks: { listTabs: async input => { calls.push(input); return { tabs: ['scoped'] }; }, navigate: async () => ({ success: true }) }, resolveScope: async s => ({ ...s, browserSpaceId: 7 }) });
 const h = await harness({ browserGateway: gateway }); try {
  const id = await h.save(); const pair = await h.service.dispatch('mcp:pairing:create', { scope, name: 'Fixture client', integrationIds: [id], browserMethods: ['listTabs'] });
  const exchange = await post(pair.exchangeUrl, { code: pair.code }); assert.equal(exchange.status, 200); const { token, endpoint, grantId } = exchange.data;
  assert.equal((await post(pair.exchangeUrl, { code: pair.code })).status, 403);
  assert.equal((await post(endpoint, rpc('initialize', { protocolVersion: '2025-11-25' }), token)).data.result.serverInfo.name, 'vek-scoped-gateway');
  assert.equal((await post(endpoint, rpc('ping'), null)).status, 401);
  assert.equal((await post(endpoint, rpc('ping'), token, { origin: 'https://hostile.example' })).status, 403);
  const tools = (await post(endpoint, rpc('tools/list'), token)).data.result.tools; assert.ok(tools.some(t => t.name === `external.${id}.echo`)); assert.ok(tools.some(t => t.name === 'browser.listTabs')); assert.ok(!tools.some(t => t.name === 'browser.navigate'));
  const echoed = await post(endpoint, rpc('tools/call', { name: `external.${id}.echo`, arguments: { hello: 'gateway' } }), token); assert.equal(JSON.parse(echoed.data.result.content[0].text).args.hello, 'gateway');
  const scoped = await post(endpoint, rpc('tools/call', { name: 'browser.listTabs', arguments: {} }), token); assert.equal(scoped.status, 200); assert.equal(calls[0].scope.threadId, 't1'); assert.equal(calls[0].scope.browserSpaceId, 7);
  const forbidden = await post(endpoint, rpc('tools/call', { name: 'browser.navigate', arguments: { targetId: 'id', url: 'https://example.com' } }), token); assert.ok(forbidden.data.error);
  const cross = await post(endpoint, rpc('tools/call', { name: 'vek.tasks.create', arguments: { integrationId: id, name: 'inspect', scope: otherScope } }), token); const created = JSON.parse(cross.data.result.content[0].text); assert.deepEqual(created.scope, scope);
  const disk = await fs.readFile(join(h.dir, 'mcp/state.json'), 'utf8'); assert.ok(!disk.includes(token)); assert.ok(!disk.includes(pair.code)); assert.ok(!JSON.stringify(h.service.snapshot()).includes(token));
  await h.service.dispatch('mcp:grants:revoke', { id: grantId }); assert.equal((await post(endpoint, rpc('ping'), token)).status, 403);
 } finally { await h.close(); }
});

test('HTTP cancellation owns its request and disconnected stdio servers reconnect', async () => {
 const h = await harness(); try {
  const id = await h.save(); const pair = await h.service.dispatch('mcp:pairing:create', { scope, integrationIds: [id] }); const exchange = (await post(pair.exchangeUrl, { code: pair.code })).data;
  await post(exchange.endpoint, rpc('tools/list'), exchange.token);
  const pending = post(exchange.endpoint, rpc('tools/call', { name: `external.${id}.slow`, arguments: { ms: 2500 } }, 'cancel-me'), exchange.token);
  await new Promise(r => setTimeout(r, 30)); const notification = await post(exchange.endpoint, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me' } }, exchange.token); assert.equal(notification.status, 202);
  const cancelled = await pending; const outcome = JSON.parse(cancelled.data.result.content[0].text); assert.equal(outcome.status, 'cancelled');
  assert.ok(value(await h.call(id, 'inspect')).cancelled >= 1);
  assert.equal((await h.call(id, 'exit')).status, 'failed');
  const reconnect = await h.call(id, 'inspect'); assert.equal(reconnect.status, 'completed'); assert.equal(value(reconnect).counter, 1);
  await assert.rejects(h.service.dispatch('mcp:pairing:create', { scope: { projectId: 'p1' }, integrationIds: [id], browserMethods: ['listTabs'] }), /Unknown browser/);
 } finally { await h.close(); }
});

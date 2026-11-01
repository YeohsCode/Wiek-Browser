import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const { createMcpService, StdioClient, HttpClient } = createRequire(import.meta.url)('../app/mcp-service.cjs');
const peer = path.join(import.meta.dirname, 'fixtures/mcp-resource-peer.cjs');
const scope = { projectId: 'p', threadId: 'a' }, second = { projectId: 'p', threadId: 'b' }, uri = 'fixture:///notes';
async function setup(t, mode = '') {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vek-resources-'));
 const service = createMcpService({ dataDir: dir, requestTimeoutMs: 400, resolveScope: async s => s.projectId === 'p' ? { ...s, projectPath: dir } : null });
 t.after(async () => { await service.close(); await fs.rm(dir, { recursive: true, force: true }); });
 const state = await service.dispatch('mcp:integrations:save', { name: 'Resources', command: process.execPath, args: [peer, mode], scope });
 const id = state.integrations[0].id;
 const call = (verb, extra = {}) => service.dispatch(`mcp:resources:${verb}`, { integrationId: id, scope, uri, ...extra });
 return { dir, service, id, call, connection: () => service.snapshot().connections[0] };
}
const pause = ms => new Promise(r => setTimeout(r, ms));
async function inspect(h, name = 'inspect') { const job = await h.service.dispatch('mcp:tools:call', { integrationId: h.id, scope, name }); const done = await h.service.dispatch('mcp:tasks:wait', { id: job.id, scope }); return JSON.parse(done.result.content[0].text); }

test('scoped resource pagination, templates, text and binary reads do not persist contents', async t => {
 const h = await setup(t);
 assert.equal((await h.call('list')).resources.length, 2);
 assert.equal((await h.call('templates')).resourceTemplates[0].uriTemplate, 'fixture:///entry/{id}');
 assert.equal((await h.call('read')).contents[0].text, 'revision 0');
 assert.equal((await h.call('read', { uri: 'file:///never-opened/binary' })).contents[0].blob, 'AAEC');
 await assert.rejects(h.call('read', { scope: second }), /outside/);
 await assert.rejects(h.call('subscribe', { scope: { projectId: 'other' } }), /scope/);
 const disk = await fs.readFile(path.join(h.dir, 'mcp/state.json'), 'utf8'); assert.ok(!disk.includes('revision 0')); assert.ok(!disk.includes('AAEC'));
 assert.ok(!JSON.stringify(h.service.snapshot()).includes('revision 0'));
});

test('subscriptions retain early updates, invalidate lists, and require explicit rereads', async t => {
 const h = await setup(t); await h.call('list'); await h.call('subscribe');
 assert.equal(h.connection().resourceSubscriptions[0].revision, 1); assert.equal(h.connection().resourceSubscriptions[0].status, 'subscribed');
 const before = await inspect(h); assert.equal(before.counts['resources/read'], undefined);
 await inspect(h, 'mutate'); await pause(10);
 assert.equal(h.connection().resources, null); assert.equal(h.connection().resourceSubscriptions.length, 1);
 assert.equal(h.connection().resourceSubscriptions[0].revision, 2);
 assert.equal((await inspect(h)).counts['resources/read'], undefined);
 assert.equal((await h.call('read')).contents[0].text, 'revision 1'); assert.equal(h.connection().resourceSubscriptions[0].readRevision, 2);
 await h.call('unsubscribe'); assert.equal(h.connection().resourceSubscriptions.length, 0);
 await inspect(h, 'mutate'); assert.equal(h.connection().resourceSubscriptions.length, 0);
});

test('updates during an outstanding read leave it stale', async t => {
 const h = await setup(t); const slow = 'fixture:///slow'; await h.call('subscribe', { uri: slow });
 const result = await h.call('read', { uri: slow }); assert.equal(result.stale, true); assert.equal(result.revision, 1);
 assert.equal(h.connection().resourceSubscriptions[0].revision, 2); assert.equal(h.connection().resourceSubscriptions[0].readRevision, 1);
});

test('missing resources or subscription capability never sends unsupported methods', async t => {
 for (const mode of ['noresources', 'nosubscribe']) { const h = await setup(t, mode); await assert.rejects(h.call('subscribe'), /advertise/); const status = await inspect(h); assert.equal(status.counts['resources/subscribe'], undefined); if (mode === 'noresources') { await assert.rejects(h.call('list'), /advertise/); await assert.rejects(h.call('read'), /advertise/); } }
});

test('invalid pagination and concurrent list invalidation fail explicitly', async t => {
 for (const mode of ['duplicate', 'cycle', 'emptycursor', 'overlist', 'list-race']) { const h = await setup(t, mode); await assert.rejects(h.call('list'), /Duplicate|cursor|limits|changed/); assert.equal(h.connection().resources, null); }
});

test('invalid URIs and content unions or blobs are rejected; inert text stays literal', async t => {
 const h = await setup(t);
 for (const value of ['relative', 'fixture:///a\n', '', null, 'fixture:///a b']) await assert.rejects(h.call('read', { uri: value }), /URI/);
 for (const value of ['fixture:///badblob', 'fixture:///both']) await assert.rejects(h.call('read', { uri: value }), /blob|either/);
 assert.match((await h.call('list')).resources[0].name, /<script>/);
});

test('uncertain subscription outcomes stay unknown; disconnect and reconnect never resubscribe', async t => {
 const h = await setup(t); await assert.rejects(h.call('subscribe', { uri: 'fixture:///hang' }), /timed out/);
 assert.equal(h.connection().resourceSubscriptions[0].status, 'unknown');
 await h.call('unsubscribe', { uri: 'fixture:///hang' });
 await h.call('subscribe', { uri: 'fixture:///reject' }); await assert.rejects(h.call('unsubscribe', { uri: 'fixture:///reject' }), /cannot/);
 assert.equal(h.connection().resourceSubscriptions[0].status, 'unknown');
 await h.service.dispatch('mcp:integrations:disconnect', { id: h.id, scope });
 await h.call('list'); assert.equal(h.connection().resourceSubscriptions.length, 0); assert.equal((await inspect(h)).counts['resources/subscribe'], undefined);
});

test('disconnect cancels pending reads and removes connection memory', async t => {
 const h = await setup(t); await h.call('subscribe');
 const read = h.call('read', { uri: 'fixture:///hang' }); const rejected = assert.rejects(read, /stopped|closed|disconnected/);
 await pause(30); await h.service.dispatch('mcp:integrations:disconnect', { id: h.id, scope }); await rejected;
 assert.equal(h.service.snapshot().connections.length, 0);
});

test('resource operation limits and AbortSignal cancellation work with a real stdio peer', async t => {
 const client = new StdioClient({ config: { command: process.execPath, args: [peer] }, cwd: os.tmpdir(), timeoutMs: 400 }); t.after(() => client.stop()); await client.start();
 const abort = new AbortController(), read = client.readResource('fixture:///hang', { signal: abort.signal }); const rejected = assert.rejects(read, /cancelled/); abort.abort(); await rejected;
 const inProgress = client.setResourceSubscription('fixture:///hang', true); const timedOut = assert.rejects(inProgress, /timed out/);
 await assert.rejects(client.setResourceSubscription('fixture:///hang', true), /already changing/); await timedOut;
 client.resourceSubscriptions = new Map(Array.from({ length: 128 }, (_, i) => [`fixture:///${i}`, { uri: `fixture:///${i}`, status: 'subscribed', revision: 0, readRevision: 0 }]));
 await assert.rejects(client.setResourceSubscription('fixture:///extra', true), /limit/);
});

async function httpPeer(t) {
 const streams = new Set(), calls = []; let session = 0;
 const server = http.createServer(async (req, res) => {
  if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
  if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); streams.add(res); res.on('close', () => streams.delete(res)); return; }
  let body = ''; for await (const chunk of req) body += chunk; const m = JSON.parse(body); calls.push(m);
  if (!Object.hasOwn(m, 'id') || !Object.hasOwn(m, 'method')) { res.writeHead(202); res.end(); return; }
  let result = {};
  if (m.method === 'initialize') { result = { protocolVersion: '2025-11-25', serverInfo: { name: 'http-resources' }, capabilities: { resources: { subscribe: true, listChanged: true } } }; res.setHeader('Mcp-Session-Id', `fixture-${++session}`); }
  if (m.method === 'resources/list') result = { resources: [{ uri, name: 'HTTP resource' }] };
  if (m.method === 'resources/read') result = { contents: [{ uri, text: 'HTTP content' }] };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
 });
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 t.after(async () => { for (const res of streams) res.destroy(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
 const client = new HttpClient({ config: { url: `http://127.0.0.1:${server.address().port}`, allowInsecureHttp: true }, cwd: os.tmpdir(), timeoutMs: 500 }); t.after(() => client.stop()); await client.start();
 return { client, calls, streams, send: m => { for (const res of streams) res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n\n'); } };
}
test('session HTTP resource subscriptions receive GET notifications and clear on session recovery', async t => {
 const h = await httpPeer(t); for (let i = 0; !h.streams.size && i < 50; i++) await pause(5); assert.equal(h.streams.size, 1);
 assert.equal((await h.client.listResources())[0].uri, uri); await h.client.setResourceSubscription(uri, true);
 h.send({ method: 'notifications/resources/updated', params: { uri } }); h.send({ method: 'notifications/resources/list_changed' }); await pause(20);
 assert.equal(h.client.resources, null); assert.equal(h.client.resourceSubscriptions.get(uri).revision, 1);
 assert.equal((await h.client.readResource(uri)).contents[0].text, 'HTTP content');
 await h.client.recoverSession(); assert.equal(h.client.resourceSubscriptions.size, 0);
 assert.equal(h.calls.filter(m => m.method === 'resources/subscribe').length, 1);
});

test('modern HTTP rejects resources locally without sending a legacy method', async () => {
 const client = new HttpClient({ config: { url: 'https://example.invalid/mcp', protocolVersion: '2026-07-28' }, cwd: os.tmpdir() });
 client.state = 'connected'; client.info = { capabilities: { resources: { subscribe: true } } };
 await assert.rejects(client.listResources(), /session MCP/); await assert.rejects(client.readResource(uri), /session MCP/); await assert.rejects(client.setResourceSubscription(uri, true), /session MCP/);
 assert.equal(client.pending.size, 0); await client.stop();
});

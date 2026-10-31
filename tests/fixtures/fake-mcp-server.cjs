'use strict';
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
const jobs = new Map(), cancelled = new Set(); let initialized = false, counter = 0, rootUri;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => send({ id, result: value });
const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
lines.on('line', line => {
 let message; try { message = JSON.parse(line); } catch { return; }
 if (message.id === 'roots-probe' && message.result) { rootUri = message.result.roots?.[0]?.uri; return; }
 if (message.method === 'initialize') {
  if (process.argv.includes('--no-initialize')) return;
  return result(message.id, { protocolVersion: process.argv.includes('--bad-version') ? '9999-01-01' : message.params.protocolVersion, serverInfo: { name: 'fake-mcp', version: '1', credentialEcho: process.env.TEST_TOKEN || '' }, capabilities: { tools: { listChanged: true } } });
 }
 if (message.method === 'notifications/initialized') { initialized = true; send({ id: 'roots-probe', method: 'roots/list' }); return; }
 if (message.method === 'notifications/cancelled') { cancelled.add(message.params.requestId); clearTimeout(jobs.get(message.params.requestId)); jobs.delete(message.params.requestId); return; }
 if (message.method === 'tools/list') {
  if (!initialized) return send({ id: message.id, error: { code: -32000, message: 'not initialized' } });
  const tools = ['echo', 'slow', 'inspect', 'invalid', 'exit', 'huge'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  return result(message.id, message.params.cursor ? { tools: tools.slice(3) } : { tools: tools.slice(0, 3), nextCursor: 'second' });
 }
 if (message.method === 'tools/call') {
  const { name, arguments: args = {} } = message.params;
  if (name === 'invalid') return process.stdout.write('this is not JSON\n');
  if (name === 'exit') return process.exit(4);
  if (name === 'huge') return process.stdout.write('x'.repeat(1200000) + '\n');
  if (name === 'slow') { const timer = setTimeout(() => { jobs.delete(message.id); result(message.id, content({ delayed: args.marker || 'done' })); }, args.ms || 1000); jobs.set(message.id, timer); return; }
  if (name === 'inspect') return result(message.id, content({ pid: process.pid, counter: ++counter, cancelled: cancelled.size, cwd: process.cwd(), rootUri, parentSecret: process.env.PARENT_SECRET || null }));
  if (name === 'echo') { if (process.env.TEST_TOKEN) { const value = process.env.TEST_TOKEN; process.stderr.write(value.slice(0, 3)); setTimeout(() => process.stderr.write(value.slice(3)), 5); } return result(message.id, content({ args, credential: process.env.TEST_TOKEN || null, [process.env.TEST_TOKEN || 'none']: 'key' })); }
  return send({ id: message.id, error: { code: -32601, message: 'unknown tool' } });
 }
});

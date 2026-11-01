'use strict';
const readline = require('node:readline');
const mode = process.argv[2] || '', subscriptions = new Set();
const counts = {}, uri = 'fixture:///notes', other = 'fixture:///second'; let version = 0;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const result = (id, value) => send({ id, result: value });
const updated = value => send({ method: 'notifications/resources/updated', params: { uri: value } });
readline.createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line), p = m.params || {}; counts[m.method] = (counts[m.method] || 0) + 1;
 if (m.method === 'initialize') return result(m.id, { protocolVersion: p.protocolVersion, serverInfo: { name: 'resource-peer', version: '1' }, capabilities: { tools: {}, ...(mode === 'noresources' ? {} : { resources: { subscribe: mode !== 'nosubscribe', listChanged: true } }) } });
 if (!Object.hasOwn(m, 'id')) return;
 if (m.method === 'resources/list') {
  if (mode === 'list-race') send({ method: 'notifications/resources/list_changed' });
  if (mode === 'overlist') return result(m.id, { resources: Array.from({ length: 2001 }, (_, i) => ({ uri: `fixture:///${i}`, name: 'item' })) });
  if (mode === 'duplicate') return result(m.id, { resources: [{ uri, name: 'one' }, { uri, name: 'two' }] });
  if (mode === 'cycle') return result(m.id, { resources: [], nextCursor: 'again' });
  if (mode === 'emptycursor') return result(m.id, { resources: [], nextCursor: '' });
  return result(m.id, p.cursor ? { resources: [{ uri: other, name: 'Second' }] } : { resources: [{ uri, name: '<script>untrusted</script>', description: 'Inert data', mimeType: 'text/plain' }], nextCursor: 'next' });
 }
 if (m.method === 'resources/templates/list') return result(m.id, { resourceTemplates: [{ uriTemplate: 'fixture:///entry/{id}', name: 'Entry' }] });
 if (m.method === 'resources/read') {
  if (p.uri.endsWith('/badblob')) return result(m.id, { contents: [{ uri: p.uri, blob: '!bad!' }] });
  if (p.uri.endsWith('/both')) return result(m.id, { contents: [{ uri: p.uri, text: 'a', blob: 'Yg==' }] });
  if (p.uri.endsWith('/binary')) return result(m.id, { contents: [{ uri: p.uri, blob: 'AAEC', mimeType: 'application/octet-stream' }] });
  if (p.uri.endsWith('/slow')) { setTimeout(() => updated(p.uri), 10); return setTimeout(() => result(m.id, { contents: [{ uri: p.uri, text: 'older read' }] }), 100); }
  if (p.uri.endsWith('/hang')) return;
  return result(m.id, { contents: [{ uri: p.uri, text: `revision ${version}`, mimeType: 'text/plain' }] });
 }
 if (m.method === 'resources/subscribe') { subscriptions.add(p.uri); updated(p.uri); if (p.uri.endsWith('/hang')) return; return result(m.id, {}); }
 if (m.method === 'resources/unsubscribe') { if (p.uri.endsWith('/reject')) return send({ id: m.id, error: { code: -32603, message: 'cannot unsubscribe' } }); subscriptions.delete(p.uri); return result(m.id, {}); }
 if (m.method === 'tools/list') return result(m.id, { tools: [{ name: 'mutate', inputSchema: { type: 'object' } }, { name: 'inspect', inputSchema: { type: 'object' } }] });
 if (m.method === 'tools/call') {
  if (p.name === 'mutate') { version++; for (const value of subscriptions) updated(value); updated('fixture:///unsolicited'); send({ method: 'notifications/resources/list_changed' }); }
  return result(m.id, { content: [{ type: 'text', text: JSON.stringify({ counts, subscriptions: [...subscriptions], version }) }] });
 }
 send({ id: m.id, error: { code: -32601, message: 'unsupported' } });
});

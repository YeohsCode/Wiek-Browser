import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import titles from '../app/local-server-title.cjs';
const {titleFromHtml, readLocalTitle} = titles;

async function fixture(t, respond) {
  const requests = [], sockets = new Set();
  const server = createServer((request, response) => { requests.push(request); respond(request, response); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return {server, requests, url: `http://127.0.0.1:${server.address().port}/`};
}

test('metadata priority, attribute forms, entities and Unicode are preserved as inert bounded text', () => {
  assert.equal(titleFromHtml('<title>Fallback</title><meta property="og:title" content="Social"><META content=Application name=application-name>'), 'Application');
  assert.equal(titleFromHtml('<meta content="&#x4e2d;&#25991; &amp; &#x1f642;" name="twitter:title"><title>Fallback</title>'), '中文 & 🙂');
  assert.equal(titleFromHtml('<title>  Hello\n &lt;img onerror=attack&gt; &nbsp; world </title>'), 'Hello <img onerror=attack> world');
  assert.equal([...titleFromHtml('<title>' + '🙂'.repeat(300) + '</title>')].length, 200);
});
test('comments, raw text, hidden templates, foreign titles and body metadata cannot impersonate the head', () => {
  assert.equal(titleFromHtml('<!--<title>Comment</title>--><script>"<title>Script</title>"</script><style><title>Style</title></style><template><title>Hidden</title></template><svg><title>Graphic</title></svg><title>Visible</title>'), 'Visible');
  assert.equal(titleFromHtml('<head></head><body><meta name=application-name content=Body>'), null);
  assert.equal(titleFromHtml('<template><svg><title>Hidden</title></svg></template><title>Real</title>'), 'Real');
  assert.equal(titleFromHtml('<script>never closes <title>Fake</title>'), null);
});
test('long valueless metadata attributes are consumed without losing the subsequent title fields',()=>{
  assert.equal(titleFromHtml('<meta '+'x'.repeat(100000)+' name=application-name content=Bounded><title>Fallback</title>'),'Bounded');
});
test('an actual loopback read sends one anonymous request and does not request embedded assets', async t => {
  const f = await fixture(t, (_q,r) => {r.setHeader('Content-Type','text/html; charset=utf-8'); r.end('<head><title>本地服务</title><script src="/must-not-load"></script></head>');});
  const result = await readLocalTitle(f.url);
  assert.equal(result.title, '本地服务'); assert.equal(result.status, 'read');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'GET');
  assert.equal(f.requests[0].headers.cookie, undefined); assert.equal(f.requests[0].headers.authorization, undefined);
  assert.equal(f.requests[0].headers['accept-encoding'], 'identity');
});
for (const [label, status, headers] of [
  ['redirect',302,{'Location':'http://192.0.2.1/','Content-Type':'text/html'}],
  ['JSON',200,{'Content-Type':'application/json'}],
  ['compressed',200,{'Content-Type':'text/html','Content-Encoding':'gzip'}],
  ['unknown charset',200,{'Content-Type':'text/html; charset=gbk'}],
  ['error status',500,{'Content-Type':'text/html'}],
]) test(`${label} responses do not supply a title or cause a follow-up request`, async t => {
  const f = await fixture(t, (_q,r) => {r.writeHead(status, headers);r.end('<title>Must not use</title>');});
  assert.deepEqual(await readLocalTitle(f.url), {title:null,status:'unsupported'});
  assert.equal(f.requests.length, 1);
});
test('response prefix limits terminate a streaming body without waiting for its end', async t => {
  const f = await fixture(t, (_q,r) => {r.setHeader('Content-Type','text/html');r.write('<title>Prefix</title>'+' '.repeat(1000));});
  const result = await readLocalTitle(f.url, {maxBytes:64});
  assert.equal(result.bytesRead,64); assert.equal(result.title,'Prefix');
});
test('timeouts and cancellation terminate real pending HTTP requests', async t => {
  const f = await fixture(t, () => {});
  await assert.rejects(readLocalTitle(f.url,{timeoutMs:40}), /timed out/);
  const controller = new AbortController(), started = once(f.server,'request');
  const pending = readLocalTitle(f.url,{signal:controller.signal}); await started; controller.abort();
  await assert.rejects(pending,/cancelled/);
  const count=f.requests.length;
  await assert.rejects(readLocalTitle(f.url,{signal:controller.signal}),/cancelled/);
  assert.equal(f.requests.length,count);
});
test('unsafe URLs and unbounded options are rejected before network access', () => {
  for(const url of ['https://127.0.0.1:42/','http://localhost:42/','http://192.0.2.1:42/','http://user:secret@127.0.0.1:42/','http://127.0.0.1:42/admin','http://127.0.0.1:42/?query=x','http://127.0.0.1:42/#fragment','http://127.0.0.1:0/']) assert.throws(()=>readLocalTitle(url),/listed loopback/);
  for(const options of [{maxBytes:0},{maxBytes:1e9},{timeoutMs:0},{timeoutMs:Infinity}])assert.throws(()=>readLocalTitle('http://127.0.0.1:42/',options),/limits/);
});

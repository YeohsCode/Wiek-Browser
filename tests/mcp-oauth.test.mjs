import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
const {createMcpService}=createRequire(import.meta.url)('../app/mcp-service.cjs');
const { createMcpOAuth, normalizeOAuth, challenge, discover } = createRequire(import.meta.url)('../app/mcp-oauth.cjs');
const scope = { projectId: 'p', threadId: 'a' };
const pause = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, settings = {}) {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vek-oauth-'));
 const cleanups=[],calls = [], codes = new Map(), tokens = [], key = randomBytes(32); let opened, base, issued = 0;
 const expectedClient = settings.registration ? 'registered-fixture-client' : 'public-client';
 const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const parsed = new URL(req.url, base), form = new URLSearchParams(req.headers['content-type']==='application/json'?'':body); calls.push({ method: req.method, path: parsed.pathname, body: Object.fromEntries(form), authorization: req.headers.authorization });
  const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if ((parsed.pathname === '/mcp' || parsed.pathname === '/mcp/')&&settings.mcp&&req.method==='POST'&&!settings.unauthorized&&req.headers.authorization===`Bearer ${tokens.at(-1)?.access_token}`){const message=JSON.parse(body);if(!Object.hasOwn(message,'id')){res.writeHead(202);res.end();return;}let result={};if(message.method==='initialize')result={protocolVersion:'2025-11-25',serverInfo:{name:'oauth-peer'},capabilities:{tools:{}}};if(message.method==='tools/list')result={tools:[{name:'echo',inputSchema:{type:'object'}}]};if(message.method==='tools/call'&&settings.stepUpChallenge){res.writeHead(403,{'WWW-Authenticate':settings.stepUpChallenge});res.end();return;}if(message.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({authorized:true,credential:req.headers.authorization})}]};return json({jsonrpc:'2.0',id:message.id,result});}
  if((parsed.pathname==='/mcp'||parsed.pathname==='/mcp/')&&settings.mcp&&req.method==='GET'&&req.headers.authorization===`Bearer ${tokens.at(-1)?.access_token}`){res.writeHead(405);res.end();return;}
  if (parsed.pathname === '/mcp' || parsed.pathname === '/mcp/') { res.writeHead(401, settings.noChallenge ? {} : { 'WWW-Authenticate': `Basic realm="other", Bearer realm="fixture, public", resource_metadata="${base}/metadata", scope="notes:read"` }); res.end(); return; }
  if (parsed.pathname === '/metadata' || parsed.pathname.startsWith('/.well-known/oauth-protected-resource')) {
   if (settings.metadataRedirect) { res.writeHead(302, { location: base + '/should-not-follow' }); res.end(); return; }
   if (settings.slowMetadata) await pause(settings.slowMetadata);
   return json({ resource: settings.wrongResource ? base + '/foreign' : base + '/mcp', authorization_servers: [base + (settings.tenant || '')], scopes_supported: ['fallback:read'] });
  }
  if (parsed.pathname.includes('/.well-known/oauth-authorization-server') || parsed.pathname.includes('/.well-known/openid-configuration') || parsed.pathname.endsWith('/.well-known/openid-configuration')) {
   if (settings.oidcAppendOnly && parsed.pathname !== '/tenant/.well-known/openid-configuration') return json({}, 404);
   if (settings.oidcOnly && parsed.pathname.includes('oauth-authorization-server')) return json({}, 404);
   return json({ issuer: settings.wrongIssuer ? base + '/wrong' : base + (settings.tenant || ''), authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', response_types_supported: ['code'], ...(settings.noPkce ? {} : { code_challenge_methods_supported: ['S256'] }), token_endpoint_auth_methods_supported: ['none'], ...(settings.registration?{registration_endpoint:settings.registrationUrl || base+'/register'}:{}) });
  }
  if (parsed.pathname === '/register' && settings.registration) {
   assert.equal(req.method, 'POST'); assert.equal(req.headers['content-type'], 'application/json'); assert.equal(req.headers.authorization, undefined);
   const metadata = JSON.parse(body);
   assert.deepEqual(metadata.grant_types, ['authorization_code','refresh_token']);
   assert.equal(metadata.token_endpoint_auth_method, 'none');
   assert.match(metadata.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
   return json({...metadata, client_id: expectedClient, ...(settings.registrationSecret?{client_secret:'fixture-secret'}:{})},201);
  }
  if (parsed.pathname === '/authorize') {
   const params = parsed.searchParams; assert.equal(params.get('resource'), base + '/mcp'); assert.equal(params.get('code_challenge_method'), 'S256'); assert.equal(params.get('client_id'), expectedClient);
   const code = randomUUID(); codes.set(code, Object.fromEntries(params)); const redirect = new URL(params.get('redirect_uri')); redirect.searchParams.set('state', params.get('state')); redirect.searchParams.set('code', code); redirect.searchParams.set('iss', base + (settings.tenant || '')); res.writeHead(302, { location: redirect.href }); res.end(); return;
  }
  if (parsed.pathname === '/token') {
   assert.equal(form.get('resource'), base + '/mcp'); assert.equal(form.get('client_id'), expectedClient); assert.equal(req.headers.authorization, undefined);
   if(settings.slowToken)await pause(settings.slowToken);
   if (settings.tokenFailure) return json({}, 503);
   let requestedScope;
   if (form.get('grant_type') === 'authorization_code') {
    const code = codes.get(form.get('code')); if (!code) return json({}, 400); codes.delete(form.get('code')); requestedScope=code.scope;
    assert.equal(form.get('redirect_uri'), code.redirect_uri); assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), code.code_challenge);
   } else { assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), tokens.at(-1).refresh_token); if (settings.refreshFailure) return json({}, 503); }
   const result = { access_token: 'access-fixture-' + randomUUID(), refresh_token: 'refresh-fixture-' + randomUUID(), token_type: 'Bearer', expires_in: ++issued === 1 ? settings.expiresIn || 3600 : 3600, scope: form.get('grant_type')==='authorization_code' ? requestedScope || 'notes:read' : 'notes:read',...settings.tokenOverride };
   if(settings.sameRotation&&form.get('grant_type')==='refresh_token')result.refresh_token=tokens.at(-1).refresh_token;
   if (settings.noRotation && form.get('grant_type') === 'refresh_token') delete result.refresh_token;
   tokens.push(result); return json(result);
  }
  json({}, 404);
 });
 await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
 const config = { id: 'i', url: base + '/mcp', allowInsecureHttp: true, oauth: { clientId: 'public-client' } };
 const options = { dataDir: dir, available: () => true, encrypt: text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); }, decrypt: bytes => { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); }, openExternal: async value => { opened = value; }, ...settings.manager };
 const manager = createMcpOAuth(options);
 t.after(async () => {for(const cleanup of cleanups)await cleanup(); manager.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
 const prepare = () => manager.prepare(config, scope);
 async function authorize() { const flow = await prepare(); await manager.open(flow.id, config, scope); const redirect = await fetch(opened, { redirect: 'manual' }); assert.equal(redirect.status, 302); const callback = await fetch(redirect.headers.get('location')); assert.equal(callback.status, 200, await callback.text()); return flow; }
 return { manager, options, config, scope, calls, tokens, dir, base, prepare, authorize, settings, cleanups, opened: () => opened };
}

test('public OAuth config and challenge parsing reject credentials/ambiguity and retain quoted commas', () => {
 assert.deepEqual(normalizeOAuth({ clientId: 'public', scopes: ['notes:read', 'notes:read'] }), { redirectPort:0,clientId: 'public', scopes: ['notes:read'] });
 for (const input of [{ clientId: 'x', clientSecret: 'secret' }, { clientId: 'x', scopes: ['two scopes'] }, { clientId: '' }, { clientId: 'x', accessToken: 'secret' }]) assert.throws(() => normalizeOAuth(input));
 assert.equal(challenge('Basic realm="basic", Bearer realm="comma, inside", scope="notes:read"').realm, 'comma, inside');
 assert.throws(() => challenge('Bearer resource_metadata="https://a/", resource_metadata="https://b/"'), /Duplicate/);
 assert.deepEqual(challenge('Basic realm="basic"'), {});
});

test('actual OAuth code flow verifies PKCE/resource/state and stores only encrypted tokens', async t => {
 const h = await fixture(t); const flow = await h.prepare();
 assert.equal(flow.status, 'prepared'); assert.deepEqual(flow.scopes, ['notes:read']); assert.equal(h.opened(), undefined); assert.ok(!JSON.stringify(h.manager.snapshot()).includes('authorizationUrl'));
 await h.manager.open(flow.id, h.config, scope); const authorization = new URL(h.opened()); assert.equal(authorization.searchParams.get('scope'), 'notes:read'); assert.match(authorization.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
 const redirect = await fetch(authorization, { redirect: 'manual' }); const callback = await fetch(redirect.headers.get('location')); assert.equal(callback.status, 200); assert.match(await callback.text(), /complete/);
 const credential = await h.manager.authorization(h.config, scope); assert.equal(credential, `Bearer ${h.tokens[0].access_token}`);
 const disk = await fs.readFile(path.join(h.dir, 'mcp/oauth-tokens.json'), 'utf8'); for (const token of [h.tokens[0].access_token, h.tokens[0].refresh_token]) { assert.ok(!disk.includes(token)); assert.ok(!JSON.stringify(h.manager.snapshot()).includes(token)); }
 assert.equal((await fs.stat(path.join(h.dir, 'mcp/oauth-tokens.json'))).mode & 0o777, 0o600);
 assert.ok(h.calls.filter(call => call.path !== '/token').every(call => call.authorization === undefined));
});

test('well-known fallback, OIDC discovery and path-appended tenant metadata are supported', async t => {
 for (const settings of [{ noChallenge: true }, { oidcOnly: true }, { tenant: '/tenant', oidcAppendOnly: true },{ tenant: '/tenant/', oidcAppendOnly: true }]) { const h = await fixture(t, settings); const result = await discover(h.config); assert.equal(result.resource, h.base + '/mcp'); assert.deepEqual(result.scopes, settings.noChallenge ? ['fallback:read'] : ['notes:read']); if (settings.oidcAppendOnly) assert.equal(h.calls.at(-1).path, '/tenant/.well-known/openid-configuration'); }
});

test('wrong resource/issuer, missing PKCE and metadata redirects fail before browser or token requests', async t => {
 for (const settings of [{ wrongResource: true }, { wrongIssuer: true }, { noPkce: true }, { metadataRedirect: true }]) { const h = await fixture(t, settings); await assert.rejects(h.prepare(), /resource|issuer|PKCE|discovery/i); assert.equal(h.opened(), undefined); assert.equal(h.calls.filter(call => call.path === '/token').length, 0); assert.equal(h.manager.snapshot().flows[0].status, 'failed'); }
});

test('foreign scope/config and callbacks with wrong state/origin/issuer or duplicate params are rejected', async t => {
 const h = await fixture(t); const flow = await h.prepare(); await assert.rejects(h.manager.open(flow.id, h.config, { projectId: 'p', threadId: 'b' }), /scope/); await h.manager.open(flow.id, h.config, scope);
 const authorization = new URL(h.opened()), target = new URL(authorization.searchParams.get('redirect_uri')), state = authorization.searchParams.get('state');
 target.searchParams.set('state', '文'.repeat(43)); target.searchParams.set('code', 'invalid'); assert.equal((await fetch(target)).status, 400);
 target.searchParams.set('state', state); target.searchParams.set('iss', h.base + '/foreign'); assert.equal((await fetch(target)).status, 400); target.searchParams.delete('iss');
 assert.equal((await fetch(target, { headers: { Origin: 'https://evil.invalid' } })).status, 400); target.searchParams.append('code', 'duplicate'); assert.equal((await fetch(target)).status, 400);
 assert.equal(h.manager.snapshot().flows[0].status, 'authorizing'); assert.equal(h.calls.filter(call => call.path === '/token').length, 0);
 h.manager.cancel(flow.id, h.config, scope); assert.equal(h.manager.snapshot().flows[0].status, 'cancelled');
 await assert.rejects(h.manager.authorization(h.config, { projectId: 'p', threadId: 'b' }), /required/);
});

test('prepare never opens a browser; expired and cancelled discovery cannot resume or store credentials', async t => {
 const h = await fixture(t, { manager: { timeoutMs: 1000 } }); const flow = await h.prepare(); await pause(1100); assert.equal(h.manager.snapshot().flows[0].status, 'expired'); await assert.rejects(h.manager.open(flow.id, h.config, scope), /ready/);
 const slow = await fixture(t, { slowMetadata: 200 }); const pending = slow.prepare(), rejected = assert.rejects(pending, /cancelled/); await pause(20); const id = slow.manager.snapshot().flows[0].id; slow.manager.cancel(id, slow.config, scope); await rejected; assert.equal(slow.manager.snapshot().credentials.length, 0);
});

test('refresh is serialized, audience-bound and rotates the encrypted refresh token', async t => {
 const h = await fixture(t, { expiresIn: 1 }); await h.authorize(); const values = await Promise.all(Array.from({ length: 8 }, () => h.manager.authorization(h.config, scope)));
 assert.equal(new Set(values).size, 1); assert.equal(values[0], `Bearer ${h.tokens.at(-1).access_token}`); assert.equal(h.calls.filter(call => call.body.grant_type === 'refresh_token').length, 1);
 await assert.rejects(h.manager.authorization({ ...h.config, oauth: { clientId: 'different' } }, scope), /required/);
 await assert.rejects(h.manager.authorization(h.config, { projectId: 'p', threadId: 'other' }), /required/);
});

test('uncertain refresh or missing rotation drops credentials and never retries the refresh POST', async t => {
 for (const settings of [{ refreshFailure: true }, { noRotation: true },{sameRotation:true}]) { const h = await fixture(t, { expiresIn: 1, ...settings }); await h.authorize(); await assert.rejects(h.manager.authorization(h.config, scope), /not replayed/); assert.equal(h.manager.snapshot().credentials.length, 0); await assert.rejects(h.manager.authorization(h.config, scope), /required/); assert.equal(h.calls.filter(call => call.body.grant_type === 'refresh_token').length, 1); }
});

test('token exchange failures are terminal, and secure storage is required before discovery', async t => {
 const h = await fixture(t, { tokenFailure: true }); const flow = await h.prepare(); await h.manager.open(flow.id, h.config, scope); const redirect = await fetch(h.opened(), { redirect: 'manual' }); assert.equal((await fetch(redirect.headers.get('location'))).status, 400); await assert.rejects(h.manager.open(flow.id, h.config, scope), /ready/); assert.equal(h.calls.filter(call => call.path === '/token').length, 1);
 const unavailable = createMcpOAuth({ dataDir: h.dir, available: () => false }); await assert.rejects(unavailable.prepare(h.config, scope), /storage/); unavailable.close();
});

test('encrypted scope binding survives restart and rejects ciphertext reassignment; forget removes access', async t => {
 const h = await fixture(t); await h.authorize(); h.manager.close(); const reopened = createMcpOAuth(h.options); assert.match(await reopened.authorization(h.config, scope), /^Bearer /); reopened.close();
 const file = path.join(h.dir, 'mcp/oauth-tokens.json'), data = JSON.parse(await fs.readFile(file, 'utf8')); const targetScope = { projectId: 'p', threadId: 'b' }; data.credentials[0].scope = targetScope; data.credentials[0].key = createHash('sha256').update(JSON.stringify(['i', 'p', 'b'])).digest('hex'); data.credentials[0].fingerprint = createHash('sha256').update(JSON.stringify(['i', h.config.url, normalizeOAuth(h.config.oauth), 'p', 'b'])).digest('hex'); await fs.writeFile(file, JSON.stringify(data));
 const reassigned = createMcpOAuth(h.options); await assert.rejects(reassigned.authorization(h.config, targetScope), /cannot be opened/); reassigned.forget(h.config); assert.equal(reassigned.snapshot().credentials.length, 0); reassigned.close();
});

async function serviceFixture(t) {
 const h = await fixture(t, { mcp: true }); h.manager.close();
 const service = createMcpService({ dataDir: h.dir, oauthOptions: h.options, resolveScope: async value => value.projectId === 'p' ? { ...value, projectPath: h.dir } : null }); h.cleanups.push(()=>service.close());
 const saved = await service.dispatch('mcp:integrations:save', { name: 'OAuth fixture', transport: 'http', url: h.config.url, allowInsecureHttp: true, oauth: h.config.oauth, scope: { projectId: 'p' } }); const id = saved.integrations[0].id;
 const action = (verb, extra = {}) => service.dispatch('mcp:oauth:' + verb, { integrationId: id, scope, ...extra });
 async function authorize() { const flow = await action('prepare'); await action('open', { flowId: flow.id }); const redirect = await fetch(h.opened(), { redirect: 'manual' }); const callback = await fetch(redirect.headers.get('location')); assert.equal(callback.status, 200, await callback.text()); return flow; }
 async function callTool() { const job = await service.dispatch('mcp:tools:call', { integrationId: id, scope, name: 'echo' }); return service.dispatch('mcp:tasks:wait', { id: job.id, scope }); }
 return { ...h, service, id, action, authorize, callTool };
}
test('MCP service uses only bound encrypted OAuth tokens, redacts echoes and signs out one scope', async t => {
 const h = await serviceFixture(t); await assert.rejects(h.service.dispatch('mcp:integrations:connect', { id: h.id, scope }), /sign-in/); assert.equal(h.opened(), undefined);
 await h.authorize(); const task = await h.callTool(); assert.equal(task.status, 'completed'); assert.match(task.result.content[0].text, /authorized/); assert.ok(!JSON.stringify(task).includes(h.tokens[0].access_token)); assert.match(task.result.content[0].text, /redacted/);
 await assert.rejects(h.service.dispatch('mcp:integrations:connect', { id: h.id, scope: { projectId: 'p', threadId: 'b' } }), /sign-in/);
 const raw = await fs.readFile(path.join(h.dir, 'mcp/state.json'), 'utf8'); assert.ok(!raw.includes(h.tokens[0].access_token)); assert.ok(!JSON.stringify(h.service.snapshot()).includes(h.tokens[0].access_token));
 await h.action('forget'); assert.equal(h.service.snapshot().oauth.credentials.length, 0); assert.equal((await h.callTool()).status, 'failed');
});
test('HTTP 401 invalidates credentials and does not replay a tool POST or reopen sign-in', async t => {
 const h = await serviceFixture(t); await h.authorize(); assert.equal((await h.callTool()).status, 'completed'); const before = h.calls.filter(call => call.method === 'POST' && call.path === '/mcp').length;
 h.settings.unauthorized = true; assert.equal((await h.callTool()).status, 'failed'); const after = h.calls.filter(call => call.method === 'POST' && call.path === '/mcp').length; assert.equal(after, before + 1); assert.equal(h.service.snapshot().oauth.credentials.length, 0);
 assert.equal((await h.callTool()).status, 'failed'); assert.equal(h.calls.filter(call => call.method === 'POST' && call.path === '/mcp').length, after); assert.equal(h.service.snapshot().oauth.flows.length, 1);
});
test('explicit reauthorization disconnects old sessions and blocks tools until finished or cancelled', async t => {
 const h = await serviceFixture(t); await h.authorize(); await h.callTool(); const flow = await h.action('prepare'); assert.equal(h.service.snapshot().connections.length, 0); assert.equal((await h.callTool()).status, 'failed');
 await h.action('cancel', { flowId: flow.id }); assert.equal((await h.callTool()).status, 'completed');
 await assert.rejects(h.service.dispatch('mcp:integrations:save', { name: 'conflict', transport: 'http', url: h.config.url, allowInsecureHttp: true, headerRefs: { Authorization: 'env:TOKEN' }, oauth: h.config.oauth, scope }), /cannot be combined/);
 const config = h.service.snapshot().integrations[0]; await h.service.dispatch('mcp:integrations:save', { ...config, oauth: { clientId: 'other-client' } }); assert.equal(h.service.snapshot().oauth.credentials.length, 0);
});


test('an issuer cannot use public control IDs as tokens to corrupt persistent routing via redaction',async t=>{
 const h=await serviceFixture(t);h.settings.tokenOverride={access_token:h.id};const flow=await h.action('prepare');await h.action('open',{flowId:flow.id});const redirect=await fetch(h.opened(),{redirect:'manual'});assert.equal((await fetch(redirect.headers.get('location'))).status,400);assert.equal(h.service.snapshot().oauth.credentials.length,0);assert.equal(h.service.snapshot().integrations[0].id,h.id);const saved=JSON.parse(await fs.readFile(path.join(h.dir,'mcp/state.json'),'utf8'));assert.equal(saved.integrations[0].id,h.id);
 const publicName='Public \"OAuth\" fixture name',config=h.service.snapshot().integrations[0];await h.service.dispatch('mcp:integrations:save',{...config,name:publicName});h.settings.tokenOverride={refresh_token:publicName};const second=await h.action('prepare');await h.action('open',{flowId:second.id});const again=await fetch(h.opened(),{redirect:'manual'});assert.equal((await fetch(again.headers.get('location'))).status,400);assert.equal(h.service.snapshot().integrations[0].name,publicName);assert.equal(h.service.snapshot().oauth.credentials.length,0);
});


test('registered loopback callback ports use a stable path and occupied ports fail without opening',async t=>{
 const h=await fixture(t);const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));h.config.oauth.redirectPort=port;const flow=await h.prepare();await h.manager.open(flow.id,h.config,scope);const callback=new URL(new URL(h.opened()).searchParams.get('redirect_uri'));assert.equal(Number(callback.port),port);assert.equal(callback.pathname,'/oauth/callback');h.manager.cancel(flow.id,h.config,scope);
 h.config.oauth.redirectPort=Number(new URL(h.base).port);await assert.rejects(h.prepare(),/discovery|port/i);
 for(const redirectPort of [-1,1,1023,65536,'8080',1.5])assert.throws(()=>normalizeOAuth({clientId:'public',redirectPort}),/port/);
});

test('invalid token types, unsafe header tokens, short values and invalid lifetimes never persist',async t=>{
 for(const tokenOverride of [{token_type:'Basic'},{access_token:'public'},{access_token:'not a safe token'},{refresh_token:'short'},{expires_in:0},{scope:'bad\\scope'}]){
  const h=await fixture(t,{tokenOverride});const flow=await h.prepare();await h.manager.open(flow.id,h.config,scope);const redirect=await fetch(h.opened(),{redirect:'manual'});assert.equal((await fetch(redirect.headers.get('location'))).status,400);assert.equal(h.manager.snapshot().credentials.length,0);
 }
});


test('cancelling an in-flight code exchange never stores late-issued credentials or replays the code',async t=>{
 const h=await fixture(t,{slowToken:200});const flow=await h.prepare();await h.manager.open(flow.id,h.config,scope);const redirect=await fetch(h.opened(),{redirect:'manual'});const pending=fetch(redirect.headers.get('location'));for(let i=0;i<50&&!h.calls.some(row=>row.path==='/token');i++)await pause(5);assert.equal(h.calls.filter(row=>row.path==='/token').length,1);h.manager.cancel(flow.id,h.config,scope);assert.equal((await pending).status,400);await pause(220);assert.equal(h.manager.snapshot().credentials.length,0);assert.equal(h.manager.snapshot().flows[0].status,'cancelled');assert.equal(h.calls.filter(row=>row.path==='/token').length,1);
});


test('HTTP insufficient_scope opens a scoped, reviewed OAuth upgrade and does not replay the failed tool', async t => {
 const h = await serviceFixture(t);
 await h.authorize();
 assert.equal((await h.callTool()).status, 'completed');
 const posts = () => h.calls.filter(call => call.method === 'POST' && call.path === '/mcp').length;
 const before = posts();
 h.settings.stepUpChallenge = 'Bearer error="insufficient_scope", scope="notes:write"';
 assert.equal((await h.callTool()).status, 'failed');
 assert.equal(posts(), before + 1);
 assert.deepEqual(h.service.snapshot().oauth.additionalScopes, [
   { integrationId: h.id, scope, scopes: ['notes:read', 'notes:write'] }
 ]);
 await assert.rejects(h.action('prepare', { stepUp: true, scope: { projectId: 'p', threadId: 'other' } }), /pending/);
 const oldUrl = h.opened();
 const flow = await h.action('prepare', { stepUp: true });
 assert.deepEqual(flow.scopes, ['notes:read', 'notes:write']);
 assert.equal(h.opened(), oldUrl);
 await h.action('open', { flowId: flow.id });
 const authorization = new URL(h.opened());
 assert.equal(authorization.searchParams.get('scope'), 'notes:read notes:write');
 const redirect = await fetch(authorization, { redirect: 'manual' });
 const callback = await fetch(redirect.headers.get('location'));
 assert.equal(callback.status, 200, await callback.text());
 assert.equal(posts(), before + 1);
 assert.deepEqual(h.service.snapshot().oauth.additionalScopes, []);
 assert.deepEqual(h.service.snapshot().oauth.credentials[0].scopes, ['notes:read', 'notes:write']);
 delete h.settings.stepUpChallenge;
 assert.equal((await h.callTool()).status, 'completed');
});


test('dynamic registration is reviewed and the issued public client is rebound to this issuer and scope', async t => {
 const h = await fixture(t, { registration:true });
 const reservation = http.createServer();
 await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve));
 const port = reservation.address().port;
 await new Promise(resolve => reservation.close(resolve));
 h.config.oauth = { registration:'dynamic', issuer:h.base, redirectPort:port };
 const prepared = await h.prepare();
 assert.equal(prepared.clientIdentity.endpoint,h.base+'/register');
 assert.equal(prepared.clientIdentity.clientId,undefined);
 assert.equal(h.calls.filter(call=>call.path==='/register').length,0);
 h.manager.cancel(prepared.id,h.config,scope);
 const flow = await h.authorize();
 assert.equal(flow.status,'prepared');
 assert.equal(new URL(h.opened()).searchParams.get('client_id'),'registered-fixture-client');
 assert.equal(h.calls.filter(call=>call.path==='/register').length,1);
 await h.authorize();
 assert.equal(h.calls.filter(call=>call.path==='/register').length,1);
 await assert.rejects(h.manager.authorization(h.config,{...scope,threadId:'other'}),/required/);
});

test('dynamic registration rejects another origin or a registration requiring a client secret', async t => {
 const h = await fixture(t, { registration:true, registrationUrl:'http://127.0.0.1:1/register' });
 const reservation = http.createServer();
 await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve));
 const port = reservation.address().port;
 await new Promise(resolve => reservation.close(resolve));
 h.config.oauth = { registration:'dynamic', issuer:h.base, redirectPort:port };
 await assert.rejects(h.prepare(),/same-origin/);
 assert.equal(h.opened(),undefined);
 h.settings.registrationUrl = undefined;
 h.settings.registrationSecret = true;
 const prepared = await h.prepare();
 await assert.rejects(h.manager.open(prepared.id,h.config,scope),/incompatible public/);
 assert.equal(h.opened(),undefined);
 assert.deepEqual(h.manager.snapshot().credentials,[]);
});

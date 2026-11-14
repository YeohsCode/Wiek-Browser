'use strict';
// Explicit OAuth authorization-code/PKCE for HTTP MCP. No tool request replay,
// browser cookies, ambient credentials, dynamic registration or client secrets.
const { normalizeIdentity, resolveClientIdentity } = require('./mcp-client-identity.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const fail = (message, code = 'VEK_MCP_OAUTH') => Object.assign(new Error(message), { error_code: code });
const sha = value => createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const loopback = url => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
function text(value, label, max = 4096) { if (typeof value !== 'string' || !value || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > max) throw fail(`Invalid OAuth ${label}`); return value; }
function url(value, config, label = 'URL') { let result; try { result = new URL(text(value, label, 16384)); } catch { throw fail(`Invalid OAuth ${label}`); } if (result.username || result.password || result.hash || result.protocol !== 'https:' && !(config.allowInsecureHttp === true && new URL(config.url).protocol==='http:' && loopback(new URL(config.url)) && loopback(result) && result.protocol === 'http:')) throw fail('OAuth requires HTTPS; insecure HTTP is limited to explicitly allowed loopback fixtures'); return result; }
function scopes(values) { if (!Array.isArray(values) || values.length > 32 || values.some(value => typeof value !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(value))) throw fail('Invalid OAuth scopes'); return [...new Set(values)]; }
function normalizeOAuth(value) { if (value === undefined || value === null) return null; if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['clientId', 'scopes','redirectPort','registration','issuer'].includes(key))) throw fail('OAuth accepts a public client ID, registration, expected issuer, scopes and redirect port only'); if(value.redirectPort!==undefined&&(!Number.isInteger(value.redirectPort)||value.redirectPort!==0&&(value.redirectPort<1024||value.redirectPort>65535)))throw fail('OAuth redirect port must be zero or between 1024 and 65535'); return { ...normalizeIdentity(value),redirectPort:value.redirectPort??0,clientId: text(value.clientId, 'public client ID', 2048), ...(value.scopes === undefined ? {} : { scopes: scopes(value.scopes) }) }; }
function challenge(header) {
  if (header === undefined) return {}; text(header, 'challenge', 16384);
  const start = /(?:^|,)\s*Bearer(?:\s+|$)/i.exec(header); if (!start) return {};
  let rest = header.slice(start.index + start[0].length); const out = {};
  for (let count = 0; rest.trim() && count < 32; count++) {
    const match = /^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*("(?:[^"\\\r\n]|\\[\x20-\x7e])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*/.exec(rest); if (!match) break;
    const name = match[1].toLowerCase(); if (Object.hasOwn(out, name)) throw fail('Duplicate OAuth challenge parameter');
    out[name] = match[2].startsWith('"') ? match[2].slice(1, -1).replace(/\\(.)/g, '$1') : match[2]; rest = rest.slice(match[0].length); if (!rest.startsWith(',')) { if (rest) throw fail('Invalid OAuth challenge'); break; } rest = rest.slice(1);
  }
  return out;
}
async function fetchBounded(endpoint, { method = 'GET', body, signal, headers = {}, timeoutMs = 10000, json = true, maxBytes = 256 * 1024, acceptJsonSuffix = false } = {}) {
  const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const transport = endpoint.protocol === 'https:' ? https : http;
      const request = transport.request(endpoint, { method, signal: controller.signal, agent: false, headers: { Accept: 'application/json', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }) } }, async response => {
        if (!json || response.statusCode < 200 || response.statusCode >= 300) { response.destroy(); resolve({ status: response.statusCode, headers: response.headers }); return; }
        try {
          const mediaType=(response.headers['content-type']||'').split(';')[0].trim().toLowerCase();if (mediaType !== 'application/json' && !(acceptJsonSuffix && /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType))) throw fail('OAuth metadata/token response must be JSON');
          const chunks = []; let size = 0; for await (const chunk of response) { size += chunk.length; if (size > maxBytes) throw fail('OAuth response exceeds the size limit'); chunks.push(chunk); }
          const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('Invalid OAuth JSON response'); resolve({ status: response.statusCode, headers: response.headers, data });
        } catch (error) { response.destroy(); reject(error.error_code ? error : fail('Invalid or disconnected OAuth response')); }
      });
      request.on('error', () => reject(fail(controller.signal.aborted ? 'OAuth request cancelled or timed out' : 'OAuth connection failed'))); request.end(body);
    });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function canonical(value) { const parsed = new URL(value); return parsed.pathname === '/' ? parsed.origin : parsed.href; }
async function discover(config, signal) {
  const endpoint = url(config.url, config, 'MCP endpoint'), initial = await fetchBounded(endpoint, { json: false, signal }), auth = challenge(initial.headers['www-authenticate']);
  if (![200, 401, 403, 404, 405].includes(initial.status)) throw fail(`MCP authorization probe failed (HTTP ${initial.status})`);
  const candidates = auth.resource_metadata ? [url(auth.resource_metadata, config, 'resource metadata URL')] : [...new Set([endpoint.origin + '/.well-known/oauth-protected-resource' + (endpoint.pathname === '/' ? '' : endpoint.pathname), endpoint.origin + '/.well-known/oauth-protected-resource'])].map(value => url(value, config));
  let resource;
  for (const candidate of candidates) { const result = await fetchBounded(candidate, { signal }); if (result.status === 200) { resource = result.data; break; } if (![404, 405].includes(result.status)) throw fail(`Protected resource discovery failed (HTTP ${result.status})`); }
  if (!resource || canonical(url(resource.resource, config, 'resource identifier').href) !== canonical(endpoint.href) || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.length || resource.authorization_servers.length > 16) throw fail('Protected resource metadata does not identify this exact MCP endpoint');
  // First advertised issuer only; the UI shows it before the browser opens.
  const issuer = url(resource.authorization_servers[0], config, 'issuer'); if (issuer.search) throw fail('OAuth issuer cannot contain a query');
  const suffix = issuer.pathname === '/' ? '' : issuer.pathname;
  const metadataURLs = [...new Set([issuer.origin + '/.well-known/oauth-authorization-server' + suffix, issuer.origin + '/.well-known/openid-configuration' + suffix, ...(suffix ? [issuer.origin + suffix.replace(/\/$/,'') + '/.well-known/openid-configuration'] : [])])];
  let metadata;
  for (const location of metadataURLs) { const result = await fetchBounded(url(location, config), { signal }); if (result.status === 200) { metadata = result.data; break; } if (![404, 405].includes(result.status)) throw fail(`Authorization server discovery failed (HTTP ${result.status})`); }
  if (!metadata || text(metadata.issuer,'metadata issuer',16384) !== resource.authorization_servers[0] || !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')) throw fail('OAuth issuer mismatch or S256 PKCE is not advertised');
  if (metadata.response_types_supported && (!Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes('code'))) throw fail('OAuth server does not advertise authorization-code responses');
  if (metadata.token_endpoint_auth_methods_supported && (!Array.isArray(metadata.token_endpoint_auth_methods_supported) || !metadata.token_endpoint_auth_methods_supported.includes('none'))) throw fail('This client supports public clients with token endpoint authentication none only');
  const authorization = url(metadata.authorization_endpoint, config, 'authorization endpoint'), token = url(metadata.token_endpoint, config, 'token endpoint');
  for (const key of ['client_id','redirect_uri','response_type','state','scope','resource','code_challenge','code_challenge_method']) if (authorization.searchParams.has(key)) throw fail('Authorization endpoint contains reserved query parameters');
  const selectedScopes = config.oauth.scopes === undefined ? (auth.scope === undefined ? scopes(resource.scopes_supported || []) : scopes(auth.scope.split(' ').filter(Boolean))) : scopes(config.oauth.scopes);
  return { issuer: metadata.issuer, resource: canonical(endpoint.href), authorizationEndpoint: authorization.href, tokenEndpoint: token.href, requireIssuer:metadata.authorization_response_iss_parameter_supported===true, ...(metadata.client_id_metadata_document_supported===true?{clientIdMetadataDocumentSupported:true}:{}), scopes: selectedScopes };
}
function binding(config, scope) { return sha(JSON.stringify([config.id, config.url, normalizeOAuth(config.oauth), scope.projectId, scope.threadId || ''])); }
function keyFor(config, scope) { return sha(JSON.stringify([config.id, scope.projectId, scope.threadId || ''])); }
function tokenData(data, previous, meta) {
  if (String(data.token_type).toLowerCase() !== 'bearer') throw fail('OAuth token type must be Bearer');
  const accessToken = text(data.access_token, 'access token', 16384); if (accessToken.length<16||!/^[A-Za-z0-9._~+\/=-]+$/.test(accessToken)) throw fail('Invalid OAuth access token');
  const refreshToken = data.refresh_token === undefined ? previous?.refreshToken : text(data.refresh_token, 'refresh token', 16384);
  if(refreshToken!==undefined&&refreshToken.length<16)throw fail('OAuth refresh token is too short for safe credential handling');
  let expiresAt = null; if (data.expires_in !== undefined) { if (!Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 366 * 86400) throw fail('Invalid OAuth token lifetime'); expiresAt = Date.now() + data.expires_in * 1000; }
  const grantedScopes = data.scope === undefined ? meta.scopes : scopes(text(data.scope, 'granted scopes').split(' ').filter(Boolean));
  return { ...meta, accessToken, ...(refreshToken === undefined ? {} : { refreshToken }), expiresAt, scopes: grantedScopes };
}
function createMcpOAuth({ dataDir, encrypt, decrypt, available = () => false, openExternal, onChange = () => {}, onSecret = () => {}, timeoutMs = 180000 } = {}) {
  const directory = path.join(dataDir, 'mcp'), file = path.join(directory, 'oauth-tokens.json'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw fail('OAuth directory must not be a symlink');fs.chmodSync(directory,0o700);
  let credentials = [], closed = false; const flows = new Map(), refreshing = new Map(), scopeChallenges = new Map();
  if (fs.existsSync(file)) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw fail('Invalid encrypted OAuth store'); const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.version !== 1 || !Array.isArray(saved.credentials) || saved.credentials.length > 256) throw fail('Invalid OAuth store version'); credentials = saved.credentials.map(row=>{if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!['key','integrationId','scope','fingerprint','issuer','resource','scopes','expiresAt','sealed'].includes(key))||!/^[a-f0-9]{64}$/.test(row.key)||!/^[a-f0-9]{64}$/.test(row.fingerprint)||!row.scope||Object.keys(row.scope).some(key=>!['projectId','threadId'].includes(key)))throw fail('Invalid OAuth credential record');text(row.integrationId,'integration ID',200);text(row.scope.projectId,'project ID',200);if(row.scope.threadId!==undefined)text(row.scope.threadId,'thread ID',200);text(row.issuer,'stored issuer',16384);text(row.resource,'stored resource',16384);scopes(row.scopes);if(row.expiresAt!==null&&(!Number.isFinite(row.expiresAt)||row.expiresAt<=0))throw fail('Invalid OAuth expiry');if(typeof row.sealed!=='string'||row.sealed.length>131072||!row.sealed||Buffer.from(row.sealed,'base64').toString('base64')!==row.sealed)throw fail('Invalid encrypted OAuth token');return row;});if(new Set(credentials.map(row=>row.key)).size!==credentials.length)throw fail('Duplicate OAuth credentials');fs.chmodSync(file,0o600); }
  function persist(next) { if (next.length > 256) throw fail('OAuth credential limit reached'); const data = JSON.stringify({ version: 1, credentials: next }); if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw fail('OAuth store exceeds its size limit'); const temporary = file + '.' + randomUUID() + '.tmp'; try { fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); credentials = next; } finally { try { fs.unlinkSync(temporary); } catch {} } }
  function publish() { try { onChange(); } catch {} }
  function ensure() { if (closed) throw fail('OAuth manager is closed'); if (!available() || typeof encrypt !== 'function' || typeof decrypt !== 'function') throw fail('Secure OS credential storage is unavailable'); }
  function publicFlow(flow) { return { id: flow.id, integrationId: flow.integrationId, scope: flow.scope, status: flow.status, issuer: flow.meta?.issuer, resource: flow.meta?.resource, scopes: flow.meta?.scopes, expiresAt: flow.expiresAt, error: flow.error, ...(flow.clientIdentity?{clientIdentity:flow.clientIdentity}:{}) }; }
  function snapshot() { return { available: !closed && available(), credentials: credentials.map(({ sealed, key, fingerprint, ...row }) => row), flows: [...flows.values()].map(publicFlow), additionalScopes: credentials.flatMap(row => {const requested=scopeChallenges.get(row.key);return requested?.binding===row.fingerprint?[{integrationId:row.integrationId,scope:row.scope,scopes:requested.scopes}]:[];}) }; }
  function finish(flow, status, error) { flow.status = status; flow.error = error; clearTimeout(flow.timer); flow.controller.abort(); flow.server?.closeIdleConnections?.(); flow.server?.close(); flow.verifier = ''; flow.state = ''; flow.authorizationUrl = ''; publish(); }
  function save(config, scope, data) {
    ensure(); const key = keyFor(config, scope), fingerprint = binding(config, scope);
    const encrypted = encrypt(JSON.stringify({...data,binding:fingerprint}));
    if(!Buffer.isBuffer(encrypted)||!encrypted.length)throw fail('Secure storage did not return encrypted bytes');
    const sealed=encrypted.toString('base64');if(sealed.length>131072)throw fail('Encrypted OAuth credential exceeds the size limit');
    const row={key,integrationId:config.id,scope:copy(scope),fingerprint,issuer:data.issuer,resource:data.resource,scopes:data.scopes,expiresAt:data.expiresAt,sealed};
    onSecret(data.accessToken);if(data.refreshToken)onSecret(data.refreshToken);
    persist([...credentials.filter(item=>item.key!==key),row]);publish();
  }
  function scopeChallenge(config, scope, header) {
    const key = keyFor(config, scope);
    const credential = credentials.find(row => row.key === key && row.fingerprint === binding(config, scope));
    if (!credential) return;
    try {
      const parsed = challenge(header);
      if (parsed.error !== 'insufficient_scope' || !parsed.scope) return;
      const required = scopes(parsed.scope.split(' ').filter(Boolean));
      if (!required.some(value => !credential.scopes.includes(value))) return;
      const requested = scopes([...credential.scopes, ...required]);
      if (!scopeChallenges.has(key) && scopeChallenges.size >= 256) scopeChallenges.delete(scopeChallenges.keys().next().value);
      scopeChallenges.set(key, { binding: credential.fingerprint, scopes: requested });
      publish();
    } catch {
      // A malformed challenge cannot add permissions to the review.
    }
  }
  async function prepare(config, scope, { stepUp = false } = {}) {
    const key = keyFor(config, scope);
    const upgrade = stepUp ? scopeChallenges.get(key) : null;
    if (stepUp && upgrade?.binding !== binding(config, scope)) throw fail('No additional OAuth permissions are pending');

    ensure(); if (!normalizeOAuth(config.oauth)) throw fail('Configure a public OAuth client ID first');
    for (const old of flows.values()) if (old.integrationId === config.id && JSON.stringify(old.scope) === JSON.stringify(scope) && ['discovering','prepared','authorizing','exchanging'].includes(old.status)) throw fail('OAuth sign-in is already in progress');
    if ([...flows.values()].filter(row => ['discovering','prepared','authorizing','exchanging'].includes(row.status)).length >= 8) throw fail('Too many pending OAuth sign-ins');
    while (flows.size >= 32) { const entry = [...flows].find(([,row]) => !['discovering','prepared','authorizing','exchanging'].includes(row.status)); if (!entry) break; flows.delete(entry[0]); }
    const flow = { id: randomUUID(), integrationId: config.id, scope: copy(scope), fingerprint: binding(config, scope), controller: new AbortController(), status: 'discovering', expiresAt: new Date(Date.now() + timeoutMs).toISOString() }; flows.set(flow.id, flow); flow.timer = setTimeout(() => finish(flow, 'expired', 'Sign-in expired; start a new authorization'), timeoutMs); flow.timer.unref?.(); publish();
    try {
      flow.meta = await discover(config, flow.controller.signal);
      if (upgrade) flow.meta.scopes = upgrade.scopes;
      const previous=credentials.find(row=>row.key===keyFor(config,scope)&&row.fingerprint===binding(config,scope));
      if((upgrade||config.oauth.registration!=='metadata')&&previous){
        let identity;try{identity=JSON.parse(decrypt(Buffer.from(previous.sealed,'base64')));if(identity.binding!==binding(config,scope)||identity.resource!==canonical(config.url)||typeof identity.issuer!=='string')throw Error();}catch{throw fail('Encrypted OAuth client identity cannot be verified; sign in again');}
        if(identity.issuer!==flow.meta.issuer)throw fail('Pre-registered client belongs to a different authorization server; configure the expected issuer before authorizing again');
      }
      flow.clientIdentity=await resolveClientIdentity(config,flow.meta,flow.controller.signal,fetchBounded); if (flow.controller.signal.aborted || closed) throw fail('OAuth sign-in cancelled');
      flow.verifier = randomBytes(32).toString('base64url'); flow.state = randomBytes(32).toString('base64url'); const callbackPath = '/oauth/callback';
      flow.server = http.createServer(async (req, res) => {
        const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" }); res.end(body); };
        if (req.method !== 'GET' || req.headers.origin || req.headers.host !== `127.0.0.1:${flow.server.address()?.port}` || (req.url || '').length > 16384) return reply(400, 'Invalid callback');
        const callback = new URL(req.url, flow.redirectUri); if (callback.pathname !== callbackPath) return reply(404, 'Not found');
        for (const key of ['state','code','error','iss']) if (callback.searchParams.getAll(key).length > 1) return reply(400, 'Duplicate callback parameter');
        const returnedState = callback.searchParams.get('state') || ''; if (!/^[A-Za-z0-9_-]{43}$/.test(returnedState) || !flow.state || !timingSafeEqual(Buffer.from(returnedState), Buffer.from(flow.state))) return reply(400, 'Invalid callback state');
        if (flow.status !== 'authorizing') return reply(409, 'Authorization is not pending');
        if(flow.meta.requireIssuer&&!callback.searchParams.has('iss'))return reply(400,'Issuer parameter is required');
        if (callback.searchParams.has('iss') && callback.searchParams.get('iss') !== flow.meta.issuer) return reply(400, 'Issuer mismatch');
        if (callback.searchParams.has('error')) { reply(400, 'Authorization declined or failed. Return to Wiek.'); finish(flow, 'failed', 'Authorization was declined or failed'); return; }
        const code = callback.searchParams.get('code'); if (!code || code.length > 4096 || /[\x00-\x1f\x7f]/.test(code)) return reply(400, 'Invalid authorization code');
        flow.status = 'exchanging'; publish();
        try {
          const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, client_id: config.oauth.clientId, code_verifier: flow.verifier, resource: flow.meta.resource }).toString();
          const token = await fetchBounded(url(flow.meta.tokenEndpoint, config), { method: 'POST', body, signal: flow.controller.signal });
          if (token.status !== 200) throw fail(`OAuth token exchange failed (HTTP ${token.status}); no automatic retry`);
          if (flow.controller.signal.aborted || closed || flow.fingerprint !== binding(config, scope)) throw fail('OAuth configuration changed or sign-in cancelled');
          const granted = tokenData(token.data, null, flow.meta);
          if (upgrade && !upgrade.scopes.every(value => granted.scopes.includes(value))) throw fail('OAuth server did not grant the reviewed scopes');
          save(config, scope, granted);
          if (upgrade && scopeChallenges.get(key) === upgrade) scopeChallenges.delete(key);
          reply(200, 'Authorization complete. Return to Wiek.'); finish(flow, 'authorized');
        } catch { reply(400, 'Authorization failed. Return to Wiek and start again.'); if (!['cancelled','expired'].includes(flow.status)) finish(flow, 'failed', 'Token exchange failed; start a new sign-in. The code was not replayed.'); }
      });
      flow.server.maxConnections = 16; flow.server.requestTimeout = 5000; flow.server.headersTimeout = 5000;
      await new Promise((resolve, reject) => { flow.server.once('error', reject); flow.server.listen(config.oauth.redirectPort||0, '127.0.0.1', resolve); });
      if (flow.controller.signal.aborted || closed) throw fail('OAuth sign-in cancelled');
      flow.redirectUri = `http://127.0.0.1:${flow.server.address().port}${callbackPath}`;flow.clientIdentity.redirectUri=flow.redirectUri;
      const authorization = new URL(flow.meta.authorizationEndpoint); for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.oauth.clientId, redirect_uri: flow.redirectUri, state: flow.state, code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256', resource: flow.meta.resource, ...(flow.meta.scopes.length ? { scope: flow.meta.scopes.join(' ') } : {}) })) authorization.searchParams.set(key, value);
      flow.authorizationUrl = authorization.href; flow.status = 'prepared'; publish(); return publicFlow(flow);
    } catch (error) { if (!['cancelled','expired'].includes(flow.status)) finish(flow, 'failed', error.error_code ? error.message : 'OAuth discovery failed'); throw error.error_code ? error : fail('OAuth discovery failed'); }
  }
  function flowFor(id, config, scope) { const flow = flows.get(id); if (!flow || flow.integrationId !== config.id || flow.fingerprint !== binding(config, scope)) throw fail('OAuth flow is outside this configuration/scope'); return flow; }
  async function open(id, config, scope) { ensure(); const flow = flowFor(id, config, scope); if (flow.status !== 'prepared') throw fail('OAuth flow is not ready to open'); if (typeof openExternal !== 'function') throw fail('External browser sign-in is unavailable'); flow.status = 'authorizing'; publish(); try { await openExternal(flow.authorizationUrl); } catch { finish(flow, 'failed', 'Could not open the authorization page'); throw fail('Could not open the authorization page'); } return publicFlow(flow); }
  function cancel(id, config, scope) { const flow = flowFor(id, config, scope); if (['discovering','prepared','authorizing','exchanging'].includes(flow.status)) finish(flow, 'cancelled'); return publicFlow(flow); }
  function forget(config, scope) { for(const row of credentials)if(row.integrationId===config.id&&(!scope||row.key===keyFor(config,scope)))scopeChallenges.delete(row.key);for (const flow of flows.values()) if (flow.integrationId === config.id && (!scope || JSON.stringify(flow.scope) === JSON.stringify(scope)) && ['discovering','prepared','authorizing','exchanging'].includes(flow.status)) finish(flow, 'cancelled'); for (const active of refreshing.values()) if (active.integrationId === config.id && (!scope || active.key === keyFor(config, scope))) active.controller.abort(); persist(credentials.filter(row => row.integrationId !== config.id || scope && row.key !== keyFor(config, scope))); publish(); }
  async function authorization(config, scope, signal) {
    ensure();if([...flows.values()].some(flow=>flow.integrationId===config.id&&JSON.stringify(flow.scope)===JSON.stringify(scope)&&['discovering','prepared','authorizing','exchanging'].includes(flow.status)))throw fail('OAuth sign-in is in progress; finish or cancel it before connecting','VEK_MCP_OAUTH_REQUIRED');  const key = keyFor(config, scope), row = credentials.find(item => item.key === key && item.fingerprint === binding(config, scope)); if (!row) throw fail('OAuth sign-in is required; prepare authorization explicitly', 'VEK_MCP_OAUTH_REQUIRED');
    let data; try { data = JSON.parse(decrypt(Buffer.from(row.sealed, 'base64')));if(data.binding!==binding(config,scope)||data.resource!==canonical(config.url)||data.expiresAt!==null&&(!Number.isFinite(data.expiresAt)||data.expiresAt<=0))throw fail('OAuth credential binding mismatch'); tokenData({ token_type: 'Bearer', access_token: data.accessToken, ...(data.refreshToken ? { refresh_token: data.refreshToken } : {}) }, data, data); } catch { throw fail('Encrypted OAuth credential cannot be opened; sign in again'); }
    if (data.expiresAt === null || data.expiresAt > Date.now() + 30000) { onSecret(data.accessToken); return `Bearer ${data.accessToken}`; }
    if (!data.refreshToken) throw fail('OAuth token expired; sign in again', 'VEK_MCP_OAUTH_REQUIRED');
    if (refreshing.has(key)) return refreshing.get(key).promise;
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const operation = { key, integrationId: config.id, controller }; refreshing.set(key, operation);
    operation.promise = (async () => {
      try {
        const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: data.refreshToken, client_id: config.oauth.clientId, resource: data.resource }).toString(); const response = await fetchBounded(url(data.tokenEndpoint, config), { method: 'POST', body, signal: controller.signal });
        if (response.status !== 200 || controller.signal.aborted || closed || !credentials.includes(row)) throw fail('OAuth refresh failed');
        const next = tokenData(response.data, data, data); if (response.data.refresh_token === undefined||response.data.refresh_token===data.refreshToken) throw fail('OAuth public-client refresh token rotation is required'); save(config, scope, next); return `Bearer ${next.accessToken}`;
      } catch { if (credentials.includes(row)) { persist(credentials.filter(item => item !== row)); publish(); } throw fail('OAuth refresh failed; sign in again. Refresh was not replayed.', 'VEK_MCP_OAUTH_REQUIRED'); }
      finally { signal?.removeEventListener('abort', abort); refreshing.delete(key); }
    })(); return operation.promise;
  }
  function close() { if (closed) return; closed = true; for (const flow of flows.values()) if (['discovering','prepared','authorizing','exchanging'].includes(flow.status)) finish(flow, 'cancelled'); for (const operation of refreshing.values()) operation.controller.abort();for(const flow of flows.values())flow.server?.closeAllConnections?.(); }
  return { snapshot, prepare, open, cancel, forget, authorization, scopeChallenge, close };
}
module.exports = { createMcpOAuth, normalizeOAuth, challenge, discover };

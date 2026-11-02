'use strict';
// Independent MCP service with stdio and controlled Streamable HTTP transports.
// Protocol behavior follows public specifications; no private daemon is included.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { prepareInput, validateResponses } = require('./mcp-input.cjs');
const { createMcpOAuth } = require('./mcp-oauth.cjs');
const { methods: resourceMethods, resetResources, resourceNotification } = require('./mcp-resources.cjs');
const { createHttpClientClass, validateHttpConfig } = require('./mcp-http-client.cjs');
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const fail = (message, code = 'VEK_MCP_INVALID_REQUEST') => Object.assign(new Error(message), { error_code: code });
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const nonempty = (value, label, max = 4096) => { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail(`${label} must be nonempty text`); return value.trim(); };
const scopeKey = scope => `${scope.projectId}\0${scope.threadId || ''}`;
function normalizeScope(scope) { if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw fail('A project scope is required'); return { projectId: nonempty(scope.projectId, 'projectId', 200), ...(scope.threadId ? { threadId: nonempty(scope.threadId, 'threadId', 200) } : {}) }; }
function containsScope(owner, requested) { return owner.projectId === requested.projectId && (!owner.threadId || owner.threadId === requested.threadId); }
function boundedNumber(value, fallback, min, max) { value = value === undefined ? fallback : Number(value); if (!Number.isFinite(value) || value < min || value > max) throw fail(`Number must be between ${min} and ${max}`); return value; }
function safeText(value, secrets) { let text = String(value); for (const secret of secrets) if (secret) { const forms = [secret]; for (let depth = 0; depth < 3; depth++) forms.push(JSON.stringify(forms.at(-1)).slice(1, -1)); for (const form of [...new Set(forms)].sort((a,b) => b.length-a.length)) text = text.split(form).join('[redacted]'); } return text; }
function redact(value, secrets) { if (typeof value === 'string') return safeText(value, secrets); if (Array.isArray(value)) return value.map(item => redact(item, secrets)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [safeText(key, secrets), redact(item, secrets)])); return value === undefined ? null : value; }

class StdioClient {
  constructor({ config, cwd, credentials = {}, onChange = () => {}, maxMessageBytes = 1024 * 1024, timeoutMs = 15000 }) {
    this.config = config; this.cwd = cwd; this.credentials = credentials; this.onChange = onChange; this.maxMessageBytes = maxMessageBytes; this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.nextId = 1; this.buffer = ''; this.state = 'connecting'; this.tools = null; this.stderr = ''; this.secrets = Object.values(credentials).filter(Boolean); this.stopped = false; resetResources(this);
  }
  async start() {
    const env = {}; for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, this.credentials);
    this.child = spawn(this.config.command, this.config.args, { cwd: this.cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {}); this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stderr.on('data', chunk => { this.stderrBytes = (this.stderrBytes || 0) + Buffer.byteLength(chunk); this.stderr = `Server diagnostic output received (${this.stderrBytes} bytes; content is not retained)`; this.notifyChange(); });
    this.child.on('error', error => this.break(fail(`MCP process could not start: ${safeText(error.message, this.secrets)}`, 'VEK_MCP_PROCESS_FAILED')));
    this.child.once('close', (code, signal) => { this.exit = { code, signal }; this.break(fail('MCP process exited', 'VEK_MCP_DISCONNECTED')); });
    try {
      const result = await this.request('initialize', { protocolVersion: PROTOCOLS[0], capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'vek-browser', version: '0.1.0' } }, { timeoutMs: this.timeoutMs });
      if (!result || !PROTOCOLS.includes(result.protocolVersion) || !result.serverInfo || typeof result.serverInfo.name !== 'string' || !result.capabilities || typeof result.capabilities !== 'object') throw fail('Invalid MCP initialize response', 'VEK_MCP_PROTOCOL_ERROR');
      this.info = redact(result, this.secrets); this.notify('notifications/initialized'); this.state = 'connected'; this.notifyChange(); return this;
    } catch (error) { await this.stop(); throw error; }
  }
  notifyChange() { try { this.onChange(this); } catch {} }
  consume(chunk) {
    if (this.stopped) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxMessageBytes && !this.buffer.includes('\n')) { this.break(fail('MCP stdout message exceeds the size limit', 'VEK_MCP_PROTOCOL_ERROR')); this.stop(); return; }
    while (this.buffer.includes('\n')) {
      const end = this.buffer.indexOf('\n'), line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { if (Buffer.byteLength(line) > this.maxMessageBytes) throw new Error(); message = JSON.parse(line); if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') throw new Error(); }
      catch { this.break(fail('Malformed MCP stdout message', 'VEK_MCP_PROTOCOL_ERROR')); this.stop(); return; }
      if (Object.hasOwn(message, 'method')) {
        if (typeof message.method !== 'string') { this.break(fail('Malformed MCP method', 'VEK_MCP_PROTOCOL_ERROR')); this.stop(); return; }
        if (Object.hasOwn(message, 'id')) {
          if (message.method === 'ping') this.write({ jsonrpc: '2.0', id: message.id, result: {} });
          else if (message.method === 'roots/list') this.write({ jsonrpc: '2.0', id: message.id, result: { roots: [{ uri: require('node:url').pathToFileURL(this.cwd).href, name: path.basename(this.cwd) }] } });
          else this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method is not supported' } });
        } else if (resourceNotification(this, message)) { /* Connection-local invalidation only. */ }
        else if (message.method === 'notifications/tools/list_changed') { this.tools = null; this.notifyChange(); }
        continue;
      }
      if (!Object.hasOwn(message, 'id') || Number(Object.hasOwn(message, 'result')) + Number(Object.hasOwn(message, 'error')) !== 1) { this.break(fail('Malformed MCP response', 'VEK_MCP_PROTOCOL_ERROR')); this.stop(); return; }
      const pending = this.pending.get(message.id); if (!pending) continue; // Ignore a late cancelled response.
      this.pending.delete(message.id); clearTimeout(pending.timer); pending.cleanup?.();
      if (message.error) pending.reject(fail(safeText(message.error.message || 'MCP request failed', this.secrets), 'VEK_MCP_REMOTE_ERROR'));
      else pending.resolve(redact(message.result, this.secrets));
    }
  }
  write(message) { if (this.stopped || !this.child?.stdin.writable) throw fail('MCP connection is closed', 'VEK_MCP_DISCONNECTED'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  notify(method, params) { this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); }
  request(method, params = {}, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (this.pending.size >= 64) return Promise.reject(fail('Too many pending MCP requests', 'VEK_MCP_CAPACITY'));
    if (signal?.aborted) return Promise.reject(fail('MCP request cancelled', 'VEK_MCP_CANCELLED'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const finishError = (reason, code) => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); clearTimeout(pending.timer); pending.cleanup?.();
        if (method !== 'initialize') { try { this.notify('notifications/cancelled', { requestId: id, reason }); } catch {} }
        reject(fail(reason, code));
      };
      const abort = () => finishError('MCP request cancelled', 'VEK_MCP_CANCELLED');
      const timer = setTimeout(() => finishError('MCP request timed out', 'VEK_MCP_TIMEOUT'), timeoutMs);
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve, reject, timer, cleanup }); signal?.addEventListener('abort', abort, { once: true });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) { this.pending.delete(id); clearTimeout(timer); cleanup(); reject(error); }
    });
  }
  async listTools({ signal } = {}) {
    if (!this.info?.capabilities?.tools) return [];
    if (this.tools) return this.tools;
    const tools = []; let cursor; const seen = new Set();
    for (let page = 0; page < 50; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, { signal });
      if (!Array.isArray(result?.tools) || result.tools.some(tool => !tool || typeof tool.name !== 'string' || !tool.inputSchema || typeof tool.inputSchema !== 'object')) throw fail('Invalid tools/list response', 'VEK_MCP_PROTOCOL_ERROR');
      for (const tool of result.tools) { if (seen.has(tool.name)) throw fail('Duplicate MCP tool name', 'VEK_MCP_PROTOCOL_ERROR'); seen.add(tool.name); tools.push(tool); }
      if (!result.nextCursor) { this.tools = tools; return tools; }
      cursor = nonempty(result.nextCursor, 'nextCursor');
    }
    throw fail('MCP tools pagination exceeded the limit', 'VEK_MCP_PROTOCOL_ERROR');
  }
  break(error) { if (this.state !== 'disconnected') { this.state = 'disconnected'; resetResources(this); this.error = safeText(error.message, this.secrets); for (const p of this.pending.values()) { clearTimeout(p.timer); p.cleanup?.(); p.reject(error); } this.pending.clear(); this.notifyChange(); } }
  async stop() {
    if (this.stopped) return; this.stopped = true; this.break(fail('MCP connection stopped', 'VEK_MCP_DISCONNECTED'));
    const child = this.child; if (!child || child.exitCode !== null || child.signalCode) return;
    const kill = signal => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    child.stdin.end(); kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => { const timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, 500); timer.unref?.(); })]);
  }
}

Object.assign(StdioClient.prototype, resourceMethods);
const HttpClient = createHttpClientClass(StdioClient);

// No raw CDP or token is exposed. The host supplies only selected callbacks and
// must continue enforcing task Space ownership in each callback.
function createBrowserGateway({ callbacks = {}, resolveScope = async scope => scope } = {}) {
  const definitions = {
    listTabs: { description: 'List tabs in this agent scope', inputSchema: { type: 'object', additionalProperties: false } },
    snapshot: { description: 'Snapshot a scoped page, or the active page when targetId is omitted', inputSchema: { type: 'object', properties: { targetId: { type: 'string' }, options: { type: 'object' } }, additionalProperties: false } },
    createTab: { description: 'Create a tab in this agent scope', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
    navigate: { description: 'Navigate a scoped tab', inputSchema: { type: 'object', properties: { targetId: { type: 'string' }, url: { type: 'string' } }, required: ['targetId', 'url'], additionalProperties: false } },
  };
  const methods = Object.keys(definitions).filter(key => typeof callbacks[key] === 'function');
  return {
    methods,
    tools(allowed = methods) { return methods.filter(method => allowed.includes(method)).map(method => ({ name: `browser.${method}`, ...definitions[method] })); },
    async call(name, args = {}, { scope, allowedMethods = methods, signal } = {}) {
      const method = name.replace(/^browser\./, '');
      if (!methods.includes(method) || !allowedMethods.includes(method)) throw fail('Browser method is outside the integration allowlist', 'VEK_MCP_FORBIDDEN');
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(definitions[method].inputSchema.properties || {}, key))) throw fail('Invalid browser tool arguments');
      for (const [key, definition] of Object.entries(definitions[method].inputSchema.properties || {})) if (args[key] !== undefined) {
        if (definition.type === 'string') nonempty(args[key], key, 65536);
        else if (definition.type === 'object' && (!args[key] || typeof args[key] !== 'object' || Array.isArray(args[key]))) throw fail(`Invalid browser tool ${key}`);
      }
      for (const key of definitions[method].inputSchema.required || []) nonempty(args[key], key, 65536);
      const normalized = normalizeScope(scope); if (!normalized.threadId) throw fail('Browser capabilities require an agent thread scope', 'VEK_MCP_FORBIDDEN'); const resolved = await resolveScope(normalized); if (!resolved) throw fail('Unknown agent scope', 'VEK_MCP_FORBIDDEN');
      if (signal?.aborted) throw fail('Browser request cancelled', 'VEK_MCP_CANCELLED');
      return callbacks[method]({ scope: resolved, arguments: clone(args), signal });
    },
  };
}

function createMcpService({ dataDir, onChange = () => {}, resolveScope, resolveCredential, browserGateway, oauthOptions = {}, requestTimeoutMs = 15000, maxResultBytes = 1024 * 1024 } = {}) {
  if (!dataDir || typeof resolveScope !== 'function') throw fail('dataDir and resolveScope callbacks are required');
  const directory = path.join(path.resolve(dataDir), 'mcp'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw fail('MCP directory must not be a symlink'); fs.chmodSync(directory, 0o700);
  const stateFile = path.join(directory, 'state.json'); let state = { version: 1, integrations: [], tasks: [], grants: [] };
  if (fs.existsSync(stateFile)) { if (fs.lstatSync(stateFile).isSymbolicLink()) throw fail('MCP state must not be a symlink'); state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (state.version !== 1 || !['integrations', 'tasks', 'grants'].every(key => Array.isArray(state[key]))) throw fail('Unsupported MCP state'); }
  const lockPath = path.join(directory, 'service.lock'), lockToken = randomUUID();
  if (fs.existsSync(lockPath)) { let live = false; try { process.kill(JSON.parse(fs.readFileSync(lockPath)).pid, 0); live = true; } catch (e) { if (e.code === 'EPERM') live = true; } if (live) throw fail('Another MCP service is using this data directory', 'VEK_MCP_DATA_LOCKED'); fs.unlinkSync(lockPath); }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: lockToken }), { mode: 0o600, flag: 'wx' });
  const connections = new Map(), activeTasks = new Map(), runtimeResults = new Map(), pairings = new Map(), secrets = new Set(), gatewayCalls = new Map(); let closed = false, closing = false, gateway, gatewayPromise;
  let oauthManager;try{oauthManager=createMcpOAuth({dataDir,...oauthOptions,onChange:publish,onSecret:value=>{if(secrets.has(value))return;if(secrets.size>=2048)throw fail('OAuth credential redaction capacity reached; restart before authorizing again','VEK_MCP_CAPACITY');const control=JSON.stringify([state.integrations,state.grants.map(({tokenHash,...row})=>row),state.tasks.map(({id,integrationId,scope,name,grantId})=>({id,integrationId,scope,name,grantId}))]);if(control.includes(value)||control.includes(JSON.stringify(value).slice(1,-1)))throw fail('OAuth token collides with public control data','VEK_MCP_OAUTH');secrets.add(value);}});}catch(error){fs.unlinkSync(lockPath);throw error;}
  for (const task of state.tasks) if (['queued', 'running', 'awaiting_input'].includes(task.status)) { task.status = 'interrupted'; task.completedAt = new Date().toISOString(); }
  function publicTask(task) { const review=activeTasks.get(task.id)?.review;return redact({...task,...(review?{inputReview:{id:review.id,round:review.round,expiresAt:review.expiresAt,forms:review.forms}}:{}),...(runtimeResults.has(task.id)?{result:runtimeResults.get(task.id)}:{})}, secrets); }
  function snapshot() { return redact({ integrations: state.integrations, tasks: state.tasks.map(publicTask), grants: state.grants.map(({ tokenHash, ...grant }) => grant), connections: [...connections.values()].map(c => ({ integrationId: c.integrationId, scope: c.scope, status: c.client?.state || 'connecting', serverInfo: c.client?.info?.serverInfo, error: c.client?.error, stderr: c.client?.stderr || '', tools: c.client?.tools || [], notificationStreams:c.client?.subscriptionSnapshot?.(), resourceCapabilities: c.client?.info?.capabilities?.resources || null, resources: c.client?.resources, resourceTemplates: c.client?.resourceTemplates, resourceSubscriptions: [...(c.client?.resourceSubscriptions?.values() || [])] })), oauth:oauthManager?.snapshot(), gateway: gateway ? { url: gateway.url } : null }, secrets); }
  function publish() { if (closed) return; const tmp = `${stateFile}.${randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(redact(state, secrets), null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, stateFile); try { onChange(snapshot()); } catch {} }
  function ensureOpen() { if (closed || closing) throw fail('MCP service is closed', 'VEK_MCP_CLOSED'); }
  async function scopeFor(value) { const scope = normalizeScope(value); const resolved = await resolveScope(scope); if (!resolved || resolved.projectId !== scope.projectId || (scope.threadId && resolved.threadId !== scope.threadId) || !path.isAbsolute(resolved.projectPath || '') || !fs.statSync(resolved.projectPath).isDirectory()) throw fail('Unknown or unavailable project/thread scope', 'VEK_MCP_FORBIDDEN'); return { scope, resolved }; }
  function integrationFor(id, scope) { const item = state.integrations.find(item => item.id === id); if (!item) throw fail('MCP integration not found', 'VEK_MCP_NOT_FOUND'); if (!containsScope(item.scope, scope)) throw fail('MCP integration is outside this project/thread', 'VEK_MCP_FORBIDDEN'); return item; }
  async function connect(id, scopeValue) {
    ensureOpen(); const { scope, resolved } = await scopeFor(scopeValue), config = integrationFor(id, scope), key = `${id}\0${scopeKey(scope)}`;
    if (!config.enabled) throw fail('MCP integration is disabled', 'VEK_MCP_FORBIDDEN');
    let connection = connections.get(key); if (connection?.client?.state === 'disconnected') { connections.delete(key); void connection.client.stop(); connection = null; } if (connection) return connection.ready;
    if (connections.size >= 32) throw fail('MCP connection limit reached', 'VEK_MCP_CAPACITY');
    connection = { integrationId: id, scope }; connections.set(key, connection);
    connection.ready = (async () => {
      const credentials = {};
      for (const [envName, ref] of Object.entries(config.transport === 'http' ? config.headerRefs || {} : config.credentialRefs || {})) {
        let value;
        if (resolveCredential) { try { value = await resolveCredential(ref, scope); } catch { throw fail(`Credential reference unavailable: ${ref}`, 'VEK_MCP_CREDENTIAL_UNAVAILABLE'); } }
        else if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) value = process.env[ref.slice(4)];
        if (typeof value !== 'string' || !value) throw fail(`Credential reference unavailable: ${ref}`, 'VEK_MCP_CREDENTIAL_UNAVAILABLE');
        credentials[envName] = value; secrets.add(value);
      }
      if (closed || closing) throw fail('MCP service is closed', 'VEK_MCP_CLOSED');
      connection.client = new (config.transport === 'http' ? HttpClient : StdioClient)({ config, cwd: resolved.projectPath, credentials, ...(config.oauth?{authorization:signal=>oauthManager.authorization(config,scope,signal),onAuthorizationFailure:status=>{if(status===401)oauthManager.forget(config,scope);}}:{}),timeoutMs: requestTimeoutMs, onChange: publish });
      await connection.client.start(); return connection.client;
    })().catch(async error => { connections.delete(key); await connection.client?.stop(); publish(); throw error; });
    publish(); return connection.ready;
  }
  async function disconnect(id, scope) { for(const active of [...activeTasks.values()])if(active.task.integrationId===id&&(!scope||scopeKey(active.task.scope)===scopeKey(scope))){active.controller.abort();active.finish('cancelled');} for (const [key, c] of [...connections]) if (c.integrationId === id && (!scope || scopeKey(c.scope) === scopeKey(scope))) { connections.delete(key); await c.ready.catch(() => null); await c.client?.stop(); } publish(); }
  function taskAllowed(task, scope, grant) { if (!task || scopeKey(task.scope) !== scopeKey(scope) || grant && task.grantId !== grant.id) throw fail('Task is outside this scope', 'VEK_MCP_FORBIDDEN'); return task; }
  function limitedResult(result) { const data = redact(result, secrets); const text = JSON.stringify(data); return Buffer.byteLength(text) <= maxResultBytes ? data : { isError: true, content: [{ type: 'text', text: `Tool response exceeded ${maxResultBytes} bytes and was omitted.` }], truncated: true }; }
  async function startTask(payload, grant) {
    ensureOpen(); if (activeTasks.size >= 32) throw fail('MCP task concurrency limit reached', 'VEK_MCP_CAPACITY'); const { scope } = await scopeFor(payload.scope); const name = nonempty(payload.name, 'tool name', 256), args = payload.arguments === undefined ? {} : payload.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('Tool arguments must be an object');
    const integrationId = payload.integrationId;
    if (integrationId) { integrationFor(integrationId, scope); if (grant && !grant.integrationIds.includes(integrationId)) throw fail('Integration is not allowed by this grant', 'VEK_MCP_FORBIDDEN'); }
    else if (!browserGateway || !name.startsWith('browser.') || grant && !grant.browserMethods.includes(name.slice(8))) throw fail('Tool is not allowed', 'VEK_MCP_FORBIDDEN');
    const timeoutMs = boundedNumber(payload.timeoutMs, requestTimeoutMs, 10, 300000);
    const task = { id: randomUUID(), integrationId: integrationId || null, name, scope, status: 'queued', createdAt: new Date().toISOString(), ...(grant ? { grantId: grant.id } : {}) };
    state.tasks.push(task); state.tasks = state.tasks.filter((item, index) => activeTasks.has(item.id) || index >= state.tasks.length - 500); const controller = new AbortController(); let resolveDone;
    const running = { task, controller, done: new Promise(resolve => { resolveDone = resolve; }), resolveDone: null }; running.resolveDone = resolveDone; activeTasks.set(task.id, running);
    const finish = (status, result, error) => { if (!activeTasks.has(task.id)) return; clearTimeout(running.timer); task.status = status; task.completedAt = new Date().toISOString(); if (result !== undefined) {if(task.interactive){runtimeResults.set(task.id,limitedResult(result));while(runtimeResults.size>500)runtimeResults.delete(runtimeResults.keys().next().value);task.resultRetained=false;}else task.result = limitedResult(result);} if (error) task.error = task.interactive ? (error === 'VEK_MCP_UNSUPPORTED_CAPABILITY' ? 'The server requested an input type or form schema Vek does not support.' : 'Interactive tool call ended without a result; no automatic retry was sent.') : safeText(error, secrets); activeTasks.delete(task.id); publish(); resolveDone(publicTask(task)); };
    running.finish = finish; running.expiresAt = new Date(Date.now()+timeoutMs).toISOString(); running.timer = setTimeout(() => { controller.abort(); finish('timed_out', undefined, 'Tool call timed out'); }, timeoutMs);
    publish();
    void (async () => {
      try {
        let result; task.status = 'running'; task.startedAt = new Date().toISOString(); publish();
        if (integrationId) { const client = await connect(integrationId, scope); if (controller.signal.aborted) return; const tools = await client.listTools({ signal: controller.signal }); if (!tools.some(tool => tool.name === name)) throw fail('Unknown MCP tool', 'VEK_MCP_NOT_FOUND'); const original={name,arguments:clone(args)};let continuation={},round=0;
          while(true){
            if(controller.signal.aborted)return;
            result=await client.request('tools/call',{...original,...continuation},{timeoutMs,signal:controller.signal,allowInput:!grant});
            if(result?.resultType!=='input_required')break;
            task.interactive=true;
            if(++round>8)throw fail('MCP input round limit reached','VEK_MCP_CAPACITY');
            const prepared=prepareInput(result);
            const inputResponses=await new Promise((resolve,reject)=>{
              const abort=()=>{running.review=null;reject(fail('Input cancelled','VEK_MCP_CANCELLED'));};
              const cleanup=()=>controller.signal.removeEventListener('abort',abort);
              running.review={id:randomUUID(),round,forms:prepared.forms,expiresAt:running.expiresAt,submit:responses=>{cleanup();running.review=null;resolve(responses);}};
              controller.signal.addEventListener('abort',abort,{once:true});
              if(controller.signal.aborted){abort();return;}
              task.status='awaiting_input';publish();
            });
            continuation={inputResponses,...(Object.hasOwn(prepared,'requestState')?{requestState:prepared.requestState}:{})};
            task.status='running';publish();
          } }
        else result = await browserGateway.call(name, args, { scope, signal: controller.signal, ...(grant ? { allowedMethods: grant.browserMethods } : {}) });
        finish('completed', result);
      } catch (error) { finish(controller.signal.aborted ? 'cancelled' : error.error_code === 'VEK_MCP_TIMEOUT' ? 'timed_out' : 'failed', undefined, task.interactive ? error.error_code : error.message); }
    })();
    return publicTask(task);
  }
  async function readTask(id, scopeValue, grant) { const { scope } = await scopeFor(scopeValue); return publicTask(taskAllowed(state.tasks.find(task => task.id === id), scope, grant)); }
  async function waitTask(id, scopeValue, timeoutMs = 30000, grant) { const task = await readTask(id, scopeValue, grant), active = activeTasks.get(id); if (!active) return task; return Promise.race([active.done, new Promise(resolve => { const timer = setTimeout(() => resolve(publicTask(active.task)), boundedNumber(timeoutMs, 30000, 0, 60000)); timer.unref?.(); })]); }
  async function cancelTask(id, scopeValue, grant) { await readTask(id, scopeValue, grant); const active = activeTasks.get(id); if (active) { active.controller.abort(); active.finish('cancelled'); } return readTask(id, scopeValue, grant); }
  async function dispatch(action, p = {}) {
    ensureOpen();
    if (action === 'mcp:snapshot') return snapshot();
    if(action.startsWith('mcp:oauth:')){const {scope}=await scopeFor(p.scope),config=integrationFor(p.integrationId,scope);if(!config.enabled||config.transport!=='http'||!config.oauth)throw fail('Choose an enabled HTTP integration with a public OAuth client ID');if(action==='mcp:oauth:prepare'){const preparing=oauthManager.prepare(config,scope).then(value=>({value}),error=>({error}));await disconnect(config.id,scope);const result=await preparing;if(result.error)throw result.error;return result.value;}if(action==='mcp:oauth:open')return oauthManager.open(p.flowId,config,scope);if(action==='mcp:oauth:cancel')return oauthManager.cancel(p.flowId,config,scope);if(action==='mcp:oauth:forget'){await disconnect(config.id,scope);oauthManager.forget(config,scope);return snapshot();}throw fail('Unknown OAuth action');}
    if (action === 'mcp:integrations:save') {
      if (Object.hasOwn(p, 'env') || Object.hasOwn(p, 'credentials') || Object.hasOwn(p, 'token') || Object.hasOwn(p, 'headers')) throw fail('Only credential references may be configured');
      const { scope } = await scopeFor(p.scope); const credentialRefs = {};
      for (const [key, ref] of Object.entries(p.credentialRefs || {})) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw fail('Invalid credential environment name'); credentialRefs[key] = nonempty(ref, 'credential reference', 500); if (!/^[a-z][a-z0-9+.-]*:[A-Za-z0-9._/-]+$/.test(credentialRefs[key])) throw fail('Credential references must use a provider:name form such as env:API_KEY'); }
      if (p.transport !== undefined && !['stdio', 'http'].includes(p.transport)) throw fail('Unknown MCP transport');
      let transportConfig;
      if (p.transport === 'http') {
        if (p.command !== undefined || p.args !== undefined || Object.keys(credentialRefs).length) throw fail('HTTP integrations use URL and header references, not process configuration');
        transportConfig = { transport: 'http', ...validateHttpConfig(p) };
      } else {
        if(p.oauth!==undefined)throw fail('OAuth applies to HTTP integrations only');
        if (!Array.isArray(p.args) || p.args.length > 128 || p.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 65536)) throw fail('args must be an array of strings');
        if (p.headerRefs !== undefined || p.url !== undefined) throw fail('Select HTTP transport to configure an endpoint');
        transportConfig = { transport: 'stdio', command: nonempty(p.command, 'command'), args: [...p.args], credentialRefs };
      }
      const config = { id: p.id || randomUUID(), name: nonempty(p.name, 'name', 200), ...transportConfig, scope, enabled: p.enabled !== false };
      const old = state.integrations.find(item => item.id === config.id); if (p.id && !old) throw fail('MCP integration not found', 'VEK_MCP_NOT_FOUND'); if (old) {await disconnect(old.id);if(old.url!==config.url||JSON.stringify(old.oauth)!==JSON.stringify(config.oauth)||scopeKey(old.scope)!==scopeKey(config.scope))oauthManager.forget(old);}
      state.integrations = [...state.integrations.filter(item => item.id !== config.id), config]; publish(); return snapshot();
    }
    if (action === 'mcp:integrations:list') { const scope = p.scope ? (await scopeFor(p.scope)).scope : null; return { integrations: state.integrations.filter(item => !scope || containsScope(item.scope, scope)) }; }
    if (action === 'mcp:integrations:remove') { await disconnect(p.id);const old=state.integrations.find(item=>item.id===p.id);if(old)oauthManager.forget(old); state.integrations = state.integrations.filter(item => item.id !== p.id); publish(); return snapshot(); }
    if (action === 'mcp:integrations:connect') { await connect(p.id, p.scope); return snapshot(); }
    if (action === 'mcp:integrations:disconnect') { await disconnect(p.id, p.scope ? normalizeScope(p.scope) : null); return snapshot(); }
    if (action === 'mcp:subscriptions:watch' || action === 'mcp:subscriptions:stop') { const client=await connect(p.integrationId,p.scope); if(!client.modern)throw fail('List streams require the 2026 HTTP protocol','VEK_MCP_UNSUPPORTED_CAPABILITY'); await client.watchLists(action.endsWith(':watch')); return snapshot(); }
    if (action === 'mcp:tools:list') return { tools: await (await connect(p.integrationId, p.scope)).listTools() };
    if (action === 'mcp:resources:list' || action === 'mcp:resources:templates') return { [action.endsWith(':templates') ? 'resourceTemplates' : 'resources']: await (await connect(p.integrationId, p.scope)).listResources({ templates: action.endsWith(':templates') }) };
    if (action === 'mcp:resources:read') return (await connect(p.integrationId, p.scope)).readResource(p.uri);
    if (action === 'mcp:resources:subscribe' || action === 'mcp:resources:unsubscribe') { await (await connect(p.integrationId, p.scope)).setResourceSubscription(p.uri, action.endsWith(':subscribe')); return snapshot(); }
    if (action === 'mcp:tasks:create' || action === 'mcp:tools:call') return startTask(p);
    if (action === 'mcp:tasks:read') return readTask(p.id, p.scope);
    if (action === 'mcp:tasks:wait') return waitTask(p.id, p.scope, p.timeoutMs);
    if (action === 'mcp:tasks:respond') {
      const {scope}=await scopeFor(p.scope);taskAllowed(state.tasks.find(task=>task.id===p.id),scope);
      const active=activeTasks.get(p.id),review=active?.review;
      if(!review||review.id!==p.reviewId||active.controller.signal.aborted)throw fail('This input review has ended or changed','VEK_MCP_INPUT_EXPIRED');
      const responses=validateResponses(review.forms,p.responses);review.submit(responses);return publicTask(active.task);
    }
    if (action === 'mcp:tasks:cancel') return cancelTask(p.id, p.scope);
    if (action === 'mcp:gateway:start') { await startGateway(); return snapshot(); }
    if (action === 'mcp:pairing:create') return createPairing(p);
    if (action === 'mcp:grants:revoke') { const grant = state.grants.find(g => g.id === p.id); if (!grant) throw fail('Grant not found', 'VEK_MCP_NOT_FOUND'); grant.revokedAt = new Date().toISOString(); for (const active of [...activeTasks.values()]) if (active.task.grantId === grant.id) { active.controller.abort(); active.finish('cancelled'); } publish(); return snapshot(); }
    throw fail(`Unknown MCP action: ${action}`);
  }
  async function createPairing(p) {
    const { scope } = await scopeFor(p.scope); if (p.integrationIds !== undefined && !Array.isArray(p.integrationIds) || p.browserMethods !== undefined && !Array.isArray(p.browserMethods)) throw fail('Pairing allowlists must be arrays'); const integrationIds = [...(p.integrationIds || [])], browserMethods = [...(p.browserMethods || [])];
    if (!Array.isArray(integrationIds) || !Array.isArray(browserMethods)) throw fail('Pairing allowlists must be arrays');
    for (const id of integrationIds) integrationFor(id, scope);
    for (const method of browserMethods) if (!browserGateway?.methods.includes(method)) throw fail('Unknown browser capability');
    if (browserMethods.length && !scope.threadId) throw fail('Browser capabilities require an agent thread scope');
    if (!integrationIds.length && !browserMethods.length) throw fail('Choose at least one integration or browser capability');
    await startGateway(); const code = randomBytes(18).toString('base64url'), id = randomUUID(), expiresAt = Date.now() + boundedNumber(p.ttlMs, 300000, 1000, 600000);
    pairings.set(hash(code), { id, name: nonempty(p.name || 'Local MCP client', 'name', 200), scope, integrationIds, browserMethods, expiresAt, grantTtlMs: boundedNumber(p.grantTtlMs, 86400000, 1000, 30 * 86400000) });
    return { pairingId: id, code, expiresAt: new Date(expiresAt).toISOString(), exchangeUrl: `${gateway.url}/pair` };
  }
  async function gatewayRequest(message, grant) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw fail('Invalid JSON-RPC message');
    const p = message.params || {}, scope = grant.scope;
    if (message.method === 'initialize') return { protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'vek-scoped-gateway', version: '0.1.0' } };
    if (message.method === 'ping') return {};
    if (message.method === 'notifications/cancelled') { const pending = gatewayCalls.get(`${grant.id}:${JSON.stringify(p.requestId)}`); if (pending) await cancelTask(pending.id, scope, grant); return undefined; }
    if (message.method.startsWith('notifications/')) return undefined;
    if (message.method === 'tools/list') {
      const tools = [
        { name: 'vek.tasks.create', description: 'Start a scoped external MCP tool task', inputSchema: { type: 'object', required: ['integrationId', 'name'], properties: { integrationId: { type: 'string' }, name: { type: 'string' }, arguments: { type: 'object' }, timeoutMs: { type: 'number' } } } },
        ...['read', 'wait', 'cancel'].map(name => ({ name: `vek.tasks.${name}`, description: `${name} a task created by this client`, inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, timeoutMs: { type: 'number' } } } })),
        ...(browserGateway?.tools(grant.browserMethods) || []),
      ];
      for (const id of grant.integrationIds) for (const tool of await (await connect(id, scope)).listTools()) tools.push({ ...tool, name: `external.${id}.${tool.name}` });
      return { tools };
    }
    if (message.method !== 'tools/call') throw fail('MCP method is not supported', 'VEK_MCP_METHOD_NOT_FOUND');
    const args = p.arguments || {}; let task;
    if (p.name === 'vek.tasks.create') return asContent(await startTask({ ...args, scope }, grant));
    if (p.name === 'vek.tasks.read') return asContent(await readTask(args.id, scope, grant));
    if (p.name === 'vek.tasks.wait') return asContent(await waitTask(args.id, scope, args.timeoutMs, grant));
    if (p.name === 'vek.tasks.cancel') return asContent(await cancelTask(args.id, scope, grant));
    if (typeof p.name === 'string' && p.name.startsWith('browser.')) task = await startTask({ scope, name: p.name, arguments: args }, grant);
    else { const id = grant.integrationIds.find(id => p.name?.startsWith(`external.${id}.`)); if (!id) throw fail('Tool is outside this grant', 'VEK_MCP_FORBIDDEN'); task = await startTask({ scope, integrationId: id, name: p.name.slice(`external.${id}.`.length), arguments: args }, grant); }
    const key = `${grant.id}:${JSON.stringify(message.id)}`; gatewayCalls.set(key, { id: task.id });
    try { const finished = await waitTask(task.id, scope, requestTimeoutMs + 100, grant); return finished.status === 'completed' && finished.result?.content ? finished.result : asContent(finished, finished.status !== 'completed'); } finally { gatewayCalls.delete(key); }
  }
  const asContent = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
  function startGateway() { ensureOpen(); if (gateway) return Promise.resolve(gateway); if (!gatewayPromise) gatewayPromise = startGatewayServer().catch(error => { gatewayPromise = undefined; throw error; }); return gatewayPromise; }
  async function startGatewayServer() {
    ensureOpen(); if (gateway) return gateway;
    const server = http.createServer(async (req, res) => {
      const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return json(403, { error: 'Origin or host is not allowed' });
      if (req.method !== 'POST' || !['/pair', '/mcp'].includes(req.url)) return json(405, { error: 'Use POST /pair or POST /mcp' });
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw fail('Request body is too large'); }
        let message; try { message = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
        if (req.url === '/pair') {
          const key = hash(String(message.code || '')), pairing = pairings.get(key); pairings.delete(key);
          if (!pairing || pairing.expiresAt <= Date.now()) return json(403, { error: 'Invalid or expired pairing code' });
          const token = randomBytes(32).toString('base64url'), grant = { id: randomUUID(), name: pairing.name, scope: pairing.scope, integrationIds: pairing.integrationIds, browserMethods: pairing.browserMethods, tokenHash: hash(token), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + pairing.grantTtlMs).toISOString() };
          state.grants.push(grant); publish(); return json(200, { token, grantId: grant.id, endpoint: `${gateway.url}/mcp`, expiresAt: grant.expiresAt });
        }
        const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1]; if (!bearer) return json(401, { error: 'Bearer token required' });
        const digest = Buffer.from(hash(bearer), 'hex'), grant = state.grants.find(g => !g.revokedAt && Date.parse(g.expiresAt) > Date.now() && typeof g.tokenHash === 'string' && Buffer.from(g.tokenHash, 'hex').length === digest.length && timingSafeEqual(Buffer.from(g.tokenHash, 'hex'), digest));
        if (!grant) return json(403, { error: 'Token is invalid, expired, or revoked' });
        await scopeFor(grant.scope);
        let result; try { result = await gatewayRequest(message, grant); } catch (error) { return json(200, { jsonrpc: '2.0', id: message.id ?? null, error: { code: error.error_code === 'VEK_MCP_METHOD_NOT_FOUND' ? -32601 : -32000, message: safeText(error.message, secrets) } }); }
        if (!Object.hasOwn(message, 'id')) { res.writeHead(202); res.end(); return; }
        return json(200, { jsonrpc: '2.0', id: message.id, result });
      } catch (error) { json(400, { error: safeText(error.message, secrets) }); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    gateway = { server, url: `http://127.0.0.1:${server.address().port}` }; publish(); return gateway;
  }
  async function close() {
    if (closed || closing) return; closing = true;oauthManager.close();
    for (const active of [...activeTasks.values()]) { active.controller.abort(); active.finish('interrupted'); }
    for (const c of [...connections.values()]) { await c.ready.catch(() => null); await c.client?.stop(); } connections.clear();
    pairings.clear(); gatewayCalls.clear(); if (gatewayPromise) await gatewayPromise.catch(() => null); publish(); closed = true;
    if (gateway) { gateway.server.closeAllConnections?.(); await new Promise(resolve => gateway.server.close(resolve)); gateway = undefined; }
    try { if (JSON.parse(fs.readFileSync(lockPath)).token === lockToken) fs.unlinkSync(lockPath); } catch {}
  }
  publish(); return { dispatch, snapshot, close, startGateway };
}
module.exports = { createMcpService, createBrowserGateway, StdioClient, HttpClient };

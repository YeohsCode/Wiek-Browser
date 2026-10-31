'use strict';
// Independent ACP v1 stdio client. No client filesystem/terminal/auth delegation.
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const cut = (value, max = 4096) => String(value ?? '').slice(0, max);
const now = () => new Date().toISOString();
function acpAttachments(files) {
  let bytes = 0;
  return files.map(file => {
    const data = fs.readFileSync(file.storedPath); bytes += data.length;
    if (bytes > 24 * 1024 * 1024) throw Error('ACP attachments exceed 24 MiB combined');
    if (file.mimeType.startsWith('image/')) return { type: 'image', mimeType: file.mimeType, data: data.toString('base64') };
    const resource = { uri: pathToFileURL(file.storedPath).href, mimeType: file.mimeType };
    if (file.mimeType === 'application/pdf') resource.blob = data.toString('base64');
    else resource.text = new TextDecoder('utf8', { fatal: true }).decode(data);
    return { type: 'resource', resource };
  });
}
function catalogue(response) {
  const options = [], models = []; let truncated = false;
  function choices(values, depth = 0) {
    if (!Array.isArray(values) || depth > 1) return [];
    const out = [];
    for (const item of values) {
      if (out.length >= 256) { truncated = true; break; }
      if (Array.isArray(item?.options)) { const nested = choices(item.options, depth + 1), remaining = 256 - out.length; if (nested.length > remaining) truncated = true; out.push(...nested.slice(0, remaining)); }
      else if (validId(item?.value)) out.push({ id: item.value, name: cut(item.name || item.value, 256) });
    }
    return out;
  }
  for (const item of (Array.isArray(response?.configOptions) ? response.configOptions : []).slice(0, 32)) {
    if (item?.type !== 'select' || !validId(item.id)) continue;
    const values = choices(item.options);
    options.push({ id: item.id, name: cut(item.name, 256), category: cut(item.category, 64), currentValue: cut(item.currentValue, 256), values });
    if ((item.category === 'model' || item.id === 'model') && !models.length) models.push(...values);
  }
  const modelOption = options.find(item => item.category === 'model' || item.id === 'model');
  if (!modelOption && Array.isArray(response?.models?.availableModels)) for (const item of response.models.availableModels) {
    if (models.length >= 256) { truncated = true; break; }
    if (validId(item.modelId)) models.push({ id: item.modelId, name: cut(item.name || item.modelId, 256) });
  }
  return { source: 'acp-session', observedAt: now(), models, ...(modelOption ? { modelConfigId: modelOption.id, currentModelId: modelOption.currentValue } : validId(response?.models?.currentModelId) ? { currentModelId: response.models.currentModelId, legacyModelSelector: true } : {}), truncated };
}
function connectAcp({ child, active, run, thread, project, text, attachments = [], discoverOnly = false, consume, publish, killTree, onSession }) {
  let closed = false, finishing = false, phase = 'initializing', sessionId = thread.nativeThreadId || null, sequence = 0, buffer = '', displayBytes = 0;
  const decoder = new StringDecoder('utf8'), pending = new Map(), approvals = new Map(), serverIds = new Set(), tools = new Map(), children = new Map(), timers = new Set();
  let capabilities = {}, currentCatalogue;
  const timer = (fn, ms) => { const handle = setTimeout(() => { timers.delete(handle); fn(); }, ms); handle.unref?.(); timers.add(handle); return handle; };
  const write = value => { if (closed || child.stdin.destroyed || child.stdin.writableEnded) throw Error('ACP input is closed'); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); };
  const terminate = () => { killTree(child, 'SIGTERM'); timer(() => killTree(child, 'SIGKILL'), 1000); };
  const failure = cause => { if (closed || finishing || active.finalizing) return; run.error = cut(cause.message || cause, 8192); finishing = true; terminate(); };
  const request = (method, params, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = ++sequence, timeout = timeoutMs ? timer(() => { pending.delete(id); reject(Error(`ACP request timed out: ${method}`)); }, timeoutMs) : null;
    pending.set(id, { resolve, reject, timeout });
    try { write({ id, method, params }); } catch (e) { clearTimeout(timeout); pending.delete(id); reject(e); }
  });
  const respond = (id, result) => write({ id, result });
  const cancelPermissions = () => { for (const entry of approvals.values()) { try { respond(entry.requestId, { outcome: { outcome: 'cancelled' } }); } catch {} if (entry.record.status === 'pending') entry.record.status = 'expired'; } approvals.clear(); };
  const closeInput = () => { cancelPermissions(); child.stdin.end(); timer(terminate, 1000); };
  const retain = (value, limit = 4096) => {
    const raw = Buffer.from(cut(value, limit)), left = Math.max(0, 256 * 1024 - displayBytes); let valueText = raw.subarray(0, left).toString('utf8');
    while (Buffer.byteLength(valueText) > left) valueText = valueText.slice(0, -1);
    displayBytes += Buffer.byteLength(valueText); if (raw.length > left || String(value ?? '').length > limit) run.nativeEventsTruncated = true; return valueText;
  };
  function childRecord(meta) {
    if (!validId(meta?.id)) return null;
    if (children.has(meta.id)) return children.get(meta.id);
    if (children.size >= 100) { run.nativeEventsTruncated = true; return null; }
    const record = { id: meta.id, description: retain(meta.title || meta.id, 2048), status: 'observed', messages: [] };
    run.subagents ||= []; run.subagents.push(record); children.set(meta.id, record); return record;
  }
  function toolContent(content) {
    if (!Array.isArray(content)) return '';
    return content.map(item => item?.type === 'content' && item.content?.type === 'text' ? cut(item.content.text, 16384)
      : item?.type === 'diff' ? `Diff ${cut(item.path, 1024)}\n---\n${cut(item.oldText, 8192)}\n+++\n${cut(item.newText, 8192)}` : `[${cut(item?.type || 'unsupported', 64)} content omitted]`).join('\n');
  }
  function update(value) {
    const kind = value.sessionUpdate, childMeta = value._meta?.['opencode/child-session'];
    if (childMeta !== undefined && !validId(childMeta?.id)) throw Error('ACP child session identity is invalid');
    const child = childRecord(childMeta);
    if (childMeta && !child) return; // Bounded child output never becomes a root answer.
    if (kind === 'agent_message_chunk' && value.content?.type === 'text' && typeof value.content.text === 'string') {
      if (child) { child.messages[0] ||= { role: 'assistant', content: '' }; const remaining = Math.max(0, 16384 - child.messages[0].content.length); child.messages[0].content += retain(value.content.text, remaining); }
      else consume('stdout', Buffer.from(value.content.text));
    }
    if (['tool_call', 'tool_call_update'].includes(kind)) {
      if (!validId(value.toolCallId)) throw Error('ACP tool identity is invalid');
      const key = JSON.stringify([child?.id || null, value.toolCallId]); let entry = tools.get(key);
      if (!entry) {
        if (tools.size >= 200) { run.toolEventsTruncated = true; return; }
        entry = { id: value.toolCallId, name: 'Tool', status: 'observed', ...(child ? { parentToolUseId: child.id } : {}) };
        tools.set(key, entry); run.toolEvents ||= []; run.toolEvents.push(entry);
      }
      if (typeof value.title === 'string') entry.name = retain(value.title, 256);
      if (value.rawInput !== undefined) entry.input = retain(JSON.stringify(value.rawInput));
      if (value.content !== undefined) entry.result = retain(toolContent(value.content), 16384);
      if (['pending', 'in_progress', 'completed', 'failed'].includes(value.status)) entry.status = value.status === 'pending' || value.status === 'in_progress' ? 'running' : value.status;
    }
    if (kind === 'usage_update' && !child) {
      if (Number.isSafeInteger(value.used) && value.used >= 0 && Number.isSafeInteger(value.size) && value.size >= 0) run.contextUsage = { used: value.used, size: value.size };
      if (value.cost?.currency === 'USD' && Number.isFinite(value.cost.amount) && value.cost.amount >= 0) run.usage = { ...run.usage, sessionCostUsd: value.cost.amount, source: 'native-provider-event', scope: 'acp-session' };
    }
  }
  active.native = { completed: false };
  active.finishNativeActivity = outcome => { for (const record of [...tools.values(), ...children.values()]) if (['observed', 'running'].includes(record.status)) { record.status = outcome === 'completed' ? 'unresolved' : 'interrupted'; record.endReason = `Prompt ${outcome}; no terminal activity event observed`; } };
  active.acp = {
    cancel() { cancelPermissions(); if (sessionId && phase === 'prompt') write({ method: 'session/cancel', params: { sessionId } }); else closeInput(); },
    approve(id, decision) {
      const entry = approvals.get(id);
      if (!entry || entry.record.status !== 'pending' || finishing || active.stopReason) throw Error('ACP permission request is unavailable');
      const option = entry.options.find(item => item.kind === (decision === 'accept' ? 'allow_once' : 'reject_once'));
      if (decision === 'accept' && !option) throw Error('ACP request has no single-use allow option');
      respond(entry.requestId, { outcome: decision === 'cancel' || !option ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option.optionId } });
      entry.record.status = decision === 'accept' ? 'accepted' : decision === 'decline' ? 'declined' : 'cancelled'; entry.record.decidedAt = now(); approvals.delete(id);
    },
  };
  function event(value) {
    if (!value || value.jsonrpc !== '2.0' || Array.isArray(value)) throw Error('ACP emitted an invalid JSON-RPC object');
    if (finishing) return;
    if (value.id !== undefined && value.method === undefined) {
      const entry = pending.get(value.id); if (!entry) return;
      clearTimeout(entry.timeout); pending.delete(value.id);
      if (value.error) entry.reject(Error(cut(value.error.message || `ACP error ${value.error.code}`, 8192))); else if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)) entry.reject(Error('ACP response result is invalid')); else entry.resolve(value.result);
      return;
    }
    if (typeof value.method !== 'string') throw Error('ACP frame is missing its method');
    const params = value.params || {};
    if (params.sessionId !== undefined && sessionId && params.sessionId !== sessionId) throw Error('ACP update belongs to a different session');
    if (value.id !== undefined) {
      if (!((typeof value.id === 'number' && Number.isSafeInteger(value.id)) || validId(value.id)) || serverIds.has(value.id) || serverIds.size >= 10000) throw Error('ACP server request identity is invalid or repeated');
      serverIds.add(value.id);
      if (value.method !== 'session/request_permission') { write({ id: value.id, error: { code: -32601, message: 'Vek does not expose client filesystem, terminal or authentication methods' } }); return; }
      if (phase !== 'prompt' || active.stopReason || params.sessionId !== sessionId) { respond(value.id, { outcome: { outcome: 'cancelled' } }); return; }
      if (!Array.isArray(params.options) || params.options.length > 32 || !params.options.every(item => validId(item?.optionId) && typeof item.kind === 'string') || new Set(params.options.map(item => item.optionId)).size !== params.options.length) throw Error('ACP permission options are invalid');
      if ((run.approvals?.length || 0) >= 64) { respond(value.id, { outcome: { outcome: 'cancelled' } }); return; }
      const record = { id: randomUUID(), kind: 'tool', title: cut(params.toolCall?.title || 'Agent permission request', 2048), command: cut(JSON.stringify(params.toolCall || {}), 8192), cwd: project.path, status: 'pending', createdAt: now(), canAccept: params.options.some(item => item.kind === 'allow_once') };
      run.approvals ||= []; run.approvals.push(record); approvals.set(record.id, { requestId: value.id, options: params.options, record }); publish(); return;
    }
    if (value.method === 'session/update' && params.sessionId === sessionId) {
      if (params.update?.sessionUpdate === 'config_option_update') { currentCatalogue = catalogue(params.update); thread.nativeCatalog = currentCatalogue; publish(); }
      if (phase === 'prompt') { update(params.update || {}); publish(); }
    }
  }
  child.stdout.on('data', chunk => {
    if (finishing) return; buffer += decoder.write(chunk);
    try { let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw Error('ACP frame exceeds 4 MiB'); if (line.trim()) event(JSON.parse(line)); } if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw Error('ACP frame exceeds 4 MiB'); } catch (e) { failure(e); }
  });
  child.on('close', () => { closed = true; for (const handle of timers) clearTimeout(handle); timers.clear(); for (const entry of approvals.values()) if (entry.record.status === 'pending') entry.record.status = 'expired'; approvals.clear(); for (const entry of pending.values()) entry.reject(Error('ACP provider disconnected before completion')); pending.clear(); });
  active.native.ready = (async () => {
    const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } }, clientInfo: { name: 'vek-browser', version: require('../package.json').version } });
    if (initialized.protocolVersion !== 1) throw Error('Unsupported ACP protocol version'); capabilities = initialized.agentCapabilities || {};
    if (active.stopReason || closed) return;
    const resumed = !!sessionId;
    if (resumed && capabilities.loadSession !== true) throw Error('ACP agent cannot load the owned native session');
    phase = 'loading';
    const result = await request(resumed ? 'session/load' : 'session/new', { cwd: project.path, mcpServers: [], ...(resumed ? { sessionId } : {}) });
    if (active.stopReason || closed) return;
    if (!resumed && !validId(result.sessionId)) throw Error('ACP agent did not return a valid session id');
    if (resumed && result.sessionId !== undefined && result.sessionId !== sessionId) throw Error('ACP loaded a different session');
    sessionId = resumed ? sessionId : result.sessionId; thread.nativeThreadId = sessionId; run.nativeThreadId = sessionId;
    currentCatalogue = catalogue(result); thread.nativeCatalog = currentCatalogue; onSession(); publish();
    if (discoverOnly) { active.native.completed = true; finishing = true; closeInput(); return; }
    if (thread.model) {
      if (!currentCatalogue.models.some(item => item.id === thread.model)) throw Error('Selected model is absent from the ACP session catalogue');
      if (currentCatalogue.modelConfigId) {
        const selected = await request('session/set_config_option', { sessionId, configId: currentCatalogue.modelConfigId, value: thread.model });
        if (!Array.isArray(selected.configOptions)) throw Error('ACP model selection did not return its config state');
        currentCatalogue = catalogue(selected); thread.nativeCatalog = currentCatalogue;
        if (currentCatalogue.currentModelId !== thread.model) throw Error('ACP did not confirm the selected model');
      } else if (currentCatalogue.legacyModelSelector) await request('session/set_model', { sessionId, modelId: thread.model });
      else throw Error('ACP agent did not advertise a model selector');
      publish();
    }
    for (const block of attachments) if ((block.type === 'image' && !capabilities.promptCapabilities?.image) || (block.type === 'resource' && !capabilities.promptCapabilities?.embeddedContext)) throw Error('ACP agent did not advertise support for this attachment type');
    if (active.stopReason || closed) return;
    phase = 'prompt'; run.nativeUserMessageId = randomUUID();
    const promptResult = request('session/prompt', { sessionId, prompt: [{ type: 'text', text: thread.nativeContextSent ? text.current : text.full }, ...attachments] }, 0);
    thread.nativeContextSent = true;
    const resultPrompt = await promptResult;
    if (!['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'].includes(resultPrompt.stopReason)) throw Error('ACP prompt ended without a recognized stop reason');
    run.nativeStopReason = resultPrompt.stopReason;
    if (resultPrompt.stopReason === 'cancelled') active.stopReason ||= 'stopped';
    if (resultPrompt.usage && ['inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(resultPrompt.usage[key]) && resultPrompt.usage[key] >= 0)) run.usage = { ...run.usage, inputTokens: resultPrompt.usage.inputTokens, outputTokens: resultPrompt.usage.outputTokens, source: 'native-provider-event', scope: 'prompt-main-session' };
    active.native.completed = true; finishing = true; closeInput(); publish();
  })();
  active.native.ready.catch(failure);
  return active.acp;
}
module.exports = { connectAcp, acpAttachments, catalogue };

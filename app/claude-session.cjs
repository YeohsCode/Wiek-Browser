'use strict';

// Independent client of Claude Code's public stream-json/control protocol.
// One Vek run owns one CLI process and one prompt. Follow-ups use --resume.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const error = message => new Error(message);
const stamp = () => new Date().toISOString();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const bounded = (value, limit = 4096) => String(value ?? '').slice(0, limit);

function claudeLaunch({ args, model, resumeId, attachments }) {
  if (resumeId && !uuid(resumeId)) throw error('Claude resume id is invalid');
  // Preflight before a subprocess is launched; copying an attachment does not
  // silently authorize an unbounded protocol frame or a lossy text truncation.
  let bytes = 0;
  const blocks = attachments.map(file => {
    const data = fs.readFileSync(file.storedPath);
    bytes += data.length;
    if (bytes > 24 * 1024 * 1024) throw error('Claude attachments exceed the 24 MiB combined input limit');
    if (file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf') return {
      type: file.mimeType === 'application/pdf' ? 'document' : 'image',
      source: { type: 'base64', media_type: file.mimeType, data: data.toString('base64') },
    };
    return { type: 'text', text: `Attachment ${JSON.stringify(file.name)} (${file.mimeType}):\n${new TextDecoder('utf-8', { fatal: true }).decode(data)}` };
  });
  const sessionId = resumeId || randomUUID();
  // Runtime owns these flags. Refuse conflicting configuration rather than
  // allowing --continue or permission bypass to change the selected session.
  const reserved = /^(?:-p|-r|-c|--(?:print|resume|continue|session-id|fork-session|input-format|output-format|verbose|include-partial-messages|permission-mode|permission-prompt-tool|dangerously-skip-permissions|allow-dangerously-skip-permissions|model|setting-sources|settings|mcp-config|strict-mcp-config|allowedTools|allowed-tools|disallowedTools|disallowed-tools|tools))(?:=|$)/;
  if (args.some(arg => reserved.test(arg) || /\{\{?(prompt|model)\}?\}/.test(arg))) throw error('Claude native protocol owns session, prompt, model, tool, settings and permission arguments; use extra argv only for independent CLI options');
  return { sessionId, blocks, args: [...args,
    '--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
    '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    `${resumeId ? '--resume' : '--session-id'}=${sessionId}`, ...(model ? [`--model=${model}`] : []),
  ] };
}

function connectClaude({ child, launch, active, run, thread, project, text, consume, publish, killTree, onSession }) {
  let buffer = '', closed = false, terminal = false, initialized = false, sent = false, sequence = 0;
  const decoder = new StringDecoder('utf8'), pending = new Map(), permissions = new Map(), seen = new Set(), streamed = new Map();
  const timers = new Set();
  const timer = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); id.unref?.(); timers.add(id); return id; };
  const write = value => {
    if (closed || child.stdin.destroyed || child.stdin.writableEnded) throw error('Claude protocol input is closed');
    child.stdin.write(JSON.stringify(value) + '\n');
  };
  const terminate = () => { killTree(child, 'SIGTERM'); timer(() => killTree(child, 'SIGKILL'), 1000); };
  const failure = cause => {
    if (closed || active.finalizing || terminal) return;
    run.error = bounded(cause.message || cause, 8192); terminal = true; terminate();
  };
  const request = data => new Promise((resolve, reject) => {
    const id = `vek-${++sequence}-${randomUUID()}`;
    const timeout = timer(() => { pending.delete(id); reject(error(`Claude control request timed out: ${data.subtype}`)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    try { write({ type: 'control_request', request_id: id, request: data }); }
    catch (cause) { clearTimeout(timeout); pending.delete(id); reject(cause); }
  });
  const response = (id, data, reason) => write({ type: 'control_response', response: reason
    ? { subtype: 'error', request_id: id, error: reason }
    : { subtype: 'success', request_id: id, response: data } });
  const expire = () => { for (const record of permissions.values()) if (record.approval.status === 'pending') record.approval.status = 'expired'; permissions.clear(); };
  const session = id => {
    if (id !== launch.sessionId) throw error('Claude emitted a different session id; this run will not attach to that session');
  };
  const tool = block => {
    if (block.type !== 'tool_use' || typeof block.id !== 'string' || seen.has(`tool:${block.id}`)) return;
    if ((run.toolEvents?.length || 0) >= 200) { run.toolEventsTruncated = true; return; }
    seen.add(`tool:${block.id}`); run.toolEvents ||= [];
    run.toolEvents.push({ id: bounded(block.id, 256), name: bounded(block.name, 256), input: bounded(JSON.stringify(block.input || {})), createdAt: stamp() });
  };
  function event(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw error('Claude emitted an invalid protocol object');
    if (terminal) return;
    if (value.type === 'control_response') {
      const result = value.response, waiting = pending.get(result?.request_id);
      if (!waiting) return;
      clearTimeout(waiting.timeout); pending.delete(result.request_id);
      if (result.subtype === 'success') waiting.resolve(result.response || {});
      else waiting.reject(error(bounded(result.error || 'Claude control request failed')));
      return;
    }
    if (value.type === 'control_cancel_request') {
      for (const [id, record] of permissions) if (record.requestId === value.request_id) { record.approval.status = 'expired'; permissions.delete(id); publish(); }
      return;
    }
    if (value.type === 'control_request') {
      const id = value.request_id, data = value.request;
      if (typeof id !== 'string' || !id || id.length > 256 || seen.has(`request:${id}`)) throw error('Claude control request id is invalid or repeated');
      if (seen.size >= 10000) throw error('Claude event identity limit exceeded');
      seen.add(`request:${id}`);
      if (!sent || data?.subtype !== 'can_use_tool') { response(id, null, 'Unsupported Claude control request'); return; }
      if (typeof data.tool_name !== 'string' || !data.input || typeof data.input !== 'object' || Array.isArray(data.input)) throw error('Claude permission request is malformed');
      if ((run.approvals?.length || 0) >= 64) { response(id, { behavior: 'deny', message: 'Vek per-turn approval limit reached' }); return; }
      const approval = { id: randomUUID(), kind: 'tool', title: bounded(data.title || data.tool_name, 2048),
        command: bounded(JSON.stringify(data.input), 8192), cwd: project.path, toolName: bounded(data.tool_name, 256), status: 'pending', createdAt: stamp() };
      run.approvals ||= []; run.approvals.push(approval);
      permissions.set(approval.id, { requestId: id, input: data.input, approval }); publish(); return;
    }
    if (value.session_id !== undefined) session(value.session_id);
    // Subagent messages belong to their tool invocation. They must not become
    // the parent answer or interfere with its streaming message identity.
    if (value.parent_tool_use_id != null) return;
    if (value.type === 'system' && value.subtype === 'init') {
      session(value.session_id); if (!sent || initialized) throw error('Claude session initialization is premature or repeated');
      initialized = true; run.nativeThreadId = launch.sessionId;
      thread.nativeThreadId = launch.sessionId; onSession(); publish(); return;
    }
    if (value.type === 'stream_event') {
      if (!initialized) throw error('Claude streamed before session initialization');
      const item = value.event || {};
      if (item.type === 'message_start') {
        const id = item.message?.id;
        if (typeof id !== 'string' || streamed.has(id)) throw error('Claude repeated or omitted a message identity');
        if (streamed.size >= 2000) throw error('Claude message limit exceeded');
        streamed.set(id, new Set()); active.claude.messageId = id;
      }
      if (item.type === 'content_block_delta' && item.delta?.type === 'text_delta') {
        const indices = streamed.get(active.claude.messageId);
        if (!indices || !Number.isInteger(item.index) || typeof item.delta.text !== 'string') throw error('Claude text delta is missing its message identity');
        indices.add(item.index); consume('stdout', Buffer.from(item.delta.text));
      }
      return;
    }
    if (value.type === 'assistant') {
      if (!initialized || typeof value.message?.id !== 'string' || !Array.isArray(value.message.content)) throw error('Claude assistant message is malformed');
      const key = `message:${value.message.id}`; if (seen.has(key)) return;
      if (seen.size >= 10000) throw error('Claude event identity limit exceeded'); seen.add(key);
      value.message.content.forEach((block, index) => {
        if (block.type === 'text' && typeof block.text === 'string' && !streamed.get(value.message.id)?.has(index)) consume('stdout', Buffer.from(block.text));
        tool(block);
      }); publish(); return;
    }
    if (value.type === 'result') {
      if (!initialized || !sent) throw error('Claude result arrived without an initialized prompt');
      session(value.session_id);
      if (value.user_message_uuid !== undefined && value.user_message_uuid !== run.nativeUserMessageId) throw error('Claude result belongs to a different user message');
      if (value.subtype !== 'success' || value.is_error === true) run.error = bounded(Array.isArray(value.errors) ? value.errors.join('\n') : value.result || `Claude result: ${value.subtype}`, 8192);
      if (!run.stdout && !run.error && typeof value.result === 'string') consume('stdout', Buffer.from(value.result));
      const usage = value.usage;
      if (usage && ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) {
        run.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, source: 'native-provider-event', scope: 'main-loop-turn' };
        for (const [source, target] of [['cache_read_input_tokens', 'cachedInputTokens'], ['cache_creation_input_tokens', 'cacheCreationInputTokens']]) if (Number.isSafeInteger(usage[source]) && usage[source] >= 0) run.usage[target] = usage[source];
        // The CLI calls this a session cumulative estimate. Never sum it as a
        // per-turn bill, and keep main-loop usage separate from model totals.
        if (Number.isFinite(value.total_cost_usd) && value.total_cost_usd >= 0) run.usage.sessionCostUsd = value.total_cost_usd;
        if (value.modelUsage && typeof value.modelUsage === 'object' && !Array.isArray(value.modelUsage)) {
          run.usage.modelTotals = Object.entries(value.modelUsage).slice(0, 64).map(([model, totals]) => ({ model: bounded(model, 256),
            ...Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'].filter(key => Number.isFinite(totals?.[key]) && totals[key] >= 0).map(key => [key, totals[key]])) }));
        }
      }
      run.nativeResultId = bounded(value.uuid, 256); active.native.completed = true; terminal = true; expire();
      child.stdin.end(); timer(terminate, 1000); publish();
    }
  }
  active.native = { completed: false };
  active.claude = {
    interrupt: () => request({ subtype: 'interrupt' }),
    approve(id, decision) {
      if (terminal || closed || active.stopReason) throw error('Claude turn is no longer accepting approval');
      const record = permissions.get(id); if (!record || record.approval.status !== 'pending') throw error('Claude approval is unavailable or expired');
      response(record.requestId, decision === 'accept' ? { behavior: 'allow', updatedInput: record.input }
        : { behavior: 'deny', message: 'Declined by the Vek user', ...(decision === 'cancel' ? { interrupt: true } : {}) });
      record.approval.status = decision === 'accept' ? 'accepted' : decision === 'decline' ? 'declined' : 'cancelled';
      record.approval.decidedAt = stamp(); permissions.delete(id);
    },
  };
  child.stdout.on('data', chunk => {
    if (terminal) return;
    buffer += decoder.write(chunk);
    try {
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw error('Claude protocol frame exceeds 4 MiB');
        if (line.trim()) event(JSON.parse(line));
        if (terminal) { buffer = ''; break; }
      }
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw error('Claude protocol frame exceeds 4 MiB');
    } catch (cause) { failure(cause); }
  });
  child.on('close', () => {
    closed = true; expire(); for (const id of timers) clearTimeout(id); timers.clear();
    for (const waiting of pending.values()) waiting.reject(error('Claude provider disconnected')); pending.clear();
    if (!terminal && buffer.trim() && !active.stopReason) run.error = 'Claude provider disconnected with an incomplete protocol frame';
  });
  active.native.ready = (async () => {
    await request({ subtype: 'initialize', hooks: null });
    if (active.stopReason || closed) return;
    const messageId = randomUUID(); run.nativeUserMessageId = messageId;
    sent = true;
    write({ type: 'user', uuid: messageId, session_id: launch.sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }, ...launch.blocks] } });
  })();
  active.native.ready.catch(failure);
  return active.claude;
}

module.exports = { claudeLaunch, connectClaude };

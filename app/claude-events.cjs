'use strict';
// Bounded display-only evidence. Never resolves provider paths or executes tools.
const { createHash } = require('node:crypto');
const stamp = () => new Date().toISOString();
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
const text = (value, limit = 4096) => String(value ?? '').slice(0, limit);
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.type === 'text' ? String(block.text || '') : `[${text(block?.type || 'unsupported', 64)} content omitted]`).join('\n');
}
function createClaudeEvents(record, budget = 256 * 1024) {
  const tools = new Map(), children = new Map(), messages = new Set(), tasks = new Map();
  let used = 0;
  function keep(value, limit = 4096) {
    const raw = Buffer.from(text(value, limit)); const available = Math.max(0, budget - used);
    let output = raw.subarray(0, available).toString('utf8');
    while (Buffer.byteLength(output) > available) output = output.slice(0, -1);
    used += Buffer.byteLength(output);
    if (raw.length > available || String(value ?? '').length > limit) record.nativeEventsTruncated = true;
    return output;
  }
  function child(toolId) {
    if (!id(toolId)) return null;
    if (children.has(toolId)) return children.get(toolId);
    if (children.size >= 100) { record.nativeEventsTruncated = true; return null; }
    const value = { id: toolId, status: 'observed', messages: [], createdAt: stamp() };
    record.subagents ||= []; record.subagents.push(value); children.set(toolId, value); return value;
  }
  function tool(toolId, parent = null) {
    if (!id(toolId) || (parent !== null && !id(parent))) return null;
    const key = JSON.stringify([parent, toolId]);
    if (tools.has(key)) return tools.get(key);
    if (tools.size >= 200) { record.toolEventsTruncated = true; return null; }
    const value = { id: toolId, name: 'Unknown tool', status: 'observed', createdAt: stamp(), ...(parent ? { parentToolUseId: parent } : {}) };
    record.toolEvents ||= []; record.toolEvents.push(value); tools.set(key, value); return value;
  }
  function blocks(value) {
    const parent = id(value.parent_tool_use_id), content = value.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const entry = tool(block.id, parent); if (!entry || entry.input !== undefined) continue;
        entry.name = keep(block.name, 256); entry.input = keep(JSON.stringify(block.input || {}));
        if (entry.status === 'observed') entry.status = 'running';
      } else if (block?.type === 'tool_result') {
        const entry = tool(block.tool_use_id, parent); if (!entry || entry.result !== undefined) continue;
        entry.result = keep(contentText(block.content), 16384); entry.status = block.is_error === true ? 'failed' : 'completed'; entry.completedAt = stamp();
      }
    }
  }
  function accept(value) {
    const parent = id(value.parent_tool_use_id);
    if (['assistant', 'user'].includes(value.type)) {
      blocks(value);
      if (parent) {
        const entry = child(parent), body = contentText(value.message?.content);
        const key = createHash('sha256').update(JSON.stringify([parent, value.type, value.message?.id || value.uuid, body])).digest('hex');
        if (entry && body && !messages.has(key)) {
          if (messages.size >= 200) { record.nativeEventsTruncated = true; return; }
          messages.add(key); const saved = keep(body, 16384);
          if (saved) entry.messages.push({ role: value.type, content: saved, createdAt: stamp() });
        }
      }
    }
    if (value.type === 'tool_progress') {
      const entry = tool(value.tool_use_id, parent);
      if (entry) {
        if (entry.name === 'Unknown tool') entry.name = keep(value.tool_name, 256);
        if (Number.isFinite(value.elapsed_time_seconds) && value.elapsed_time_seconds >= 0) entry.elapsedSeconds = Math.min(value.elapsed_time_seconds, 1e9);
        if (entry.status === 'observed') entry.status = 'running';
      }
    }
    if (value.type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(value.subtype) && id(value.task_id)) {
      const prior = tasks.get(value.task_id), runId = id(value.run_id);
      if (prior?.runId && runId && runId < prior.runId) return;
      const entry = child(id(value.tool_use_id) || prior?.id || `task:${value.task_id}`);
      if (!entry) return;
      // A later run of one task may replace counters/status, never its transcript.
      if (prior?.runId && runId && runId > prior.runId) { delete entry.completedAt; entry.status = 'running'; }
      tasks.set(value.task_id, entry); entry.taskId = value.task_id; if (runId) entry.runId = runId;
      if (value.description) entry.description = keep(value.description, 2048);
      if (value.summary) entry.summary = keep(value.summary, 4096);
      if (value.subtype === 'task_started') { if (!entry.completedAt) entry.status = 'running'; }
      if (value.subtype === 'task_notification' && ['completed', 'failed', 'stopped'].includes(value.status)) { entry.status = value.status; entry.completedAt = stamp(); }
      if (value.usage && typeof value.usage === 'object') entry.usage = Object.fromEntries(['total_tokens', 'tool_uses', 'duration_ms'].filter(key => Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0).map(key => [key, value.usage[key]]));
      // output_file is deliberately neither read nor made a clickable file URL.
    }
  }
  function finish(outcome) {
    for (const entry of [...tools.values(), ...children.values()]) if (['running', 'observed'].includes(entry.status)) { entry.status = outcome === 'completed' ? 'unresolved' : 'interrupted'; entry.endReason = outcome === 'completed' ? 'Turn ended without a terminal event for this activity' : `Turn ${text(outcome, 64)}`; }
  }
  return { accept, finish };
}
// Native archive import retains display evidence, never executable capabilities.
function copyClaudeActivity(source) {
  const output = {}; let remaining = 256 * 1024;
  const take = (value, limit) => { const source = String(value ?? ''); let result = source.slice(0, limit); if (source.length > limit || Buffer.byteLength(result) > remaining) output.nativeEventsTruncated = true; while (Buffer.byteLength(result) > remaining) result = result.slice(0, Math.floor(result.length / 2)); remaining -= Buffer.byteLength(result); return result; };
  const status = value => ['completed', 'failed', 'stopped', 'interrupted', 'unresolved'].includes(value) ? value : 'unresolved';
  if (source?.toolEvents !== undefined) {
    if (!Array.isArray(source.toolEvents) || source.toolEvents.length > 200) throw new Error('Imported Claude tool event count is invalid');
    output.toolEvents = source.toolEvents.map(value => {
      if (!value || !id(value.id)) throw new Error('Imported Claude tool identity is invalid');
      const entry = { id: value.id, name: take(value.name, 256), status: status(value.status) };
      for (const key of ['input', 'result', 'endReason']) if (typeof value[key] === 'string') entry[key] = take(value[key], key === 'result' ? 16384 : 4096);
      if (id(value.parentToolUseId)) entry.parentToolUseId = value.parentToolUseId;
      if (Number.isFinite(value.elapsedSeconds) && value.elapsedSeconds >= 0) entry.elapsedSeconds = Math.min(value.elapsedSeconds, 1e9);
      return entry;
    });
  }
  if (source?.subagents !== undefined) {
    if (!Array.isArray(source.subagents) || source.subagents.length > 100) throw new Error('Imported Claude subagent count is invalid');
    let count = 0;
    output.subagents = source.subagents.map(value => {
      if (!value || !id(value.id) || !Array.isArray(value.messages)) throw new Error('Imported Claude subagent is invalid');
      const entry = { id: value.id, status: status(value.status), messages: [] };
      for (const key of ['description', 'summary', 'endReason']) if (typeof value[key] === 'string') entry[key] = take(value[key], 4096);
      for (const message of value.messages) {
        if (++count > 200 || !['assistant', 'user'].includes(message?.role) || typeof message.content !== 'string') throw new Error('Imported Claude subagent transcript is invalid');
        entry.messages.push({ role: message.role, content: take(message.content, 16384) });
      }
      for (const key of ['taskId', 'runId']) if (id(value[key])) entry[key] = value[key];
      if (value.usage && typeof value.usage === 'object') entry.usage = Object.fromEntries(['total_tokens', 'tool_uses', 'duration_ms'].filter(key => Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0).map(key => [key, value.usage[key]]));
      return entry;
    });
  }
  if (remaining <= 0 || source?.nativeEventsTruncated) output.nativeEventsTruncated = true;
  if (source?.toolEventsTruncated) output.toolEventsTruncated = true;
  return output;
}
module.exports = { createClaudeEvents, contentText, copyClaudeActivity };

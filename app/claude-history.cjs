'use strict';
// Explicitly selected JSONL only. No home-directory discovery, path following,
// provider invocation, native resume authority, or imported executable config.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createClaudeEvents } = require('./claude-events.cjs');
const fail = message => new Error(message);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const main = entry => !entry.isSidechain && !entry.teamName && !entry.isMeta;
function readHistory(filename, label = 'Claude') {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')) throw fail(`Choose an absolute ${label} JSONL file path`);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 32 * 1024 * 1024) throw fail(`${label} history must be a regular file at most 32 MiB`);
    // Bounded even when an external writer grows the selected file during read.
    const bytes = Buffer.alloc(before.size + 1); let length = 0, size;
    while (length < bytes.length && (size = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += size;
    const after = fs.fstatSync(fd);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail(`${label} history changed while reading; choose it again`);
    const data = bytes.subarray(0, length);
    const fingerprint = createHash('sha256').update(data).digest('hex');
    return { data, fingerprint, identity: `${before.dev}:${before.ino}`, sourceName: path.basename(filename) };
  } finally { fs.closeSync(fd); }
}
function parseHistory(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) throw fail('Claude history exceeds 32 MiB');
  let source; try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('Claude history must be valid UTF-8'); }
  const lines = source.split(/\r?\n/); if (lines.length > 20000 + (source.endsWith('\n') ? 1 : 0)) throw fail('Claude history exceeds 20000 lines');
  const entries = [], byId = new Map(), sessionIds = new Set(); let skipped = 0, excluded = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    if (Buffer.byteLength(lines[index]) > 4 * 1024 * 1024) throw fail(`Claude history line ${index + 1} exceeds 4 MiB`);
    let value; try { value = JSON.parse(lines[index]); } catch { throw fail(`Claude history line ${index + 1} is invalid JSON (including incomplete tails)`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`Claude history line ${index + 1} is not an object`);
    if (!['user', 'assistant', 'system', 'progress', 'attachment'].includes(value.type) || !value.uuid) { skipped++; continue; }
    if (!uuid(value.uuid) || (value.parentUuid != null && !uuid(value.parentUuid))) throw fail(`Claude history line ${index + 1} has invalid chain identities`);
    if (!main(value)) { excluded++; continue; }
    if (value.sessionId !== undefined) { if (!uuid(value.sessionId)) throw fail('Claude history session identity is invalid'); sessionIds.add(value.sessionId); }
    if (byId.has(value.uuid)) { if (JSON.stringify(byId.get(value.uuid).value) !== JSON.stringify(value)) throw fail('Claude history has conflicting duplicate message identities'); skipped++; continue; }
    const entry = { value, position: index }; entries.push(entry); byId.set(value.uuid, entry);
  }
  if (sessionIds.size !== 1) throw fail('Choose a history file containing exactly one main Claude session');
  // Validate every main chain once, including unselected branches. Missing links
  // remain explicit boundaries (compaction can legitimately start a new chain).
  const complete = new Set(); let missingParents = 0;
  for (const entry of entries) {
    let current = entry; const visiting = new Set();
    while (current && !complete.has(current.value.uuid)) {
      if (visiting.has(current.value.uuid)) throw fail('Claude history contains a parent cycle'); visiting.add(current.value.uuid);
      const parent = current.value.parentUuid;
      if (parent && !byId.has(parent)) missingParents++;
      current = parent ? byId.get(parent) : null;
    }
    for (const key of visiting) complete.add(key);
  }
  const parents = new Set(entries.map(entry => entry.value.parentUuid).filter(Boolean));
  const branchIds = new Set();
  for (const entry of entries.filter(entry => !parents.has(entry.value.uuid))) {
    let current = entry;
    while (current && !['user', 'assistant'].includes(current.value.type)) current = byId.get(current.value.parentUuid);
    if (current) branchIds.add(current.value.uuid);
  }
  if (branchIds.size > 256) throw fail('Claude history exceeds 256 selectable branches');
  const toolOnly = e => e?.type === 'user' && Array.isArray(e.message?.content) && e.message.content.length && e.message.content.every(block => block?.type === 'tool_result');
  const continuedApiIds = new Set();
  for (const key of branchIds) if (!toolOnly(byId.get(key).value)) {
    let current = byId.get(key);
    while (current) { if (current.value.type === 'assistant' && typeof current.value.message?.id === 'string') continuedApiIds.add(current.value.message.id); current = byId.get(current.value.parentUuid); }
  }
  for (const key of branchIds) { const e = byId.get(key).value; if (toolOnly(e) && continuedApiIds.has(byId.get(e.parentUuid)?.value.message?.id)) branchIds.delete(key); }
  const branches = [...branchIds].map(key => byId.get(key)).sort((a, b) => b.position - a.position).map(({ value }) => ({ id: value.uuid, label: `${value.type}: ${visibleText(value.message?.content).replace(/\s+/g, ' ').slice(0, 100) || '(tool activity)'}` }));
  if (!branches.length || branches.length > 256) throw fail('Claude history must have between 1 and 256 selectable conversation branches');
  return { entries, byId, sessionId: [...sessionIds][0], branches, skipped, excluded, missingParents };
}
function visibleText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => block?.type === 'text' ? String(block.text || '') : ['image', 'document'].includes(block?.type) ? `[${block.type} attachment not imported]` : '').filter(Boolean).join('\n');
}
function selectBranch(parsed, leafId) {
  if (!parsed.branches.some(branch => branch.id === leafId)) throw fail('Choose a listed Claude conversation branch');
  const selected = new Set(), chain = []; let current = parsed.byId.get(leafId);
  while (current) { selected.add(current.value.uuid); chain.unshift(current); current = parsed.byId.get(current.value.parentUuid); }
  // Parallel tool_result entries can be siblings of the continued branch. Only
  // recover results whose tool_use_id was observed on this selected chain and
  // whose parent is an assistant block from the same API message. Never append
  // an arbitrary sibling user prompt or another answer branch.
  const toolIds = new Set(), assistantIds = new Set();
  for (const key of selected) { const e = parsed.byId.get(key).value; if (e.type === 'assistant') { if (e.message?.id) assistantIds.add(e.message.id); for (const block of Array.isArray(e.message?.content) ? e.message.content : []) if (block.type === 'tool_use') toolIds.add(block.id); } }
  for (const entry of parsed.entries) {
    const e = entry.value, content = e.message?.content, parent = parsed.byId.get(e.parentUuid)?.value;
    if (e.type === 'user' && Array.isArray(content) && content.length && content.every(block => block.type === 'tool_result' && toolIds.has(block.tool_use_id)) && parent?.type === 'assistant' && selected.has(parent.uuid) && assistantIds.has(parent.message?.id)) selected.add(e.uuid);
  }
  const chainIds = new Set(chain.map(entry => entry.value.uuid)), extras = new Map();
  for (const entry of parsed.entries) if (selected.has(entry.value.uuid) && !chainIds.has(entry.value.uuid)) { const list = extras.get(entry.value.parentUuid) || []; list.push(entry); extras.set(entry.value.parentUuid, list); }
  const ordered = chain.flatMap(entry => [entry, ...(extras.get(entry.value.uuid) || [])]);
  const messages = [], activity = {}; const collector = createClaudeEvents(activity); let bytes = 0, attachmentsOmitted = 0;
  for (const { value: e } of ordered) {
    if (!['user', 'assistant'].includes(e.type)) continue;
    if (!e.message || (e.message.role && e.message.role !== e.type) || (!Array.isArray(e.message.content) && typeof e.message.content !== 'string')) throw fail('Claude history message content is malformed');
    const body = visibleText(e.message.content); bytes += Buffer.byteLength(body);
    if (bytes > 8 * 1024 * 1024 || Buffer.byteLength(body) > 1024 * 1024) throw fail('Selected Claude branch exceeds display/context limits (1 MiB per message, 8 MiB total)');
    if (Array.isArray(e.message.content)) attachmentsOmitted += e.message.content.filter(block => ['image', 'document'].includes(block?.type)).length;
    if (body) messages.push({ role: e.type, content: body, ...(Number.isFinite(Date.parse(e.timestamp)) ? { createdAt: new Date(e.timestamp).toISOString() } : {}) });
    collector.accept({ type: e.type, message: e.message });
  }
  collector.finish('completed');
  return { messages, activity, attachmentsOmitted, entryCount: selected.size };
}
module.exports = { readHistory, parseHistory, selectBranch };

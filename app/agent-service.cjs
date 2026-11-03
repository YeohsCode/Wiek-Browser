'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { claudeLaunch, connectClaude } = require('./claude-session.cjs');
const {validateClaudeModel}=require('./claude-models.cjs');
const { readHistory, parseHistory, selectBranch } = require('./claude-history.cjs');
const { copyClaudeActivity } = require('./claude-events.cjs');
const { connectAcp, acpAttachments } = require('./acp-session.cjs');
const {connectCodexDiscovery,validateCodexModel} = require('./codex-protocol.cjs');
const {parseCodexHistory,copyCodexReplay} = require('./codex-history.cjs');
const {connectCodexSession}=require('./codex-session.cjs');
const automationRuntime=require('./automation-runtime.cjs');

const now = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const fail = (message, code = 'VEK_AGENT_INVALID_REQUEST') => Object.assign(new Error(message), { error_code: code });
const nonempty = (value, name, limit = 65536) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw fail(`${name} must be non-empty text (at most ${limit} characters)`);
  return value.trim();
};

function cronFields(expression) {
  const parts = nonempty(expression, 'cron', 256).split(/\s+/);
  if (parts.length !== 5) throw fail('Cron requires five fields: minute hour day month weekday');
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return parts.map((part, index) => {
    const [low, high] = bounds[index], values = new Set();
    for (const term of part.split(',')) {
      const match = term.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!match) throw fail('Cron supports numeric fields, *, ranges, lists, and steps');
      const step = Number(match[2] || 1);
      if (!Number.isInteger(step) || step < 1 || step > high - low + 1) throw fail('Invalid cron step');
      const range = match[1] === '*' ? [low, high] : match[1].includes('-') ? match[1].split('-').map(Number) : [Number(match[1]), match[2] ? high : Number(match[1])];
      if (range[0] < low || range[1] > high || range[0] > range[1]) throw fail('Cron field is out of range');
      for (let value = range[0]; value <= range[1]; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return { values, unrestricted: part === '*' };
  });
}

const zoneFormatters = new Map();
function zoneFormatter(value = 'UTC') {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(value)) throw fail('Cron timeZone must be a valid IANA timezone');
  if (zoneFormatters.has(value)) return zoneFormatters.get(value);
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', { timeZone: value, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw fail('Cron timeZone must be a valid IANA timezone'); }
  if (zoneFormatters.size >= 64) zoneFormatters.delete(zoneFormatters.keys().next().value);
  zoneFormatters.set(value, formatter); return formatter;
}
function normalizedTimeZone(value = 'UTC') { return zoneFormatter(value).resolvedOptions().timeZone; }
function wallParts(timestamp, formatter) {
  const values = {};
  for (const item of formatter.formatToParts(new Date(timestamp))) if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(item.type)) values[item.type] = Number(item.value);
  return values;
}
function wallStamp(parts) {
  const date = new Date(0); date.setUTCFullYear(parts.year, parts.month - 1, parts.day); date.setUTCHours(parts.hour || 0, parts.minute || 0, parts.second || 0, 0); return date.getTime();
}
function scheduledMinuteKey(timestamp, timeZone = 'UTC') {
  const zone = normalizedTimeZone(timeZone), parts = wallParts(timestamp, zoneFormatter(zone));
  return `${zone}|${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}
function nextCronAt(expression, after = Date.now(), timeZone = 'UTC') {
  const fields = cronFields(expression), formatter = zoneFormatter(timeZone), timestamp = Number(after);
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime()) || new Date(timestamp).getUTCFullYear() < 1) throw fail('Cron after must be a valid timestamp in a positive calendar year');
  const current = wallParts(timestamp, formatter), firstDay = wallStamp({ year: current.year, month: current.month, day: current.day });
  const hours = [...fields[1].values].sort((a, b) => a - b), minutes = [...fields[0].values].sort((a, b) => a - b);
  // Search calendar dates, not millions of UTC minutes through Intl. Candidate
  // wall minutes are round-tripped through the zone. A gap has no candidate;
  // a fold keeps only the earliest instant, so its second occurrence is never
  // returned even if `after` already falls between the two occurrences.
  for (let day = firstDay, searched = 0; searched < 5 * 366; searched++, day += 86400000) {
    const date = new Date(day);
    if (!Number.isFinite(date.getTime())) break;
    if (!fields[3].values.has(date.getUTCMonth() + 1)) continue;
    const dom = fields[2].values.has(date.getUTCDate()), dow = fields[4].values.has(date.getUTCDay());
    if (!(fields[2].unrestricted ? dow : fields[4].unrestricted ? dom : dom || dow)) continue;
    const offsets = new Set();
    // Include the offset on both sides of nearby IANA transitions, including
    // non-hour shifts and skipped calendar dates. This costs 17 Intl reads per
    // eligible calendar day, rather than one read per elapsed UTC minute.
    for (let hoursAway = -48; hoursAway <= 48; hoursAway += 6) {
      const sample = day + hoursAway * 3600000;
      if (Number.isFinite(new Date(sample).getTime())) offsets.add(wallStamp(wallParts(sample, formatter)) - sample);
    }
    for (const hour of hours) for (const minute of minutes) {
      if (day === firstDay && hour * 60 + minute <= current.hour * 60 + current.minute) continue;
      const wall = day + (hour * 60 + minute) * 60000;
      let earliest = Infinity;
      for (const offset of offsets) {
        const candidate = wall - offset;
        if (wallStamp(wallParts(candidate, formatter)) === wall) earliest = Math.min(earliest, candidate);
      }
      if (earliest > timestamp && Number.isFinite(earliest)) return new Date(earliest).toISOString();
    }
  }
  throw fail('Cron has no matching local date within five years');
}

function executable(command) {
  if (typeof command !== 'string' || !command || command.includes('\0')) return null;
  const candidates = path.isAbsolute(command) ? [command] : command.includes(path.sep) ? [] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

function discoverCodex() {
  // Help is local and does not create a session or make an inference request.
  for (const command of [executable('codex'), '/Applications/Codex.app/Contents/Resources/codex'].filter(Boolean)) {
    if (!executable(command)) continue;
    const probe = spawnSync(command, ['exec', '--help'], { encoding: 'utf8', timeout: 4000, maxBuffer: 128 * 1024, windowsHide: true });
    if (probe.status === 0 && /Run Codex non-interactively/.test(probe.stdout || '') && /--sandbox/.test(probe.stdout || '')) {
      return { id: 'codex', name: 'Codex CLI', command, args: ['exec', '--sandbox', 'read-only', '--color', 'never', '-'], modelArgs: ['--model', '{model}'], models: [], inputMode: 'stdin', enabled: true, available: true, preset: 'codex-exec', verifiedBy: 'local exec --help' };
    }
  }
  return null;
}

function discoverClaude() {
  const command = executable('claude');
  if (!command) return null;
  const probe = spawnSync(command, ['--help'], { encoding: 'utf8', timeout: 4000, maxBuffer: 128 * 1024, windowsHide: true });
  if (probe.status !== 0 || !['--input-format', '--output-format', '--resume'].every(flag => (probe.stdout || '').includes(flag))) return null;
  return { id: 'claude-native', name: 'Claude native session (opt-in)', command, args: [], modelArgs: [], models: [], inputMode: 'stdin', protocol: 'claude-stream-json', enabled: false, verifiedBy: 'local --help; authentication and model execution not checked' };
}

function discoverOpenCode() {
  const command = executable('opencode'); if (!command) return null;
  const probe = spawnSync(command, ['acp', '--help'], { encoding: 'utf8', timeout: 4000, maxBuffer: 128 * 1024, windowsHide: true });
  if (probe.status !== 0 || !/acp|Agent Client Protocol/i.test(probe.stdout || '')) return null;
  return { id: 'opencode-native', name: 'OpenCode ACP session (opt-in)', command, args: ['acp'], inputMode: 'stdin', modelArgs: [], models: [], protocol: 'opencode-acp', enabled: false, verifiedBy: 'local acp --help; no authentication or inference checked' };
}

function createAgentService({ dataDir, onChange = () => {}, runContext, turnCheckpoints, maxConcurrentRuns = 2, maxOutputBytes = 1024 * 1024, autoSchedule = true, discoverProviders = true, recoverLock = true, lockRole = 'foreground' } = {}) {
  if (!dataDir) throw fail('dataDir is required');
  maxConcurrentRuns = Math.max(1, Math.min(16, Number(maxConcurrentRuns) || 2));
  maxOutputBytes = Math.max(128, Math.min(16 * 1024 * 1024, Number(maxOutputBytes) || 1024 * 1024));
  const directory = path.join(path.resolve(dataDir), 'agents');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw fail('Agent data directory must not be a symlink');
  fs.chmodSync(directory, 0o700);
  const statePath = path.join(directory, 'state.json');
  const lockPath = path.join(directory, 'service.lock');
  const lockToken = randomUUID();
  if (fs.existsSync(lockPath)) {
    if (fs.lstatSync(lockPath).isSymbolicLink() || !fs.lstatSync(lockPath).isFile()) throw fail('Agent lock must be a regular file');
    if (!recoverLock) throw fail('Agent data directory is locked; start the browser to recover a stale lock', 'VEK_AGENT_DATA_LOCKED');
    let alive = false;
    try { const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); process.kill(lock.pid, 0); alive = true; } catch (error) { if (error.code === 'EPERM') alive = true; }
    if (alive) throw fail('Another Agent service is using this data directory', 'VEK_AGENT_DATA_LOCKED');
    fs.unlinkSync(lockPath);
  }
  let lock;try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch (error) { if(error.code==='EEXIST')throw fail('Another Agent service is using this data directory','VEK_AGENT_DATA_LOCKED');throw error; }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: lockToken,role:lockRole })); fs.closeSync(lock);
  let state;
  try {
    if (fs.existsSync(statePath)) {
      if (fs.lstatSync(statePath).isSymbolicLink()) throw fail('Agent state must not be a symlink');
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.version !== 1 || !['providers', 'projects', 'threads', 'automations'].every((key) => Array.isArray(state[key]))) throw fail('Unsupported Agent state schema');
      fs.chmodSync(statePath, 0o600);
    } else state = { version: 1, providers: [], projects: [], threads: [], automations: [], proposals: [] };
  } catch (error) { fs.unlinkSync(lockPath); throw error; }
  const running = new Map();
  const waiters = new Set();
  let closed = false;
  let scheduleTimer;
  let lifecycleBlocked=false;
  state.schedulerLifecycle ||= {suspended:false,locked:false,events:[]};
  state.schedulerLifecycle.suspended=false;state.schedulerLifecycle.locked=false;
  const completionQueue=[];let completionWorkers=0;
  const evaluationControllers=new Map(),evaluationTasks=new Set();
  let publishTimer;
  state.proposals ||= [];
  for (const thread of state.threads) {
    thread.archived ||= false; thread.pinned ||= false; thread.notes ||= ''; thread.markers ||= []; thread.revisions ||= [];
    thread.attachments ||= [];
    for(const run of thread.runs||[])if(['pending','running'].includes(run.completionEvaluation?.status)){if(Number.isSafeInteger(run.completionEvaluation?.pid))run.recoveredEvaluationProcess={pid:run.completionEvaluation.pid,observedAt:now(),reason:'Host stopped before evaluator exit was observed'};run.completionEvaluation={...run.completionEvaluation,status:'interrupted',reason:'Browser stopped during stop evaluation; no automatic evaluator replay'};}
  }

  function snapshot() {
    return clone({ ...state, providers: state.providers.map((provider) => ({ ...provider, available: !!executable(provider.command) })), runningCount: running.size, maxConcurrentRuns, recoveryBlocks: recoveryBlocks(), pendingCompletionEvaluations:completionQueue.length+completionWorkers });
  }
  function persist() {
    const temporary = path.join(directory, `.state-${process.pid}-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, statePath);
      try { const directoryFd = fs.openSync(directory, 'r'); try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); } } catch { /* Directory fsync is unavailable on some platforms. */ }
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
  }
  function publish() {
    clearTimeout(publishTimer); publishTimer = undefined;
    persist();
    for (const check of [...waiters]) check();
    try { onChange(snapshot()); } catch { /* An observer cannot stop a provider or corrupt persistence. */ }
  }
  function publishSoon() {
    if (!publishTimer && !closed) { publishTimer = setTimeout(publish, 100); publishTimer.unref?.(); }
  }
  const locate = (type, id) => {
    const found = state[type].find((item) => item.id === id);
    if (!found) throw fail(`${type.slice(0, -1)} not found`, 'VEK_AGENT_NOT_FOUND');
    return found;
  };
  const message = (role, content, runId) => ({ id: randomUUID(), role, content, createdAt: now(), ...(runId ? { runId } : {}) });
  for (const thread of state.threads) {
    let recovered = false;
    for (const run of thread.runs || []) if (run.status === 'running') { for (const item of [...(run.toolEvents || []), ...(run.subagents || [])]) if (['running','observed'].includes(item.status)) { item.status='interrupted'; item.endReason='Browser stopped before activity finalization'; } run.status = 'interrupted'; if(Number.isSafeInteger(run.providerPid))run.recoveredProcess={pid:run.providerPid,observedAt:now(),reason:'Host stopped before provider exit was observed'}; run.phase = 'settled'; run.completedAt = now(); if (run.fileChanges) { run.fileChanges.status = 'interrupted'; run.fileChanges.error = 'Browser stopped before snapshot finalization. No after state was inferred.'; } for (const approval of run.approvals || []) if (approval.status === 'pending') approval.status = 'expired'; recovered = true; }
    if (thread.status === 'discovering') { thread.status = ['idle','completed','failed','stopped','interrupted'].includes(thread.modelDiscovery?.previousStatus) ? thread.modelDiscovery.previousStatus : 'idle'; thread.modelDiscovery = { ...thread.modelDiscovery, status: 'interrupted', error: 'Browser stopped during model discovery; no prompt was sent' }; }
    if (thread.status === 'running' || recovered) {
      thread.status = 'interrupted'; delete thread.activeRunId;
      thread.messages.push(message('system', 'The previous run was interrupted when the browser stopped. It has not been resumed automatically.'));
      thread.updatedAt = now();
    }
  }
  const discovered = discoverProviders ? discoverCodex() : null;
  if (discovered && !state.providers.some((provider) => provider.id === discovered.id)) state.providers.push(discovered);
  if (discovered && !state.providers.some((provider) => provider.id === 'codex-native')) state.providers.push({ ...discovered, id: 'codex-native', name: 'Codex native session (opt-in)', args: ['app-server', '--stdio'], modelArgs: [], protocol: 'codex-app-server', enabled: false });
  const claudeDiscovered = discoverProviders ? discoverClaude() : null;
  if (claudeDiscovered && !state.providers.some(provider => provider.id === claudeDiscovered.id)) state.providers.push(claudeDiscovered);

  const openCodeDiscovered = discoverProviders ? discoverOpenCode() : null;
  if (openCodeDiscovered && !state.providers.some(provider => provider.id === openCodeDiscovered.id)) state.providers.push(openCodeDiscovered);

  function killTree(child, signal) {
    if (!child) return;
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
  }
  const maxAttachmentBytes = 20 * 1024 * 1024, maxAttachments = 10, maxArchiveBytes = 32 * 1024 * 1024;
  const claudePreviews = new Map();
  const codexPreviews = new Map();
  const attachmentsRoot = path.join(directory, 'attachments');
  function attachmentType(name, bytes) {
    const ext = path.extname(name).toLowerCase();
    if (ext === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mimeType: 'image/png', storageExt: '.png' };
    if (['.jpg', '.jpeg'].includes(ext) && bytes[0] === 255 && bytes[1] === 216) return { mimeType: 'image/jpeg', storageExt: '.jpg' };
    if (ext === '.gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return { mimeType: 'image/gif', storageExt: '.gif' };
    if (ext === '.webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return { mimeType: 'image/webp', storageExt: '.webp' };
    if (ext === '.pdf' && bytes.subarray(0, 5).toString() === '%PDF-') return { mimeType: 'application/pdf', storageExt: '.pdf' };
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.svg'].includes(ext)) throw fail('Attachment contents do not match a supported image/PDF type');
    if (bytes.includes(0)) throw fail('Binary attachments must be a supported image or PDF');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('Text attachments must be valid UTF-8'); }
    return { mimeType: ext === '.md' ? 'text/markdown' : ext === '.json' ? 'application/json' : ext === '.csv' ? 'text/csv' : 'text/plain', storageExt: '.txt' };
  }
  function safeAttachmentPath(thread, attachment) {
    if (!/^[a-f0-9-]{36}$/i.test(thread.id) || !/^[a-f0-9-]{36}$/i.test(attachment.id) || !/^\.(png|jpg|gif|webp|pdf|txt)$/.test(attachment.storageExt || '')) throw fail('Attachment path metadata is invalid');
    const folder = path.join(attachmentsRoot, thread.id), file = path.join(folder, attachment.id + attachment.storageExt);
    for (const dir of [attachmentsRoot, folder]) if (fs.lstatSync(dir).isSymbolicLink()) throw fail('Attachment directories must not be symlinks');
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || fs.statSync(file).size > maxAttachmentBytes) throw fail('Stored attachment is unavailable or exceeds its limit');
    return file;
  }
  function writeAttachment(thread, bytes, filename, createdFiles = []) {
    if (bytes.length > maxAttachmentBytes) throw fail('Each attachment must be at most 20 MiB');
    const name = String(filename).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 256) || 'attachment';
    const type = attachmentType(name, bytes);
    if (!/^[a-f0-9-]{36}$/i.test(thread.id)) throw fail('Invalid attachment thread id');
    const folder = path.join(attachmentsRoot, thread.id);
    for (const dir of [attachmentsRoot, folder]) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); if (fs.lstatSync(dir).isSymbolicLink()) throw fail('Attachment directories must not be symlinks'); fs.chmodSync(dir, 0o700); }
    const id = randomUUID(), storedPath = path.join(folder, id + type.storageExt), temporary = path.join(folder, `.attachment-${randomUUID()}.tmp`);
    let fd;
    try { fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, storedPath); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
    createdFiles.push(storedPath);
    return { id, name, ...type, bytes: bytes.length, storedPath, available: true, createdAt: now() };
  }
  function addAttachmentPaths(thread, paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > maxAttachments || paths.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) throw fail('Choose one to ten absolute attachment file paths');
    thread.attachments ||= [];
    if (thread.attachments.filter((item) => !item.detachedAt).length + paths.length > maxAttachments) throw fail('A conversation can have at most ten active attachments');
    const createdFiles = [], added = [];
    try {
      for (const file of paths) {
        const source = fs.realpathSync(file), fd = fs.openSync(source, 'r');
        let bytes;
        try { const before = fs.fstatSync(fd); if (!before.isFile() || before.size > maxAttachmentBytes) throw fail('Each attachment must be a regular file at most 20 MiB'); bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail('Attachment changed while being copied; choose it again'); } finally { fs.closeSync(fd); }
        added.push(writeAttachment(thread, bytes, path.basename(file), createdFiles));
      }
    } catch (error) { for (const file of createdFiles) try { fs.unlinkSync(file); } catch {} throw error; }
    thread.attachments.push(...added); thread.updatedAt = now();
  }
  function selectedAttachments(thread) {
    return (thread.attachments || []).filter((item) => !item.detachedAt && item.available !== false).map((item) => ({ ...item, storedPath: safeAttachmentPath(thread, item) }));
  }
  function copyAttachments(source, target) {
    const files = [], copied = [], mapping = new Map();
    try { for (const attachment of selectedAttachments(source)) { const created = writeAttachment(target, fs.readFileSync(attachment.storedPath), attachment.name, files); copied.push(created); mapping.set(attachment.id, created); } }
    catch (error) { for (const file of files) try { fs.unlinkSync(file); } catch {} throw error; }
    target.attachments = copied;
    for (const message of target.messages) if (message.attachments) message.attachments = message.attachments.map((item) => mapping.get(item.id) || { id: item.id, name: item.name, mimeType: item.mimeType, bytes: item.bytes, available: false });
  }
  function providerContext(thread, project, provider) {
    const context = runContext?.({ thread: clone(thread), project: clone(project), provider: clone(provider) }) || {};
    if (context?.then) throw fail('runContext must be synchronous');
    const contextEnv = context.env || (context.promptPrefix !== undefined ? {} : context);
    if (contextEnv && (typeof contextEnv !== 'object' || Object.entries(contextEnv).some(([key, value]) => !/^(?:VEK|WIEK)_[A-Z0-9_]+$/.test(key) || typeof value !== 'string' || value.includes('\0')))) throw fail('runContext must return only WIEK_* or VEK_* environment strings');
    if (context.promptPrefix !== undefined && (typeof context.promptPrefix !== 'string' || context.promptPrefix.length > 32768)) throw fail('runContext promptPrefix must be text up to 32768 characters');
    require('./brand.cjs').normalizeEnvironment(contextEnv);
    return { context, contextEnv };
  }
  function startModelDiscovery(thread) {
    if (closed || running.has(thread.id)) throw fail('Stop active work before discovering models');
    if (running.size >= maxConcurrentRuns) throw fail('Agent concurrency limit reached');
    const project = locate('projects', thread.projectId), provider = locate('providers', thread.providerId), command = executable(provider.command);
    if (!['opencode-acp','codex-app-server','claude-stream-json'].includes(provider.protocol) || !provider.enabled || !command) throw fail('Choose an enabled native OpenCode, Codex or Claude executable for model discovery');
    if (turnCheckpoints?.locked?.(project.id) || [...running.values()].some(active => active.projectPath === project.path)) throw fail('Project is busy; finish active work before discovering models');
    const { contextEnv } = providerContext(thread, project, provider);
    const binding = createHash('sha256').update(JSON.stringify([provider.protocol, command, provider.args, project.path])).digest('hex');
    if (thread.nativeSessionBinding !== binding) { delete thread.nativeThreadId; delete thread.nativeContextSent; delete thread.nativeCatalog; delete thread.nativeSessionBinding; }
    const previousStatus = thread.status, run = { id: randomUUID(), stdout: '', stderr: '', status: 'discovering' };
    let resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
    const active = { child: null, thread, run, projectPath: project.path, checkpointed: true, done, stopReason: null, discovery: true };
    thread.modelDiscovery = { status: 'running', startedAt: now(), previousStatus }; thread.status = 'discovering'; running.set(thread.id, active);
    const finish = error => {
      if (active.finalizing) return; active.finalizing = true; active.child = null; clearTimeout(active.killTimer);
      if (!active.stopReason && !error && !run.error && !active.native?.completed) run.error = 'Native provider disconnected during model discovery';
      thread.status = previousStatus; thread.modelDiscovery = { ...thread.modelDiscovery, status: active.stopReason ? 'cancelled' : error || run.error || !active.native?.completed ? 'failed' : 'completed', completedAt: now(), ...(error || run.error ? { error: String(error?.message || run.error).slice(0, 8192) } : {}) };
      running.delete(thread.id); publish(); resolveDone(); armScheduler();
    };
    try {
      const claude=provider.protocol==='claude-stream-json'?claudeLaunch({args:provider.args,attachments:[]}):null;
      const child = spawn(command, claude?claude.args:provider.args, { cwd: project.path, env: { ...process.env, ...contextEnv }, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe','pipe','pipe'] }); active.child = child;
      const connect = claude?connectClaude:provider.protocol === 'codex-app-server' ? connectCodexDiscovery : connectAcp;
      connect({ child, ...(claude?{launch:claude}:{}), active, run, thread, project, discoverOnly: true, consume: () => {}, publish: publishSoon, killTree, onSession: () => { thread.nativeSessionBinding = binding; } });
      child.stderr.on('data', chunk => { if (run.stderr.length < 8192) run.stderr += chunk.toString('utf8').slice(0, 8192 - run.stderr.length); });
      child.stdin.on('error', () => {}); child.on('error', error => { run.error = error.message; }); child.on('close', () => finish());
    } catch (error) { finish(error); }
    publish();
  }
  function recoveryBlocks(){return state.threads.flatMap(thread=>(thread.runs||[]).flatMap(run=>[run.recoveredProcess,run.recoveredEvaluationProcess].filter(item=>item&&processAlive(item.pid)).map(item=>({projectId:thread.projectId,threadId:thread.id,runId:run.id,pid:item.pid,reason:'A provider or stop evaluator from an interrupted host may still be running. No signal or replay was sent.'}))));}
  function processAlive(pid){if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
  function startRun(thread, prompt, automationId, automationReservationId) {
    if (closed) throw fail('Agent service is closed');
    automationAccess(thread, automationId);
    if (running.has(thread.id)) throw fail('This thread is already running', 'VEK_AGENT_OVERLAP');
    if (running.size >= maxConcurrentRuns) throw fail('Agent concurrency limit reached', 'VEK_AGENT_CAPACITY');
    prompt = nonempty(prompt, 'prompt');
    const project = locate('projects', thread.projectId);
    if(recoveryBlocks().some(block=>block.projectId===project.id))throw fail('An interrupted provider may still be running in this project; wait for it to exit and refresh recovery status. No automatic replay or force-kill is permitted.','VEK_AGENT_PROJECT_BUSY');
    const checkpointed = project.checkpointsEnabled === true;
    if (turnCheckpoints?.locked?.(project.id)) throw fail('File restore is active in this project', 'VEK_AGENT_PROJECT_BUSY');
    if (checkpointed && !turnCheckpoints) throw fail('Automatic checkpoint support is unavailable');
    if ([...running.values()].some(active => active.projectPath === project.path && (checkpointed || active.checkpointed))) throw fail('A protected turn is already running in this project', 'VEK_AGENT_PROJECT_BUSY');
    const provider = locate('providers', thread.providerId);
    const command = executable(provider.command);
    if (!provider.enabled || !command) throw fail('The selected provider CLI is unavailable or disabled; configure an installed executable', 'VEK_AGENT_PROVIDER_UNAVAILABLE');
    if (!['codex-app-server', 'claude-stream-json', 'opencode-acp'].includes(provider.protocol) && thread.model && !(provider.modelArgs?.length || provider.args.some((arg) => /\{\{?model\}?\}/.test(arg)))) throw fail('Configure the provider modelArgs template before choosing a model');
    if (!fs.statSync(project.path).isDirectory()) throw fail('Project path is not a directory');
    const { context, contextEnv } = providerContext(thread, project, provider);
    const attachments = selectedAttachments(thread);
    const nativeBinding = createHash('sha256').update(JSON.stringify([provider.protocol || 'cli', command, provider.args, project.path])).digest('hex');
    if (thread.nativeSessionBinding !== nativeBinding) { delete thread.nativeThreadId; delete thread.nativeContextSent; delete thread.nativeCatalog; delete thread.nativeSessionBinding; }
    const acp = provider.protocol === 'opencode-acp' ? acpAttachments(attachments) : null;
    const claude = provider.protocol === 'claude-stream-json' ? claudeLaunch({ args: provider.args, model: thread.model||(thread.nativeCatalog?.source==='claude-initialize'?'default':''), resumeId: thread.nativeThreadId, attachments }) : null;
    const run = { id: randomUUID(), status: 'running', startedAt: now(), stdout: '', stderr: '', truncated: false, ...(automationId ? { automationId } : {}), ...(automationReservationId ? { automationReservationId } : {}) };
    const userMessage = message('user', prompt, run.id);
    if (attachments.length) userMessage.attachments = attachments.map(({ id, name, mimeType, bytes, storedPath }) => ({ id, name, mimeType, bytes, storedPath }));
    thread.messages.push(userMessage);
    const history = thread.messages.filter((item) => item.role !== 'system').map((item) => `${item.role.toUpperCase()}:\n${item.content}`).join('\n\n');
    const attachmentContext = attachments.length ? '\n\nUser-selected local attachments (paths are real; their contents have not been assumed read):\n' + attachments.map((item) => `- ${JSON.stringify(item.name)} | ${item.mimeType} | ${item.bytes} bytes | ${JSON.stringify(item.storedPath)}`).join('\n') : '';
    const transcript = (context.promptPrefix ? `${context.promptPrefix}\n\n${history}` : history) + attachmentContext;
    const values = { prompt: transcript, projectPath: project.path, threadId: thread.id, model: thread.model || '' };
    const args = claude ? claude.args : [...provider.args, ...(thread.model ? provider.modelArgs || [] : [])].map((arg) => arg.replace(/\{\{?(prompt|projectPath|threadId|model)\}?\}/g, (_, key) => values[key]));
    thread.runs.push(run); thread.status = 'running'; thread.activeRunId = run.id; thread.updatedAt = now();
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    let child;
    const active = { child:null, projectPath:project.path, checkpointed, run, thread, done, stopReason:null, bytes:0, resolveDone };
    if(automationId){const definition=locate('automations',automationId);run.completionPolicy=clone(definition.completionPolicy||{type:'none'});run.completionPolicyVersion=definition.completionPolicyVersion||1;}
    running.set(thread.id,active);
    run.phase = checkpointed ? 'preparing' : 'executing';
    async function finalize(code,signal,launchError) {
      if(active.finalizing)return;active.finalizing=true;active.child=null;
      clearTimeout(active.killTimer);
      await active.contract?.close();
      if(launchError)run.error=launchError.message;
      if (active.native && !active.native.completed && !active.stopReason && !run.error) run.error = 'Native provider disconnected before turn completed';
      const outcome = active.stopReason || (run.error || (code !== 0 && !active.native?.completed) ? 'failed' : 'completed');
      active.finishClaudeActivity?.(outcome); active.finishNativeActivity?.(outcome);
      run.providerOutcome=outcome;run.phase='finalizing';
      if(checkpointed){publish();try{run.fileChanges=await turnCheckpoints.after({thread:clone(thread),project:clone(project),run:{...clone(run),status:outcome}});}catch(error){run.fileChanges={...run.fileChanges,status:'partial',error:error.message};}}
      run.status=outcome;run.phase='settled';run.completedAt=now();run.exitCode=code;run.signal=signal;
      completeRun(code);
    }
    async function launch() {
    if(automationId){try{active.contract=await automationRuntime.startContract({active:()=>running.get(thread.id)===active&&!active.finalizing&&!active.stopReason&&!closed,onMemory:value=>{const definition=locate('automations',automationId);definition.memory=value;definition.memoryUpdatedAt=now();publish();},onResult:value=>{run.result={...value,reportedAt:now(),unread:false};publish();}});}catch(error){void finalize(null,null,error);return;}}
    if(active.stopReason||closed){void finalize(null,null);return;}
    try { child = spawn(command, args, { cwd: project.path, env: { ...process.env, ...contextEnv, ...(active.contract?.env||{}) }, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { void finalize(null,null,error); return; }
    active.child=child;run.providerPid=child.pid;run.executedAt=now();run.phase='executing';
    const consume = (key, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - active.bytes);
      if (chunk.length > remaining) run.truncated = true;
      if (remaining) {
        let text = chunk.subarray(0, remaining).toString('utf8');
        // Invalid/truncated UTF-8 can expand to replacement characters. Bound
        // the persisted text's actual UTF-8 size, not only the input buffer.
        while (Buffer.byteLength(text) > remaining) text = text.slice(0, -1);
        run[key] += text; active.bytes += Buffer.byteLength(text);
      }
      publishSoon();
    };
    if (acp) {
      connectAcp({ child, active, run, thread, project, text: { full: (context.promptPrefix ? context.promptPrefix + '\n\n' : '') + history, current: (context.promptPrefix ? context.promptPrefix + '\n\n' : '') + prompt }, attachments: acp, consume, publish: publishSoon, killTree, onSession: () => { thread.nativeSessionBinding = nativeBinding; } });
    } else if (claude) {
      const text = thread.nativeThreadId ? `${context.promptPrefix ? context.promptPrefix + '\n\n' : ''}${prompt}` : (context.promptPrefix ? context.promptPrefix + '\n\n' : '') + history;
      connectClaude({ child, launch: claude, active, run, thread, project, text, consume, publish: publishSoon, killTree, onSession: () => { thread.nativeSessionBinding = nativeBinding; } });
    } else if (provider.protocol === 'codex-app-server') {
      connectCodexSession({child,active,run,thread,project,attachments,text:{full:transcript,current:(context.promptPrefix?context.promptPrefix+'\n\n':'')+prompt+attachmentContext},consume,publish:publishSoon,killTree,onSession:()=>{thread.nativeSessionBinding=nativeBinding;}});
    } else child.stdout.on('data', (chunk) => consume('stdout', chunk));
    child.stderr.on('data', (chunk) => consume('stderr', chunk));
    child.stdin.on('error', () => {});
    child.on('error', (error) => { run.error = error.message; });
    child.on('close',(code,signal)=>{void finalize(code,signal);});
    if (!active.native) child.stdin.end(provider.inputMode === 'stdin' ? transcript : undefined);
    publish();
    }
    function completeRun(code) {
      for (const approval of run.approvals || []) if (approval.status === 'pending') approval.status = 'expired';
      if (provider.usageFormat === 'codex-jsonl') {
        for (const line of run.stdout.split('\n')) {
          try { const event = JSON.parse(line); const usage = event.type === 'turn.completed' && event.usage; if (usage && ['input_tokens', 'output_tokens'].every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) run.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, ...(Number.isSafeInteger(usage.cached_input_tokens) && usage.cached_input_tokens >= 0 ? { cachedInputTokens: usage.cached_input_tokens } : {}), source: 'provider-event' }; } catch {}
        }
      }
      thread.status = run.status; thread.updatedAt = now(); delete thread.activeRunId;
      running.delete(thread.id);
      const automation = state.automations.find((item) => item.id === run.automationId && item.lastRunId === run.id);
      if (automation) {
        automation.lastOutcome = run.status; automation.updatedAt = now(); if (run.error) automation.lastError = run.error;
        automation.consecutiveFailures=run.status==='failed'?(automation.consecutiveFailures||0)+1:run.status==='completed'?0:(automation.consecutiveFailures||0);
        run.result={...(run.result||{}),decision:run.status==='completed'?(run.result?.decision||'notify'):'notify',unread:run.status!=='completed'||run.result?.decision!=='silent',summary:run.result?.summary||((run.status==='completed')?'Run completed without a structured result':run.error||'Run '+run.status)};
        automation.lastResult=clone(run.result);
        if(automation.stopAfterConsecutiveFailures&&automation.consecutiveFailures>=automation.stopAfterConsecutiveFailures){automation.status='paused';automation.stopReason='Consecutive failure limit reached';}
        if(automation.status==='active'&&automation.maxRuns&&(automation.runCount||0)>=automation.maxRuns){automation.status='completed';automation.nextRunAt=null;automation.stopReason='Run limit reached';}
        if(run.status==='completed'&&run.completionPolicy?.type==='ai-evaluated')queueCompletion(automation,thread,run);

        if (automation.stopOnFailure && run.status === 'failed') { automation.status = 'paused'; automation.stopReason = 'Provider run failed'; }
      }
      if (run.stdout) thread.messages.push(message('assistant', run.stdout, run.id));
      else if (run.status === 'failed') thread.messages.push(message('system', `Provider exited without a reply${run.error ? ': ' + run.error : ` (exit ${code})`}.`, run.id));
      publish(); resolveDone(); armScheduler();
      if (!closed && run.status === 'completed' && thread.pendingFollowUps?.length) {
        const followUp = thread.pendingFollowUps.shift();
        try { startRun(thread, followUp.prompt); } catch (error) { thread.pendingFollowUps.unshift(followUp); thread.messages.push(message('system', `Queued follow-up did not start: ${error.message}`)); publish(); }
      }
    }
    if(checkpointed){
      run.fileChanges={status:'capturing-before'};publish();
      void Promise.resolve().then(async()=>{
        if(active.stopReason||closed)return;
        run.fileChanges=await turnCheckpoints.before({thread:clone(thread),project:clone(project),run:clone(run)});publish();
      }).then(()=>launch()).catch(error=>{run.fileChanges={...run.fileChanges,status:'failed',error:error.message};void finalize(null,null,error);});
    }else launch();
    return run;
  }
  async function stopThread(threadId, reason = 'stopped') {
    const thread = state.threads.find((item) => item.id === threadId);
    if (thread?.pendingFollowUps?.length) { thread.pendingFollowUps = []; thread.updatedAt = now(); }
    const active = running.get(threadId);
    if (!active) return;
    if(active.finalizing){await active.done;return;}
    active.stopReason = reason;
    if(!active.child){await active.done;return;}
    if (active.acp) { try { active.acp.cancel(); } catch { killTree(active.child, 'SIGTERM'); } }
    else if (active.claude) active.claude.interrupt().catch(() => killTree(active.child, 'SIGTERM'));
    else if (active.native?.turnId && active.native.threadId) active.native.request('turn/interrupt', { threadId: active.native.threadId, turnId: active.native.turnId }).catch(() => killTree(active.child, 'SIGTERM'));
    else killTree(active.child, 'SIGTERM');
    active.killTimer = setTimeout(() => killTree(active.child, 'SIGKILL'), 1000); active.killTimer.unref?.();
    await active.done;
  }
  function validateAutomation(input, previous = {}) {
    const kind = input.kind ?? previous.kind;
    if (!['at', 'interval', 'cron', 'heartbeat'].includes(kind)) throw fail('Automation kind must be at, interval, cron, or heartbeat');
    const threadId = input.threadId ?? previous.threadId; locate('threads', threadId);
    const template=locate('threads',threadId);
    if(template.automationOwnerId)throw fail('Choose a user conversation as the automation template');
    const executionMode=input.executionMode ?? previous.executionMode ?? 'heartbeat';
    if(!['heartbeat','standalone','dedicated'].includes(executionMode))throw fail('Execution mode must be heartbeat, standalone or dedicated');
    const closedAppAllowed=input.closedAppAllowed ?? previous.closedAppAllowed ?? false;
    if(typeof closedAppAllowed!=='boolean')throw fail('closedAppAllowed must be a boolean');
    if(closedAppAllowed && locate('providers',template.providerId).protocol && locate('providers',template.providerId).protocol!=='cli')throw fail('The closed-app worker currently supports plain CLI providers only; native approvals require the browser');
    const prompt = nonempty(input.prompt ?? previous.prompt, 'prompt');
    const result = { ...previous, name: nonempty(input.name ?? previous.name ?? 'Automation', 'name', 256), threadId, prompt, kind, executionMode, closedAppAllowed };
    if (kind === 'at') {
      const at = new Date(input.at ?? previous.at);
      if (!Number.isFinite(at.getTime())) throw fail('Automation at must be a valid date');
      result.at = at.toISOString(); delete result.intervalMs;
    } else if (kind === 'cron') {
      result.cron = nonempty(input.cron ?? previous.cron, 'cron', 256); cronFields(result.cron);
      result.timeZone = normalizedTimeZone(input.timeZone ?? previous.timeZone ?? 'UTC');
      result.dstPolicy = 'skip-missing-first-occurrence';
      delete result.at; delete result.intervalMs;
    } else {
      const intervalMs = Number(input.intervalMs ?? previous.intervalMs ?? (kind === 'heartbeat' ? 300000 : undefined));
      if (!Number.isFinite(intervalMs) || intervalMs < 25 || intervalMs > 365 * 86400000) throw fail('intervalMs must be between 25 milliseconds and one year');
      result.intervalMs = intervalMs; delete result.at;
    }
    result.memory = automationRuntime.memory(input.memory ?? previous.memory ?? '');
    result.heartbeatCooldownSeconds=Number(input.heartbeatCooldownSeconds??previous.heartbeatCooldownSeconds??60);
    if(!Number.isFinite(result.heartbeatCooldownSeconds)||result.heartbeatCooldownSeconds<0||result.heartbeatCooldownSeconds>86400)throw fail('Activity cooldown must be between 0 and 86400 seconds');
    result.stopAfterConsecutiveFailures=input.stopAfterConsecutiveFailures??previous.stopAfterConsecutiveFailures??null;
    if(result.stopAfterConsecutiveFailures!==null&&(!Number.isSafeInteger(result.stopAfterConsecutiveFailures)||result.stopAfterConsecutiveFailures<1||result.stopAfterConsecutiveFailures>10000))throw fail('Consecutive failure limit must be null or an integer from 1 to 10000');
    result.completionPolicy=automationRuntime.policy(input.completionPolicy??previous.completionPolicy??{type:'none'});
    result.completionPolicyVersion=(previous.completionPolicyVersion||1)+(JSON.stringify(result.completionPolicy)!==JSON.stringify(previous.completionPolicy||{type:'none'})?1:0);

    result.maxRuns = input.maxRuns === '' || input.maxRuns === null ? null : input.maxRuns ?? previous.maxRuns ?? null;
    if (result.maxRuns !== null && (!Number.isSafeInteger(Number(result.maxRuns)) || Number(result.maxRuns) < 1)) throw fail('maxRuns must be a positive integer');
    if (result.maxRuns !== null) result.maxRuns = Number(result.maxRuns);
    result.stopAfter = input.stopAfter === '' || input.stopAfter === null ? null : input.stopAfter ?? previous.stopAfter ?? null;
    if (result.stopAfter && !Number.isFinite(Date.parse(result.stopAfter))) throw fail('stopAfter must be a valid date');
    if (result.stopAfter) result.stopAfter = new Date(result.stopAfter).toISOString();
    result.stopOnFailure = input.stopOnFailure ?? previous.stopOnFailure ?? false;
    return result;
  }
  function nextTime(automation) { return automation.kind === 'at' ? automation.at : automation.kind === 'cron' ? nextCronAt(automation.cron, Date.now(), automation.timeZone || 'UTC') : new Date(Date.now() + automation.intervalMs).toISOString(); }
  function automationAccess(thread, automationId) {
    if(thread.automationMode==='dedicated' && thread.automationOwnerId && state.automations.some(a=>a.id===thread.automationOwnerId) && automationId!==thread.automationOwnerId)throw fail('This conversation belongs to an automation. Use its Run now/Stop controls, or delete the automation to release it.','VEK_AGENT_AUTOMATION_OWNED');
  }
  function releaseAutomationThreads(automation) {
    for(const thread of state.threads)if(thread.automationOwnerId===automation.id){thread.formerAutomationId=automation.id;delete thread.automationOwnerId;thread.updatedAt=now();}
    delete automation.ownedThreadId;
  }
  async function stopAutomation(automation) {
    for(const thread of state.threads)for(const run of thread.runs||[])if(run.automationId===automation.id)evaluationControllers.get(run.id)?.abort();
    for(let i=completionQueue.length-1;i>=0;i--)if(completionQueue[i].automationId===automation.id){completionQueue[i].run.completionEvaluation={status:'cancelled',reason:'Automation was stopped'};completionQueue.splice(i,1);}
    await Promise.all([...running.values()].filter(active=>active.run.automationId===automation.id).map(active=>stopThread(active.thread.id)));
  }
  function automationThread(automation) {
    const mode=automation.executionMode||'heartbeat',template=locate('threads',automation.threadId);
    if(mode==='heartbeat')return {thread:template,created:false};
    if(mode==='dedicated' && automation.ownedThreadId){const thread=locate('threads',automation.ownedThreadId);if(thread.archived)throw fail('The dedicated conversation is archived; unarchive it before running this automation');if(thread.automationOwnerId!==automation.id||thread.automationMode!=='dedicated')throw fail('Dedicated conversation ownership changed; edit the automation to choose a new template');return {thread,created:false};}
    const thread=newThread(template.projectId,template.providerId,`${automation.name} · ${mode==='dedicated'?'dedicated':'run '+((automation.runCount||0)+1)}`,{automationOwnerId:automation.id,automationMode:mode,automationTemplateId:template.id,...(template.model?{model:template.model}:{}),...(template.reasoningEffort?{reasoningEffort:template.reasoningEffort}:{})});
    state.threads.push(thread);if(mode==='dedicated')automation.ownedThreadId=thread.id;return {thread,created:true};
  }
  function runAutomation(automation, scheduled) {
    const timestamp = Date.now();
    if ((automation.maxRuns && (automation.runCount || 0) >= automation.maxRuns) || (automation.stopAfter && timestamp >= Date.parse(automation.stopAfter))) {
      automation.status = 'completed'; automation.nextRunAt = null; automation.stopReason = automation.maxRuns && (automation.runCount || 0) >= automation.maxRuns ? 'Run limit reached' : 'Stop date reached'; return;
    }
    const deferredScheduledFor=automation.deferred?.scheduledFor;
    const block=automationEligibility(automation,timestamp,scheduled);
    if(block){
      if(scheduled){const scheduledFor=deferredScheduledFor||automation.nextRunAt,deadline=Date.parse(scheduledFor)+600000;if(timestamp<deadline){automation.deferred={scheduledFor,reason:block,until:new Date(Math.min(timestamp+15000,deadline)).toISOString(),deadline:new Date(deadline).toISOString()};automation.lastOutcome='deferred';automation.updatedAt=now();return;}automation.lastOutcome='skipped-defer-expired';automation.lastError=block;delete automation.deferred;advanceSchedule(automation,timestamp,scheduledFor);automation.updatedAt=now();return;}
      automation.lastOutcome=block.includes('capacity')?'skipped-capacity':'skipped-overlap';automation.lastError=block;automation.updatedAt=now();return;
    }
    delete automation.deferred;
    automation.lastRunAt = new Date(timestamp).toISOString();
    let reservationId;
    if (scheduled) {
      const scheduledFor = deferredScheduledFor||automation.nextRunAt;
      const minuteKey = automation.kind === 'cron' ? scheduledMinuteKey(Date.parse(scheduledFor), automation.timeZone || 'UTC') : null;
      // Advance and persist before spawning. Previously startRun published the
      // still-due nextRunAt, leaving a crash window that replayed a scheduled
      // command on restart. Reservations deliberately do not auto-retry.
      if (automation.kind === 'at') { automation.status = 'completed'; automation.nextRunAt = null; }
      else if (automation.kind === 'cron') {
        try { automation.nextRunAt = nextCronAt(automation.cron, timestamp, automation.timeZone || 'UTC'); delete automation.lastScheduleError; }
        catch (error) {
          // The due occurrence remains valid even if the next one is outside
          // the bounded search window (for example the 2100 leap-year gap).
          // Run this occurrence once and pause future scheduling explicitly.
          automation.status = 'paused'; automation.nextRunAt = null; automation.lastScheduleError = error.message; automation.stopReason = 'Cannot calculate next cron occurrence';
        }
      }
      else { const previous = Date.parse(scheduledFor) || timestamp; automation.nextRunAt = new Date(previous + Math.max(1, Math.floor((timestamp - previous) / automation.intervalMs) + 1) * automation.intervalMs).toISOString(); }
      if (minuteKey && automation.lastScheduledMinute === minuteKey) { automation.lastOutcome = 'skipped-duplicate-minute'; automation.updatedAt = now(); return; }
      if (minuteKey) automation.lastScheduledMinute = minuteKey;
      automation.lastScheduledFor = scheduledFor; automation.lastReservationId = reservationId = randomUUID(); automation.lastOutcome = 'reserved'; automation.updatedAt = now(); publish();
    }
    const envelope='This message is an automation-dispatched turn. Only this active turn can update its automation memory or report notify/silent using POST /memory {memory} or POST /result {decision,title?,summary?} at VEK_AUTOMATION_URL with Authorization: Bearer VEK_AUTOMATION_TOKEN. Tokens are environment values; never print or store them. These privileges end with this turn; a later manual follow-up is not an automation run.';
    const prompt = `${automation.prompt}\n\n${envelope}`+(automation.memory?`\n\nAutomation memory (local notes):\n${automationRuntime.utf8Tail(automation.memory)}`:'');
    let target;
    try {
      if([...running.values()].some(active=>active.run.automationId===automation.id))throw fail('This automation already has an active run','VEK_AGENT_OVERLAP');
      target=automationThread(automation);
      const run = startRun(target.thread, prompt, automation.id, reservationId);
      automation.runCount = (automation.runCount || 0) + 1; automation.lastOutcome = 'started'; automation.lastRunId = run.id;automation.lastRunThreadId=target.thread.id; delete automation.lastError;
    }
    catch (error) {
      if(target?.created && !target.thread.runs.length){state.threads=state.threads.filter(t=>t.id!==target.thread.id);if(automation.ownedThreadId===target.thread.id)delete automation.ownedThreadId;}
      automation.lastOutcome = ['VEK_AGENT_OVERLAP','VEK_AGENT_PROJECT_BUSY'].includes(error.error_code) ? 'skipped-overlap' : error.error_code === 'VEK_AGENT_CAPACITY' ? 'skipped-capacity' : 'failed'; automation.lastError = error.message; if (automation.lastOutcome === 'failed' && automation.stopOnFailure) { automation.status = 'paused'; automation.stopReason = 'Provider run failed'; }
    }
    automation.updatedAt = now();
  }
  function advanceSchedule(automation,timestamp,scheduledFor){
    if(automation.kind==='at'){automation.status='completed';automation.nextRunAt=null;}
    else if(automation.kind==='cron'){try{automation.nextRunAt=nextCronAt(automation.cron,timestamp,automation.timeZone||'UTC');}catch(error){automation.status='paused';automation.nextRunAt=null;automation.lastScheduleError=error.message;}}
    else{const previous=Date.parse(scheduledFor)||timestamp;automation.nextRunAt=new Date(previous+Math.max(1,Math.floor((timestamp-previous)/automation.intervalMs)+1)*automation.intervalMs).toISOString();}
  }
  function automationEligibility(automation,timestamp,scheduled){
    if(lifecycleBlocked)return 'The OS session is suspended or locked';
    if([...running.values()].some(active=>active.run.automationId===automation.id))return 'This automation has an active run';
    if(running.size>=maxConcurrentRuns)return 'Agent capacity is busy';
    let template=locate('threads',automation.threadId),thread=(automation.executionMode||'heartbeat')==='heartbeat'?template:automation.executionMode==='dedicated'&&automation.ownedThreadId?state.threads.find(t=>t.id===automation.ownedThreadId):null;
    if(recoveryBlocks().some(block=>block.projectId===template.projectId))return 'An interrupted provider may still be running';
    if(turnCheckpoints?.locked?.(template.projectId))return 'File restore is active in this project';
    if([...running.values()].some(active=>active.projectPath===locate('projects',template.projectId).path&&(active.checkpointed||locate('projects',template.projectId).checkpointsEnabled)))return 'A protected project turn is running';
    if(!thread)return null;
    const run=thread.runs?.at(-1);
    if(run?.approvals?.some(item=>item.status==='pending'))return 'Target conversation has a pending approval';
    if(run?.userInputs?.some(item=>item.status==='pending')||thread.hasPendingUserInput)return 'Target conversation has pending user input';
    if(running.has(thread.id)||['running','discovering'].includes(thread.status))return 'Target conversation has an active turn';
    if(run?.completionEvaluation?.status==='pending'||run?.completionEvaluation?.status==='running')return 'Target conversation has a pending stop evaluation';
    if(scheduled&&run?.automationId!==automation.id&&run?.completedAt&&timestamp-Date.parse(run.completedAt)<(automation.heartbeatCooldownSeconds??60)*1000)return 'Target conversation is inside its activity cooldown';
    return null;
  }
  function queueCompletion(automation,thread,run){
    if(completionQueue.length>=100){run.completionEvaluation={status:'failed',reason:'Stop evaluation queue is full'};run.result={...(run.result||{}),decision:'notify',unread:true};automation.lastResult=clone(run.result);return;}
    run.completionEvaluation={status:'pending',policyVersion:run.completionPolicyVersion};completionQueue.push({automationId:automation.id,threadId:thread.id,run});drainCompletions();
  }
  function drainCompletions(){
    while(!closed&&completionWorkers<2&&completionQueue.length){const job=completionQueue.shift(),controller=new AbortController();completionWorkers++;evaluationControllers.set(job.run.id,controller);job.run.completionEvaluation={status:'running',policyVersion:job.run.completionPolicyVersion};
      const thread=state.threads.find(t=>t.id===job.threadId),project=state.projects.find(p=>p.id===thread?.projectId);
      const task=Promise.resolve().then(()=>automationRuntime.evaluate({policy:job.run.completionPolicy,run:clone(job.run),projectPath:project?.path,signal:controller.signal,onStart:pid=>{job.run.completionEvaluation.pid=pid;publish();}})).then(result=>{
        const definition=state.automations.find(a=>a.id===job.automationId);job.run.completionEvaluation={...result,policyVersion:job.run.completionPolicyVersion,evaluatedAt:now()};
        if(definition&&definition.completionPolicyVersion===job.run.completionPolicyVersion&&JSON.stringify(definition.completionPolicy)===JSON.stringify(job.run.completionPolicy)&&result.status==='completed'&&result.matched){definition.status='completed';definition.nextRunAt=null;delete definition.deferred;definition.stopReason='Stop condition matched: '+result.reason;}
        else if(result.status==='completed'&&result.matched)job.run.completionEvaluation.stalePolicy=true;
        if(result.status==='failed'){job.run.result={...(job.run.result||{}),decision:'notify',unread:true};if(definition?.lastRunId===job.run.id)definition.lastResult=clone(job.run.result);}
      }).catch(()=>{job.run.completionEvaluation={status:'failed',reason:'Stop evaluation failed'};}).finally(()=>{evaluationControllers.delete(job.run.id);completionWorkers--;evaluationTasks.delete(task);publish();armScheduler();drainCompletions();});evaluationTasks.add(task);
    }
  }
  async function lifecycle(event){
    if(!['suspend','resume','lock-screen','unlock-screen','session-resigned','session-active'].includes(event))throw fail('Unknown scheduler lifecycle event');
    state.schedulerLifecycle.events.push({event,at:now()});state.schedulerLifecycle.events=state.schedulerLifecycle.events.slice(-32);
    if(event==='suspend'||event==='resume')state.schedulerLifecycle.suspended=event==='suspend';
    if(['lock-screen','unlock-screen','session-resigned','session-active'].includes(event))state.schedulerLifecycle.locked=['lock-screen','session-resigned'].includes(event);
    lifecycleBlocked=state.schedulerLifecycle.suspended||state.schedulerLifecycle.locked;
    if(lifecycleBlocked){clearTimeout(scheduleTimer);await Promise.all([...running.values()].filter(active=>active.run.automationId).map(active=>stopThread(active.thread.id,'interrupted')));for(const controller of evaluationControllers.values())controller.abort();}
    else runDueOnce();publish();armScheduler();return snapshot();
  }
  function armScheduler() {
    clearTimeout(scheduleTimer); scheduleTimer = undefined;
    if (closed || !autoSchedule || lifecycleBlocked) return;
    const due = state.automations.filter((automation) => automation.status === 'active' && automation.nextRunAt);
    if (!due.length) return;
    const wait = Math.max(1, Math.min(2147483647, Math.min(...due.map((automation) => Date.parse(automation.deferred?.until||automation.nextRunAt))) - Date.now()));
    scheduleTimer = setTimeout(() => {
      if (closed) return;
      for (const automation of state.automations) if (automation.status === 'active' && automation.nextRunAt && Date.parse(automation.deferred?.until||automation.nextRunAt) <= Date.now()) runAutomation(automation, true);
      publish(); armScheduler();
    }, wait);
    scheduleTimer.unref?.();
  }

  function runDueOnce({accept=()=>true,through=Date.now()}={}) {
    if(closed)throw fail('Agent service is closed');
    const attempted=[],skipped=[];
    for(const automation of state.automations)if(automation.status==='active'&&automation.nextRunAt&&Date.parse(automation.deferred?.until||automation.nextRunAt)<=through){
      const reason=accept(clone(automation),clone(locate('threads',automation.threadId)));
      if(reason!==true){skipped.push({automationId:automation.id,reason:typeof reason==='string'?reason:'not-selected'});continue;}
      runAutomation(automation,true);attempted.push({automationId:automation.id,outcome:automation.lastOutcome,runId:automation.lastRunId||null,threadId:automation.lastRunThreadId||null});
    }
    publish();return {attempted,skipped};
  }
  function newThread(projectId, providerId, title, extra = {}) {
    locate('projects', projectId); locate('providers', providerId);
    return { id: randomUUID(), projectId, providerId, title: nonempty(title || 'New thread', 'title', 256), status: 'idle', createdAt: now(), updatedAt: now(), messages: [], runs: [], attachments: [], archived: false, pinned: false, notes: '', markers: [], revisions: [], ...extra };
  }
  function editable(thread) { automationAccess(thread);if (running.has(thread.id)) throw fail('Stop the current run before changing its transcript', 'VEK_AGENT_OVERLAP'); }
  function revise(thread, kind, messages) {
    thread.revisions ||= [];
    thread.revisions.push({ id: randomUUID(), kind, createdAt: now(), messages: clone(thread.messages) });
    thread.messages = messages; thread.status = 'idle'; thread.updatedAt = now(); delete thread.nativeThreadId; delete thread.nativeContextSent; delete thread.nativeCatalog; delete thread.nativeSessionBinding;
  }
  function importBundle(data) {
    if (running.size) throw fail('Stop Agent runs before importing a transcript archive');
    if (typeof data === 'string') {
      if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw fail('Agent import exceeds 32 MiB');
      try { data = JSON.parse(data); } catch { throw fail('Agent import is not valid JSON'); }
    }
    if (!data || data.format !== 'vek-agent-export' || data.version !== 1 || !['projects', 'providers', 'threads', 'automations'].every((key) => Array.isArray(data[key]) && data[key].length <= 10000)) throw fail('Unsupported native Agent archive format');
    if (Buffer.byteLength(JSON.stringify(data)) > 32 * 1024 * 1024) throw fail('Agent import exceeds 32 MiB');
    const previous = state, importedFiles = [];
    state = clone(state);
    try {
      const projectIds = new Map(), providerIds = new Map(), threadIds = new Map();
      for (const item of data.projects) {
        if (!item || !path.isAbsolute(nonempty(item.path, 'project path', 4096))) throw fail('Imported project paths must be absolute');
        const project = { id: randomUUID(), name: nonempty(item.name, 'project name', 256), path: item.path, createdAt: now() };
        projectIds.set(item.id, project.id); state.projects.push(project);
      }
      for (const item of data.providers) {
        if (!item || !Array.isArray(item.args) || item.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || !['stdin', 'argv'].includes(item.inputMode)) throw fail('Invalid imported provider');
        if (item.models && (!Array.isArray(item.models) || item.models.some((model) => typeof model !== 'string' || model.length > 256))) throw fail('Invalid imported model catalogue');
        if (item.modelArgs && (!Array.isArray(item.modelArgs) || item.modelArgs.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) throw fail('Invalid imported model arguments');
        const provider = { id: randomUUID(), name: nonempty(item.name, 'provider name', 256), command: nonempty(item.command, 'provider command', 4096), args: [...item.args], inputMode: item.inputMode, enabled: false, models: [...(item.models || [])], modelArgs: [...(item.modelArgs || [])], ...(item.usageFormat === 'codex-jsonl' ? { usageFormat: item.usageFormat } : {}), ...(['codex-app-server', 'claude-stream-json', 'opencode-acp'].includes(item.protocol) ? { protocol: item.protocol } : {}) };
        // Imported executable configurations are inert until a user reviews and
        // enables them; no imported environment or extra provider fields apply.
        providerIds.set(item.id, provider.id); state.providers.push(provider);
      }
      for (const item of data.threads) {
        if (!item || !Array.isArray(item.messages) || !Array.isArray(item.runs) || !projectIds.has(item.projectId) || !providerIds.has(item.providerId)) throw fail('Invalid imported thread references');
        const messageIds = new Map();
        const messages = item.messages.map((entry) => {
          if (!entry || !['user', 'assistant', 'system'].includes(entry.role) || typeof entry.content !== 'string' || entry.content.length > 2 * 1024 * 1024) throw fail('Invalid imported message');
          const created = message(entry.role, entry.content); messageIds.set(entry.id, created.id); return created;
        });
        const runs = item.runs.map((run) => {
          if (!run || typeof run.stdout !== 'string' || typeof run.stderr !== 'string') throw fail('Invalid imported run output');
          return { ...copyClaudeActivity(run), id: randomUUID(), status: ['completed', 'failed', 'stopped', 'interrupted'].includes(run.status) ? run.status : 'interrupted', startedAt: String(run.startedAt || now()).slice(0, 64), completedAt: String(run.completedAt || now()).slice(0, 64), stdout: run.stdout.slice(0, maxOutputBytes), stderr: run.stderr.slice(0, maxOutputBytes), exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null, truncated: !!run.truncated };
        });
        const markers = (Array.isArray(item.markers) ? item.markers : []).map((marker) => ({ id: randomUUID(), label: nonempty(marker.label, 'marker', 256), ...(messageIds.has(marker.messageId) ? { messageId: messageIds.get(marker.messageId) } : {}), createdAt: now() }));
        const revisions = (Array.isArray(item.revisions) ? item.revisions : []).map((revision) => ({ id: randomUUID(), kind: String(revision.kind || 'import').slice(0, 64), createdAt: now(), messages: (Array.isArray(revision.messages) ? revision.messages : []).map((entry) => { if (!['user', 'assistant', 'system'].includes(entry.role) || typeof entry.content !== 'string') throw fail('Invalid revision message'); return message(entry.role, entry.content); }) }));
        const thread = newThread(projectIds.get(item.projectId), providerIds.get(item.providerId), item.title, { messages, runs, markers, revisions, status: item.status === 'running' ? 'interrupted' : 'idle', notes: String(item.notes || '').slice(0, 65536), archived: !!item.archived, pinned: !!item.pinned, ...(typeof item.model === 'string' ? { model: item.model.slice(0, 256) } : {}), ...(item.goal?.text ? { goal: { text: String(item.goal.text).slice(0, 65536), status: item.goal.status === 'complete' ? 'complete' : 'active' } } : {}) });
        if (item.codexHistory) {
          const origin=item.codexHistory;
          if(typeof origin.sourceName!=='string'||!/^[a-f0-9]{64}$/.test(origin.sha256)||typeof origin.sessionId!=='string'||origin.sessionId.length>256)throw fail('Invalid imported Codex history provenance');
          thread.codexHistory={sourceName:origin.sourceName.slice(0,256),sha256:origin.sha256,sessionId:origin.sessionId,importedAt:now(),...(origin.replay?{replay:copyCodexReplay(origin.replay)}:{}),activity:copyClaudeActivity(origin.activity)};
        }
        if (item.claudeHistory) {
          const origin = item.claudeHistory;
          if (typeof origin.sourceName !== 'string' || !/^[a-f0-9]{64}$/.test(origin.sha256) || typeof origin.sessionId !== 'string' || origin.sessionId.length > 256) throw fail('Invalid imported Claude history provenance');
          thread.claudeHistory = { sourceName: origin.sourceName.slice(0, 256), sha256: origin.sha256, sessionId: origin.sessionId, ...(typeof origin.leafId === 'string' ? { leafId: origin.leafId.slice(0, 256) } : {}), importedAt: now(), activity: copyClaudeActivity(origin.activity) };
        }
        const attachmentIds = new Map();
        if (item.attachments !== undefined && (!Array.isArray(item.attachments) || item.attachments.length > 100 || item.attachments.filter((attachment) => !attachment.detachedAt).length > maxAttachments)) throw fail('Imported attachment count exceeds its limits');
        for (const attachment of item.attachments || []) {
          if (!attachment || typeof attachment.name !== 'string' || !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 0 || attachment.bytes > maxAttachmentBytes) throw fail('Invalid imported attachment metadata or size');
          let created;
          if (attachment.available === false && attachment.inlineBase64 === undefined) created = { id: randomUUID(), name: attachment.name.slice(0, 256), mimeType: String(attachment.mimeType || 'application/octet-stream').slice(0, 100), bytes: attachment.bytes, available: false, createdAt: now() };
          else {
            if (typeof attachment.inlineBase64 !== 'string' || attachment.inlineBase64.length > Math.ceil(maxAttachmentBytes / 3) * 4 + 4 || attachment.inlineBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.inlineBase64)) throw fail('Imported attachments require validated inline data, never an external storedPath');
            const bytes = Buffer.from(attachment.inlineBase64, 'base64');
            if (bytes.length !== attachment.bytes) throw fail('Imported attachment size does not match its data');
            created = writeAttachment(thread, bytes, attachment.name, importedFiles);
          }
          if (attachment.detachedAt) created.detachedAt = now();
          attachmentIds.set(attachment.id, created); thread.attachments.push(created);
        }
        for (let index = 0; index < messages.length; index++) if (Array.isArray(item.messages[index].attachments)) messages[index].attachments = item.messages[index].attachments.map((attachment) => attachmentIds.get(attachment.id)).filter(Boolean).map(({ id, name, mimeType, bytes, storedPath, available }) => ({ id, name, mimeType, bytes, storedPath, available }));
        threadIds.set(item.id, thread.id); state.threads.push(thread);
      }
      for (const item of data.threads) {
        const thread = locate('threads', threadIds.get(item.id));
        if (threadIds.has(item.parentThreadId)) thread.parentThreadId = threadIds.get(item.parentThreadId);
        if (threadIds.has(item.sourceThreadId)) thread.sourceThreadId = threadIds.get(item.sourceThreadId);
        if (['fork', 'sidechat'].includes(item.kind)) thread.kind = item.kind;
      }
      for (const item of data.automations) {
        if (!item || !threadIds.has(item.threadId)) throw fail('Invalid imported automation thread');
        const automation = validateAutomation({ ...item, threadId: threadIds.get(item.threadId),closedAppAllowed:false,completionPolicy:{type:'none'} });
        state.automations.push({ ...automation, id: randomUUID(), status: 'paused', nextRunAt: nextTime(automation), createdAt: now(), updatedAt: now(), runCount: 0 });
      }
      if (Array.isArray(data.proposals)) for (const proposal of data.proposals) {
        if (!threadIds.has(proposal.threadId)) throw fail('Invalid imported proposal thread');
        state.proposals.push({ id: randomUUID(), threadId: threadIds.get(proposal.threadId), title: nonempty(proposal.title, 'proposal title', 256), prompt: nonempty(proposal.prompt, 'proposal prompt'), source: 'imported', status: 'pending', createdAt: now() });
      }
    } catch (error) { state = previous; for (const file of importedFiles) try { fs.unlinkSync(file); } catch {} throw error; }
  }

  async function dispatch(action, payload = {}) {
    if (closed) throw fail('Agent service is closed');
    if (typeof action !== 'string' || !action.startsWith('agents:')) throw fail('Unknown Agent action');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('payload must be an object');
    const id = payload.id ?? payload.threadId ?? payload.automationId ?? payload.projectId ?? payload.providerId;
    switch (action) {
      case 'agents:snapshot': case 'agents:projects:list': case 'agents:providers:list': case 'agents:providers:models': case 'agents:threads:list': case 'agents:automations:list': case 'agents:proposals:list': case 'agents:control:list': return snapshot();
      case 'agents:control:create': {
        const parent = payload.parentThreadId ? locate('threads', payload.parentThreadId) : null;
        const child = newThread(payload.projectId || parent?.projectId, payload.providerId || parent?.providerId, payload.title || 'Child agent', { kind: 'agent', ...(parent ? { parentThreadId: parent.id } : {}), ...(parent?.browserSpaceId !== undefined ? { browserSpaceId: parent.browserSpaceId } : {}), ...(payload.model || parent?.model ? { model: payload.model || parent.model } : {}) });
        if (parent && payload.includeAttachments) copyAttachments(parent, child);
        state.threads.push(child); if (payload.prompt) startRun(child, payload.prompt); break;
      }
      case 'agents:control:read': return clone(locate('threads', id));
      case 'agents:control:wait': {
        const ids = payload.ids || [id];
        if (!Array.isArray(ids) || !ids.length || ids.length > 8) throw fail('wait requires one to eight thread ids');
        for (const target of ids) locate('threads', target);
        const timeoutMs = Math.max(0, Math.min(60000, Number(payload.timeoutMs ?? 30000) || 0));
        return new Promise((resolve) => {
          let timer;
          const finish = (reason) => { clearTimeout(timer); waiters.delete(check); resolve({ ...snapshot(), waitResult: { reason, threads: ids.map((target) => state.threads.find((item) => item.id === target)).filter(Boolean).map(clone) } }); };
          const check = (reason) => { if (reason === 'closed') return finish('closed'); if (ids.some((target) => !running.has(target))) finish('settled'); };
          waiters.add(check); timer = setTimeout(() => finish('timeout'), timeoutMs); check();
        });
      }
      case 'agents:control:steer': {
        const thread = locate('threads', id), prompt = nonempty(payload.prompt, 'follow-up prompt');automationAccess(thread);
        const active = running.get(thread.id);
        if (active?.discovery) throw fail('Wait for model discovery to finish before sending a prompt');
        if (active?.claude || active?.acp) { thread.pendingFollowUps ||= []; thread.pendingFollowUps.push({ id: randomUUID(), prompt, createdAt: now() }); thread.updatedAt = now(); }
        else if (active?.native) { await active.native.ready; await active.native.request('turn/steer', { threadId: active.native.threadId, expectedTurnId: active.native.turnId, input: [{ type: 'text', text: prompt }] }); thread.messages.push(message('user', prompt, active.run.id)); thread.updatedAt = now(); }
        else if (active) { thread.pendingFollowUps ||= []; thread.pendingFollowUps.push({ id: randomUUID(), prompt, createdAt: now() }); thread.updatedAt = now(); }
        else startRun(thread, prompt);
        break;
      }
      case 'agents:control:stop': locate('threads', id); await stopThread(id); break;
      case 'agents:control:handoff': {
        const source = locate('threads', payload.fromThreadId || id);
        const request = nonempty(payload.prompt, 'handoff prompt', 32768);
        if (payload.toThreadId === source.id) throw fail('Handoff requires a different destination thread');
        let destination = payload.toThreadId ? locate('threads', payload.toThreadId) : null;
        if(destination)automationAccess(destination);
        if (destination && running.has(destination.id)) throw fail('Handoff destination is already running', 'VEK_AGENT_OVERLAP');
        await stopThread(source.id);
        if (!destination) { destination = newThread(source.projectId, source.providerId, payload.title || `Handoff: ${source.title}`, { parentThreadId: source.id, kind: 'handoff', model: source.model || '', ...(source.browserSpaceId !== undefined ? { browserSpaceId: source.browserSpaceId } : {}) }); copyAttachments(source, destination); state.threads.push(destination); }
        const context = source.messages.slice(-12).map((item) => `${item.role}: ${item.content}`).join('\n\n').slice(-30000);
        startRun(destination, `Handoff from local conversation ${JSON.stringify(source.title)}. This is copied transcript context, not native session transfer.\n\n${context}\n\nNew request:\n${request}`);
        source.handoffTargetId = destination.id; source.updatedAt = now(); break;
      }
      case 'agents:control:approval': {
        const active = running.get(id), approval = active?.run.approvals?.find((item) => item.id === payload.approvalId && item.status === 'pending');
        if (!active?.native || !approval) throw fail('No verified native approval request is pending; no approval was sent', 'VEK_AGENT_UNSUPPORTED');
        if (!['accept', 'decline', 'cancel'].includes(payload.decision)) throw fail('Approval decision must be accept, decline, or cancel');
        if (active.acp) { active.acp.approve(approval.id, payload.decision); if (payload.decision === 'cancel') await stopThread(id); break; }
        if (active.claude) { active.claude.approve(approval.id, payload.decision); if (payload.decision === 'cancel') await stopThread(id); break; }
        if(active.native.approve){active.native.approve(approval.id,payload.decision);if(payload.decision==='cancel')await stopThread(id);break;}
        active.native.write({ id: active.native.approvalIds.get(approval.id), result: { decision: payload.decision } }); active.native.approvalIds.delete(approval.id);
        approval.status = payload.decision === 'accept' ? 'accepted' : payload.decision === 'decline' ? 'declined' : 'cancelled'; approval.decidedAt = now(); break;
      }
      case 'agents:claude:preview': {
        for (const [key, value] of claudePreviews) if (value.expiresAt < Date.now()) claudePreviews.delete(key);
        if (claudePreviews.size >= 4) throw fail('Close an existing Claude import preview first (maximum four)');
        const source = readHistory(payload.path), parsed = parseHistory(source.data), token = randomUUID();
        const first = selectBranch(parsed, parsed.branches[0].id);
        const expiresAt = Date.now() + 15 * 60 * 1000;
        claudePreviews.set(token, { path: payload.path, fingerprint: source.fingerprint, identity: source.identity, parsed, sourceName: source.sourceName, expiresAt });
        return { ...snapshot(), claudeImportPreview: { token, sourceName: source.sourceName, sha256: source.fingerprint, sessionId: parsed.sessionId, branches: parsed.branches, skippedEntries: parsed.skipped, excludedEntries: parsed.excluded, missingParents: parsed.missingParents, attachmentsOmitted: first.attachmentsOmitted, previewText: first.messages.map(entry => `${entry.role}: ${entry.content}`).join('\n\n').slice(0, 12000), expiresAt: new Date(expiresAt).toISOString() } };
      }
      case 'agents:claude:branch': {
        const preview = claudePreviews.get(payload.token);
        if (!preview || preview.expiresAt < Date.now()) throw fail('Claude import preview is unavailable or expired');
        const chosen = selectBranch(preview.parsed, payload.leafId);
        return { ...snapshot(), claudeBranchPreview: { leafId: payload.leafId, text: chosen.messages.map(entry => `${entry.role}: ${entry.content}`).join('\n\n').slice(0, 12000), attachmentsOmitted: chosen.attachmentsOmitted, messageCount: chosen.messages.length } };
      }
      case 'agents:claude:discard': claudePreviews.delete(payload.token); break;
      case 'agents:codex:preview': {
        for (const [key,value] of codexPreviews) if(value.expiresAt < Date.now()) codexPreviews.delete(key);
        if(codexPreviews.size>=4)throw fail('Close an existing Codex import preview first (maximum four)');
        const source=readHistory(payload.path,'Codex'),parsed=parseCodexHistory(source.data),token=randomUUID(),expiresAt=Date.now()+15*60*1000;
        codexPreviews.set(token,{path:payload.path,...source,data:undefined,parsed,expiresAt});
        return {...snapshot(),codexImportPreview:{token,sourceName:source.sourceName,sha256:source.fingerprint,sessionId:parsed.sessionId,messageCount:parsed.messages.length,replay:parsed.replay,skippedEntries:parsed.skipped,contextEntries:parsed.contextEntries,attachmentsOmitted:parsed.attachmentsOmitted,previewText:parsed.messages.map(e=>`${e.role}: ${e.content}`).join('\n\n').slice(0,12000),expiresAt:new Date(expiresAt).toISOString()}};
      }
      case 'agents:codex:discard': codexPreviews.delete(payload.token); break;
      case 'agents:codex:import': {
        const preview=codexPreviews.get(payload.token);
        if(!preview||preview.expiresAt<Date.now())throw fail('Codex import preview is unavailable or expired; select the file again');
        const source=readHistory(preview.path,'Codex');if(source.identity!==preview.identity||source.fingerprint!==preview.fingerprint)throw fail('Codex history changed since preview; select the file again');
        const chosen=preview.parsed;
        const imported=newThread(payload.projectId,payload.providerId,payload.title||`Codex: ${preview.sourceName}`,{messages:[message('system','Imported Codex visible transcript. Continuing creates a new provider session with copied text; source session IDs, instructions, tools and paths do not grant execution or file recovery authority.'),...chosen.messages.map(e=>({...message(e.role,e.content),...(e.createdAt?{createdAt:e.createdAt}:{})}))]});
        imported.codexHistory={sourceName:preview.sourceName,sha256:preview.fingerprint,sessionId:chosen.sessionId,sourceSessionId:chosen.sourceSessionId,importedAt:now(),skippedEntries:chosen.skipped,contextEntries:chosen.contextEntries,attachmentsOmitted:chosen.attachmentsOmitted,replay:chosen.replay,activity:chosen.activity};
        state.threads.push(imported);codexPreviews.delete(payload.token);publish();return {...snapshot(),importedThreadId:imported.id};
      }
      case 'agents:claude:import': {
        const preview = claudePreviews.get(payload.token);
        if (!preview || preview.expiresAt < Date.now()) throw fail('Claude import preview is unavailable or expired; select the file again');
        const source = readHistory(preview.path);
        if (source.identity !== preview.identity || source.fingerprint !== preview.fingerprint) throw fail('Claude history changed since preview; select the file again');
        const chosen = selectBranch(preview.parsed, payload.leafId);
        const imported = newThread(payload.projectId, payload.providerId, payload.title || `Claude: ${preview.sourceName}`, { messages: [message('system', 'Imported Claude transcript. Continuing starts a new provider session with copied visible text; source tools, attachments and session IDs do not grant execution or file recovery authority.'), ...chosen.messages.map(entry => ({ ...message(entry.role, entry.content), ...(entry.createdAt ? { createdAt: entry.createdAt } : {}) }))] });
        imported.claudeHistory = { sourceName: preview.sourceName, sha256: preview.fingerprint, sessionId: preview.parsed.sessionId, leafId: payload.leafId, importedAt: now(), excludedEntries: preview.parsed.excluded, missingParents: preview.parsed.missingParents, attachmentsOmitted: chosen.attachmentsOmitted, activity: chosen.activity };
        state.threads.push(imported); claudePreviews.delete(payload.token); publish();
        return { ...snapshot(), importedThreadId: imported.id };
      }
      case 'agents:export': {
        let estimatedBytes = 0;
        const threads = state.threads.map((source) => {
          const thread = clone(source); delete thread.nativeThreadId; delete thread.nativeContextSent; delete thread.nativeCatalog; delete thread.nativeSessionBinding;
          thread.attachments = (source.attachments || []).map((attachment) => {
            const { id, name, mimeType, bytes, createdAt, detachedAt } = attachment;
            const metadata = { id, name, mimeType, bytes, createdAt, ...(detachedAt ? { detachedAt } : {}) };
            if (payload.metadataOnly || attachment.available === false) return { ...metadata, available: false };
            estimatedBytes += Math.ceil(bytes / 3) * 4;
            if (estimatedBytes > maxArchiveBytes) throw fail('Native JSON archive exceeds 32 MiB; use metadataOnly export to omit copied file data');
            return { ...metadata, available: true, inlineBase64: fs.readFileSync(safeAttachmentPath(source, attachment)).toString('base64') };
          });
          for (const entry of [...thread.messages, ...(thread.revisions || []).flatMap((revision) => revision.messages || [])]) if (entry.attachments) entry.attachments = entry.attachments.map(({ id, name, mimeType, bytes }) => ({ id, name, mimeType, bytes }));
          return thread;
        });
        const content = JSON.stringify({ format: 'vek-agent-export', version: 1, exportedAt: now(), projects: state.projects, providers: state.providers.map(({ id, name, command, args, inputMode, models, modelArgs, usageFormat, protocol }) => ({ id, name, command, args, inputMode, models, modelArgs, usageFormat, protocol })), threads, automations: state.automations, proposals: state.proposals }, null, 2);
        if (Buffer.byteLength(content) > maxArchiveBytes) throw fail('Native JSON archive exceeds the 32 MiB import/export limit');
        return { ...snapshot(), exportData: { filename: `vek-agent-${new Date().toISOString().slice(0, 10)}.json`, mimeType: 'application/json', content } };
      }
      case 'agents:import': importBundle(payload.data); break;
      case 'agents:projects:create': {
        const projectPath = path.resolve(nonempty(payload.path, 'path', 4096));
        if (!path.isAbsolute(payload.path) || !fs.statSync(projectPath).isDirectory()) throw fail('Project path must be an existing absolute directory');
        const canonicalPath = fs.realpathSync(projectPath);
        const existing = state.projects.find((project) => project.path === canonicalPath);
        if (!existing) state.projects.push({ id: randomUUID(), name: nonempty(payload.name || path.basename(projectPath), 'name', 256), path: canonicalPath, createdAt: now() });
        break;
      }
      case 'agents:projects:checkpoints': {
        const project=locate('projects',id);if(typeof payload.enabled!=='boolean')throw fail('enabled must be boolean');
        if([...running.values()].some(active=>active.projectPath===project.path)||turnCheckpoints?.locked?.(project.id))throw fail('Finish project runs and file restores before changing checkpoint capture','VEK_AGENT_PROJECT_BUSY');
        project.checkpointsEnabled=payload.enabled;break;
      }
      case 'agents:changes:list': case 'agents:changes:diff': case 'agents:changes:preview': case 'agents:changes:restore': {
        if(!turnCheckpoints?.dispatch)throw fail('Turn checkpoint support is unavailable');return turnCheckpoints.dispatch(action,payload,clone(locate('threads',id)));
      }
      case 'agents:projects:delete': locate('projects', id); if (state.threads.some((thread) => thread.projectId === id)) throw fail('Delete the project threads first'); state.projects = state.projects.filter((project) => project.id !== id); break;
      case 'agents:providers:discover': { for (const discovered of [discoverCodex(), discoverClaude(), discoverOpenCode()].filter(Boolean)) if (!state.providers.some(provider => provider.id === discovered.id)) state.providers.push(discovered); break; }
      case 'agents:providers:configure': {
        if (payload.env !== undefined) throw fail('Provider environment overrides are not supported');
        const command = nonempty(payload.command, 'command', 4096);
        if (!Array.isArray(payload.args) || payload.args.length > 128 || payload.args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 65536)) throw fail('Provider args must be an argv string array');
        if (!['stdin', 'argv'].includes(payload.inputMode || 'stdin')) throw fail('inputMode must be stdin or argv');
        if (payload.inputMode === 'argv' && !payload.args.some((arg) => /\{\{?prompt\}?\}/.test(arg))) throw fail('argv inputMode requires a {prompt} placeholder in args');
        const providerId = payload.id || randomUUID();
        if (state.threads.some((thread) => thread.providerId === providerId && running.has(thread.id))) throw fail('Stop provider runs before reconfiguring it');
        if (payload.models !== undefined && (!Array.isArray(payload.models) || payload.models.length > 256 || payload.models.some((model) => typeof model !== 'string' || !model.trim() || model.length > 256))) throw fail('models must be a list of user-configured model names');
        if (payload.modelArgs !== undefined && (!Array.isArray(payload.modelArgs) || payload.modelArgs.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) throw fail('modelArgs must be an argv string array');
        if (payload.usageFormat && payload.usageFormat !== 'codex-jsonl') throw fail('Only verified codex-jsonl usage events are supported');
        if (payload.protocol && !['cli', 'codex-app-server', 'claude-stream-json', 'opencode-acp'].includes(payload.protocol)) throw fail('Provider protocol must be cli, codex-app-server, claude-stream-json or opencode-acp');
        if (['claude-stream-json', 'opencode-acp'].includes(payload.protocol) && ((payload.inputMode && payload.inputMode !== 'stdin') || payload.modelArgs?.length)) throw fail('Streaming native sessions require stdin mode and empty modelArgs');
        const provider = { id: providerId, name: nonempty(payload.name || command, 'name', 256), command, args: [...payload.args], inputMode: payload.inputMode || 'stdin', enabled: payload.enabled !== false, models: [...(payload.models || [])], modelArgs: [...(payload.modelArgs || [])], ...(payload.usageFormat ? { usageFormat: payload.usageFormat } : {}), ...(['codex-app-server', 'claude-stream-json', 'opencode-acp'].includes(payload.protocol) ? { protocol: payload.protocol } : {}) };
        const index = state.providers.findIndex((item) => item.id === providerId);
        if (index < 0) state.providers.push(provider); else state.providers[index] = provider;
        for (const thread of state.threads) if (thread.providerId === providerId) { delete thread.nativeCatalog; delete thread.reasoningEffort; }
        break;
      }
      case 'agents:providers:remove': locate('providers', id); if (state.threads.some((thread) => thread.providerId === id)) throw fail('Delete provider threads first'); state.providers = state.providers.filter((provider) => provider.id !== id); break;
      case 'agents:threads:create': if (payload.browserSpaceId !== undefined && (!Number.isSafeInteger(payload.browserSpaceId) || payload.browserSpaceId < 0)) throw fail('browserSpaceId must be a non-negative integer'); state.threads.push(newThread(payload.projectId, payload.providerId, payload.title, { ...(payload.model ? { model: nonempty(payload.model, 'model', 256) } : {}), ...(payload.browserSpaceId !== undefined ? { browserSpaceId: payload.browserSpaceId } : {}) })); break;
      case 'agents:threads:read': return clone(locate('threads', id));
      case 'agents:threads:rename': { const thread = locate('threads', id); thread.title = nonempty(payload.title, 'title', 256); thread.updatedAt = now(); break; }
      case 'agents:threads:archive': case 'agents:threads:unarchive': case 'agents:threads:pin': case 'agents:threads:unpin': {
        const thread = locate('threads', id); if (action.endsWith(':archive') || action.endsWith(':unarchive')) thread.archived = action.endsWith(':archive'); else thread.pinned = action.endsWith(':pin'); thread.updatedAt = now(); break;
      }
      case 'agents:threads:notes': { const thread = locate('threads', id); if (typeof payload.notes !== 'string' || payload.notes.length > 65536) throw fail('notes must be text up to 65536 characters'); thread.notes = payload.notes; thread.updatedAt = now(); break; }
      case 'agents:threads:goal': { const thread = locate('threads', id); const text = typeof payload.goal === 'string' ? payload.goal : payload.goal?.text; if (text === '' || payload.goal === null) delete thread.goal; else thread.goal = { text: nonempty(text, 'goal'), status: (payload.status || payload.goal?.status) === 'complete' ? 'complete' : 'active' }; thread.updatedAt = now(); break; }
      case 'agents:threads:marker:add': { const thread = locate('threads', id); if (payload.messageId && !thread.messages.some((item) => item.id === payload.messageId)) throw fail('Marker message not found'); thread.markers.push({ id: randomUUID(), label: nonempty(payload.label, 'marker label', 256), ...(payload.messageId ? { messageId: payload.messageId } : {}), createdAt: now() }); thread.updatedAt = now(); break; }
      case 'agents:threads:marker:remove': { const thread = locate('threads', id); thread.markers = thread.markers.filter((item) => item.id !== payload.markerId); thread.updatedAt = now(); break; }
      case 'agents:threads:discover-models': {const thread=locate('threads',id);automationAccess(thread);startModelDiscovery(thread);break;}
      case 'agents:threads:model': {
        const thread = locate('threads', id); editable(thread); const protocol = locate('providers', thread.providerId).protocol;
        const model = payload.model ? nonempty(payload.model, 'model', 256) : '';
        if (model && ['opencode-acp','codex-app-server'].includes(protocol) && thread.nativeCatalog && !thread.nativeCatalog.models.some(item => item.id === model)) throw fail('Choose an observed native model');
        if(protocol==='claude-stream-json'&&thread.nativeCatalog)validateClaudeModel({model},thread.nativeCatalog);
        const effort = payload.reasoningEffort ? nonempty(payload.reasoningEffort,'reasoning effort',64) : '';
        if (effort) { if (!['codex-app-server','claude-stream-json'].includes(protocol) || !thread.nativeCatalog) throw fail('Discover native model capabilities before choosing reasoning effort'); (protocol==='claude-stream-json'?validateClaudeModel:validateCodexModel)({model,reasoningEffort:effort},thread.nativeCatalog); }
        thread.model=model; if(effort)thread.reasoningEffort=effort;else delete thread.reasoningEffort; thread.updatedAt = now(); break;
      }
      case 'agents:attachments:add': { const thread = locate('threads', id); editable(thread); addAttachmentPaths(thread, payload.paths || [payload.path]); break; }
      case 'agents:attachments:read': { const thread = locate('threads', id), attachment = thread.attachments.find((item) => item.id === payload.attachmentId); if (!attachment || attachment.available === false) throw fail('Attachment file is unavailable'); return { ...snapshot(), attachmentData: { ...clone(attachment), storedPath: safeAttachmentPath(thread, attachment) } }; }
      case 'agents:attachments:remove': { const thread = locate('threads', id); editable(thread); const attachment = thread.attachments.find((item) => item.id === payload.attachmentId); if (!attachment) throw fail('Attachment not found'); attachment.detachedAt = now(); thread.updatedAt = now(); break; }
      case 'agents:attachments:restore': { const thread = locate('threads', id); editable(thread); const attachment = thread.attachments.find((item) => item.id === payload.attachmentId); if (!attachment || attachment.available === false) throw fail('Attachment file is unavailable; choose the source file again'); if (attachment.detachedAt && thread.attachments.filter((item) => !item.detachedAt).length >= maxAttachments) throw fail('A conversation can have at most ten active attachments'); safeAttachmentPath(thread, attachment); delete attachment.detachedAt; thread.updatedAt = now(); break; }
      case 'agents:threads:fork': case 'agents:threads:sidechat': {
        const source = locate('threads', id);
        const index = payload.messageId ? source.messages.findIndex((item) => item.id === payload.messageId) : source.messages.length - 1;
        if (payload.messageId && index < 0) throw fail('Fork message not found');
        const created = newThread(source.projectId, source.providerId, payload.title || `${action.endsWith(':sidechat') ? 'Sidechat' : 'Fork'}: ${source.title}`, { parentThreadId: source.id, kind: action.endsWith(':sidechat') ? 'sidechat' : 'fork', model: source.model || '', ...(source.browserSpaceId !== undefined ? { browserSpaceId: source.browserSpaceId } : {}), messages: source.messages.slice(0, index + 1).map((item) => ({ ...clone(item), id: randomUUID(), sourceMessageId: item.id })), sourceThreadId: source.id });
        copyAttachments(source, created);
        state.threads.push(created); if (payload.prompt) startRun(created, payload.prompt); break;
      }
      case 'agents:threads:edit': case 'agents:threads:resend': {
        const thread = locate('threads', id); editable(thread);
        const index = payload.messageId ? thread.messages.findIndex((item) => item.id === payload.messageId) : thread.messages.findLastIndex((item) => item.role === 'user');
        if (index < 0 || thread.messages[index].role !== 'user') throw fail('Select an existing user message');
        const content = nonempty(payload.content ?? payload.prompt ?? thread.messages[index].content, 'message');
        const replacement = { ...thread.messages[index], content, editedAt: now() };
        revise(thread, action.endsWith(':resend') ? 'resend' : 'edit', action.endsWith(':resend') ? thread.messages.slice(0, index) : [...thread.messages.slice(0, index), replacement]);
        if (action.endsWith(':resend')) startRun(thread, content); break;
      }
      case 'agents:threads:rollback': {
        const thread = locate('threads', id); editable(thread); const index = thread.messages.findIndex((item) => item.id === payload.messageId); if (index < 0) throw fail('Rollback message not found');
        revise(thread, 'rollback', thread.messages.slice(0, index + (payload.includeMessage === false ? 0 : 1))); break;
      }
      case 'agents:threads:delete': {const thread=locate('threads',id);automationAccess(thread);for(const a of state.automations.filter(a=>a.threadId===id)){a.status='paused';await stopAutomation(a);releaseAutomationThreads(a);}await stopThread(id);state.threads=state.threads.filter(t=>t.id!==id);state.automations=state.automations.filter(a=>a.threadId!==id);state.proposals=state.proposals.filter(p=>p.threadId!==id);break;}
      case 'agents:threads:prompt': startRun(locate('threads', id), payload.prompt); break;
      case 'agents:threads:stop': locate('threads', id); await stopThread(id); break;
      case 'agents:recovery:refresh': break;
      case 'agents:automations:mark-read': {const a=locate('automations',id);if(a.lastResult)a.lastResult.unread=false;const run=state.threads.flatMap(t=>t.runs||[]).find(r=>r.id===a.lastRunId);if(run?.result)run.result.unread=false;break;}
      case 'agents:automations:create': { const automation = validateAutomation(payload); state.automations.push({ ...automation, id: randomUUID(), status: payload.status === 'paused' ? 'paused' : 'active', nextRunAt: nextTime(automation), createdAt: now(), updatedAt: now() }); break; }
      case 'agents:automations:update': { const previous = locate('automations', id), candidate = validateAutomation(payload, previous), next = nextTime(candidate); if(candidate.executionMode!==(previous.executionMode||'heartbeat')||candidate.threadId!==previous.threadId){if([...running.values()].some(active=>active.run.automationId===id))throw fail('Stop the automation run before changing its mode or template');releaseAutomationThreads(previous);delete candidate.ownedThreadId;} Object.assign(previous, candidate, { updatedAt: now() }); if (previous.kind !== 'at') delete previous.at; if (!['interval', 'heartbeat'].includes(previous.kind)) delete previous.intervalMs; if (previous.kind !== 'cron') { delete previous.cron; delete previous.timeZone; delete previous.dstPolicy; } delete previous.lastScheduleError; if (previous.stopReason === 'Cannot calculate next cron occurrence') delete previous.stopReason; delete previous.deferred; previous.nextRunAt = next; if (previous.status === 'completed') previous.status = 'paused'; break; }
      case 'agents:automations:delete': {const a=locate('automations',id);a.status='paused';await stopAutomation(a);releaseAutomationThreads(a);state.automations=state.automations.filter(item=>item.id!==id);break;}
      case 'agents:automations:pause': { const automation = locate('automations', id); automation.status = 'paused'; delete automation.deferred; automation.updatedAt = now(); break; }
      case 'agents:automations:resume': { const automation = locate('automations', id), next = nextTime(automation); automation.status = 'active'; delete automation.deferred; automation.nextRunAt = next; delete automation.lastScheduleError; if (automation.stopReason === 'Cannot calculate next cron occurrence') delete automation.stopReason; automation.updatedAt = now(); break; }
      case 'agents:automations:run': runAutomation(locate('automations', id), false); break;
      case 'agents:automations:stop': { const automation = locate('automations', id); automation.status = 'paused'; delete automation.deferred; automation.updatedAt = now(); await stopAutomation(automation); break; }
      case 'agents:proposals:create': {
        const automation = payload.automationId ? locate('automations', payload.automationId) : null;
        const thread = locate('threads', payload.threadId || automation?.threadId);
        const prompt = nonempty(payload.prompt, 'proposal prompt');
        const run = payload.runId ? thread.runs.find((item) => item.id === payload.runId) : null;
        if (payload.runId && (!run || !run.stdout.includes(prompt))) throw fail('A provider-sourced proposal must quote text from its actual run output');
        state.proposals.push({ id: randomUUID(), title: nonempty(payload.title || 'Proposed task', 'title', 256), prompt, threadId: thread.id, ...(automation ? { automationId: automation.id } : {}), source: run ? 'provider-output' : 'manual', ...(run ? { sourceRunId: run.id } : {}), status: 'pending', createdAt: now() }); break;
      }
      case 'agents:proposals:accept': { const proposal = locate('proposals', payload.proposalId || id); if (proposal.status !== 'pending') throw fail('Proposal has already been decided'); const run = startRun(locate('threads', proposal.threadId), proposal.prompt); proposal.status = 'accepted'; proposal.runId = run.id; proposal.decidedAt = now(); break; }
      case 'agents:proposals:reject': { const proposal = locate('proposals', payload.proposalId || id); if (proposal.status !== 'pending') throw fail('Proposal has already been decided'); proposal.status = 'rejected'; proposal.decidedAt = now(); break; }
      default: throw fail('Unknown Agent action');
    }
    publish(); armScheduler(); return snapshot();
  }
  async function close() {
    claudePreviews.clear(); codexPreviews.clear();
    if (closed) return;
    closed = true;for(const controller of evaluationControllers.values())controller.abort();for(const job of completionQueue.splice(0))job.run.completionEvaluation={status:'cancelled',reason:'Browser stopped before stop evaluation'}; clearTimeout(scheduleTimer); clearTimeout(publishTimer);
    for (const check of [...waiters]) check('closed');
    await Promise.all([...running.keys()].map((threadId) => stopThread(threadId, 'interrupted')));
    await Promise.all([...evaluationTasks]);
    persist();
    try { if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).token === lockToken) fs.unlinkSync(lockPath); } catch {}
  }
  for (const automation of state.automations) {
    const runs = state.threads.flatMap((thread) => thread.runs || []).filter((run) => run.automationId === automation.id);
    if (runs.length) automation.runCount = Math.max(automation.runCount || 0, runs.length);
    if (['reserved','started'].includes(automation.lastOutcome)) {
      const run = runs.find(item=>item.id===automation.lastRunId)||(automation.lastReservationId?runs.find(item=>item.automationReservationId===automation.lastReservationId):null);
      automation.lastOutcome = run?.status || 'interrupted-before-start'; if (run) {automation.lastRunId = run.id;if(run.status==='interrupted'){run.result={...(run.result||{}),decision:'notify',unread:true,summary:'Host stopped before provider exit was observed. This run was not replayed.'};automation.lastResult=clone(run.result);}}
    }
    if (automation.kind === 'cron') {
      try { automation.timeZone = normalizedTimeZone(automation.timeZone || 'UTC'); cronFields(automation.cron); nextCronAt(automation.cron, Date.now(), automation.timeZone); automation.dstPolicy = 'skip-missing-first-occurrence'; }
      catch (error) { automation.status = 'paused'; automation.nextRunAt = null; automation.lastError = error.message; automation.stopReason = 'Invalid saved cron schedule'; }
    }
    if (automation.nextRunAt && !Number.isFinite(Date.parse(automation.nextRunAt))) { automation.status = 'paused'; automation.nextRunAt = null; automation.lastError = 'Invalid saved nextRunAt'; automation.stopReason = 'Invalid saved schedule timestamp'; }
  }
  persist(); armScheduler();
  function recoverFileChanges(records){
    if(running.size)throw fail('Recover checkpoint metadata before starting Agent runs');
    for(const record of records){const thread=state.threads.find(t=>t.id===record.threadId&&t.projectId===record.projectId),run=thread?.runs.find(r=>r.id===record.runId);if(run)run.fileChanges=clone(record);}
    persist();
  }
  return { dispatch, snapshot, close, recoverFileChanges,runDueOnce,lifecycle };
}

module.exports = { createAgentService, nextCronAt };

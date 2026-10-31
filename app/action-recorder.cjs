'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const clone = value => JSON.parse(JSON.stringify(value));
const timestamp = () => new Date().toISOString();
const error = message => Object.assign(new Error(message), { error_code: 'VEK_RECORDER_INVALID_REQUEST' });
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000;

function safeUrl(value) {
  try { const url = new URL(String(value)); if (!['http:', 'https:', 'file:', 'about:'].includes(url.protocol)) return ''; url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href.slice(0, 4096); } catch { return ''; }
}
function safeText(value, limit = 200) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : ''; }
function sensitive(event) {
  const target = event.target || {};
  if (event.sensitive || event.isSensitive || event.password || event.payment || target.sensitive || target.opaque) return true;
  const type = String(event.inputType || event.targetType || target.type || '').toLowerCase();
  const autocomplete = String(event.autocomplete || target.autocomplete || '').toLowerCase();
  if (type === 'password' || /(?:^|\s)(?:cc-\S+|current-password|new-password|one-time-code)(?:\s|$)/.test(autocomplete)) return true;
  const isInput = event.kind === 'key' || /^(input|textarea)$/i.test(target.tagName || event.tagName || '') || event.editable;
  return !!isInput && /password|passwd|passcode|credit.?card|card.?number|card.?holder|card.?exp|cvv\d*|cvc\d*|security.?code|payment|\biban\b|\bccnum\b|secret|api.?key|auth.?token/i.test([target.name, target.id, event.fieldName, event.fieldRole, event.selector].filter(Boolean).join(' '));
}
function safeEvent(event) {
  if (!event || typeof event !== 'object' || !['click', 'key', 'scroll'].includes(event.kind)) return { reason: 'unsupported' };
  if (sensitive(event)) return { reason: 'sensitive' };
  const result = { id: randomUUID(), kind: event.kind, at: timestamp(), url: safeUrl(event.url) };
  if (event.kind === 'key') {
    const key = String(event.key || '');
    const navigation = new Set(['Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', 'Insert', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']);
    const combination = (event.ctrlKey || event.metaKey) && /^[a-zA-Z0-9]$/.test(key);
    if (!navigation.has(key) && !combination) return { reason: 'printable-input' };
    result.key = combination ? key.toUpperCase() : key;
    result.modifiers = ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'].filter(name => event[name] === true).map(name => name.replace('Key', ''));
  }
  if (finite(event.x) && finite(event.y)) { result.x = event.x; result.y = event.y; }
  if (event.kind === 'scroll') {
    if (finite(event.deltaX)) result.deltaX = event.deltaX;
    if (finite(event.deltaY)) result.deltaY = event.deltaY;
  }
  if (event.box && ['x', 'y', 'width', 'height'].every(key => finite(event.box[key])) && event.box.width >= 0 && event.box.height >= 0) result.box = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, event.box[key]]));
  // Selectors can carry typed values in attribute selectors. Do not retain
  // value/text/credential attributes, or selector dialects containing page text.
  if (typeof event.selector === 'string' && event.selector.length <= 1024 && !/[\u0000-\u001f]/.test(event.selector) && !/\[\s*(?:value|aria-valuetext|data-(?:token|secret|password|key))\s*[~|^$*]?=|text\s*=|:has-text\(/i.test(event.selector)) result.selector = event.selector;
  return { event: result };
}

function createActionRecorder({ dataDir, onChange = () => {}, capture, activePage, maxEvents = 200, maxImageBytes = 5 * 1024 * 1024, maxTotalImageBytes = 50 * 1024 * 1024, minCaptureIntervalMs = 500, captureTimeoutMs = 3000 } = {}) {
  if (!dataDir || typeof activePage !== 'function' || typeof capture !== 'function') throw error('dataDir, capture, and activePage are required');
  maxEvents = Math.max(1, Math.min(200, Number(maxEvents) || 200));
  maxImageBytes = Math.max(8, Math.min(5 * 1024 * 1024, Number(maxImageBytes) || 5 * 1024 * 1024));
  maxTotalImageBytes = Math.max(8, Math.min(50 * 1024 * 1024, Number(maxTotalImageBytes) || 50 * 1024 * 1024));
  minCaptureIntervalMs = Math.max(0, Number(minCaptureIntervalMs) || 0);
  captureTimeoutMs = Math.max(10, Math.min(30000, Number(captureTimeoutMs) || 3000));
  const directory = path.join(path.resolve(dataDir), 'recordings'), imageRoot = path.join(directory, 'images'), indexPath = path.join(directory, 'index.json');
  for (const dir of [directory, imageRoot]) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); if (fs.lstatSync(dir).isSymbolicLink()) throw error('Recorder directories must not be symlinks'); fs.chmodSync(dir, 0o700); }
  let sessions = [], activeId = null, accepting = false, closed = false, queue = Promise.resolve();
  const pending = new Map();
  const limits = { maxEvents, maxImageBytes, maxTotalImageBytes, minCaptureIntervalMs, captureTimeoutMs };
  function metadata(session) { const { lastCaptureTime, ...result } = session; return clone(result); }
  function snapshot() { return { version: 1, sessions: sessions.map(metadata), activeSessionId: activeId, recording: accepting && !closed, limits: { ...limits } }; }
  function atomic(file, data) {
    const temporary = path.join(path.dirname(file), `.recorder-${randomUUID()}.tmp`);
    let fd;
    try { fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, file); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
  }
  function persist(session) {
    if (session) atomic(path.join(directory, `${session.id}.json`), JSON.stringify({ version: 1, ...session }, null, 2) + '\n');
    atomic(indexPath, JSON.stringify({ version: 1, sessions: sessions.map(session => ({ id: session.id })) }, null, 2) + '\n');
  }
  function publish(session) { persist(session); try { onChange(snapshot()); } catch {} }
  const find = id => { const session = sessions.find(item => item.id === id); if (!session) throw error('Recording session not found'); return session; };
  function enqueue(work) { const task = queue.then(work); queue = task.catch(() => {}); return task; }
  if (fs.existsSync(indexPath)) {
    if (fs.lstatSync(indexPath).isSymbolicLink()) throw error('Recorder index must not be a symlink');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (index.version !== 1 || !Array.isArray(index.sessions)) throw error('Unsupported recorder index');
    for (const item of index.sessions) {
      if (!uuid(item.id)) throw error('Invalid recorder session id');
      const file = path.join(directory, `${item.id}.json`);
      if (fs.lstatSync(file).isSymbolicLink()) throw error('Recorder session must not be a symlink');
      const session = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (session.version !== 1 || session.id !== item.id || !Array.isArray(session.events) || session.events.length > 200) throw error('Invalid recorder session');
      if (['recording', 'stopping'].includes(session.status)) { session.status = 'interrupted'; session.endedAt = timestamp(); session.stopReason = 'app-restart'; }
      sessions.push(session); fs.chmodSync(file, 0o600);
    }
    fs.chmodSync(indexPath, 0o600);
    for (const session of sessions) persist(session);
  }
  function finish(session, status, reason) {
    if (activeId === session.id) { activeId = null; accepting = false; }
    if (!['stopped', 'interrupted'].includes(session.status)) { session.status = status; session.endedAt = timestamp(); session.stopReason = reason; }
    publish(session);
  }
  async function stop(status = 'stopped', reason = 'user-stop') {
    const session = activeId ? find(activeId) : null;
    accepting = false;
    if (!session) { await queue; return; }
    session.status = 'stopping';
    return enqueue(() => finish(session, status, reason));
  }
  function imageBytes(session, event) {
    if (!event?.image || !uuid(event.image.id)) throw error('No screenshot is recorded for this event');
    const folder = path.join(imageRoot, session.id), file = path.join(folder, `${event.image.id}.png`);
    if (fs.lstatSync(folder).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) throw error('Screenshot paths must not be symlinks');
    const size = fs.statSync(file).size;
    if (size > maxImageBytes || size > 5 * 1024 * 1024) throw error('Stored screenshot exceeds the image limit');
    return fs.readFileSync(file);
  }
  async function record(input) {
    if (closed || !accepting || !activeId) return { accepted: false, reason: 'off' };
    const session = find(activeId), page = activePage();
    if (input?.targetId !== session.targetId || page?.targetId !== session.targetId) return { accepted: false, reason: 'different-target' };
    const sanitized = safeEvent(input);
    if (!sanitized.event) return { accepted: false, reason: sanitized.reason };
    if (session.events.length + (pending.get(session.id) || 0) >= maxEvents) return { accepted: false, reason: 'event-limit' };
    pending.set(session.id, (pending.get(session.id) || 0) + 1);
    return enqueue(async () => {
      try {
        if (session.deletedAt || activePage()?.targetId !== session.targetId) return { accepted: false, reason: 'different-target' };
        const event = sanitized.event;
        const captureTime = Date.now();
        if (closed || !accepting) event.screenshotStatus = closed ? 'app-closing' : 'recording-stopped';
        else if (session.imageBytes >= maxTotalImageBytes) event.screenshotStatus = 'total-limit';
        else if (session.lastCaptureTime !== undefined && captureTime - session.lastCaptureTime < minCaptureIntervalMs) event.screenshotStatus = 'rate-limited';
        else {
          session.lastCaptureTime = captureTime;
          let timer;
          try {
            const value = await Promise.race([Promise.resolve().then(() => capture({ targetId: session.targetId })), new Promise((_, reject) => { timer = setTimeout(() => reject(error('capture-timeout')), captureTimeoutMs); })]);
            const encoded = typeof value?.pngBase64 === 'string' ? value.pngBase64.replace(/^data:image\/png;base64,/, '') : '';
            if (closed || !accepting) event.screenshotStatus = closed ? 'app-closing' : 'recording-stopped';
            else if (activePage()?.targetId !== session.targetId) event.screenshotStatus = 'different-target';
            else if (!encoded || encoded.length > Math.ceil(maxImageBytes / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) event.screenshotStatus = 'image-limit-or-invalid';
            else {
              const bytes = Buffer.from(encoded, 'base64');
              if (bytes.length > maxImageBytes || bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) event.screenshotStatus = 'image-limit-or-invalid';
              else if (session.imageBytes + bytes.length > maxTotalImageBytes) event.screenshotStatus = 'total-limit';
              else {
                const folder = path.join(imageRoot, session.id); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
                if (fs.lstatSync(folder).isSymbolicLink()) throw error('Image directory must not be a symlink'); fs.chmodSync(folder, 0o700);
                const id = randomUUID(); atomic(path.join(folder, `${id}.png`), bytes);
                event.image = { id, bytes: bytes.length, capturedAt: timestamp() }; event.screenshotStatus = 'captured'; session.imageBytes += bytes.length;
              }
            }
          } catch { event.screenshotStatus = 'capture-failed'; }
          finally { clearTimeout(timer); }
        }
        session.events.push(event); session.updatedAt = timestamp();
        if (session.events.length >= maxEvents) finish(session, 'stopped', 'event-limit'); else publish(session);
        return { accepted: true, sessionId: session.id, event: clone(event) };
      } finally { pending.set(session.id, Math.max(0, (pending.get(session.id) || 1) - 1)); }
    });
  }
  async function dispatch(action, payload = {}) {
    if (closed) throw error('Recorder is closed');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw error('Recorder payload must be an object');
    const id = payload.id || payload.sessionId;
    if (action === 'recorder:list') return snapshot();
    if (action === 'recorder:stop') { await stop(); return snapshot(); }
    if (action === 'recorder:start') {
      if (activeId) throw error('Stop the current recording before starting another');
      const page = activePage(); if (!page?.targetId || typeof page.targetId !== 'string') throw error('No current browser page is available');
      if (payload.targetId && payload.targetId !== page.targetId) throw error('Recording can start only on the current page');
      const session = { id: randomUUID(), name: safeText(payload.name, 200) || `Recording ${new Date().toLocaleString()}`, targetId: page.targetId, url: safeUrl(page.url), title: safeText(page.title), status: 'recording', startedAt: timestamp(), updatedAt: timestamp(), events: [], imageBytes: 0 };
      sessions.push(session); activeId = session.id; accepting = true; publish(session); return snapshot();
    }
    if (action === 'recorder:delete') {
      const session = find(id); if (activeId === id) await stop();
      return enqueue(() => { session.deletedAt = timestamp(); publish(session); return snapshot(); });
    }
    return enqueue(() => {
      const session = find(id);
      if (action === 'recorder:read') {
        const result = metadata(session);
        if (payload.eventId) { const event = session.events.find(item => item.id === payload.eventId); result.preview = { eventId: payload.eventId, pngBase64: imageBytes(session, event).toString('base64') }; }
        return result;
      }
      if (action === 'recorder:restore') { delete session.deletedAt; publish(session); return snapshot(); }
      if (action === 'recorder:export') {
        const recording = metadata(session);
        recording.events = recording.events.map(event => ({ ...event, ...(event.image ? { pngBase64: imageBytes(session, event).toString('base64') } : {}) }));
        return { ...snapshot(), exportData: { filename: `vek-recording-${session.id}.json`, mimeType: 'application/json', content: JSON.stringify({ format: 'vek-action-recording', version: 1, exportedAt: timestamp(), recording }, null, 2) } };
      }
      throw error('Unknown recorder action');
    });
  }
  async function close() { if (closed) return; closed = true; await stop('interrupted', 'app-close'); await queue; }
  return { dispatch, record, snapshot, close };
}
module.exports = { createActionRecorder };

'use strict';
// An explicit local search corpus. No directory crawling, background page
// capture, embeddings, remote service, or automatic agent context injection.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const MAX_TEXT = 256 * 1024, MAX_TOTAL = 16 * 1024 * 1024, MAX_DOCUMENTS = 512;
const fail = (message, code = 'VEK_MEMORY_INVALID') => Object.assign(new Error(message), { error_code: code });
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const fold = value => value.normalize('NFKC').toLocaleLowerCase('und');
function string(value, label, max = 4096, empty = false) { if (typeof value !== 'string' || !empty && !value || !value.isWellFormed() || value.includes('\0') || Buffer.byteLength(value) > max) throw fail(`Invalid memory ${label}`); return value; }
function scope(value) { return string(value, 'profile', 200); }
function record(row) {
  if (!row || Array.isArray(row) || typeof row !== 'object' || Object.keys(row).some(key => !['id','profileId','kind','projectId','spaceId','source','title','text','sha256','indexedAt'].includes(key))) throw fail('Invalid memory record');
  const out = { id: string(row.id, 'ID', 100), profileId: scope(row.profileId), kind: row.kind, source: string(row.source, 'source', 16384), title: string(row.title, 'title', 4096, true), text: string(row.text, 'text', MAX_TEXT, true), indexedAt: string(row.indexedAt, 'date', 32) };
  if (!['page','file'].includes(out.kind) || !Number.isFinite(Date.parse(out.indexedAt))) throw fail('Invalid memory kind/date');
  if (out.kind === 'page') { const url = new URL(out.source); if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail('Invalid memory page URL'); if (!Number.isSafeInteger(row.spaceId) || row.spaceId < 1) throw fail('Invalid memory Space'); out.spaceId = row.spaceId; }
  else { if (!path.isAbsolute(out.source)) throw fail('Memory file must be absolute'); out.projectId = string(row.projectId, 'project', 200); }
  out.sha256 = hash(out.text); if (row.sha256 !== undefined && row.sha256 !== out.sha256) throw fail('Memory content hash mismatch'); return out;
}
async function projectFile(root, value) {
  const input = path.resolve(value); let ancestor = path.dirname(input);
  for (let depth = 0; depth < 128; depth++) {
    let actual; try { actual = await fsp.realpath(ancestor); } catch {}
    if (actual === root) {
      const aliasInside = path.relative(root, ancestor);
      if (aliasInside && !aliasInside.startsWith('..' + path.sep) && aliasInside !== '..' && !path.isAbsolute(aliasInside)) throw fail('Internal project aliases are not supported');
      const relative = path.relative(ancestor, input), resolved = path.resolve(root, relative);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || await fsp.realpath(resolved) !== resolved) throw fail('Choose a regular file inside the selected project without symlinks');
      return { resolved, relative };
    }
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  throw fail('Choose a regular file inside the selected project without symlinks');
}
function createMemoryService({ dataDir, policy = () => ({}), projects = () => [], onChange = () => {} } = {}) {
  const directory = path.join(path.resolve(dataDir), 'memory'), file = path.join(directory, 'state.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); if (fs.lstatSync(directory).isSymbolicLink()) throw fail('Memory directory must not be a symlink'); fs.chmodSync(directory, 0o700);
  let rows = [], closed = false, epoch = 0, lastPolicy = '', active = new Map();
  if (fs.existsSync(file)) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TOTAL * 3) throw fail('Invalid memory state file'); const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.version !== 1 || !Array.isArray(saved.documents) || saved.documents.length > MAX_DOCUMENTS) throw fail('Unsupported memory state'); rows = saved.documents.map(record); if (new Set(rows.map(row => row.id)).size !== rows.length) throw fail('Duplicate memory IDs'); }
  if(rows.reduce((total,row)=>total+Buffer.byteLength(row.text),0)>MAX_TOTAL)throw fail('Memory corpus limit reached');
  const lockFile=path.join(directory,'host.lock'),lockToken=randomUUID();
  if(fs.existsSync(lockFile)){if(fs.lstatSync(lockFile).isSymbolicLink())throw fail('Memory lock must not be a symlink');const owner=JSON.parse(fs.readFileSync(lockFile,'utf8'));let live=true;try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')live=false;else throw error;}if(live)throw fail('Memory index is already open','VEK_MEMORY_LOCKED');fs.unlinkSync(lockFile);}
  fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid,token:lockToken}),{flag:'wx',mode:0o600});
  function unlock(){try{if(JSON.parse(fs.readFileSync(lockFile,'utf8')).token===lockToken)fs.unlinkSync(lockFile);}catch{}}
  function settings() { const value = policy(); return { page: value.browserActivity === true, file: value.localFiles === true }; }
  function ensureOpen() { if (closed) throw fail('Memory service is closed'); }
  function persist(next) {
    if (next.length > MAX_DOCUMENTS || next.reduce((total, row) => total + Buffer.byteLength(row.text), 0) > MAX_TOTAL) throw fail('Memory corpus limit reached', 'VEK_MEMORY_LIMIT');
    const serialized=JSON.stringify({version:1,documents:next});if(Buffer.byteLength(serialized)>MAX_TOTAL*3)throw fail('Encoded memory corpus limit reached','VEK_MEMORY_LIMIT');
    const temporary = `${file}.${randomUUID()}.tmp`; let fd;
    try { fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, file); rows = next; }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch {} }
    try { onChange(); } catch {}
  }
  function syncPolicy() { ensureOpen(); const enabled = settings(), key = JSON.stringify(enabled); if (key !== lastPolicy) { epoch++; const next = rows.filter(row => enabled[row.kind]); if (next.length !== rows.length) persist(next); lastPolicy = key; } }
  function metadata(row) { const { text, ...out } = row; return { ...out, bytes: Buffer.byteLength(text) }; }
  function snapshot(profileId) { scope(profileId); const enabled = settings(), documents = rows.filter(row => row.profileId === profileId && enabled[row.kind]); return { profileId, documents: documents.map(metadata).sort((a,b) => b.indexedAt.localeCompare(a.indexedAt)), busy: active.has(profileId), enabled, limits: { documentBytes: MAX_TEXT, totalBytes: MAX_TOTAL, documents: MAX_DOCUMENTS } }; }
  function allowed(kind) { ensureOpen(); syncPolicy(); if (!settings()[kind]) throw fail('Enable the corresponding memory setting first', 'VEK_MEMORY_DISABLED'); }
  function upsert(items) { const next = rows.slice(); for (const item of items) { const at = next.findIndex(row => row.profileId === item.profileId && row.kind === item.kind && row.source === item.source && (item.kind === 'file' ? row.projectId === item.projectId : row.spaceId === item.spaceId)); if (at < 0) next.push(item); else next[at] = { ...item, id: next[at].id }; } persist(next); }
  function indexPage(profileId, page) { scope(profileId); allowed('page'); const url = new URL(page.url); url.search = ''; url.hash = ''; upsert([record({ id: randomUUID(), profileId, kind: 'page', spaceId: page.spaceId, source: url.href, title: page.title || '', text: page.text, indexedAt: new Date().toISOString() })]); return snapshot(profileId); }
  async function indexFiles(profileId, payload) {
    scope(profileId); allowed('file'); if (active.has(profileId)) throw fail('Memory indexing is already running', 'VEK_MEMORY_BUSY');
    const project = projects().find(row => row.id === payload.projectId); if (!project) throw fail('Choose an existing project');
    if (!Array.isArray(payload.paths) || !payload.paths.length || payload.paths.length > 32 || payload.paths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) throw fail('Choose 1–32 absolute file paths');
    const operation = { cancelled: false }, generation = epoch; active.set(profileId, operation);
    let root; try { root = await fsp.realpath(project.path); } catch (error) { active.delete(profileId); throw error; } try { onChange(); } catch {}
    const items = [], warnings = [];
    try {
      for (const source of [...new Set(payload.paths)]) {
        if (operation.cancelled || generation !== epoch || !settings().file || closed) throw fail('Memory indexing cancelled', 'VEK_MEMORY_CANCELLED');
        let handle;
        try {
          const {resolved,relative} = await projectFile(root,source);
          if (!/\.(txt|md|markdown|csv|tsv|json|js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|c|h|cpp|css|html|xml|yaml|yml|toml|sql|log)$/i.test(resolved)) throw fail('Only supported UTF-8 text files can be indexed');
          const selected = await fsp.lstat(resolved);
          handle = await fsp.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); const before = await handle.stat();
          if (selected.dev !== before.dev || selected.ino !== before.ino || !before.isFile() || before.size > MAX_TEXT) throw fail('File is not regular or exceeds 256 KiB');
          const bytes = Buffer.alloc(MAX_TEXT + 1); let size = 0;
          while (size < bytes.length) { const part = await handle.read(bytes, size, bytes.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
          const after = await handle.stat(), current = await fsp.lstat(resolved); if (current.dev !== before.dev || current.ino !== before.ino) throw fail('File changed while indexing; choose it again'); if (size > MAX_TEXT || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await fsp.realpath(resolved) !== resolved) throw fail('File changed while indexing; choose it again');
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
          items.push(record({ id: randomUUID(), profileId, kind: 'file', projectId: project.id, source: resolved, title: relative, text: content, indexedAt: new Date().toISOString() }));
        } catch (error) { warnings.push({ source, error: error.error_code ? error.message : 'File unavailable or not valid UTF-8 text' }); }
        finally { await handle?.close(); }
      }
      if (operation.cancelled || generation !== epoch || !settings().file || closed) throw fail('Memory indexing cancelled', 'VEK_MEMORY_CANCELLED');
      if (items.length) upsert(items); return { indexed: items.length, warnings, ...snapshot(profileId), busy: false };
    } finally { active.delete(profileId); try { onChange(); } catch {} }
  }
  function search(profileId, payload) {
    scope(profileId); const query = string(payload.query, 'query', 512).trim(); if (!query) throw fail('Enter a memory search query');
    const terms = [...new Set(fold(query).split(/\s+/).filter(Boolean))]; if (terms.length > 16) throw fail('Use at most 16 query terms');
    const enabled = settings(); const results = [];
    for (const row of rows) {
      if (row.profileId !== profileId || !enabled[row.kind] || payload.projectId && row.projectId !== payload.projectId || payload.spaceId !== undefined && row.spaceId !== payload.spaceId) continue;
      const title = fold(row.title), body = fold(row.text); if (!terms.every(term => title.includes(term) || body.includes(term))) continue;
      const offset = Math.max(0, body.indexOf(terms[0]) - 80); results.push({ ...metadata(row), snippet: row.text.slice(offset, offset + 320), score: terms.reduce((score, term) => score + (title.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0), 0) });
    }
    results.sort((a,b) => b.score - a.score || b.indexedAt.localeCompare(a.indexedAt)); return { profileId, query, total: results.length, results: results.slice(0, 50) };
  }
  async function dispatch(action, payload = {}) {
    ensureOpen(); scope(payload.profileId); syncPolicy();
    if (action === 'memory:snapshot') return snapshot(payload.profileId);
    if (action === 'memory:search') return search(payload.profileId, payload);
    if (action === 'memory:index:files') return indexFiles(payload.profileId, payload);
    if (action === 'memory:cancel') { const operation = active.get(payload.profileId); if (operation) operation.cancelled = true; return snapshot(payload.profileId); }
    if (action === 'memory:clear') { const operation = active.get(payload.profileId); if (operation) operation.cancelled = true; persist(rows.filter(row => row.profileId !== payload.profileId)); return snapshot(payload.profileId); }
    const row = rows.find(row => row.id === payload.id && row.profileId === payload.profileId && settings()[row.kind]); if (!row) throw fail('Memory document not found', 'VEK_MEMORY_NOT_FOUND');
    if (action === 'memory:read') return clone(row);
    if (action === 'memory:remove') { const operation=active.get(payload.profileId);if(operation)operation.cancelled=true; persist(rows.filter(item => item !== row)); return snapshot(payload.profileId); }
    throw fail('Unknown memory action');
  }
  try{syncPolicy();}catch(error){unlock();throw error;} return { dispatch, snapshot, syncPolicy, indexPage, close() { closed = true; for (const operation of active.values()) operation.cancelled = true; unlock(); } };
}
module.exports = { createMemoryService };

'use strict';
// Independent, read-only Chromium profile reader. No automatic profile discovery.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const exec = promisify(execFile);
const EPOCH = 11644473600;
const MAX_ROWS = 20000;
function regular(file) { try { return fs.lstatSync(file).isFile() && fs.realpathSync(file) === path.resolve(file); } catch { return false; } }
function sourceDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('Select an absolute profile directory');
  const real = fs.realpathSync(directory);
  if (!fs.statSync(real).isDirectory()) throw new Error('Expected a profile directory');
  return real;
}
async function query(file, sql) {
  if (!regular(file)) return [];
  // SQLite opens the source read-only and supplies a coherent read transaction,
  // including committed WAL rows; no raw live-database copy is made.
  const uri = pathToFileURL(path.resolve(file)); uri.searchParams.set('mode', 'ro');
  const { stdout } = await exec('/usr/bin/sqlite3', ['-readonly', '-json', uri.href, sql], { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}
function decryptMac(bytes, password, domain, version = 0) {
  if (!bytes.length) return '';
  if (bytes.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported Chromium encryption version');
  if (typeof password !== 'string' || !password) throw new Error('Source browser key unavailable');
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    let plain = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
    if (domain !== undefined && version >= 24) {
      const hash = crypto.createHash('sha256').update(domain).digest();
      if (plain.length < 32 || !crypto.timingSafeEqual(plain.subarray(0, 32), hash)) throw new Error('Cookie domain authentication failed');
      plain = plain.subarray(32);
    }
    return plain.toString('utf8');
  } finally { key.fill(0); }
}
function bookmarksFromJSON(json) {
  const result = []; let visited = 0;
  function walk(item, folder = '') {
    if (++visited > MAX_ROWS * 4) throw new Error('Bookmark file exceeds import limit');
    if (!item || typeof item !== 'object') return;
    if (item.type === 'url' && /^https?:\/\//i.test(item.url)) result.push({ title: String(item.name || item.url), url: item.url, folder });
    if (Array.isArray(item.children)) for (const child of item.children) walk(child, [folder, item.name].filter(Boolean).join('/'));
  }
  for (const root of Object.values(json.roots || {})) walk(root);
  return result.slice(0, MAX_ROWS);
}
async function inspectProfile(directory) {
  const root = sourceDirectory(directory), files = {};
  for (const name of ['Bookmarks', 'History', 'Cookies', 'Network/Cookies', 'Login Data', 'Preferences']) files[name] = regular(path.join(root, name));
  if (!Object.values(files).some(Boolean)) throw new Error('No supported Chromium profile files found in this folder');
  return { path: root, files, encryptedDataSupported: process.platform === 'darwin', limitPerCategory: MAX_ROWS };
}
async function readProfile({ directory, bookmarks = true, history = true, cookies = false, passwords = false, getPassword } = {}) {
  const source = await inspectProfile(directory), root = source.path;
  const output = { bookmarks: [], history: [], cookies: [], passwords: [], warnings: [], counts: {} };
  const warn = (category, reason) => { const existing = output.warnings.find(w => w.category === category && w.reason === reason); if (existing) existing.count++; else output.warnings.push({ category, reason, count: 1 }); };
  let secret, requested = false;
  async function key() { if (!requested) { requested = true; secret = getPassword ? await getPassword() : undefined; } return secret; }
  if (bookmarks && source.files.Bookmarks) {
    const file = path.join(root, 'Bookmarks'); if (fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('Bookmark file is too large');
    output.bookmarks = bookmarksFromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  if (history && source.files.History) {
    const rows = await query(path.join(root, 'History'), `SELECT url,title,last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT ${MAX_ROWS}`);
    output.history = rows.filter(r => /^https?:\/\//i.test(r.url)).map(r => ({ url: r.url, title: r.title || r.url, at: new Date(Math.max(0, Number(r.last_visit_time) / 1e6 - EPOCH) * 1000).toISOString() })).reverse();
  }
  if (cookies) {
    const cookieFile = path.join(root, source.files['Network/Cookies'] ? 'Network/Cookies' : 'Cookies');
    const meta = await query(cookieFile, "SELECT value FROM meta WHERE key='version'");
    const version = Number(meta[0]?.value || 0);
    const columns = new Set((await query(cookieFile, 'PRAGMA table_info(cookies)')).map(r => r.name));
    if (columns.size) {
      const partition = columns.has('top_frame_site_key') ? 'top_frame_site_key' : "'' AS top_frame_site_key";
      const rows = await query(cookieFile, `SELECT host_key,name,value,hex(encrypted_value) AS encrypted,path,expires_utc,is_secure,is_httponly,samesite,${partition} FROM cookies LIMIT ${MAX_ROWS}`);
      for (const row of rows) {
        if (row.top_frame_site_key) { warn('cookies', 'Partitioned cookie cannot be represented by this Electron cookie API'); continue; }
        try {
          const host = typeof row.host_key === 'string' ? row.host_key : '';
          const hostname = host.replace(/^\./, '');
          let origin;
          try { origin = new URL(`${row.is_secure ? 'https' : 'http'}://${hostname}/`); } catch {}
          if (!origin || !hostname || origin.hostname !== hostname.toLowerCase() || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash || (row.path && !row.path.startsWith('/'))) { warn('cookies', 'Invalid cookie host or path'); continue; }
          const value = row.encrypted ? decryptMac(Buffer.from(row.encrypted, 'hex'), await key(), row.host_key, version) : row.value;
          const expires = Number(row.expires_utc) / 1e6 - EPOCH;
          if (Number(row.expires_utc) > 0 && expires <= Date.now() / 1000) { warn('cookies', 'Expired cookie'); continue; }
          const secure = Boolean(row.is_secure);
          output.cookies.push({ url: origin.href, ...(row.host_key.startsWith('.') ? { domain: row.host_key } : {}), name: row.name, value, path: row.path || '/', secure, httpOnly: Boolean(row.is_httponly), sameSite: ({ 0: 'no_restriction', 1: 'lax', 2: 'strict' })[row.samesite] || 'unspecified', ...(expires > 0 ? { expirationDate: expires } : {}) });
        } catch (failure) { warn('cookies', /authentication/.test(failure.message) ? 'Cookie domain authentication failed' : 'Unsupported encryption or unavailable source key'); }
      }
    }
  }
  if (passwords && source.files['Login Data']) {
    const rows = await query(path.join(root, 'Login Data'), `SELECT origin_url,username_value,hex(password_value) AS encrypted,blacklisted_by_user FROM logins LIMIT ${MAX_ROWS}`);
    for (const row of rows) {
      if (row.blacklisted_by_user || !/^https?:\/\//i.test(row.origin_url)) continue;
      try { output.passwords.push({ origin: new URL(row.origin_url).origin, username: row.username_value, password: decryptMac(Buffer.from(row.encrypted, 'hex'), await key()) }); }
      catch { warn('passwords', 'Unsupported encryption or unavailable source key'); }
    }
  }
  secret = undefined;
  for (const category of ['bookmarks', 'history', 'cookies', 'passwords']) output.counts[category] = output[category].length;
  return output;
}
async function readSelectedProfiles({ directories, ...options }) {
  if (!Array.isArray(directories) || directories.length < 1 || directories.length > 12) throw new Error('Select up to 12 Chromium profile folders');
  const roots = new Set();
  const result = { bookmarks: [], history: [], cookies: [], passwords: [], warnings: [], sources: 0 };
  const categories = ['bookmarks', 'history', 'cookies', 'passwords'];
  let sourceKey;
  for (const directory of directories) {
    let root;
    try {
      root = sourceDirectory(directory);
      if (roots.has(root)) continue;
      roots.add(root);
      const profile = await readProfile({ ...options, directory: root, getPassword: () => sourceKey ??= Promise.resolve().then(() => options.getPassword?.()) });
      result.sources++;
      for (const category of categories) {
        const room = MAX_ROWS - result[category].length;
        result[category].push(...profile[category].slice(0, room));
        if (profile[category].length > room) result.warnings.push({ category, count: profile[category].length - room, reason: 'Combined import limit reached' });
      }
      result.warnings.push(...profile.warnings);
    } catch (error) {
      if (directories.length === 1) throw error;
      result.warnings.push({ category: 'profiles', count: 1, reason: 'Selected profile could not be read' });
    }
  }
  return result;
}
function createCredentialVault({ dataDir, encrypt, decrypt }) {
  const file = path.join(dataDir, 'credentials.json');
  let entries = [];
  if (fs.existsSync(file)) { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Credential vault must not be a symlink'); entries = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(entries)) throw new Error('Invalid credential vault'); }
  const summary = entry => ({ id: entry.id, origin: entry.origin, username: entry.username });
  function httpOrigin(value) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Saved logins require an HTTP(S) origin'); return url.origin; }
  function save(next) {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch {} }
    entries = next;
  }
  return {
    list: () => entries.map(summary),
    import(rows) {
      // Encrypt all rows before mutating state: keychain failure cannot leave a half-import.
      const sealed = rows.map(row => ({ id: crypto.randomUUID(), origin: httpOrigin(row.origin), username: String(row.username || ''), sealed: Buffer.from(encrypt(row.password)).toString('base64') }));
      const next = entries.slice();
      for (const item of sealed) { const at = next.findIndex(e => e.origin === item.origin && e.username === item.username); if (at < 0) next.push(item); else next[at] = item; }
      if (sealed.length) save(next); return sealed.length;
    },
    remove(id) { save(entries.filter(e => e.id !== id)); },
    forOrigin(id, origin) { const entry = entries.find(e => e.id === id && e.origin === origin); if (!entry) throw new Error('Saved login does not match the active page origin'); return { username: entry.username, password: decrypt(Buffer.from(entry.sealed, 'base64')) }; },
  };
}
module.exports = { inspectProfile, readProfile, readSelectedProfiles, decryptMac, bookmarksFromJSON, createCredentialVault };

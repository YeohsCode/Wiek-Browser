import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inspectProfile, readProfile, readSelectedProfiles, decryptMac, createCredentialVault } = require('../app/profile-import.cjs');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const password = 'temporary fixture key';
function encrypted(value, domain, key = password) {
  const cipher = crypto.createCipheriv('aes-128-cbc', crypto.pbkdf2Sync(key, 'saltysalt', 1003, 16, 'sha1'), Buffer.alloc(16, 32));
  const plain = Buffer.concat([domain ? crypto.createHash('sha256').update(domain).digest() : Buffer.alloc(0), Buffer.from(value)]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vek-profile #'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { name: 'Bar', children: [{ type: 'url', name: 'Fixture', url: 'https://fixture.test/path' }, { type: 'url', url: 'javascript:alert(1)' }] } } }));
  execFileSync('/usr/bin/sqlite3', [path.join(root, 'History'), "CREATE TABLE urls(url,title,last_visit_time); INSERT INTO urls VALUES('https://fixture.test','Hello',13300000000000000);"]);
  return root;
}
test('selected Chromium profile read transaction includes WAL, handles path metacharacters, never needs a key for history/bookmarks', async t => {
  const root = await fixture(t);
  const live = new DatabaseSync(path.join(root, 'History')); live.exec("PRAGMA journal_mode=WAL; INSERT INTO urls VALUES('https://wal.test','Committed WAL',13300000000000001)"); t.after(()=>live.close());
  const info = await inspectProfile(root); assert.equal(info.files.Bookmarks, true);
  const result = await readProfile({ directory: root, getPassword: () => { throw new Error('Must not access keychain'); } });
  assert.equal(result.bookmarks.length, 1); assert.equal(result.bookmarks[0].folder, 'Bar');
  assert.equal(result.history.find(h=>h.title==='Hello').at, '2022-06-18T04:26:40.000Z');
  assert.equal(result.history.some(h=>h.title==='Committed WAL'),true);
  assert.deepEqual(result.counts, { bookmarks: 1, history: 2, cookies: 0, passwords: 0 });
});
test('mac v10 decryption validates host binding and rejects wrong/unknown keys', () => {
  const blob = encrypted('session fixture', '.fixture.test');
  assert.equal(decryptMac(blob, password, '.fixture.test', 24), 'session fixture');
  assert.throws(() => decryptMac(blob, password, '.other.test', 24), /authentication/);
  assert.throws(() => decryptMac(blob, 'wrong', '.fixture.test', 24));
  assert.throws(() => decryptMac(Buffer.from('v20test'), password), /Unsupported/);
});
test('cookies/password import decrypts fixtures, requests key once, reports partitioned/expired failures', async t => {
  const root = await fixture(t);
  const blob = encrypted('secret-value', '.fixture.test').toString('hex');
  execFileSync('/usr/bin/sqlite3', [path.join(root, 'Cookies'), `CREATE TABLE meta(key,value); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key,name,value,encrypted_value BLOB,path,expires_utc,is_secure,is_httponly,samesite,top_frame_site_key); INSERT INTO cookies VALUES('.fixture.test','session','',X'${blob}','/',0,1,1,1,''); INSERT INTO cookies VALUES('.fixture.test','partitioned','value',X'','/',0,1,1,1,'https://parent.test'); INSERT INTO cookies VALUES('.fixture.test','expired','value',X'','/',1,1,1,1,'');`]);
  execFileSync('/usr/bin/sqlite3', [path.join(root, 'Login Data'), `CREATE TABLE logins(origin_url,username_value,password_value BLOB,blacklisted_by_user); INSERT INTO logins VALUES('https://fixture.test/login','alice',X'${encrypted('fixture-password').toString('hex')}',0);`]);
  let calls = 0;
  const result = await readProfile({ directory: root, cookies: true, passwords: true, getPassword: () => { calls++; return password; } });
  assert.equal(calls, 1); assert.equal(result.cookies[0].value, 'secret-value'); assert.equal(result.cookies[0].httpOnly, true);
  assert.equal(result.passwords[0].origin, 'https://fixture.test'); assert.equal(result.passwords[0].password, 'fixture-password'); assert.equal(result.warnings.length, 2);
  const unavailable = await readProfile({ directory: root, cookies: true, getPassword: () => undefined });
  assert.equal(unavailable.cookies.length, 0); assert.equal(unavailable.warnings.length, 3);
});
test('vault stores only sealed secrets, deduplicates, requires exact origin, survives restart, and encrypts atomically', async t => {
  const root = await fixture(t);
  const key = crypto.randomBytes(32);
  const encrypt = value => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); };
  const decrypt = bytes => { const d = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); d.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString(); };
  let vault = createCredentialVault({ dataDir: root, encrypt, decrypt });
  vault.import([{ origin: 'https://fixture.test/login', username: 'alice', password: 'fixture-only-password' }]);
  const json = await fs.readFile(path.join(root, 'credentials.json'), 'utf8'); assert.equal(json.includes('fixture-only-password'), false);
  assert.equal((await fs.stat(path.join(root, 'credentials.json'))).mode & 0o777, 0o600);
  vault = createCredentialVault({ dataDir: root, encrypt, decrypt });
  const entry = vault.list()[0]; assert.equal('password' in entry, false); assert.equal('sealed' in entry, false);
  assert.throws(() => vault.forOrigin(entry.id, 'http://fixture.test'), /origin/);
  assert.equal(vault.forOrigin(entry.id, 'https://fixture.test').password, 'fixture-only-password');
  vault.import([{ origin: 'https://fixture.test', username: 'alice', password: 'replacement' }]); assert.equal(vault.list().length, 1);
  vault.remove(vault.list()[0].id); assert.equal(vault.list().length, 0);
  const broken = createCredentialVault({ dataDir: root, encrypt: () => { throw new Error('Keychain unavailable'); }, decrypt });
  assert.throws(() => broken.import([{ origin: 'https://fixture.test', password: 'x' }]), /Keychain/); assert.equal(broken.list().length, 0);
});


test('multi-profile import reads each selected canonical folder once and reports unreadable selections', async t => {
  const first = await fixture(t), second = await fixture(t);
  await fs.writeFile(path.join(second, 'Bookmarks'), JSON.stringify({
    roots: { bookmark_bar: { name: 'Second', children: [{ type: 'url', name: 'Second', url: 'https://second.test/' }] } }
  }));
  const alias = path.join(second, 'first-alias');
  await fs.symlink(first, alias);
  const firstBytes = await fs.readFile(path.join(first, 'Bookmarks'));
  const result = await readSelectedProfiles({
    directories: [first, path.join(second, 'missing'), alias, second],
    getPassword: () => { throw new Error('Unprotected categories must not access the source key'); }
  });
  assert.equal(result.sources, 2);
  assert.deepEqual(result.bookmarks.map(row => row.url), ['https://fixture.test/path', 'https://second.test/']);
  assert.equal(result.history.length, 2);
  assert.deepEqual(result.warnings, [{ category: 'profiles', count: 1, reason: 'Selected profile could not be read' }]);
  assert.deepEqual(await fs.readFile(path.join(first, 'Bookmarks')), firstBytes);
  await assert.rejects(readSelectedProfiles({ directories: [path.join(first, 'missing')] }), /ENOENT/);
  await assert.rejects(readSelectedProfiles({ directories: Array(13).fill(first) }), /up to 12/);
});

test('mixed browser import groups key requests by the selected source browser', async t => {
  const browserKeys = { chrome: 'chrome fixture key', edge: 'edge fixture key' };
  const selections = new Map();
  const calls = [];
  for (const [browser, name] of [['chrome', 'first'], ['edge', 'second'], ['chrome', 'third']]) {
    const root = await fixture(t);
    selections.set(root, browser);
    const db = new DatabaseSync(path.join(root, 'Login Data'));
    db.exec('CREATE TABLE logins(origin_url,username_value,password_value BLOB,blacklisted_by_user)');
    db.prepare('INSERT INTO logins VALUES (?, ?, ?, 0)').run('https://fixture.test', name, encrypted(name, null, browserKeys[browser]));
    db.close();
  }
  const result = await readSelectedProfiles({
    directories: [...selections.keys()],
    passwords: true,
    browserForDirectory: directory => selections.get(directory),
    getPassword: browser => { calls.push(browser); return browserKeys[browser]; },
  });
  assert.deepEqual(calls, ['chrome', 'edge']);
  assert.deepEqual(result.passwords.map(row => [row.username, row.password]), [['first', 'first'], ['second', 'second'], ['third', 'third']]);
  assert.deepEqual(result.warnings, []);
  const unavailable = await readSelectedProfiles({
    directories: [...selections.keys()],
    passwords: true,
    browserForDirectory: directory => selections.get(directory),
    getPassword: browser => {
      if (browser === 'edge') throw new Error('Fixture key was denied');
      return browserKeys[browser];
    },
  });
  assert.deepEqual(unavailable.passwords.map(row => row.password), ['first', 'third']);
  assert.deepEqual(unavailable.warnings, [{ category: 'passwords', reason: 'Unsupported encryption or unavailable source key', count: 1 }]);
});

test('the settings flow assigns each protected source and verifies the choices before reading credentials', { skip: process.platform !== 'darwin' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiek-mixed-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directories = [];
  for (const browser of ['chrome', 'edge']) {
    const directory = await fixture(t);
    directories.push(directory);
    const db = new DatabaseSync(path.join(directory, 'Cookies'));
    db.exec("CREATE TABLE meta(key,value); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key,name,value,encrypted_value BLOB,path,expires_utc,is_secure,is_httponly,samesite)");
    db.prepare("INSERT INTO cookies VALUES('.fixture.test', ?, '', ?, '/', 0, 1, 1, 1)").run(browser, encrypted(browser + ' cookie', '.fixture.test', browser + ' fixture key'));
    db.close();
  }
  const env = { ...process.env, WIEK_DATA_DIR: root, VEK_DATA_DIR: root, WIEK_MIXED_PROFILES: JSON.stringify(directories) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(import.meta.dirname, 'fixtures/profile-import-mixed-host.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', buffer => { output += buffer; });
  child.stderr.on('data', buffer => { output += buffer; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /"mixedSourceImport":true/);
});

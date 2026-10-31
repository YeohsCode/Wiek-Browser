import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { inspectProfile, readProfile, decryptMac, createCredentialVault } = createRequire(import.meta.url)('../app/profile-import.cjs');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const password = 'temporary fixture key';
function encrypted(value, domain) {
  const cipher = crypto.createCipheriv('aes-128-cbc', crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1'), Buffer.alloc(16, 32));
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

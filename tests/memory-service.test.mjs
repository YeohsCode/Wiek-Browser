import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createMemoryService } = createRequire(import.meta.url)('../app/memory-service.cjs');
async function harness(t, enabled = true) {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vek-memory-')), project = path.join(dir, 'project'); await fs.mkdir(project);
 let policy = { browserActivity: enabled, localFiles: enabled };
 const canonicalProject = await fs.realpath(project);
 const options = { dataDir: dir, policy: () => policy, projects: () => [{ id: 'p', path: canonicalProject }] };
 const service = createMemoryService(options); t.after(async () => { service.close(); await fs.rm(dir, { recursive: true, force: true }); });
 return { dir, project, service, options, policy: next => { policy = { ...policy, ...next }; service.syncPolicy(); }, dispatch: (action, payload = {}) => service.dispatch('memory:' + action, { profileId: 'one', ...payload }), page: (text, extra = {}) => service.indexPage('one', { url: 'https://fixture.test/page?token=not-retained#fragment', title: 'Page title', text, spaceId: 1, ...extra }) };
}
test('explicit page indexing stores bounded text, strips query/fragment, searches Chinese and English', async t => {
 const h = await harness(t); h.page('Some memory evidence. 中文全文检索 可以使用。');
 const snapshot = await h.dispatch('snapshot'); assert.equal(snapshot.documents.length, 1); assert.equal(snapshot.documents[0].source, 'https://fixture.test/page'); assert.equal(snapshot.documents[0].text, undefined);
 assert.equal((await h.dispatch('search', { query: 'MEMORY evidence' })).total, 1); assert.equal((await h.dispatch('search', { query: '全文检索' })).total, 1);
 const id = snapshot.documents[0].id; assert.match((await h.dispatch('read', { id })).text, /中文/);
 const file = path.join(h.dir, 'memory/state.json'); assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.ok(!(await fs.readFile(file, 'utf8')).includes('not-retained'));
});
test('profiles, project filters and Space filters do not mix documents', async t => {
 const h = await harness(t); h.page('visible keyword'); h.service.indexPage('two', { url: 'https://other.test/', title: 'secret', text: 'secret keyword', spaceId: 2 });
 const source = path.join(h.project, 'note.md'); await fs.writeFile(source, 'project keyword'); await h.dispatch('index:files', { projectId: 'p', paths: [source] });
 assert.equal((await h.dispatch('search', { query: 'keyword' })).total, 2); assert.equal((await h.dispatch('search', { query: 'secret' })).total, 0); assert.equal((await h.dispatch('search', { query: 'keyword', projectId: 'p' })).total, 1); assert.equal((await h.dispatch('search', { query: 'keyword', spaceId: 1 })).total, 1);
 const foreign = h.service.snapshot('two').documents[0].id; await assert.rejects(h.dispatch('read', { id: foreign }), /not found/); await assert.rejects(h.dispatch('remove', { id: foreign }), /not found/);
 await h.dispatch('clear'); assert.equal(h.service.snapshot('two').documents.length, 1);
});
test('selected text files yield partial failures, never crawl directories or follow symlinks', async t => {
 const h = await harness(t), valid = path.join(h.project, 'note.txt'), outside = path.join(h.dir, 'outside.txt'), link = path.join(h.project, 'link.txt'), bad = path.join(h.project, 'bad.txt'), huge = path.join(h.project, 'huge.txt');
 await fs.writeFile(valid, 'Selected file contents'); await fs.writeFile(outside, 'never index outside'); await fs.symlink(outside, link); await fs.writeFile(bad, Buffer.from([0xff, 0xfe])); await fs.writeFile(huge, 'x'.repeat(262145));
 const result = await h.dispatch('index:files', { projectId: 'p', paths: [valid, valid, outside, link, bad, huge, h.project] });
 assert.equal(result.indexed, 1); assert.equal(result.busy, false); assert.equal(result.warnings.length, 5); assert.equal(result.documents.length, 1); assert.equal((await h.dispatch('search', { query: 'outside' })).total, 0); assert.equal(await fs.readFile(valid, 'utf8'), 'Selected file contents');
 await assert.rejects(h.dispatch('index:files', { projectId: 'unknown', paths: [valid] }), /project/); await assert.rejects(h.dispatch('index:files', { projectId: 'p', paths: ['note.txt'] }), /absolute/);
});
test('upsert preserves document identity and replaces the saved search corpus; source changes require explicit reindex', async t => {
 const h = await harness(t), source = path.join(h.project, 'note.txt'); await fs.writeFile(source, 'before text'); const first = await h.dispatch('index:files', { projectId: 'p', paths: [source] });
 await fs.writeFile(source, 'after text'); assert.equal((await h.dispatch('search', { query: 'after' })).total, 0); assert.equal((await h.dispatch('search', { query: 'before' })).total, 1);
 const second = await h.dispatch('index:files', { projectId: 'p', paths: [source] }); assert.equal(second.documents.length, 1); assert.equal(first.documents[0].id, second.documents[0].id); assert.notEqual(first.documents[0].sha256, second.documents[0].sha256); assert.equal((await h.dispatch('search', { query: 'before' })).total, 0);
 h.page('first page'); const pageId = h.service.snapshot('one').documents.find(row => row.kind === 'page').id; h.page('replacement page'); assert.equal(h.service.snapshot('one').documents.find(row => row.kind === 'page').id, pageId);
});
test('disabled defaults reject capture; disabling purges that category across profiles and survives restart', async t => {
 const h = await harness(t, false); assert.throws(() => h.page('disabled'), /Enable/); await assert.rejects(h.dispatch('index:files', { projectId: 'p', paths: [] }), /Enable/);
 h.policy({ browserActivity: true, localFiles: true }); h.page('purge this'); h.service.indexPage('two', { url: 'https://two.test/', title: '', text: 'purge other', spaceId: 2 });
 const source = path.join(h.project, 'keep.txt'); await fs.writeFile(source, 'keep file'); await h.dispatch('index:files', { projectId: 'p', paths: [source] });
 h.policy({ browserActivity: false }); assert.equal(h.service.snapshot('one').documents.length, 1); assert.equal(h.service.snapshot('two').documents.length, 0); assert.ok(!(await fs.readFile(path.join(h.dir, 'memory/state.json'), 'utf8')).includes('purge this'));
 h.service.close(); const reopened = createMemoryService(h.options); assert.equal(reopened.snapshot('one').documents.length, 1); reopened.close();
});
test('cancel or policy disable during file reading commits no partial corpus', async t => {
 for (const how of ['cancel', 'clear', 'disable', 'forget']) {
  const h = await harness(t), source = path.join(h.project, 'note.txt'); await fs.writeFile(source, 'new content');
  let forgottenId;if(how==='forget'){const first=await h.dispatch('index:files',{projectId:'p',paths:[source]});forgottenId=first.documents[0].id;await fs.writeFile(source,'replacement pending text');}
  let entered, release; const started = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; }), original = fs.open;
  const mock = t.mock.method(fs, 'open', async (...args) => { entered(); await gate; return original(...args); });
  const pending = h.dispatch('index:files', { projectId: 'p', paths: [source] }); const rejected = assert.rejects(pending, /cancelled/); await started;
  if (how === 'disable') { h.policy({ localFiles: false }); h.policy({ localFiles: true }); } else if(how==='forget')await h.dispatch('remove',{id:forgottenId});else await h.dispatch(how);
  release(); await rejected; mock.mock.restore(); assert.equal(h.service.snapshot('one').documents.length, 0);
 }
});
test('concurrent indexing is rejected while an explicit selection is in progress', async t => {
 const h = await harness(t), source = path.join(h.project, 'note.txt'); await fs.writeFile(source, 'body');
 let release; const gate = new Promise(r => { release = r; }), original = fs.realpath;
 const mock = t.mock.method(fs, 'realpath', async (...args) => { await gate; return original(...args); });
 const first = h.dispatch('index:files', { projectId: 'p', paths: [source] }); await assert.rejects(h.dispatch('index:files', { projectId: 'p', paths: [source] }), /already running/); release(); await first; mock.mock.restore();
});
test('delete removes stored text, search does not execute content, and malformed inputs preserve corpus', async t => {
 const h = await harness(t); h.page('<img id=bad onerror=steal()> inert text'); const id = h.service.snapshot('one').documents[0].id;
 assert.match((await h.dispatch('search', { query: 'inert' })).results[0].snippet, /<img/);
 for (const query of ['', '  ', 'x'.repeat(513), 'a\0b', Array(18).fill('a').map((v,i)=>v+i).join(' ')]) await assert.rejects(h.dispatch('search', { query }), /query|terms/);
 assert.throws(() => h.page('x'.repeat(262145)), /text/); assert.equal(h.service.snapshot('one').documents.length, 1);
 await h.dispatch('remove', { id }); assert.equal((await h.dispatch('search', { query: 'inert' })).total, 0); assert.ok(!(await fs.readFile(path.join(h.dir, 'memory/state.json'), 'utf8')).includes('steal'));
});
test('private state validates hashes, rejects symlinks, and excludes a second owner', async t => {
 const h = await harness(t); h.page('retained'); assert.throws(() => createMemoryService(h.options), /already open/); h.service.close();
 const filename = path.join(h.dir, 'memory/state.json'), saved = JSON.parse(await fs.readFile(filename, 'utf8')); saved.documents[0].text = 'tampered'; await fs.writeFile(filename, JSON.stringify(saved)); assert.throws(() => createMemoryService(h.options), /hash/);
 await fs.rm(filename); await fs.symlink(path.join(h.dir, 'target.json'), filename); await fs.writeFile(path.join(h.dir, 'target.json'), '{}'); assert.throws(() => createMemoryService(h.options), /state file/);
});

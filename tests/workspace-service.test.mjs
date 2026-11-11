import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import workspace from '../app/workspace-service.cjs';
const execute = promisify(execFile);
async function fixture(t, git = false) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vek-workspace-test-'));
  const root = path.join(parent, 'project'); await fs.mkdir(root);
  const events = [], projects = [{ id: 'p', name: 'Fixture', path: root }];
  const service = workspace.createWorkspaceService({ projects: () => projects, onChange: value => events.push(value) });
  t.after(async () => { await service.close(); await fs.rm(parent, { recursive: true, force: true }); });
  const call = (action, payload = {}) => service.dispatch(`workspace:${action}`, { projectId: 'p', ...payload });
  const gitRun = (...args) => execute('git', ['-C', root, ...args]);
  if (git) { await gitRun('init'); await gitRun('config', 'user.name', 'Wiek Fixture'); await gitRun('config', 'user.email', 'fixture@example.test'); await gitRun('config', 'commit.gpgSign', 'false'); await fs.mkdir(path.join(parent, 'empty-hooks')); await gitRun('config', 'core.hooksPath', path.join(parent, 'empty-hooks')); }
  return { root, parent, service, call, gitRun, projects, events };
}

test('project scope rejects traversal, outside symlinks and protected Git metadata', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.parent, 'secret'), 'outside');
  await fs.symlink(path.join(f.parent, 'secret'), path.join(f.root, 'link'));
  await fs.mkdir(path.join(f.root, '.git')); await fs.writeFile(path.join(f.root, '.git/config'), 'internal');
  await fs.symlink(path.join(f.root, '.git/config'), path.join(f.root, 'git-alias'));
  for (const file of ['../secret', '/etc/passwd', 'link']) await assert.rejects(f.call('read', { path: file }), /project|relative|Symlink/);
  for (const file of ['.git/config', 'git-alias']) await assert.rejects(f.call('read', { path: file }), /Git internals/);
  await assert.rejects(f.service.dispatch('workspace:tree', { projectId: 'unknown' }), /registered project/);
  assert.equal(await fs.readFile(path.join(f.parent, 'secret'), 'utf8'), 'outside');
});

test('atomic text writes preserve contents, require hashes and detect external edits', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'notes.txt'), 'original');
  const read = await f.call('read', { path: 'notes.txt' }); assert.match(read.hash, /^[a-f0-9]{64}$/);
  await assert.rejects(f.call('write', { path: 'notes.txt', content: 'blind' }), /expectedHash/);
  const saved = await f.call('write', { path: 'notes.txt', content: 'saved', expectedHash: read.hash });
  assert.equal(saved.content, 'saved'); assert.notEqual(saved.hash, read.hash);
  await fs.writeFile(path.join(f.root, 'notes.txt'), 'external');
  await assert.rejects(f.call('write', { path: 'notes.txt', content: 'lost update', expectedHash: saved.hash }), /changed on disk/);
  assert.equal(await fs.readFile(path.join(f.root, 'notes.txt'), 'utf8'), 'external');
  const created = await f.call('write', { path: 'new.txt', content: 'new', expectedHash: null }); assert.equal(created.bytes, 3);
  assert.deepEqual((await fs.readdir(f.root)).filter(name => name.startsWith('.vek-save-')), []);
});

test('concurrent same-hash saves serialize so only the first succeeds', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'a'); const read = await f.call('read', { path: 'a.txt' });
  const results = await Promise.allSettled(['b', 'c'].map(content => f.call('write', { path: 'a.txt', content, expectedHash: read.hash })));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1); assert.equal(results.filter(item => item.status === 'rejected').length, 1);
});

test('tree/search are bounded, skip heavy folders and do not follow symlink directories', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'src')); await fs.mkdir(path.join(f.root, 'node_modules'));
  await fs.writeFile(path.join(f.root, 'src/code.js'), 'Alpha\nneedle here\nNEEDLE too'); await fs.writeFile(path.join(f.root, 'node_modules/ignored'), 'needle');
  await fs.symlink(f.parent, path.join(f.root, 'outside'));
  const tree = await f.call('tree'); assert.equal(tree.entries.some(item => item.name === 'node_modules'), false); assert.equal(tree.entries.find(item => item.name === 'outside').type, 'symlink');
  const found = await f.call('search', { query: 'needle' }); assert.deepEqual(found.results.map(item => item.line), [2, 3]);
  assert.equal(found.results.every(item => item.path === 'src/code.js'), true);
  assert.equal((await f.call('search', { query: 'needle', limit: 1 })).truncated, true);
  assert.equal((await f.call('tree', { limit: 1 })).truncated, true);
});

test('UTF-8 editor rejects binary/oversize files while artifacts support image metadata', async t => {
  const f = await fixture(t); const image = Buffer.from([137,80,78,71,0,13,10]); await fs.writeFile(path.join(f.root, 'image.png'), image);
  await fs.writeFile(path.join(f.root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1)); await fs.writeFile(path.join(f.root, 'page.html'), '<script>doNotExecute()</script>');
  await assert.rejects(f.call('read', { path: 'image.png' }), /Binary/); await assert.rejects(f.call('read', { path: 'large.txt' }), /2 MiB/);
  const preview = await f.call('preview', { path: 'image.png' }); assert.equal(preview.kind, 'image'); assert.equal(preview.base64, image.toString('base64'));
  const html = await f.call('preview', { path: 'page.html' }); assert.equal(html.kind, 'text'); assert.equal(html.content, '<script>doNotExecute()</script>');
  assert.equal((await f.call('artifacts')).items.some(item => item.name === 'page.html'), true);
});

test('Git supports real staging, committing, diff, history and branch switching', async t => {
  const f = await fixture(t, true); await fs.writeFile(path.join(f.root, 'hello.txt'), 'one\n');
  assert.equal((await f.call('git:status')).entries[0].status, '??');
  await f.call('git:stage', { paths: ['hello.txt'] }); assert.match((await f.call('git:diff', { staged: true })).stdout, /\+one/);
  await f.call('git:commit', { message: 'Initial fixture' }); const history = await f.call('git:log'); assert.equal(history.commits[0].subject, 'Initial fixture'); assert.match(history.commits[0].hash, /^[a-f0-9]{40}$/);
  const original = (await f.call('git:status')).branch;
  await f.call('git:branch:create', { name: 'feature-fixture', checkout: true }); assert.equal((await f.call('git:status')).branch, 'feature-fixture');
  assert.equal((await f.call('git:branches')).branches.find(item => item.name === 'feature-fixture').current, true);
  await f.call('git:branch:switch', { name: original }); assert.equal((await f.call('git:status')).branch, original);
  await fs.writeFile(path.join(f.root, 'hello.txt'), 'two\n'); await f.call('git:stage', { paths: ['hello.txt'] }); await f.call('git:unstage', { paths: ['hello.txt'] });
  assert.match((await f.call('git:diff')).stdout, /\+two/); assert.equal((await f.call('git:diff', { staged: true })).stdout, '');
});

test('Git stash lifecycle preserves real local modifications', async t => {
  const f = await fixture(t, true); await fs.writeFile(path.join(f.root, 'a'), 'before'); await f.gitRun('add', 'a'); await f.gitRun('commit', '-m', 'base');
  await fs.writeFile(path.join(f.root, 'a'), 'after'); await f.call('git:stash:push', { message: 'fixture save' }); assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'before');
  const list = await f.call('git:stash:list'); assert.equal(list.stashes.length, 1); assert.match(list.stashes[0].description, /fixture save/);
  await f.call('git:stash:pop', { stash: list.stashes[0].id }); assert.equal(await fs.readFile(path.join(f.root, 'a'), 'utf8'), 'after'); assert.equal((await f.call('git:stash:list')).stashes.length, 0);
});

test('Git rejects parent repository scope and option/pathspec injection', async t => {
  const f = await fixture(t, true); await fs.mkdir(path.join(f.root, 'nested')); f.projects.push({ id: 'nested', name: 'Nested', path: path.join(f.root, 'nested') });
  await assert.rejects(f.service.dispatch('workspace:git:status', { projectId: 'nested' }), /repository root/);
  await assert.rejects(f.call('git:branch:create', { name: '--help' }), /invalid/);
  await fs.writeFile(path.join(f.root, 'safe.txt'), 'keep unstaged'); await assert.rejects(f.call('git:stage', { paths: [':(top)*'] }), /did not match any files/);
  assert.equal((await f.call('git:status')).entries.find(item => item.path === 'safe.txt').index, '?');
});

test('project watchers report changes and close without leaking handles', async t => {
  const f = await fixture(t); const watching = await f.call('watch'); assert.equal(watching.watches.length, 1);
  await fs.writeFile(path.join(f.root, 'watched.txt'), 'changed');
  const changed = () => f.events.some(event => event.lastEvent?.type === 'files-changed' && event.lastEvent.changes?.some(item => item.path === 'watched.txt'));
  const deadline = performance.now() + 2500;
  while (!changed() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(changed(), true, JSON.stringify(f.events.map(event => event.lastEvent)));
  assert.equal((await f.call('watch', { enabled: false })).watches.length, 0);
  await f.service.close(); await assert.rejects(f.call('read', { path: 'watched.txt' }), /closed/);
});


test('new files cannot enter Git internals through a directory alias', async t => {
  const f = await fixture(t, true); await fs.symlink(path.join(f.root, '.git'), path.join(f.root, 'metadata-alias'));
  await assert.rejects(f.call('write', { path: 'metadata-alias/new-config', content: 'forbidden', expectedHash: null }), /Git internals/);
  await assert.rejects(fs.stat(path.join(f.root, '.git/new-config')), /ENOENT/);
  assert.deepEqual((await f.call('git:log')).commits, []);
});

test('Git filenames are literal argv and inherited Git-directory overrides are removed', async t => {
  const f = await fixture(t, true), name = '$(touch sentinel).txt'; await fs.writeFile(path.join(f.root, name), 'literal argv');
  const previous = process.env.GIT_WORK_TREE; process.env.GIT_WORK_TREE = f.parent;
  try { await f.call('git:stage', { paths: [name] }); const status = await f.call('git:status'); assert.equal(status.entries.find(item => item.path === name).index, 'A'); }
  finally { if (previous === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previous; }
  await assert.rejects(fs.stat(path.join(f.root, 'sentinel')), /ENOENT/);
});

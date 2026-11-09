import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), appRoot = process.env.VEK_WORKSPACE_APP_ROOT || path.resolve(import.meta.dirname, '..');
const workspace = require(path.join(appRoot, 'app/workspace-service.cjs')), remoteModule = require(path.join(appRoot, 'app/workspace-remote-git.cjs'));
const exec = promisify(execFile);
async function fixture(t, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vek-remote-git-')), root = path.join(parent, 'project'), bare = path.join(parent, 'remote.git'), other = path.join(parent, 'other');
  await fs.mkdir(root); await exec('git', ['init', '--bare', bare]);
  const git = async (...args) => (await exec('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Offline fixture'); await git('config', 'user.email', 'fixture@example.test'); await git('config', 'commit.gpgSign', 'false');
  await fs.writeFile(path.join(root, 'file.txt'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'Base'); await git('remote', 'add', 'origin', bare); await git('push', '-u', 'origin', 'main'); await git('checkout', '-b', 'feature');
  await fs.writeFile(path.join(root, 'file.txt'), 'feature\n'); await git('commit', '-am', 'Feature');
  const projects = [{ id: 'p', name: 'Offline Git', path: root }], events = [];
  const service = workspace.createWorkspaceService({ projects: () => projects, onChange: value => events.push(value), ...options });
  const call = (action, payload = {}) => service.dispatch('workspace:git:' + action, { projectId: 'p', ...payload });
  const prepare = (operation, payload = {}) => call('remote:prepare', { operation, remote: 'origin', ...payload });
  const run = value => call('remote:run', { reviewId: value.reviewId, confirm: true });
  const clone = async () => { await exec('git', ['clone', '--branch', 'main', bare, other]); const command = async (...args) => (await exec('git', ['-C', other, ...args], { encoding: 'utf8' })).stdout.trim(); await command('config', 'user.name', 'Other fixture'); await command('config', 'user.email', 'other@example.test'); return command; };
  t.after(async () => { await service.close(); await fs.rm(parent, { recursive: true, force: true }); });
  return { parent, root, bare, other, projects, service, call, prepare, run, git, clone, events };
}

test('configured remote listing and reviewed new-branch push use a real local bare Git remote', async t => {
  const f = await fixture(t), head = await f.git('rev-parse', 'HEAD');
  const listed = await f.call('remote:list'); assert.equal(listed.remotes[0].name, 'origin'); assert.equal(listed.remotes[0].push, f.bare);
  const review = await f.prepare('push'); assert.equal(review.review.branch, 'feature'); assert.equal(review.review.remoteHead, null); assert.equal(review.review.localHead, head);
  assert.equal((await exec('git', ['--git-dir', f.bare, 'show-ref', 'refs/heads/feature']).catch(() => ({ stdout: '' }))).stdout, '');
  await assert.rejects(f.call('remote:run', { reviewId: review.reviewId }), /Explicitly confirm/);
  const result = await f.run(review); assert.equal(result.state, 'succeeded'); assert.equal((await exec('git', ['--git-dir', f.bare, 'rev-parse', 'feature'])).stdout.trim(), head);
  await assert.rejects(f.run(review), /Review expired/); assert.equal(f.service.snapshot().remoteGit.jobs[0].state, 'succeeded');
});

test('one-use review rejects local edits, branch changes, wrong project and destination changes', async t => {
  const f = await fixture(t), review = await f.prepare('push');
  await fs.writeFile(path.join(f.root, 'new.txt'), 'external file'); const failed = await f.run(review); assert.equal(failed.errorCode, 'VEK_REMOTE_REVIEW_STALE'); assert.equal(failed.state, 'failed');
  await fs.unlink(path.join(f.root, 'new.txt')); const next = await f.prepare('push'); f.projects.push({ id: 'other', path: f.root });
  await assert.rejects(f.service.dispatch('workspace:git:remote:run', { projectId: 'other', reviewId: next.reviewId, confirm: true }), /another project/);
  await f.git('remote', 'set-url', 'origin', path.join(f.parent, 'different.git')); assert.equal((await f.run(next)).state, 'failed');
});

test('fetch downloads just the selected branch without moving HEAD or changing working bytes', async t => {
  const f = await fixture(t), other = await f.clone(), head = await f.git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(f.other, 'remote.txt'), 'remote change'); await other('add', '.'); await other('commit', '-m', 'Remote change'); await other('push', 'origin', 'main');
  await fs.writeFile(path.join(f.root, 'uncommitted.txt'), 'keep'); const review = await f.prepare('fetch', { branch: 'main' }); const result = await f.run(review);
  assert.equal(result.state, 'succeeded'); assert.equal(await f.git('rev-parse', 'refs/remotes/origin/main'), await other('rev-parse', 'HEAD')); assert.equal(await f.git('rev-parse', 'HEAD'), head); assert.equal(await fs.readFile(path.join(f.root, 'uncommitted.txt'), 'utf8'), 'keep');
});

test('pull applies a true fast-forward, refuses dirty/diverged states and never creates merge commits', async t => {
  const f = await fixture(t), other = await f.clone(); await f.git('checkout', 'main');
  await fs.writeFile(path.join(f.other, 'remote.txt'), 'remote'); await other('add', '.'); await other('commit', '-m', 'Remote'); await other('push', 'origin', 'main');
  await fs.writeFile(path.join(f.root, 'dirty'), 'local'); await assert.rejects(f.prepare('pull'), /clean working tree/); await fs.unlink(path.join(f.root, 'dirty'));
  assert.equal((await f.run(await f.prepare('pull'))).state, 'succeeded'); assert.equal(await f.git('rev-parse', 'HEAD'), await other('rev-parse', 'HEAD'));
  await fs.writeFile(path.join(f.root, 'local.txt'), 'local'); await f.git('add', '.'); await f.git('commit', '-m', 'Local'); const local = await f.git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(f.other, 'remote.txt'), 'remote again'); await other('commit', '-am', 'Remote again'); await other('push', 'origin', 'main');
  const result = await f.run(await f.prepare('pull')); assert.equal(result.state, 'failed'); assert.equal(await f.git('rev-parse', 'HEAD'), local); assert.equal(await fs.readFile(path.join(f.root, 'local.txt'), 'utf8'), 'local');
});

test('normal push rejects rewrites, explicit force-with-lease succeeds, stale remote review never writes', async t => {
  const f = await fixture(t); assert.equal((await f.run(await f.prepare('push'))).state, 'succeeded');
  await f.git('reset', '--hard', 'main'); await fs.writeFile(path.join(f.root, 'rewrite.txt'), 'rewrite'); await f.git('add', '.'); await f.git('commit', '-m', 'Rewrite');
  await assert.rejects(f.prepare('push'), /Normal push requires a known ancestor/); const force = await f.prepare('push', { force: true }); assert.equal(force.review.force, true); assert.equal((await f.run(force)).state, 'succeeded');
  const review = await f.prepare('push'), other = await f.clone(); await other('checkout', 'feature'); await fs.writeFile(path.join(f.other, 'racer'), 'racer'); await other('add', '.'); await other('commit', '-m', 'Racing commit'); await other('push', 'origin', 'feature');
  const expected = await other('rev-parse', 'HEAD'), result = await f.run(review); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'VEK_REMOTE_LEASE'); assert.equal((await exec('git', ['--git-dir', f.bare, 'rev-parse', 'feature'])).stdout.trim(), expected);
});

test('transport/options/multiple push destinations are refused and names remain literal argv', async t => {
  const f = await fixture(t); await f.git('remote', 'add', 'unsafe', 'ext::sh -c touch marker'); await assert.rejects(f.call('remote:prepare', { operation: 'push', remote: 'unsafe' }), /HTTPS\/SSH/);
  await f.git('remote', 'add', 'secret', 'https://user:password@example.test/r.git'); await assert.rejects(f.call('remote:prepare', { operation: 'push', remote: 'secret' }), /embedded credentials/);
  await assert.rejects(f.prepare('push', { branch: '--all' }), /valid branch/); await assert.rejects(f.call('remote:prepare', { operation: 'push', remote: '--all' }), /configured remote/);
  await f.git('config', '--add', 'remote.origin.pushurl', f.bare); await f.git('config', '--add', 'remote.origin.pushurl', path.join(f.parent, 'other.git')); await assert.rejects(f.prepare('push'), /exactly one/);
  await assert.rejects(fs.stat(path.join(f.root, 'marker')), { code: 'ENOENT' });
});

async function wrapperFixture(t, action) {
  const f = await fixture(t); await f.service.close(); const wrapper = path.join(f.parent, 'git-wrapper'), marker = path.join(f.parent, 'started');
  await fs.writeFile(wrapper, `#!${process.execPath}\nconst cp=require('node:child_process'),fs=require('node:fs');const args=process.argv.slice(2);if(args.includes(${JSON.stringify(action)})){fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});process.stderr.write('https://user:top-secret@example.test/r?token=hidden');setInterval(()=>{},1000);}else{const r=cp.spawnSync('/usr/bin/git',args,{env:process.env,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}\n`, { mode: 0o755 });
  const service = workspace.createWorkspaceService({ projects: () => f.projects, gitCommand: wrapper, remoteTimeoutMs: 2000 }); t.after(() => service.close());
  const call = (op, payload = {}) => service.dispatch('workspace:git:' + op, { projectId: 'p', ...payload });
  const waitStarted = async () => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (await fs.stat(marker).then(() => true).catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 15)); } throw new Error('wrapper did not start'); };
  return { ...f, service, call, waitStarted, marker };
}

test('cancel interrupts a real push process, marks remote outcome uncertain and cannot replay', async t => {
  const f = await wrapperFixture(t, 'push'), review = await f.call('remote:prepare', { operation: 'push', remote: 'origin' });
  const pending = f.call('remote:run', { reviewId: review.reviewId, confirm: true }); await f.waitStarted(); assert.equal((await f.call('remote:cancel', { id: review.reviewId })).cancelled, true);
  const result = await pending; assert.equal(result.state, 'uncertain'); assert.equal(result.errorCode, 'VEK_REMOTE_CANCELLED'); assert.doesNotMatch(JSON.stringify(result), /top-secret|hidden/); await assert.rejects(f.call('remote:run', { reviewId: review.reviewId, confirm: true }), /Review expired/);
});

test('timeout bounds real child lifetime; service close cancels children and reviewed fetch stays safe', async t => {
  const f = await wrapperFixture(t, 'fetch'), review = await f.call('remote:prepare', { operation: 'fetch', remote: 'origin', branch: 'main' });
  const start = Date.now(), result = await f.call('remote:run', { reviewId: review.reviewId, confirm: true }); assert.equal(result.errorCode, 'VEK_REMOTE_TIMEOUT'); assert.equal(result.state, 'failed'); assert.ok(Date.now() - start < 5000);
  await fs.unlink(f.marker); const next = await f.call('remote:prepare', { operation: 'fetch', remote: 'origin', branch: 'main' }), pending = f.call('remote:run', { reviewId: next.reviewId, confirm: true }); await f.waitStarted(); const pid = Number(await fs.readFile(f.marker, 'utf8')); await f.service.close(); assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH'); assert.equal((await pending).state, 'cancelled');
});

test('pending review cancellation is explicit and wrong-project cancellation cannot consume it', async t => {
  const f = await fixture(t), review = await f.prepare('push'); f.projects.push({ id: 'other', path: f.root });
  const wrong = await f.service.dispatch('workspace:git:remote:cancel', { projectId: 'other', id: review.reviewId }); assert.equal(wrong.cancelled, false);
  assert.equal((await f.call('remote:cancel', { id: review.reviewId })).cancelled, true); await assert.rejects(f.run(review), /Review expired/);
});

async function githubFixture(t) {
  const f = await fixture(t); await f.git('push', 'origin', 'feature'); await f.git('remote', 'add', 'github', 'https://github.com/offline/fixture.git'); await f.service.close();
  const gitWrapper = path.join(f.parent, 'git-gh-wrapper'), gh = path.join(f.parent, 'gh-fixture'), audit = path.join(f.parent, 'gh-audit.jsonl'), statePath = path.join(f.parent, 'pr.json'), modePath = path.join(f.parent, 'gh-mode');
  const state = { number: 7, title: '<script>inert</script>', body: 'body', state: 'open', draft: false, merged: false, head: { sha: await f.git('rev-parse', 'feature'), ref: 'feature' }, base: { sha: await f.git('rev-parse', 'main'), ref: 'main' }, updated_at: '2026-11-03T00:00:00Z' }; await fs.writeFile(statePath, JSON.stringify(state));
  await fs.writeFile(gitWrapper, `#!${process.execPath}\nconst cp=require('child_process');const a=process.argv.slice(2).map(x=>x==='https://github.com/offline/fixture.git'?${JSON.stringify(f.bare)}:x);const r=cp.spawnSync('/usr/bin/git',a,{env:process.env,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);\n`, { mode: 0o755 });
  await fs.writeFile(gh, `#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2),body=fs.readFileSync(0,'utf8'),method=a[a.indexOf('--method')+1],route=a[a.indexOf('-H')+4],pr=JSON.parse(fs.readFileSync(${JSON.stringify(statePath)},'utf8'));fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({a,body})+'\\n');const mode=fs.existsSync(${JSON.stringify(modePath)})?fs.readFileSync(${JSON.stringify(modePath)},'utf8'):'';if(mode==='auth'){process.stderr.write('HTTP 401 bad credentials secret-no-log');process.exit(1);}if(mode==='invalid'){process.stdout.write('invalid');process.exit(0);}if(mode==='reject-merge'&&method==='PUT'){process.stdout.write(JSON.stringify({merged:false,message:'Not mergeable'}));process.exit(0);}if(mode==='hold'&&method!=='GET'){setInterval(()=>{},1000);}else if(a.includes('Accept: application/vnd.github.diff')&&mode==='large-diff')process.stdout.write('x'.repeat(300000));else if(a.includes('Accept: application/vnd.github.diff'))process.stdout.write('diff --git a/file b/file\\n+literal <script>');else if(method==='GET')process.stdout.write(JSON.stringify(a.some(x=>x.includes('?state=all'))?[pr]:pr));else if(method==='POST'&&a.includes('repos/offline/fixture/pulls'))process.stdout.write(JSON.stringify({...pr,number:8,title:JSON.parse(body).title,draft:JSON.parse(body).draft}));else if(method==='PATCH')process.stdout.write(JSON.stringify({...pr,state:JSON.parse(body).state}));else process.stdout.write(JSON.stringify({id:9,merged:method==='PUT'}));\n`, { mode: 0o755 });
  const service = workspace.createWorkspaceService({ projects: () => f.projects, gitCommand: gitWrapper, ghCommand: gh, remoteTimeoutMs: 1500 }); t.after(() => service.close());
  const call = (op, payload = {}) => service.dispatch('workspace:git:' + op, { projectId: 'p', remote: 'github', ...payload });
  const readAudit = async () => (await fs.readFile(audit, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { ...f, service, call, state, statePath, modePath, readAudit };
}

test('GitHub list/detail/diff use fixed repository routes and inert bounded strings via a real synthetic gh process', async t => {
  const f = await githubFixture(t), list = await f.call('pr:list'); assert.equal(list.repository, 'offline/fixture'); assert.equal(list.pullRequests[0].title, '<script>inert</script>');
  const detail = await f.call('pr:detail', { number: 7 }); assert.match(detail.diff, /literal <script>/); assert.equal(detail.pullRequest.url, 'https://github.com/offline/fixture/pull/7');
  assert.equal((await f.readAudit()).every(row => row.a.includes('--hostname') && row.a.includes('github.com') && row.a.includes('GET')), true);
  await assert.rejects(f.call('pr:detail', { number: '--help' }), /number/); await assert.rejects(f.call('pr:list', { remote: 'origin' }), /github.com/);
});

test('PR create is reviewable and draft by default; literal multiline body reaches stdin only after confirmation', async t => {
  const f = await githubFixture(t), body = 'line one\n$(touch no-shell) `whoami` <script>inert</script>';
  const review = await f.call('pr:prepare', { operation: 'create', title: 'Review title', body, base: 'main' }); assert.equal(review.review.draft, true); assert.equal(review.review.repository, 'offline/fixture'); assert.equal((await f.readAudit()).length, 0);
  const job = await f.call('pr:run', { reviewId: review.reviewId, confirm: true }); assert.equal(job.state, 'succeeded'); assert.equal(job.result.number, 8);
  const audit = await f.readAudit(); assert.equal(audit.length, 1); assert.equal(audit[0].a.includes('--input'), true); assert.deepEqual(JSON.parse(audit[0].body), { title: 'Review title', body, base: 'main', head: 'offline:feature', draft: true }); await assert.rejects(fs.stat(path.join(f.root, 'no-shell')), { code: 'ENOENT' });
});

test('PR comment/state/merge require review and are bound to the exact pull request snapshot', async t => {
  const f = await githubFixture(t), review = await f.call('pr:prepare', { operation: 'comment', number: 7, body: 'Reviewed comment\nnext line' });
  await fs.writeFile(f.statePath, JSON.stringify({ ...f.state, updated_at: '2026-11-03T01:00:00Z' })); const stale = await f.call('pr:run', { reviewId: review.reviewId, confirm: true }); assert.equal(stale.errorCode, 'VEK_REMOTE_REVIEW_STALE'); assert.equal((await f.readAudit()).filter(row => row.a.includes('POST')).length, 0);
  for (const operation of ['comment', 'close', 'reopen', 'merge']) { const current = await f.call('pr:prepare', { operation, number: 7, body: 'Comment', method: 'squash' }); assert.equal((await f.call('pr:run', { reviewId: current.reviewId, confirm: true })).state, 'succeeded'); }
  const writes = (await f.readAudit()).filter(row => !row.a.includes('GET')); assert.equal(writes.length, 4); assert.deepEqual(JSON.parse(writes.at(-1).body), { sha: f.state.head.sha, merge_method: 'squash' });
});

test('authentication/protocol failures are explicit; uncertain PR POSTs are never retried', async t => {
  const f = await githubFixture(t); await fs.writeFile(f.modePath, 'auth'); await assert.rejects(f.call('pr:list'), error => error.error_code === 'VEK_REMOTE_AUTH' && !error.message.includes('secret-no-log'));
  await fs.writeFile(f.modePath, 'invalid'); await assert.rejects(f.call('pr:list'), error => error.error_code === 'VEK_PR_PROTOCOL'); await fs.writeFile(f.modePath, '');
  const review = await f.call('pr:prepare', { operation: 'comment', number: 7, body: 'One shot' }); await fs.writeFile(f.modePath, 'hold'); const result = await f.call('pr:run', { reviewId: review.reviewId, confirm: true }); assert.equal(result.state, 'uncertain'); assert.equal(result.errorCode, 'VEK_REMOTE_TIMEOUT'); assert.equal((await f.readAudit()).filter(row => row.a.includes('POST')).length, 1); await assert.rejects(f.call('pr:run', { reviewId: review.reviewId, confirm: true }), /Review expired/);
});

test('pure URL validation excludes credentials, remote helpers and unintended hosts', () => {
  for (const value of ['ext::sh', 'http://github.com/a/b', 'https://token@github.com/a/b', 'ssh://git:password@host/a', 'https://host/r?token=x']) assert.throws(() => remoteModule.transport(value, '/tmp'));
  assert.equal(remoteModule.github('git@github.com:owner/repo.git').fullName, 'owner/repo'); assert.throws(() => remoteModule.github('https://github.com.evil.test/a/b'));
});


test('PR branch publication checks, replaced reviews and rejected merge results never report false success', async t => {
  const f = await githubFixture(t);
  await fs.writeFile(path.join(f.root, 'later.txt'), 'later'); await f.git('add', '.'); await f.git('commit', '-m', 'Unpublished');
  await assert.rejects(f.call('pr:prepare', { operation: 'create', base: 'main', title: 'Unpublished' }), error => error.error_code === 'VEK_PR_UNPUSHED');
  const first = await f.call('pr:prepare', { operation: 'comment', number: 7, body: 'First' }), second = await f.call('pr:prepare', { operation: 'merge', number: 7 });
  await assert.rejects(f.call('pr:run', { reviewId: first.reviewId, confirm: true }), /Review expired/);
  await fs.writeFile(f.modePath, 'reject-merge'); const result = await f.call('pr:run', { reviewId: second.reviewId, confirm: true }); assert.equal(result.state, 'failed'); assert.equal(result.errorCode, 'VEK_PR_REJECTED');
});

test('server-side lease rejects a branch changed after the final read, preserving the racing commit', async t => {
  const f = await fixture(t); await f.run(await f.prepare('push')); const other = await f.clone(); await other('checkout', 'feature');
  await fs.writeFile(path.join(f.other, 'racer.txt'), 'racer'); await other('add', '.'); await other('commit', '-m', 'Racer'); const racer = await other('rev-parse', 'HEAD'); await other('push', 'origin', 'HEAD:refs/heads/staged-racer');
  await f.service.close(); const wrapper = path.join(f.parent, 'lease-race');
  await fs.writeFile(wrapper, `#!${process.execPath}\nconst cp=require('child_process'),a=process.argv.slice(2);if(a.includes('push'))cp.spawnSync('/usr/bin/git',['--git-dir',${JSON.stringify(f.bare)},'update-ref','refs/heads/feature',${JSON.stringify(racer)}]);const r=cp.spawnSync('/usr/bin/git',a,{env:process.env,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);\n`, {mode:0o755});
  const service = workspace.createWorkspaceService({projects:()=>f.projects,gitCommand:wrapper}); t.after(()=>service.close());
  const review = await service.dispatch('workspace:git:remote:prepare',{projectId:'p',remote:'origin',operation:'push'}), result = await service.dispatch('workspace:git:remote:run',{projectId:'p',reviewId:review.reviewId,confirm:true});
  assert.equal(result.errorCode,'VEK_REMOTE_LEASE'); assert.equal(result.state,'uncertain'); assert.equal((await exec('git',['--git-dir',f.bare,'rev-parse','feature'])).stdout.trim(),racer);
});


test('large PR diffs have an explicit bounded preview instead of a silently shortened full-diff claim', async t => {
  const f = await githubFixture(t); await fs.writeFile(f.modePath, 'large-diff');
  const detail = await f.call('pr:detail', { number: 7 }); assert.equal(detail.diffTruncated, true); assert.equal(detail.diffLimitBytes, 256 * 1024); assert.equal(Buffer.byteLength(detail.diff), detail.diffLimitBytes);
});

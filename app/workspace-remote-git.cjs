'use strict';
// Independent, explicit remote operations. Reviews are ephemeral capabilities, never credentials.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fail = (message, code = 'VEK_REMOTE_GIT_ERROR') => Object.assign(new Error(message), { error_code: code });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const objectId = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || '');
const MAX_BYTES = 2 * 1024 * 1024;
function redact(value, limit = 12000) {
  return String(value || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@').replace(/([?&](?:token|key|password|access_token)=)[^\s&]+/gi, '$1[redacted]').slice(0, limit);
}
function transport(raw, root) {
  if (typeof raw !== 'string' || !raw || /[\x00-\x1f\x7f]/.test(raw) || raw.startsWith('-')) throw fail('Remote URL is invalid');
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s]+$/.test(raw)) return { url: raw, display: raw };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { url: path.resolve(root, raw), display: path.resolve(root, raw) };
  let url; try { url = new URL(raw); } catch { throw fail('Remote URL is invalid'); }
  if (!['https:', 'ssh:', 'file:'].includes(url.protocol) || url.password || url.search || url.hash || (url.protocol === 'https:' && url.username)) throw fail('Use an HTTPS/SSH or local Git remote without embedded credentials', 'VEK_REMOTE_TRANSPORT');
  return { url: url.href, display: url.href };
}
function github(url) {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match || ['.', '..'].includes(match[1]) || ['.', '..'].includes(match[2])) throw fail('Pull requests require a configured github.com HTTPS or SSH remote', 'VEK_PR_REMOTE');
  return { owner: match[1], name: match[2], fullName: match[1] + '/' + match[2] };
}
function createRemoteGit({ gitCommand = 'git', ghCommand = 'gh', timeoutMs = 90000, publish = () => {} } = {}) {
  const reviews = new Map(), jobs = new Map(), running = new Map(); let closed = false;
  const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !['GH_DEBUG', 'GH_FORCE_TTY', 'GH_BROWSER', 'BROWSER', 'SSH_ASKPASS'].includes(key))), GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', LC_ALL: 'C' });
  function processRun(command, args, ctx, control, input) {
    if (closed) return Promise.reject(fail('Remote Git service is closed'));
    if (control?.cancelled) return Promise.reject(fail('Operation cancelled', 'VEK_REMOTE_CANCELLED'));
    let completed;
    const done = new Promise(resolve => { completed = resolve; });
    return new Promise((resolve, reject) => {
      let child, stdout = '', stderr = '', bytes = 0, reason = '', finished = false;
      try { child = spawn(command, args, { cwd: ctx.root, env: environment(), shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { reject(fail('Cannot start the configured command', 'VEK_REMOTE_COMMAND_UNAVAILABLE')); return; }
      const kill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {} };
      const hardKill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
      let escalator;
      const stop = why => { if (finished) return; reason = why; kill(); escalator ||= setTimeout(hardKill, 500); escalator.unref?.(); };
      const handle = { stop, child, done }; if (control) control.handle = handle;
      running.set(child, handle);
      const timer = setTimeout(() => stop('timeout'), Math.max(20, timeoutMs)); timer.unref?.();
      const add = key => data => { bytes += Buffer.byteLength(data, 'utf8'); if (bytes > MAX_BYTES) { stop('output'); return; } if (key === 'out') stdout += data.toString('utf8'); else stderr += data.toString('utf8'); };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', add('out')); child.stderr.on('data', add('err')); child.stdin.on('error', () => {}); child.stdin.end(input === undefined ? undefined : input);
      let spawnError = false; child.on('error', () => { spawnError = true; });
      child.on('close', code => {
        finished = true; clearTimeout(timer); clearTimeout(escalator); running.delete(child); if (control?.handle === handle) control.handle = null; completed();
        if (reason) return reject(fail(reason === 'cancelled' ? 'Operation cancelled; remote writes may already have reached the server. Refresh before retrying.' : reason === 'timeout' ? 'Operation timed out; refresh the remote before retrying a write.' : 'Command output exceeded the 2 MiB limit', reason === 'cancelled' ? 'VEK_REMOTE_CANCELLED' : reason === 'timeout' ? 'VEK_REMOTE_TIMEOUT' : 'VEK_REMOTE_OUTPUT_LIMIT'));
        if (spawnError) return reject(fail('Git or GitHub CLI is unavailable. Install the command and configure authentication outside this panel.', 'VEK_REMOTE_COMMAND_UNAVAILABLE'));
        if (code !== 0) {
          const text = stderr + stdout;
          const [message, errorCode] = /authenticat|permission denied|could not read username|not logged|bad credentials|http 401|http 403/i.test(text) ? ['Authentication or repository access failed. Configure Git/gh credentials outside this panel.', 'VEK_REMOTE_AUTH'] : /stale info|fetch first|non-fast-forward|rejected/i.test(text) ? ['Remote branch changed or rejected the update. Fetch and review again.', 'VEK_REMOTE_LEASE'] : ['Remote command failed. Refresh before retrying; no automatic retry was sent.', 'VEK_REMOTE_COMMAND_FAILED'];
          return reject(fail(message, errorCode));
        }
        resolve({ stdout, stderr });
      });
    });
  }
  const git = (ctx, args, control) => processRun(gitCommand, ['--literal-pathspecs', '--no-optional-locks', '-C', ctx.root, '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'core.sshCommand=ssh -oBatchMode=yes', ...args], ctx, control);
  function branch(value) { if (typeof value !== 'string' || !value || value.length > 200 || value.startsWith('-') || /[\s\x00-\x1f]/.test(value)) throw fail('Choose a valid branch'); return value; }
  async function validBranch(ctx, value, control) { value = branch(value); await git(ctx, ['check-ref-format', 'refs/heads/' + value], control); return value; }
  async function remote(ctx, name, control, push = false) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name.startsWith('-')) throw fail('Choose a configured remote');
    const urls = (await git(ctx, ['remote', 'get-url', '--all', ...(push ? ['--push'] : []), name], control)).stdout.trim().split('\n');
    if (urls.length !== 1) throw fail('Select a remote with exactly one destination', 'VEK_REMOTE_MULTIPLE_URLS');
    return { name, ...transport(urls[0], ctx.root) };
  }
  async function local(ctx, control) {
    const head = (await git(ctx, ['rev-parse', '--verify', 'HEAD'], control)).stdout.trim();
    const name = (await git(ctx, ['symbolic-ref', '--short', '-q', 'HEAD'], control)).stdout.trim();
    const status = (await git(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], control)).stdout;
    if (!objectId(head)) throw fail('Choose a branch with a commit');
    return { head, branch: name, statusHash: digest(status), clean: status.length === 0 };
  }
  async function tip(ctx, url, name, control) {
    const raw = (await git(ctx, ['ls-remote', '--refs', '--', url, 'refs/heads/' + name], control)).stdout.trim();
    if (!raw) return '';
    const rows = raw.split('\n'); if (rows.length !== 1) throw fail('Remote returned an ambiguous branch');
    const [oid, ref] = rows[0].split('\t'); if (!objectId(oid) || ref !== 'refs/heads/' + name) throw fail('Remote returned an invalid branch'); return oid;
  }
  function remember(record) {
    for (const [id, row] of reviews) if (row.expiresAt < Date.now()) reviews.delete(id);
    for (const [id, row] of reviews) if (row.root === record.root && row.projectId === record.projectId) reviews.delete(id);
    if (reviews.size >= 32) throw fail('Too many pending reviews; finish or cancel an earlier review');
    record.id = crypto.randomUUID(); record.expiresAt = Date.now() + 120000; reviews.set(record.id, record);
    return { review: clone(record.public), reviewId: record.id, expiresAt: new Date(record.expiresAt).toISOString() };
  }
  function take(ctx, payload) {
    const row = reviews.get(payload.reviewId);
    if (!row || row.expiresAt < Date.now() || row.root !== ctx.root || row.projectId !== payload.projectId) throw fail('Review expired or belongs to another project. Prepare a fresh review.', 'VEK_REMOTE_REVIEW_REQUIRED');
    if (payload.confirm !== true) throw fail('Explicitly confirm this reviewed operation', 'VEK_REMOTE_CONFIRM_REQUIRED');
    reviews.delete(row.id); return row;
  }
  function event(job) { try { publish({ type: 'remote-git', projectId: job.projectId, job: clone(job) }); } catch {} }
  function snapshot() { return { jobs: [...jobs.values()].map(clone), pendingReviews: reviews.size }; }
  async function executeReview(ctx, payload) {
    const row = take(ctx, payload), control = { id: row.id, cancelled: false, handle: null };
    const job = { id: row.id, projectId: payload.projectId, operation: row.operation, state: 'running', startedAt: new Date().toISOString(), remote: row.public.remote, message: '' };
    while (jobs.size >= 32) { const old = [...jobs].find(([, value]) => value.state !== 'running'); if (!old) throw fail('Too many active remote operations'); jobs.delete(old[0]); }
    jobs.set(job.id, job); running.set(control, { control, projectId: payload.projectId }); event(job);
    let writeStarted = false;
    try {
      const now = await local(ctx, control), currentRemote = await remote(ctx, row.name, control, row.operation === 'push');
      if (digest(now) !== digest(row.local) || currentRemote.url !== row.url) throw fail('Project or destination changed after review. Prepare a fresh review.', 'VEK_REMOTE_REVIEW_STALE');
      if (row.kind === 'pr') {
        if (row.operation === 'pr:create') {
          if (await tip(ctx, row.url, row.local.branch, control) !== row.local.head) throw fail('Push the reviewed branch before creating a pull request', 'VEK_PR_UNPUSHED');
          if (await tip(ctx, row.url, row.body.base, control) !== row.baseTip) throw fail('Base branch changed after review. Prepare a fresh review.', 'VEK_REMOTE_REVIEW_STALE');
        } else {
          const current = await api(ctx, row.repo, 'GET', '/pulls/' + row.number, undefined, control);
          if (digest(prState(current)) !== digest(row.prState)) throw fail('Pull request changed after review. Read and review it again.', 'VEK_REMOTE_REVIEW_STALE');
        }
        writeStarted = true;
        const response = await api(ctx, row.repo, row.method, row.endpoint, row.body, control);
        if (row.operation === 'pr:merge' && response?.merged !== true) throw Object.assign(fail('GitHub did not merge this pull request. Refresh its status and branch protection checks.', 'VEK_PR_REJECTED'), { definitiveFailure: true });
        if (row.operation === 'pr:comment' && (!Number.isSafeInteger(response?.id) || response.id < 1)) throw fail('GitHub returned an invalid comment response', 'VEK_PR_PROTOCOL');
        if (['pr:close', 'pr:reopen'].includes(row.operation) && (response?.number !== row.number || response.state !== row.body.state)) throw fail('GitHub did not confirm the requested pull request state', 'VEK_PR_PROTOCOL');
        job.result = normalizePrResult(response, row.repo, row.number);
      } else {
        const actual = await tip(ctx, row.url, row.branch, control);
        if (actual !== row.tip) throw fail('Remote branch changed after review. Prepare a fresh review.', 'VEK_REMOTE_LEASE');
        if (row.operation === 'push') {
          writeStarted = true;
          await git(ctx, ['push', '--porcelain', '--no-follow-tags', '--force-with-lease=refs/heads/' + row.branch + ':' + row.tip, '--', row.url, row.local.head + ':refs/heads/' + row.branch], control);
        } else {
          if (!actual) throw fail('Remote branch no longer exists', 'VEK_REMOTE_LEASE');
          const tracking = 'refs/remotes/' + row.name + '/' + row.branch;
          await git(ctx, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', row.url, '+refs/heads/' + row.branch + ':' + tracking], control);
          const fetched = (await git(ctx, ['rev-parse', '--verify', tracking], control)).stdout.trim();
          if (fetched !== actual) throw fail('Remote changed while fetching. Review the downloaded branch again.', 'VEK_REMOTE_LEASE');
          if (row.operation === 'pull') {
            if (digest(await local(ctx, control)) !== digest(row.local)) throw fail('Local files or branch changed during fetch; fast-forward was not applied', 'VEK_REMOTE_REVIEW_STALE');
            await git(ctx, ['merge', '--ff-only', '--no-edit', actual], control);
          }
        }
        job.result = { remote: row.public.remote, branch: row.branch, head: row.local.head, remoteHead: row.tip };
      }
      job.state = 'succeeded'; job.message = 'Completed the reviewed operation.';
    } catch (error) {
      job.state = writeStarted && !error.definitiveFailure ? 'uncertain' : error.error_code === 'VEK_REMOTE_CANCELLED' ? 'cancelled' : 'failed';
      job.errorCode = error.error_code || 'VEK_REMOTE_GIT_ERROR'; job.message = redact(error.message);
      if (job.state === 'uncertain') job.message += ' A remote write may have succeeded. Read the remote before preparing another write; this review cannot be replayed.';
    } finally {
      running.delete(control); job.finishedAt = new Date().toISOString(); event(job);
    }
    return clone(job);
  }
  async function api(ctx, repo, method, suffix, input, control, diff = false) {
    const args = ['api', '--hostname', 'github.com', '--method', method, '-H', 'Accept: ' + (diff ? 'application/vnd.github.diff' : 'application/vnd.github+json'), '-H', 'X-GitHub-Api-Version: 2022-11-28', 'repos/' + repo.fullName + suffix];
    if (input !== undefined) args.push('--input', '-');
    const result = await processRun(ghCommand, args, ctx, control, input === undefined ? undefined : JSON.stringify(input));
    if (diff) { const bytes = Buffer.from(result.stdout, 'utf8'), limitBytes = 256 * 1024; return { text: redact(bytes.subarray(0, limitBytes).toString('utf8'), Infinity), truncated: bytes.length > limitBytes, limitBytes }; }
    try { return JSON.parse(result.stdout); } catch { throw fail('GitHub CLI returned invalid JSON', 'VEK_PR_PROTOCOL'); }
  }
  function prState(value) { return { number: value?.number, state: value?.state, head: value?.head?.sha, base: value?.base?.sha, updatedAt: value?.updated_at, merged: value?.merged }; }
  function publicPr(value, repo) {
    if (!Number.isSafeInteger(value?.number) || value.number < 1 || !['open', 'closed'].includes(value.state) || !objectId(value?.head?.sha) || !objectId(value?.base?.sha)) throw fail('GitHub returned an invalid pull request', 'VEK_PR_PROTOCOL');
    return { number: value.number, title: String(value.title || '').slice(0, 1000), body: String(value.body || '').slice(0, 50000), bodyTruncated: String(value.body || '').length > 50000, state: value.state, draft: Boolean(value.draft), merged: Boolean(value.merged), head: value.head.ref, headSha: value.head.sha, base: value.base.ref, baseSha: value.base.sha, url: 'https://github.com/' + repo.fullName + '/pull/' + value.number, updatedAt: value.updated_at };
  }
  function normalizePrResult(value, repo, number) {
    if (Number.isSafeInteger(value?.number)) return publicPr(value, repo);
    return { number: number || null, url: number ? 'https://github.com/' + repo.fullName + '/pull/' + number : null, message: 'GitHub accepted the request. Refresh the pull request to verify its current state.' };
  }
  function number(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw fail('Choose a pull request number'); return value; }
  function text(value, label, max, optional = false) { if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()) || value.includes('\0')) throw fail(label + ' is invalid'); return value; }
  async function dispatch(ctx, payload, operation) {
    if (closed) throw fail('Remote Git service is closed');
    if (operation === 'remote:status') return snapshot();
    if (operation === 'remote:cancel') {
      const candidate = reviews.get(payload.id), review = candidate?.projectId === payload.projectId && candidate.root === ctx.root ? candidate : null;
      if (review) reviews.delete(payload.id);
      const row = [...running.values()].find(value => value.control && value.projectId === payload.projectId && jobs.get(payload.id)?.id === payload.id && jobs.get(payload.id)?.state === 'running' && value.control.id === payload.id);
      if (row) { row.control.cancelled = true; row.control.handle?.stop('cancelled'); }
      return { cancelled: Boolean(review || row), ...snapshot() };
    }
    if (operation === 'remote:run' || operation === 'pr:run') return executeReview(ctx, payload);
    if (operation === 'remote:list') {
      const names = (await git(ctx, ['remote'])).stdout.trim().split('\n').filter(Boolean), remotes = [];
      for (const name of names.slice(0, 100)) { try { const fetched = await remote(ctx, name), pushed = await remote(ctx, name, undefined, true); remotes.push({ name, fetch: fetched.display, push: pushed.display, github: (() => { try { return github(fetched.url).fullName; } catch { return null; } })() }); } catch (error) { remotes.push({ name, error: error.message }); } }
      return { projectId: payload.projectId, remotes };
    }
    if (operation === 'remote:prepare') {
      const op = payload.operation;
      if (!['fetch', 'pull', 'push'].includes(op)) throw fail('Choose fetch, pull or push');
      const target = await remote(ctx, payload.remote, undefined, op === 'push'), state = await local(ctx), name = await validBranch(ctx, payload.branch || state.branch), remoteTip = await tip(ctx, target.url, name);
      if (op === 'pull' && (!state.clean || state.branch !== name)) throw fail('Fast-forward pull requires the selected current branch and a clean working tree', 'VEK_PULL_DIRTY');
      if (op !== 'push' && !remoteTip) throw fail('Selected remote branch does not exist');
      const force = payload.force === true;
      if (force && op !== 'push') throw fail('Force applies only to push');
      if (op === 'push' && remoteTip && !force) await git(ctx, ['merge-base', '--is-ancestor', remoteTip, state.head]).catch(() => { throw fail('Normal push requires a known ancestor. Fetch this branch first; use reviewed force-with-lease only for an intentional rewrite.', 'VEK_PUSH_DIVERGED'); });
      const record = { root: ctx.root, projectId: payload.projectId, kind: 'git', operation: op, name: target.name, url: target.url, branch: name, tip: remoteTip, local: state };
      record.public = { operation: op, remote: target.name, destination: target.display, branch: name, localBranch: state.branch, localHead: state.head, remoteHead: remoteTip || null, force, clean: state.clean, policy: op === 'push' ? force ? 'Explicit rewrite with an exact remote-object lease' : 'Fast-forward or new branch, with an exact remote-object lease' : op === 'pull' ? 'Fetch one branch and fast-forward only; no rebase or auto stash' : 'Fetch one branch; working files and HEAD stay in place' };
      return remember(record);
    }
    if (operation.startsWith('pr:')) {
      const target = await remote(ctx, payload.remote), repo = github(target.url);
      if (operation === 'pr:list') {
        const values = await api(ctx, repo, 'GET', '/pulls?state=all&per_page=30'); if (!Array.isArray(values) || values.length > 30) throw fail('GitHub returned an invalid list', 'VEK_PR_PROTOCOL');
        return { projectId: payload.projectId, repository: repo.fullName, pullRequests: values.map(value => publicPr(value, repo)), limit: 30 };
      }
      if (operation === 'pr:detail') {
        const selected = number(payload.number), value = await api(ctx, repo, 'GET', '/pulls/' + selected), diff = await api(ctx, repo, 'GET', '/pulls/' + selected, undefined, undefined, true);
        return { projectId: payload.projectId, repository: repo.fullName, pullRequest: publicPr(value, repo), diff: diff.text, diffTruncated: diff.truncated, diffLimitBytes: diff.limitBytes };
      }
      if (operation !== 'pr:prepare') throw fail('Unsupported pull request operation');
      const op = payload.operation, state = await local(ctx), record = { root: ctx.root, projectId: payload.projectId, kind: 'pr', operation: 'pr:' + op, name: target.name, url: target.url, repo, local: state };
      let publicValue;
      if (op === 'create') {
        const base = await validBranch(ctx, payload.base), title = text(payload.title, 'Title', 1000), body = text(payload.body || '', 'Body', 50000, true);
        if (base === state.branch) throw fail('Base and head branches must differ');
        if (await tip(ctx, target.url, state.branch) !== state.head) throw fail('Push this exact branch before creating a pull request', 'VEK_PR_UNPUSHED');
        record.baseTip = await tip(ctx, target.url, base);
        if (!record.baseTip) throw fail('Base branch does not exist on this remote');
        record.method = 'POST'; record.endpoint = '/pulls'; record.body = { title, body, base, head: repo.owner + ':' + state.branch, draft: payload.draft !== false };
        publicValue = { title, body, base, head: state.branch, draft: record.body.draft };
      } else {
        record.number = number(payload.number);
        const value = await api(ctx, repo, 'GET', '/pulls/' + record.number); publicValue = publicPr(value, repo); record.prState = prState(value);
        if (op === 'comment') { record.method = 'POST'; record.endpoint = '/issues/' + record.number + '/comments'; record.body = { body: text(payload.body, 'Comment', 50000) }; publicValue = { ...publicValue, comment: record.body.body }; }
        else if (['close', 'reopen'].includes(op)) { if (value.merged) throw fail('A merged pull request cannot be reopened or closed'); record.method = 'PATCH'; record.endpoint = '/pulls/' + record.number; record.body = { state: op === 'close' ? 'closed' : 'open' }; }
        else if (op === 'merge') {
          if (value.state !== 'open' || value.draft) throw fail('Only an open, ready pull request can be merged');
          const method = payload.method || 'merge'; if (!['merge', 'squash', 'rebase'].includes(method)) throw fail('Choose a merge method');
          record.method = 'PUT'; record.endpoint = '/pulls/' + record.number + '/merge'; record.body = { sha: value.head.sha, merge_method: method }; publicValue = { ...publicValue, mergeMethod: method };
        } else throw fail('Choose create, comment, close, reopen or merge');
      }
      record.public = { operation: record.operation, remote: target.name, destination: target.display, repository: repo.fullName, localHead: state.head, ...publicValue };
      return remember(record);
    }
    throw fail('Unsupported remote Git operation');
  }
  async function close() { closed = true; reviews.clear(); const handles = [...running.values()].filter(handle => handle.stop); for (const handle of handles) handle.stop('cancelled'); await Promise.allSettled(handles.map(handle => handle.done)); }
  return { dispatch, snapshot, close };
}
module.exports = { createRemoteGit, redact, transport, github };

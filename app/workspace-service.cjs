'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRemoteGit } = require('./workspace-remote-git.cjs');
const { repositoryLayout } = require('./repository-layout.cjs');
const execute = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IGNORED = new Set(['.git', 'node_modules', '.next', '.cache', 'dist', 'build']);
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const fail = (message, code = 'VEK_WORKSPACE_ERROR') => Object.assign(new Error(message), { error_code: code });
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const clone = value => JSON.parse(JSON.stringify(value));
const cap = (value, fallback, max) => Math.max(1, Math.min(max, Math.floor(Number(value) || fallback)));

function createWorkspaceService({ projects, onChange = () => {}, gitCommand = 'git', ghCommand = 'gh', remoteTimeoutMs } = {}) {
  if (typeof projects !== 'function') throw new TypeError('projects must return the registered project list');
  let closed = false, sequence = 0, lastEvent = null;
  const watches = new Map(), mutations = new Map();
  const remoteGit = createRemoteGit({ gitCommand, ghCommand, timeoutMs: remoteTimeoutMs, publish });
  async function serialized(key, fn) {
    const previous = mutations.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn); mutations.set(key, current);
    try { return await current; } finally { if (mutations.get(key) === current) mutations.delete(key); }
  }
  async function context(payload) {
    if (closed) throw fail('Workspace service is closed');
    const entry = projects().find(item => item.id === payload.projectId);
    if (!entry) throw fail('Choose a registered project', 'VEK_PROJECT_NOT_FOUND');
    const root = await fsp.realpath(entry.path);
    if (!(await fsp.stat(root)).isDirectory()) throw fail('Project path is not a directory');
    return { root, project: entry };
  }
  function relative(value, allowRoot = false) {
    const name = value ?? '';
    if (typeof name !== 'string' || name.includes('\0') || name.includes('\\') || path.isAbsolute(name) || name.split('/').includes('..')) throw fail('Use a project-relative path without traversal', 'VEK_PATH_OUTSIDE_PROJECT');
    const normalized = path.posix.normalize(name || '.');
    if (normalized.split('/').includes('.git')) throw fail('Git internals cannot be read or edited through the workspace', 'VEK_PATH_PROTECTED');
    if (!allowRoot && normalized === '.') throw fail('Choose a file path');
    return normalized === '.' ? '' : normalized;
  }
  async function resolveFile(ctx, value, { allowMissing = false, allowRoot = false } = {}) {
    const rel = relative(value, allowRoot);
    const target = path.resolve(ctx.root, rel);
    if (!inside(ctx.root, target)) throw fail('Path leaves the project', 'VEK_PATH_OUTSIDE_PROJECT');
    let canonical;
    try { canonical = await fsp.realpath(target); }
    catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
      let ancestor = path.dirname(target), suffix = [path.basename(target)], parent;
      while (true) {
        try { parent = await fsp.realpath(ancestor); break; }
        catch (failure) { if (failure.code !== 'ENOENT' || ancestor === ctx.root) throw failure; suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
      }
      if (!inside(ctx.root, parent)) throw fail('Parent path leaves the project', 'VEK_PATH_OUTSIDE_PROJECT');
      if (path.relative(ctx.root, parent).split(path.sep).includes('.git')) throw fail('Git internals cannot be read or edited through the workspace', 'VEK_PATH_PROTECTED');
      return { path: path.join(parent, ...suffix), relativePath: rel, exists: false };
    }
    if (!inside(ctx.root, canonical)) throw fail('Symlink leaves the project', 'VEK_PATH_OUTSIDE_PROJECT');
    if (path.relative(ctx.root, canonical).split(path.sep).includes('.git')) throw fail('Git internals cannot be read or edited through the workspace', 'VEK_PATH_PROTECTED');
    return { path: canonical, relativePath: rel, exists: true };
  }
  async function readBuffer(ctx, file) {
    const resolved = await resolveFile(ctx, file);
    if (!(await fsp.stat(resolved.path)).isFile()) throw fail('The selected path is not a regular file');
    const handle = await fsp.open(resolved.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw fail('The selected path is not a regular file');
      if (info.size > MAX_FILE_BYTES) throw fail('File exceeds the 2 MiB workspace limit', 'VEK_FILE_TOO_LARGE');
      const storage = Buffer.alloc(MAX_FILE_BYTES + 1); let offset = 0;
      while (offset < storage.length) { const { bytesRead } = await handle.read(storage, offset, storage.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      const buffer = storage.subarray(0, offset);
      if (buffer.length > MAX_FILE_BYTES) throw fail('File exceeds the 2 MiB workspace limit', 'VEK_FILE_TOO_LARGE');
      return { ...resolved, buffer, info };
    } finally { await handle.close(); }
  }
  function decode(buffer) {
    if (buffer.includes(0)) throw fail('Binary file: use artifact preview instead', 'VEK_FILE_BINARY');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw fail('File is not valid UTF-8 text', 'VEK_FILE_BINARY'); }
  }
  async function tree(ctx, payload) {
    const start = await resolveFile(ctx, payload.path || '', { allowRoot: true });
    if (!(await fsp.stat(start.path)).isDirectory()) throw fail('Tree root must be a directory');
    const maxDepth = cap(payload.depth, 2, 8), maxEntries = cap(payload.limit, 1000, 5000);
    let count = 0, truncated = false;
    async function visit(directory, prefix, depth) {
      directory = await fsp.realpath(directory);
      if (!inside(ctx.root, directory)) throw fail('Directory leaves the project', 'VEK_PATH_OUTSIDE_PROJECT');
      const rows = [];
      const entries = (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (IGNORED.has(entry.name) || (!payload.hidden && entry.name.startsWith('.'))) continue;
        if (count >= maxEntries) { truncated = true; break; }
        count++;
        const relativePath = path.posix.join(prefix, entry.name);
        const item = { name: entry.name, path: relativePath, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' };
        if (entry.isDirectory() && depth < maxDepth) item.children = await visit(path.join(directory, entry.name), relativePath, depth + 1);
        rows.push(item);
      }
      return rows;
    }
    return { projectId: payload.projectId, path: start.relativePath, entries: await visit(start.path, start.relativePath, 1), count, truncated };
  }
  async function search(ctx, payload) {
    const query = String(payload.query || '');
    if (!query || query.length > 500) throw fail('Search query must contain 1–500 characters');
    const maxResults = cap(payload.limit, 100, 500), results = [];
    const caseSensitive = payload.caseSensitive === true, needle = caseSensitive ? query : query.toLowerCase();
    let files = 0, bytes = 0, truncated = false;
    const contentSearch = payload.content !== false;
    async function walk(directory, prefix) {
      if (truncated) return;
      directory = await fsp.realpath(directory);
      if (!inside(ctx.root, directory)) throw fail('Directory leaves the project', 'VEK_PATH_OUTSIDE_PROJECT');
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        if (IGNORED.has(entry.name) || entry.isSymbolicLink() || (!payload.hidden && entry.name.startsWith('.'))) continue;
        const relativePath = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) { if (relativePath.split('/').length < 12) await walk(path.join(directory, entry.name), relativePath); continue; }
        if (!entry.isFile()) continue;
        if (++files > 5000 || bytes > 20 * 1024 * 1024 || results.length >= maxResults) { truncated = true; return; }
        const comparePath = caseSensitive ? relativePath : relativePath.toLowerCase();
        if (!contentSearch) { if (comparePath.includes(needle)) results.push({ path: relativePath, kind: 'path' }); continue; }
        try {
          const file = await readBuffer(ctx, relativePath); bytes += file.buffer.length;
          const lines = decode(file.buffer).split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if ((caseSensitive ? lines[i] : lines[i].toLowerCase()).includes(needle)) results.push({ path: relativePath, line: i + 1, text: lines[i].slice(0, 500), kind: 'content' });
            if (results.length >= maxResults) { truncated = true; break; }
          }
        } catch (error) { if (!['VEK_FILE_BINARY', 'VEK_FILE_TOO_LARGE', 'EACCES', 'ENOENT'].includes(error.error_code || error.code)) throw error; }
        if (truncated) return;
      }
    }
    await walk(ctx.root, '');
    return { projectId: payload.projectId, query, results, filesScanned: files, bytesScanned: bytes, truncated };
  }
  async function write(ctx, payload) {
    if (!Object.prototype.hasOwnProperty.call(payload, 'expectedHash')) throw fail('An expectedHash is required; read the file before saving', 'VEK_FILE_CONFLICT');
    if (typeof payload.content !== 'string') throw fail('File content must be text');
    const buffer = Buffer.from(payload.content, 'utf8');
    if (buffer.length > MAX_FILE_BYTES) throw fail('File exceeds the 2 MiB workspace limit', 'VEK_FILE_TOO_LARGE');
    const file = await resolveFile(ctx, payload.path, { allowMissing: true });
    let currentHash = null, info;
    if (file.exists) { const current = await readBuffer(ctx, payload.path); currentHash = sha256(current.buffer); info = current.info; }
    if (currentHash !== payload.expectedHash) throw fail('The file changed on disk. Reload it before saving your edits.', 'VEK_FILE_CONFLICT');
    const parent = path.dirname(file.path), temporary = path.join(parent, `.vek-save-${crypto.randomUUID()}`);
    try {
      await fsp.writeFile(temporary, buffer, { flag: 'wx', mode: info?.mode ?? 0o600 });
      if (await fsp.realpath(parent) !== parent) throw fail('Parent path changed while saving', 'VEK_PATH_OUTSIDE_PROJECT');
      // Recheck immediately before the atomic replacement, including external edits during the write.
      let newest = null;
      try { const current = await readBuffer(ctx, payload.path); if (current.path !== file.path) throw fail('File target changed while saving', 'VEK_FILE_CONFLICT'); newest = sha256(current.buffer); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (newest !== currentHash) throw fail('The file changed while saving. Reload it before saving.', 'VEK_FILE_CONFLICT');
      await fsp.rename(temporary, file.path);
    } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
    publish({ type: 'write', projectId: payload.projectId, path: file.relativePath });
    return { projectId: payload.projectId, path: file.relativePath, content: payload.content, hash: sha256(buffer), bytes: buffer.length, mtimeMs: (await fsp.stat(file.path)).mtimeMs };
  }
  async function artifacts(ctx, payload) {
    const listing = await tree(ctx, { ...payload, depth: 8, limit: 5000 });
    const extensions = new Set(['.html', '.htm', '.md', '.txt', '.json', '.csv', '.svg', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.mp3', '.wav']);
    const items = [];
    function collect(rows) { for (const item of rows) { if (item.type === 'file' && extensions.has(path.extname(item.name).toLowerCase())) items.push(item); if (item.children) collect(item.children); } }
    collect(listing.entries);
    return { projectId: payload.projectId, items: items.slice(0, 500), truncated: listing.truncated || items.length > 500 };
  }
  async function preview(ctx, payload) {
    const file = await readBuffer(ctx, payload.path), extension = path.extname(file.path).toLowerCase();
    const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const result = { projectId: payload.projectId, path: file.relativePath, bytes: file.buffer.length, hash: sha256(file.buffer) };
    if (images[extension]) return { ...result, kind: 'image', mime: images[extension], base64: file.buffer.toString('base64') };
    try { return { ...result, kind: 'text', content: decode(file.buffer) }; }
    catch (error) { if (error.error_code !== 'VEK_FILE_BINARY') throw error; return { ...result, kind: 'binary', note: 'Binary metadata only; external viewers and executable HTML previews are not enabled.' }; }
  }
  function publish(event) {
    lastEvent = { ...event, sequence: ++sequence, at: new Date().toISOString() };
    try { onChange(snapshot()); } catch {}
  }
  function snapshot() {
    return { version: 1, projects: clone(projects()), watches: [...watches.values()].map(({ projectId, recursive }) => ({ projectId, recursive })), lastEvent: clone(lastEvent), remoteGit: remoteGit.snapshot(), capabilities: { fileLimitBytes: MAX_FILE_BYTES, git: true, checkpoints: true, remoteGit: true, remotePullRequests: true, executablePreview: false } };
  }
  async function watch(ctx, payload) {
    if (payload.enabled === false) { const existing = watches.get(payload.projectId); existing?.handle.close(); clearTimeout(existing?.timer); watches.delete(payload.projectId); return snapshot(); }
    if (watches.has(payload.projectId)) return snapshot();
    if (watches.size >= 8) throw fail('At most eight projects can be watched at a time');
    const record = { projectId: payload.projectId, recursive: true, timer: null, handle: null, pending: new Map() };
    const callback = (eventType, filename) => {
      if (closed) return;
      if (!filename) return;
      const filenameString = String(filename).replaceAll(path.sep, '/');
      if (filenameString.split('/').some(part => IGNORED.has(part) || part.startsWith('.vek-save-'))) return;
      try { const rel = relative(filenameString); record.pending.set(rel, eventType); } catch { return; }
      clearTimeout(record.timer);
      record.timer = setTimeout(() => { const changes = [...record.pending].slice(0, 200).map(([file, type]) => ({ path: file, type })); record.pending.clear(); publish({ type: 'files-changed', projectId: payload.projectId, changes }); }, 120);
      record.timer.unref?.();
    };
    try { record.handle = fs.watch(ctx.root, { recursive: true }, callback); }
    catch { record.recursive = false; record.handle = fs.watch(ctx.root, callback); }
    record.handle.on('error', error => publish({ type: 'watch-error', projectId: payload.projectId, message: error.message })); record.handle.unref?.(); watches.set(payload.projectId, record);
    return snapshot();
  }
  async function git(ctx, args, options = {}) {
    try {
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
      const pending = execute(gitCommand, ['--literal-pathspecs', '--no-optional-locks', '-C', ctx.root, '-c', 'core.quotepath=false', ...args], {
        encoding: options.encoding || 'utf8', timeout: 20000, maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
        env: { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C', ...options.env }, windowsHide: true,
      }); if (options.input !== undefined) { pending.child.stdin.on('error', () => {}); pending.child.stdin.end(options.input); } const {stdout,stderr} = await pending; return { stdout, stderr };
    } catch (error) { throw fail(`Git command failed: ${String(error.stderr || error.message).trim().slice(0, 4000)}`, 'VEK_GIT_ERROR'); }
  }
  async function repository(ctx) {
    const top = (await git(ctx, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (await fsp.realpath(top) !== ctx.root) throw fail('Choose the repository root as the project before using Git', 'VEK_GIT_ROOT_SCOPE');
  }
  async function gitPaths(ctx, payload) {
    if (!Array.isArray(payload.paths) || !payload.paths.length || payload.paths.length > 500) throw fail('Choose 1–500 project-relative file paths');
    const paths = [];
    for (const file of payload.paths) { relative(file); await resolveFile(ctx, file, { allowMissing: true }); paths.push(file); }
    return paths;
  }
  function ref(value, label = 'Branch') {
    if (typeof value !== 'string' || !value || value.startsWith('-') || value.includes('\0') || value.length > 256) throw fail(`${label} name is invalid`);
    return value;
  }
  // Checkpoints are private Git objects/refs. The real index is never used as a scratch index.
  const checkpointPrefix = ctx => repositoryLayout(ctx.root).checkpointPrefix;
  async function checkpointRefs(ctx){
    const prefix=checkpointPrefix(ctx);
    return (await git(ctx,['for-each-ref','--format=%(refname)',prefix])).stdout.trim().split('\n').filter(ref=>ref.startsWith(prefix)&&/^[a-f0-9-]{36}$/.test(ref.slice(prefix.length)));
  }
  const objectId = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  function checkpointId(value) { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw fail('Choose a checkpoint from this repository'); return value; }
  async function checkpointLock(ctx, operation) {
    const layout=repositoryLayout(ctx.root),{gitDir,commonDir}=layout;
    if(path.resolve((await git(ctx,['rev-parse','--absolute-git-dir'])).stdout.trim())!==gitDir||path.resolve((await git(ctx,['rev-parse','--path-format=absolute','--git-common-dir'])).stdout.trim())!==commonDir)throw fail('Git storage differs from the selected repository layout','VEK_CHECKPOINT_UNSAFE');
    const storage=['objects','refs','refs/vek','refs/vek/checkpoints'];
    if(layout.linked)storage.push(path.relative(commonDir,path.join(commonDir,layout.checkpointPrefix)));
    for(const directory of storage)try{const target=path.join(commonDir,directory),info=await fsp.lstat(target);if(info.isSymbolicLink()||!info.isDirectory()||await fsp.realpath(target)!==target)throw fail('Git checkpoint storage cannot use directory aliases','VEK_CHECKPOINT_UNSAFE');}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const entry of await fsp.readdir(path.join(commonDir,'objects'),{withFileTypes:true}))if(entry.isSymbolicLink())throw fail('Git objects cannot use symlink storage','VEK_CHECKPOINT_UNSAFE');
    for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','REBASE_HEAD','rebase-merge','rebase-apply','sequencer'])if(fs.existsSync(path.join(gitDir,name)))throw fail('Finish the active merge/rebase/cherry-pick before using checkpoints','VEK_CHECKPOINT_UNSAFE');
    if((await git(ctx,['rev-parse','--shared-index-path'])).stdout.trim())throw fail('Split indexes are not supported by checkpoints','VEK_CHECKPOINT_UNSAFE');
    if((await git(ctx,['config','--bool','core.sparseCheckout']).catch(()=>({stdout:''}))).stdout.trim()==='true')throw fail('Sparse checkouts are not supported by checkpoints','VEK_CHECKPOINT_UNSAFE');
    const lockPath=path.join(gitDir,'index.lock');let lock;
    try{lock=await fsp.open(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fail('Git index is busy. Finish the other Git operation and retry.','VEK_CHECKPOINT_CONFLICT');throw error;}
    const identity=await lock.stat(),info={gitDir,indexPath:path.join(gitDir,'index'),lockPath,lock};
    try{if(repositoryLayout(ctx.root).identity!==layout.identity)throw fail('Repository identity changed while locking');return await operation(info);}finally{await lock.close().catch(()=>{});try{const present=await fsp.lstat(lockPath);if(!present.isSymbolicLink()&&present.ino===identity.ino&&present.dev===identity.dev)await fsp.unlink(lockPath);}catch{}}
  }
  async function checkpointPath(ctx,file,{missing=false}={}) {
    const rel=relative(file);if(rel.includes('\ufffd'))throw fail('Checkpoint cannot safely represent this filename encoding','VEK_CHECKPOINT_UNSAFE');if(rel!==file)throw fail('Checkpoint contains a noncanonical path','VEK_CHECKPOINT_UNSAFE');
    let current=ctx.root;const parts=rel.split('/');
    for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);try{const info=await fsp.lstat(current);if(info.isSymbolicLink()||(!info.isDirectory()&&i<parts.length-1)||(!info.isFile()&&i===parts.length-1))throw fail('Checkpoint paths must be regular files without symlink components: '+rel,'VEK_CHECKPOINT_UNSAFE');}catch(error){if(missing&&error.code==='ENOENT')return{path:current===path.join(ctx.root,rel)?current:path.join(ctx.root,rel),exists:false};throw error;}}
    return{path:current,exists:true};
  }
  async function checkpointState(ctx,info) {
    const head=(await git(ctx,['rev-parse','--verify','HEAD'])).stdout.trim();if(!objectId(head))throw fail('Checkpoints require an existing HEAD commit');
    let index=null,indexMode=0o644;try{const stat=await fsp.lstat(info.indexPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw fail('Git index is not a supported regular file');index=await fsp.readFile(info.indexPath);indexMode=stat.mode&0o777;if(index.length>16*1024*1024)throw fail('Git index exceeds checkpoint limits');}catch(error){if(error.code!=='ENOENT')throw error;}
    const staged=(await git(ctx,['ls-files','--stage','-z'])).stdout.split('\0').filter(Boolean),paths=new Set();
    for(const entry of staged){const tab=entry.indexOf('\t'),[mode,,stage]=entry.slice(0,tab).split(' ');if(tab<0||stage!=='0'||!['100644','100755'].includes(mode))throw fail('Unmerged entries, symlinks, submodules and sparse indexes are not supported','VEK_CHECKPOINT_UNSAFE');paths.add(entry.slice(tab+1));}
    for(const file of (await git(ctx,['ls-files','--others','--exclude-standard','-z'])).stdout.split('\0').filter(Boolean))paths.add(file);
    if(paths.size>2000)throw fail('Checkpoint supports at most 2000 nonignored files');
    const files=[];let total=0;
    for(const file of [...paths].sort()){const resolved=await checkpointPath(ctx,file,{missing:true});if(!resolved.exists)continue;const value=await readBuffer(ctx,file);if(value.path!==path.join(ctx.root,file))throw fail('Checkpoint path changed while reading','VEK_CHECKPOINT_UNSAFE');total+=value.buffer.length;if(total>32*1024*1024)throw fail('Checkpoint content exceeds 32 MiB');files.push({path:file,bytes:value.buffer,sha256:sha256(value.buffer),mode:(value.info.mode&0o111)?'100755':'100644'});}
    const signature=sha256(Buffer.from(JSON.stringify({head,index:index===null?null:sha256(index),indexMode,files:files.map(({path,sha256,mode})=>({path,sha256,mode}))})));
    return{head,index,indexMode,files,signature,total};
  }
  async function checkpointStore(ctx,info,current,name) {
    if(typeof name!=='string'||!name.trim()||name.length>120)throw fail('Checkpoint name must contain 1–120 characters');
    if((await checkpointRefs(ctx)).length>=1000)throw fail('At most 1000 checkpoints including protection snapshots are supported');
    const id=crypto.randomUUID(),createdAt=new Date().toISOString(),temporary=path.join(info.gitDir,'vek-index-'+crypto.randomUUID());
    const env={GIT_INDEX_FILE:temporary},blob=async bytes=>(await git(ctx,['hash-object','-w','--stdin'],{input:bytes})).stdout.trim();
    let indexTree,worktreeTree;
    try{
      if(current.index!==null)await fsp.writeFile(temporary,current.index,{mode:0o600,flag:'wx'});else await git(ctx,['read-tree','--empty'],{env});
      indexTree=(await git(ctx,['write-tree'],{env})).stdout.trim();
      await fsp.rm(temporary,{force:true});await git(ctx,['read-tree','--empty'],{env});
      for(const file of current.files)file.blob=await blob(file.bytes);
      await git(ctx,['update-index','-z','--index-info'],{env,input:current.files.map(file=>`${file.mode} ${file.blob}\t${file.path}\0`).join('')});
      worktreeTree=(await git(ctx,['write-tree'],{env})).stdout.trim();
    }finally{await fsp.rm(temporary,{force:true});await fsp.rm(temporary+'.lock',{force:true});}
    const indexBlob=current.index===null?null:await blob(current.index);
    const manifest={version:1,id,name:name.trim(),createdAt,head:current.head,indexBlob,indexMode:current.indexMode,indexTree,worktreeTree,files:current.files.map(({path,blob,mode,sha256})=>({path,blob,mode,sha256})),bytes:current.total};
    const manifestBlob=await blob(Buffer.from(JSON.stringify(manifest)));
    const tree=(await git(ctx,['mktree'],{input:`100644 blob ${manifestBlob}\tmanifest.json\n${indexBlob?`100644 blob ${indexBlob}\tindex.bin\n`:''}040000 tree ${indexTree}\tindex-tree\n040000 tree ${worktreeTree}\tworktree\n`})).stdout.trim();
    const commit=(await git(ctx,['commit-tree',tree,'-p',current.head,'-m','Wiek checkpoint: '+name.trim()],{env:{GIT_AUTHOR_NAME:'Wiek Checkpoint',GIT_AUTHOR_EMAIL:'checkpoint@localhost',GIT_COMMITTER_NAME:'Wiek Checkpoint',GIT_COMMITTER_EMAIL:'checkpoint@localhost'}})).stdout.trim();
    if((await checkpointState(ctx,info)).signature!==current.signature)throw fail('Files or index changed while creating the checkpoint. Retry after changes settle.','VEK_CHECKPOINT_CONFLICT');
    await git(ctx,['update-ref',checkpointPrefix(ctx)+id,commit,'0'.repeat(commit.length)]);return manifest;
  }
  async function checkpointRead(ctx,id) {
    const ref=checkpointPrefix(ctx)+checkpointId(id),raw=(await git(ctx,['show',ref+':manifest.json'])).stdout;
    if(Buffer.byteLength(raw)>2*1024*1024)throw fail('Checkpoint manifest is too large');let value;try{value=JSON.parse(raw);}catch{throw fail('Checkpoint manifest is invalid');}
    if(value.version!==1||value.id!==id||typeof value.name!=='string'||!objectId(value.head)||!objectId(value.indexTree)||!objectId(value.worktreeTree)||!Array.isArray(value.files)||value.files.length>2000||!(value.indexBlob===null||objectId(value.indexBlob)))throw fail('Checkpoint manifest is invalid');
    if((await git(ctx,['rev-parse',ref+':worktree'])).stdout.trim()!==value.worktreeTree||(await git(ctx,['rev-parse',ref+':index-tree'])).stdout.trim()!==value.indexTree)throw fail('Checkpoint trees changed');
    const tree=(await git(ctx,['ls-tree','-r','-z',ref+':worktree'])).stdout.split('\0').filter(Boolean),seen=new Set();if(tree.length!==value.files.length)throw fail('Checkpoint tree does not match its manifest');
    for(const entry of tree){const tab=entry.indexOf('\t'),[mode,type,hash]=entry.slice(0,tab).split(' '),file=entry.slice(tab+1),row=value.files.find(row=>row.path===file);relative(file);if(file!==relative(file)||seen.has(file)||!row||!['100644','100755'].includes(mode)||type!=='blob'||row.mode!==mode||row.blob!==hash||!objectId(row.blob)||! /^[a-f0-9]{64}$/.test(row.sha256))throw fail('Checkpoint contains unsafe file metadata');seen.add(file);}
    if(!Number.isInteger(value.indexMode)||value.indexMode<0||value.indexMode>0o777)throw fail('Checkpoint index permissions are invalid');
    if(value.indexBlob&&(await git(ctx,['rev-parse',ref+':index.bin'])).stdout.trim()!==value.indexBlob)throw fail('Checkpoint index changed');
    return value;
  }
  const checkpointMeta=record=>({id:record.id,name:record.name,createdAt:record.createdAt,head:record.head,files:record.files.length,bytes:record.bytes});
  async function checkpointAction(ctx,payload,operation) {
    if(operation==='compare'){
      const from=await checkpointRead(ctx,payload.fromId),to=await checkpointRead(ctx,payload.toId);
      const args=['diff','--no-ext-diff','--no-textconv','--no-renames'];
      const worktreeDiff=(await git(ctx,[...args,from.worktreeTree,to.worktreeTree,'--'])).stdout;
      const stagedDiff=(await git(ctx,[...args,from.indexTree,to.indexTree,'--'])).stdout;
      const changes=new Map(),before=new Map(from.files.map(row=>[row.path,row])),after=new Map(to.files.map(row=>[row.path,row]));
      for(const file of [...new Set([...before.keys(),...after.keys()])].sort())if(before.get(file)?.sha256!==after.get(file)?.sha256||before.get(file)?.mode!==after.get(file)?.mode)changes.set(file,{path:file,kind:!before.has(file)?'add':!after.has(file)?'remove':'modify',worktree:true,staged:false});
      const staged=(await git(ctx,[...args,'--name-status','-z',from.indexTree,to.indexTree,'--'])).stdout.split('\0');
      for(let i=0;i+1<staged.length;i+=2){const kind=staged[i],file=staged[i+1];if(!file)continue;relative(file);const row=changes.get(file)||{path:file,kind:kind==='A'?'add':kind==='D'?'remove':'modify',worktree:false};row.staged=true;changes.set(file,row);}
      return{projectId:payload.projectId,from:checkpointMeta(from),to:checkpointMeta(to),headChanged:from.head!==to.head,changes:[...changes.values()].sort((a,b)=>a.path.localeCompare(b.path)),stagedDiff,worktreeDiff};
    }
    if(operation==='list'){const refs=await checkpointRefs(ctx);if(refs.length>1000)throw fail('Too many checkpoints to list');const checkpoints=[];for(const ref of refs)checkpoints.push(checkpointMeta(await checkpointRead(ctx,ref.slice(checkpointPrefix(ctx).length))));return{projectId:payload.projectId,checkpoints:checkpoints.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};}
    return checkpointLock(ctx,async info=>{
      const current=await checkpointState(ctx,info);
      if(operation==='create'){const saved=await checkpointStore(ctx,info,current,payload.name);publish({type:'checkpoint-created',projectId:payload.projectId,id:saved.id});return{projectId:payload.projectId,checkpoint:checkpointMeta(saved)};}
      const target=await checkpointRead(ctx,payload.id);
      if(current.head!==target.head)throw fail('HEAD changed since this checkpoint. Restore on its original commit to preserve branch history.','VEK_CHECKPOINT_CONFLICT');
      const expectedState=sha256(Buffer.from(current.signature+JSON.stringify({id:target.id,head:target.head,indexBlob:target.indexBlob,indexTree:target.indexTree,worktreeTree:target.worktreeTree})));
      const before=new Map(current.files.map(file=>[file.path,file])),after=new Map(target.files.map(file=>[file.path,file]));
      const changes=[...new Set([...before.keys(),...after.keys()])].sort().filter(file=>before.get(file)?.sha256!==after.get(file)?.sha256||before.get(file)?.mode!==after.get(file)?.mode).map(file=>({path:file,kind:!before.has(file)?'add':!after.has(file)?'remove':'modify'}));
      if(operation==='preview')return{projectId:payload.projectId,checkpoint:checkpointMeta(target),expectedState,changes,stagedDiff:(await git(ctx,['diff','--no-ext-diff','--no-textconv',target.head,target.indexTree,'--'])).stdout,worktreeDiff:(await git(ctx,['diff','--no-ext-diff','--no-textconv',target.indexTree,target.worktreeTree,'--'])).stdout};
      if(operation!=='restore')throw fail('Unsupported checkpoint operation');
      if(payload.confirm!==true||payload.expectedState!==expectedState)throw fail('Preview this checkpoint, then explicitly confirm restore. Files or index changed since the preview.','VEK_CHECKPOINT_CONFLICT');
      // Validate every existing and destination path before creating the protective checkpoint.
      for(const file of target.files){const resolved=await checkpointPath(ctx,file.path,{missing:true});if(resolved.exists&&!before.has(file.path))throw fail('An ignored/unmanaged file blocks restore: '+file.path,'VEK_CHECKPOINT_CONFLICT');}
      for(const source of current.files)for(const destination of target.files)if(source.path.startsWith(destination.path+'/')||destination.path.startsWith(source.path+'/'))throw fail('File/directory topology changed; checkpoint restore refuses this layout','VEK_CHECKPOINT_UNSAFE');
      const content=new Map();let total=0;for(const file of target.files){const bytes=(await git(ctx,['cat-file','blob',file.blob],{encoding:'buffer',maxBuffer:MAX_FILE_BYTES+1})).stdout;if(bytes.length>MAX_FILE_BYTES||sha256(bytes)!==file.sha256)throw fail('Checkpoint file is corrupt or exceeds its limit');total+=bytes.length;if(total>32*1024*1024)throw fail('Checkpoint exceeds content limits');content.set(file.path,bytes);}
      const index=target.indexBlob?(await git(ctx,['cat-file','blob',target.indexBlob],{encoding:'buffer',maxBuffer:16*1024*1024+1})).stdout:null;
      if(index&&index.length>16*1024*1024)throw fail('Checkpoint index exceeds its limit');
      if((await checkpointState(ctx,info)).signature!==current.signature)throw fail('Working files changed during restore preparation. Preview again.','VEK_CHECKPOINT_CONFLICT');
      // Validate the captured index in an isolated file before any user file changes.
      const validation=path.join(info.gitDir,'vek-index-'+crypto.randomUUID());
      try{if(index!==null)await fsp.writeFile(validation,index,{mode:0o600,flag:'wx'});else await git(ctx,['read-tree','--empty'],{env:{GIT_INDEX_FILE:validation}});if((await git(ctx,['write-tree'],{env:{GIT_INDEX_FILE:validation}})).stdout.trim()!==target.indexTree)throw fail('Checkpoint index does not match its tree');}finally{await fsp.rm(validation,{force:true});await fsp.rm(validation+'.lock',{force:true});}
      const backup=await checkpointStore(ctx,info,current,('Before restore: '+target.name).slice(0,120));
      const transaction=await fsp.mkdtemp(path.join(info.gitDir,'vek-restore-'));await fsp.chmod(transaction,0o700);
      const moved=[],written=[],directories=[];let retainTransaction=false;
      try{
        // No Git commands that touch the real index run while these worktree changes are applied.
        for(const file of current.files){await checkpointPath(ctx,file.path);const saved=path.join(transaction,String(moved.length));await fsp.rename(path.join(ctx.root,file.path),saved);moved.push({file,saved});if(sha256(await fsp.readFile(saved))!==file.sha256)throw fail('A file changed during restore; restoring the prior worktree','VEK_CHECKPOINT_CONFLICT');}
        for(const file of target.files){const targetPath=path.join(ctx.root,file.path),parts=file.path.split('/').slice(0,-1);let parent=ctx.root;for(const part of parts){parent=path.join(parent,part);try{await fsp.mkdir(parent,{mode:0o755});directories.push(parent);}catch(error){if(error.code!=='EEXIST')throw error;const stat=await fsp.lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('Restore parent changed','VEK_CHECKPOINT_UNSAFE');}}
          const temporary=path.join(transaction,'new-'+written.length);await fsp.writeFile(temporary,content.get(file.path),{flag:'wx',mode:file.mode==='100755'?0o755:0o644});await checkpointPath(ctx,file.path,{missing:true});await fsp.link(temporary,targetPath);const linked=await fsp.lstat(targetPath);written.push({path:targetPath,ino:linked.ino,dev:linked.dev,hash:file.sha256});await fsp.unlink(temporary);
        }
        if(index!==null){await info.lock.writeFile(index);await info.lock.chmod(target.indexMode||0o644);await info.lock.sync();await fsp.rename(info.lockPath,info.indexPath);}else await fsp.rm(info.indexPath,{force:true});
      }catch(error){
        const rollbackErrors=[];
        for(const file of written.reverse())try{const stat=await fsp.lstat(file.path);if(stat.isSymbolicLink()||stat.ino!==file.ino||stat.dev!==file.dev||sha256(await fsp.readFile(file.path))!==file.hash)throw fail('A restored file changed concurrently: '+file.path);await fsp.unlink(file.path);}catch(failure){if(failure.code!=='ENOENT')rollbackErrors.push(failure.message);}
        for(const row of moved.reverse())try{await checkpointPath(ctx,row.file.path,{missing:true});await fsp.link(row.saved,path.join(ctx.root,row.file.path));await fsp.unlink(row.saved);}catch(failure){rollbackErrors.push(failure.message);}
        if(rollbackErrors.length){retainTransaction=true;error.message+='; concurrent changes prevented complete rollback; preserved original bytes in '+transaction+' ('+rollbackErrors.join('; ')+')';}
        for(const folder of directories.reverse())await fsp.rmdir(folder).catch(()=>{});
        error.message+=(retainTransaction?'; safety checkpoint ':'; prior state retained. Safety checkpoint ')+backup.id;throw error;
      }finally{if(!retainTransaction)await fsp.rm(transaction,{recursive:true,force:true}).catch(()=>{});}
      publish({type:'checkpoint-restored',projectId:payload.projectId,id:target.id,backupId:backup.id});
      return{projectId:payload.projectId,checkpoint:checkpointMeta(target),backupCheckpoint:checkpointMeta(backup),restored:true};
    });
  }

  const mutating = new Set(['checkpoint:create', 'checkpoint:preview', 'checkpoint:restore', 'stage', 'unstage', 'commit', 'stash:push', 'stash:apply', 'stash:pop', 'stash:drop', 'branch:create', 'branch:switch']);
  async function gitAction(ctx, payload, operation) {
    await repository(ctx);
    if(operation.startsWith('checkpoint:'))return checkpointAction(ctx,payload,operation.slice('checkpoint:'.length));
    let result;
    if (operation === 'status') {
      const raw = (await git(ctx, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout.split('\0');
      const entries = [];
      for (let i = 0; i < raw.length; i++) {
        if (!raw[i]) continue;
        const status = raw[i].slice(0, 2), file = raw[i].slice(3);
        const entry = { path: file, index: status[0], worktree: status[1], status };
        if (status.includes('R') || status.includes('C')) entry.originalPath = raw[++i];
        entries.push(entry);
      }
      const branch = await git(ctx, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ({ stdout: '(detached HEAD)' }));
      result = { branch: branch.stdout.trim(), entries: entries.slice(0, 5000), truncated: entries.length > 5000 };
    } else if (operation === 'diff') {
      const paths = payload.path ? [relative(payload.path)] : [];
      if (paths.length) await resolveFile(ctx, paths[0], { allowMissing: true });
      result = { ...(await git(ctx, ['diff', '--no-ext-diff', '--no-textconv', ...(payload.staged ? ['--cached'] : []), '--', ...paths])), staged: Boolean(payload.staged) };
    } else if (operation === 'log') {
      const hasHead = await git(ctx, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
      if (!hasHead) return { projectId: payload.projectId, commits: [] };
      const raw = (await git(ctx, ['log', '-z', `-n${cap(payload.limit, 30, 100)}`, '--format=%H%x00%h%x00%aN%x00%aI%x00%s'])).stdout.split('\0');
      const commits = []; for (let i = 0; i + 4 < raw.length; i += 5) commits.push({ hash: raw[i], shortHash: raw[i + 1], author: raw[i + 2], date: raw[i + 3], subject: raw[i + 4] }); result = { commits };
    } else if (operation === 'branches') {
      const raw = (await git(ctx, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(HEAD)', 'refs/heads/'])).stdout;
      result = { branches: raw.trim().split('\n').filter(Boolean).map(line => { const [name, hash, current] = line.split('\0'); return { name, hash, current: current === '*' }; }) };
    } else if (operation === 'stage') result = await git(ctx, ['add', '--', ...await gitPaths(ctx, payload)]);
    else if (operation === 'unstage') {
      const paths = await gitPaths(ctx, payload);
      const head = await git(ctx, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
      result = await git(ctx, head ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '--', ...paths]);
    } else if (operation === 'commit') {
      if (typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 50000) throw fail('Commit message must contain 1–50000 characters');
      result = await git(ctx, ['commit', '-m', payload.message]);
    } else if (operation === 'branch:create') {
      const name = ref(payload.name); await git(ctx, ['check-ref-format', '--branch', name]); result = await git(ctx, payload.checkout ? ['switch', '-c', name] : ['branch', '--', name]);
    } else if (operation === 'branch:switch') result = await git(ctx, ['switch', '--', ref(payload.name)]);
    else if (operation === 'stash:list') {
      const raw = (await git(ctx, ['stash', 'list', '--format=%gd%x00%gs'])).stdout;
      result = { stashes: raw.trim().split('\n').filter(Boolean).map(line => { const [id, description] = line.split('\0'); return { id, description }; }) };
    } else if (operation === 'stash:push') result = await git(ctx, ['stash', 'push', ...(payload.includeUntracked ? ['--include-untracked'] : []), '-m', String(payload.message || 'Wiek workspace stash').slice(0, 1000)]);
    else if (['stash:apply', 'stash:pop', 'stash:drop'].includes(operation)) {
      const id = payload.stash || 'stash@{0}'; if (!/^stash@\{\d+\}$/.test(id)) throw fail('Choose a stash from the local stash list'); result = await git(ctx, ['stash', operation.split(':')[1], id]);
    } else throw fail('Unsupported Git operation');
    if (mutating.has(operation)) publish({ type: 'git-changed', projectId: payload.projectId, operation });
    return { projectId: payload.projectId, ...result };
  }
  async function dispatch(action, payload = {}) {
    if (action === 'workspace:snapshot') return snapshot();
    const ctx = await context(payload);
    if (action.startsWith('workspace:git:remote:') || action.startsWith('workspace:git:pr:')) {
      await repository(ctx);
      const operation = action.slice('workspace:git:'.length);
      if (operation === 'remote:cancel' || operation === 'remote:status') return remoteGit.dispatch(ctx, payload, operation);
      return serialized(ctx.root, () => remoteGit.dispatch(ctx, payload, operation));
    }
    if (action.startsWith('workspace:git:')) {
      const operation = action.slice('workspace:git:'.length);
      return mutating.has(operation) ? serialized(ctx.root, () => gitAction(ctx, payload, operation)) : gitAction(ctx, payload, operation);
    }
    switch (action) {
      case 'workspace:tree': return tree(ctx, payload);
      case 'workspace:search': return search(ctx, payload);
      case 'workspace:read': { const file = await readBuffer(ctx, payload.path); return { projectId: payload.projectId, path: file.relativePath, content: decode(file.buffer), hash: sha256(file.buffer), bytes: file.buffer.length, mtimeMs: file.info.mtimeMs }; }
      case 'workspace:write': return serialized(ctx.root, () => write(ctx, payload));
      case 'workspace:artifacts': return artifacts(ctx, payload);
      case 'workspace:preview': return preview(ctx, payload);
      case 'workspace:watch': return watch(ctx, payload);
      default: throw fail('Unknown workspace action');
    }
  }
  async function close() { closed = true; await remoteGit.close(); await Promise.allSettled([...mutations.values()]); for (const record of watches.values()) { record.handle.close(); clearTimeout(record.timer); } watches.clear(); }
  return { dispatch, snapshot, close };
}
module.exports = { createWorkspaceService };

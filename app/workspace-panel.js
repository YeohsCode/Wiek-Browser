'use strict';

(() => {
  const tr = (message, ...values) => globalThis.WiekI18n?.t(message, ...values) ?? message.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
  let root, invoke, state = { projects: [], watches: [], capabilities: {} }, projectId = '', tab = 'files', busy = 0, error = '';
  let tree = null, directory = '', file = null, preview = null, dirty = false, changed = false, search = null, artifacts = null, git = {}, gitError = '', staged = false, dialog = null, lastEvent = 0;
  let checkpointPreview = null, checkpointNotice = '';
  let localServers = null, serverReview = null, serverNotice = '';
  let remoteName = '', remoteBranch = '', remoteReview = null, remoteResult = null, remoteRunning = '', prList = null, prDetail = null;
  let query = '', contentSearch = true, commitMessage = '', generation = 0;
  const node = (tag, text, cls) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = String(text); if (cls) item.className = cls; return item; };
  const button = (label, run, cls = '') => { const item = node('button', label, `vw-button ${cls}`); item.type = 'button'; item.disabled = busy > 0; item.onclick = run; return item; };
  const currentProject = () => state.projects.find(project => project.id === projectId);
  const formatDate = value => value ? new Date(value).toLocaleString(globalThis.WiekI18n?.locale()) : '—';
  async function request(action, payload = {}) {
    if (!projectId && action !== 'workspace:snapshot') throw new Error(tr("Choose a project first."));
    const result = await invoke(action, { projectId, ...payload });
    if (result?.error) throw new Error(result.error); return result;
  }
  async function perform(run, close = false) {
    busy++; error = ''; render();
    try { const result = await run(); if (close) dialog = null; return result; }
    catch (failure) { error = failure.message || String(failure); }
    finally { busy--; render(); }
  }
  function ask(title, fields, submit, submitLabel = 'Continue') {
    dialog = { title, fields, submit, submitLabel, values: Object.fromEntries(fields.filter(field => field.key).map(field => [field.key, field.value ?? ''])) };
    render(); queueMicrotask(() => root.querySelector('.vw-dialog input,.vw-dialog textarea')?.focus());
  }
  function confirmAction(title, description, submit) { ask(title, [{ type: 'notice', label: description }], submit); }
  async function loadTree(next = directory) {
    const mine = generation; const result = await request('workspace:tree', { path: next, depth: 1, hidden: true });
    if (mine === generation) { tree = result; directory = result.path; } return result;
  }
  async function loadGit() {
    const mine = generation;
    const actions = ['status', 'branches', 'log', 'stash:list', 'diff', 'checkpoint:list', 'remote:list'];
    const results = await Promise.allSettled(actions.map(action => request(`workspace:git:${action}`, action === 'diff' ? { staged } : {})));
    if (mine !== generation) return;
    git = {}; gitError = '';
    for (let i = 0; i < actions.length; i++) {
      if (results[i].status === 'fulfilled') git[actions[i]] = results[i].value;
      else if (!gitError) gitError = results[i].reason.message || String(results[i].reason);
    }
    if (!git['remote:list']?.remotes?.some(item => item.name === remoteName)) remoteName = git['remote:list']?.remotes?.[0]?.name || '';
    if (!remoteBranch) remoteBranch = git.status?.branch || '';
  }
  async function selectProject(next) {
    if (dirty) return confirmAction(tr("Switch project"), tr("Discard the unsaved editor changes before switching?"), () => { dirty = false; return perform(() => selectProject(next), true); });
    const previous = projectId; projectId = next; generation++; directory = ''; tree = file = preview = search = artifacts = null; git = {}; checkpointPreview = null; checkpointNotice = ''; changed = false;
    remoteName = remoteBranch = remoteRunning = ''; remoteReview = remoteResult = prList = prDetail = null;
    localServers = serverReview = null; serverNotice = '';
    if (previous && previous !== next) await invoke('workspace:watch', { projectId: previous, enabled: false }).catch(() => {});
    if (!next) { render(); return; }
    await Promise.all([loadTree(), loadGit(), request('workspace:watch', { enabled: true }).then(result => { state = { ...state, watches: result.watches || [] }; })]); render();
  }
  async function openFile(relativePath) {
    if (dirty && file?.path === relativePath) { tab = 'files'; render(); return; }
    if (dirty && file?.path !== relativePath) return confirmAction(tr("Open another file"), tr("Discard your unsaved changes?"), () => { dirty = false; return perform(() => openFile(relativePath), true); });
    const mine = generation;
    return perform(async () => {
      let nextFile, nextPreview;
      try { nextFile = await request('workspace:read', { path: relativePath }); }
      catch (failure) {
        if (!/binary|UTF-8/i.test(failure.message)) throw failure;
        nextPreview = await request('workspace:preview', { path: relativePath });
      }
      if (mine === generation) { file = nextFile || null; preview = nextPreview || null; dirty = false; changed = false; tab = 'files'; }
    });
  }
  function createFile() {
    if (dirty) return confirmAction(tr("Create another file"), tr("Discard the current unsaved changes?"), () => { dirty = false; createFile(); });
    ask(tr("Create a UTF-8 file"), [{ key: 'path', label: tr("Project-relative file path"), required: true, value: directory ? `${directory}/` : '', placeholder: 'src/notes.md' }, { type: 'notice', label: tr("The parent folder must already exist. Your file is created when you save it.") }], async values => {
      file = { path: values.path, content: '', hash: null, bytes: 0 }; preview = null; dirty = true; changed = false; tab = 'files'; dialog = null; render();
    });
  }
  async function saveFile() { if (!file || !dirty) return; return perform(async () => { file = await request('workspace:write', { path: file.path, content: file.content, expectedHash: file.hash }); dirty = false; changed = false; await Promise.all([loadTree(), loadGit()]); }); }
  async function reloadFile() {
    if (!file) return;
    const load = () => perform(async () => { file = await request('workspace:read', { path: file.path }); dirty = false; changed = false; });
    return dirty ? confirmAction(tr("Reload from disk"), tr("Discard your unsaved edits and load the current file?"), () => { dialog = null; return load(); }) : load();
  }
  async function gitMutation(operation, payload = {}) { return perform(async () => { await request(`workspace:git:${operation}`, payload); await Promise.all([loadGit(), loadTree()]); }, Boolean(dialog)); }
  function header() {
    const heading = node('div', '', 'vw-header'), title = node('div'); title.append(node('h1', tr("Workspace")), node('p', tr("Project files, Git and reviewed remote operations."))); heading.append(title);
    const chooser = node('select'); chooser.setAttribute('aria-label', tr("Workspace project")); chooser.disabled = busy > 0;
    if (!state.projects.length) chooser.append(node('option', tr("Add a project in Agent workspace first")));
    for (const project of state.projects) { const option = node('option', project.name); option.value = project.id; chooser.append(option); } chooser.value = projectId;
    chooser.onchange = () => perform(() => selectProject(chooser.value)); heading.append(chooser); return heading;
  }
  async function loadServers(){const mine=generation;const result=await request('workspace:servers:list');if(mine===generation)localServers=result;}
  function serversView(body){
    const section=node('section','','vw-wide');
    section.append(node('h2',tr("Project local services")),node('p',tr("Refresh to find listening processes in this project. Choose Read title to identify a local page."),'vw-hint'));
    const refresh=button(tr("Refresh local services"),()=>perform(async()=>{serverReview=null;serverNotice='';await loadServers();}));
    if(state.capabilities?.localServers===false){refresh.disabled=true;section.append(node('p',tr("Native local service discovery is unavailable on this installation."),'vw-hint'));}
    section.append(refresh);
    if(serverNotice){const notice=node('p',serverNotice,'vw-notice');notice.role='status';section.append(notice);}
    if(localServers&&!localServers.servers.length)section.append(node('p',tr("No listening services found in this project."),'vw-empty'));
    for(const row of localServers?.servers||[]){
      const card=node('article','','vw-server-row');card.dataset.serverPid=String(row.pid);
      card.append(node('h3',tr("{0} · PID {1}", (row.name), (row.pid))),node('code',row.cwd),node('p',row.ports.map(item=>`${item.address}:${item.port}`).join(' · '),'vw-hint'));
      const actions=node('div','','vw-actions');
      for(const url of row.urls){
        const port=new URL(url).port||'80';
        actions.append(button(tr("Open {0}", (port)),()=>invoke('navigate',url)),button(tr("Read title {0}", (port)),()=>perform(async()=>{
          const mine=generation,result=await request('workspace:servers:title',{pid:row.pid,fingerprint:row.fingerprint,url});
          if(mine===generation&&localServers?.servers.includes(row)){
            row.titles||=new Map();row.titles.set(url,result);
          }
        })));
        const result=row.titles?.get(url);
        if(result){
          const title=node('p',`${port}: ${result.title|| (result.status==='unsupported'?'This address did not return supported HTML.':'No title found.')}`,'vw-server-title');
          title.dataset.serverUrl=url;card.append(title);
        }
      }
      const stop=button(tr("Review stop"),()=>perform(async()=>{const mine=generation,review=await request('workspace:servers:prepare-stop',{pid:row.pid});if(mine===generation)serverReview=review;}));
      stop.disabled=busy>0||!row.isStoppable;stop.title=row.stopDisabledReason||'';actions.append(stop);card.append(actions);section.append(card);
    }
    if(serverReview){
      const review=serverReview,card=node('div','','vw-server-review');
      card.append(node('h3',tr("Review process stop")),node('p',tr("Stop {0}, PID {1}, ports {2}?", (review.process.name), (review.process.pid), (review.process.ports.map(row=>row.port).join(', ')))),node('code',review.process.cwd),node('p',tr("This ends that process with a stop signal. Unsaved application state may be lost."),'vw-hint'));
      card.append(button(tr("Confirm stop"),()=>perform(async()=>{serverReview=null;const mine=generation,result=await request('workspace:servers:stop',{reviewId:review.reviewId,confirm:true});if(mine===generation){serverNotice=result.message;await loadServers();}},true)),button(tr("Cancel stop review"),()=>perform(async()=>{serverReview=null;await request('workspace:servers:cancel',{reviewId:review.reviewId});})));
      section.append(card);
    }
    body.append(section);
  }
  function filesView(body) {
    const rail = node('section', '', 'vw-file-rail'); const tools = node('div', '', 'vw-file-tools'); tools.append(button(tr("Project root"), () => perform(() => loadTree(''))), button(tr("+ File"), createFile)); rail.append(tools);
    const crumb = node('div', directory || '/', 'vw-breadcrumb'); rail.append(crumb);
    if (directory) rail.append(button(tr("..  Parent folder"), () => perform(() => loadTree(directory.split('/').slice(0, -1).join('/'))), 'vw-file-entry'));
    for (const entry of tree?.entries || []) {
      const item = button(`${entry.type === 'directory' ? '▸' : entry.type === 'symlink' ? '↗' : '·'}  ${entry.name}`, () => entry.type === 'directory' ? perform(() => loadTree(entry.path)) : openFile(entry.path), `vw-file-entry ${file?.path === entry.path ? 'is-active' : ''}`); item.title = entry.path; rail.append(item);
    }
    if (tree?.truncated) rail.append(node('p', tr("Listing limit reached. Open a subfolder to narrow the view."), 'vw-hint'));
    if (!tree?.entries?.length) rail.append(node('p', tr("This folder is empty."), 'vw-hint'));
    body.append(rail); const editor = node('section', '', 'vw-editor');
    if (!file && !preview) { const empty = node('div', '', 'vw-empty'); empty.append(node('h3', tr("Open a file to begin")), node('p', tr("UTF-8 files up to 2 MiB can be edited. Binary artifacts have a separate preview."))); editor.append(empty); body.append(editor); return; }
    const toolbar = node('div', '', 'vw-editor-toolbar'); toolbar.append(node('code', file?.path || preview.path), node('span', dirty ? tr("Unsaved") : tr("Saved"), 'vw-dirty'));
    if (file) toolbar.append(button(tr("Reload"), reloadFile), button(tr("Save"), saveFile, 'vw-primary')); editor.append(toolbar);
    if (changed) editor.append(node('div', tr("This project changed on disk. Saving checks the original file hash; reload to inspect external edits."), 'vw-notice'));
    if (file) {
      const textarea = node('textarea'); textarea.value = file.content; textarea.spellcheck = false; textarea.dataset.focus = 'editor'; textarea.setAttribute('aria-label', tr("Edit {0}", (file.path)));
      textarea.oninput = () => { file.content = textarea.value; dirty = true; root.querySelector('.vw-dirty').textContent = tr("Unsaved"); };
      textarea.onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); saveFile(); } }; editor.append(textarea);
      editor.append(node('div', tr("{0} bytes on disk · UTF-8 · {1}", (file.bytes.toLocaleString(globalThis.WiekI18n?.locale())), (file.hash ? `SHA-256 ${file.hash.slice(0, 12)}…` : 'New file')), 'vw-editor-meta'));
    } else editor.append(previewNode(preview));
    body.append(editor);
  }
  function previewNode(value) {
    const panel = node('div', '', 'vw-preview'); panel.append(node('p', tr("{0} · {1} bytes", (value.path), (value.bytes.toLocaleString(globalThis.WiekI18n?.locale()))), 'vw-hint'));
    if (value.kind === 'image') { const image = node('img'); image.src = `data:${value.mime};base64,${value.base64}`; image.alt = value.path; panel.append(image); }
    else if (value.kind === 'text') panel.append(node('pre', value.content));
    else panel.append(node('p', value.note || tr("Binary metadata only.")));
    return panel;
  }
  function searchView(body) {
    const section = node('section', '', 'vw-wide'); const form = node('form', '', 'vw-search-form'); const input = node('input'); input.placeholder = tr("Search this project…"); input.value = query; input.dataset.focus = 'search'; input.required = true; input.oninput = () => query = input.value;
    const mode = node('select'); for (const [value, label] of [['content', tr("File contents")], ['path', tr("File names")]]) { const option = node('option', label); option.value = value; mode.append(option); } mode.value = contentSearch ? 'content' : 'path'; mode.onchange = () => contentSearch = mode.value === 'content';
    const submit = node('button', tr("Search"), 'vw-button vw-primary'); submit.disabled = busy > 0; form.append(input, mode, submit); form.onsubmit = event => { event.preventDefault(); perform(async () => { search = await request('workspace:search', { query, content: contentSearch, hidden: true }); }); }; section.append(form);
    section.append(node('p', tr("Literal text search. Git internals, dependency/build folders, and symlink directories are excluded."), 'vw-hint'));
    if (search) { section.append(node('p', tr("{0} results · {1} files scanned{2}", (search.results.length), (search.filesScanned), (search.truncated ? ' · limit reached' : '')), 'vw-hint')); for (const result of search.results) { const row = button('', () => openFile(result.path), 'vw-search-result'); row.append(node('strong', `${result.path}${result.line ? `:${result.line}` : ''}`)); if (result.text) row.append(node('code', result.text)); section.append(row); } }
    body.append(section);
  }
  function artifactsView(body) {
    const section = node('section', '', 'vw-wide'); const heading = node('div', '', 'vw-section-heading'); heading.append(node('h2', tr("Project artifacts")), button(tr("Refresh"), () => perform(async () => artifacts = await request('workspace:artifacts', { hidden: true })))); section.append(heading, node('p', tr("Images display locally. HTML, SVG, and other UTF-8 files show source text; scripts are never executed by this preview."), 'vw-hint'));
    for (const item of artifacts?.items || []) { const open = () => perform(async () => { preview = await request('workspace:preview', { path: item.path }); file = null; dirty = false; }, Boolean(dialog)); const row = button(item.path, () => dirty ? confirmAction(tr("Preview artifact"), tr("Discard your unsaved editor changes?"), open) : open(), 'vw-artifact-row'); section.append(row); }
    if (!artifacts?.items.length) section.append(node('div', tr("No previewable project artifacts found."), 'vw-empty'));
    if (artifacts?.truncated) section.append(node('p', tr("Artifact listing limit reached."), 'vw-hint'));
    if (preview) section.append(previewNode(preview)); body.append(section);
  }
  async function prepareRemote(operation, extra = {}, pr = false) {
    const mine = generation;
    return perform(async () => {
      const result = await request(pr ? 'workspace:git:pr:prepare' : 'workspace:git:remote:prepare', { remote: remoteName, branch: remoteBranch, operation, ...extra });
      if (mine === generation) { remoteReview = result; remoteResult = null; dialog = null; }
    });
  }
  async function runRemoteReview() {
    const selected = remoteReview, mine = generation;
    if (!selected) return;
    remoteRunning = selected.reviewId; remoteReview = null;
    return perform(async () => {
      const result = await request('workspace:git:remote:run', { reviewId: selected.reviewId, confirm: true });
      if (mine === generation) { remoteResult = result; remoteRunning = ''; await Promise.all([loadGit(), loadTree()]); }
    }).finally(() => { if (mine === generation) { remoteRunning = ''; render(); } });
  }
  function remoteView(section) {
    const heading = node('div', '', 'vw-section-heading'); heading.append(node('h3', tr("Remote Git and pull requests"))); section.append(heading);
    const remotes = git['remote:list']?.remotes || [];
    if (!remotes.length) { section.append(node('p', tr("No configured remote. Add one with your Git client, then refresh."), 'vw-hint')); return; }
    const actions = node('div', '', 'vw-actions'), chooser = node('select'); chooser.setAttribute('aria-label', tr("Git remote"));
    for (const item of remotes) { const option = node('option', item.name); option.value = item.name; chooser.append(option); } chooser.value = remoteName; chooser.disabled = busy > 0;
    chooser.onchange = () => { remoteName = chooser.value; remoteReview = remoteResult = prList = prDetail = null; render(); };
    const branch = node('input'); branch.value = remoteBranch; branch.placeholder = tr("Remote branch"); branch.setAttribute('aria-label', tr("Remote Git branch")); branch.dataset.focus = 'remote-branch'; branch.disabled = busy > 0; branch.oninput = () => { remoteBranch = branch.value; };
    actions.append(chooser, branch);
    for (const [operation, label] of [['fetch', tr("Review fetch")], ['pull', tr("Review pull")], ['push', tr("Review push")]]) actions.append(button(label, () => prepareRemote(operation)));
    actions.append(button(tr("Review branch rewrite"), () => prepareRemote('push', { force: true }), 'vw-danger'));
    section.append(actions);
    const chosen = remotes.find(item => item.name === remoteName);
    section.append(node('p', chosen?.error || tr("Fetch: {0} · Push: {1}", (chosen?.fetch || '—'), (chosen?.push || '—')), 'vw-hint'));
    section.append(node('p', tr("Fetch selects one branch. Pull fast-forwards a clean current branch. Push uses an exact remote-object lease. Credentials stay with Git/gh; no login form is stored here."), 'vw-hint'));
    if (remoteRunning) {
      const pending = node('div', '', 'vw-remote-review'); pending.append(node('p', tr("Remote operation is running. Cancellation cannot undo a server write already received."), 'vw-hint'));
      const cancel = button(tr("Cancel remote operation"), () => { invoke('workspace:git:remote:cancel', { projectId, id: remoteRunning }).catch(failure => { error = failure.message; render(); }); }, 'vw-danger'); cancel.disabled = false; pending.append(cancel); section.append(pending);
    }
    if (remoteReview) {
      const review = remoteReview, panel = node('div', '', 'vw-remote-review'); panel.append(node('h3', tr("Review remote operation")), node('pre', JSON.stringify(review.review, null, 2), 'vw-diff'), node('p', 'Review expires ' + formatDate(review.expiresAt) + '. Confirming may change the remote repository or publish text.', 'vw-hint'));
      panel.append(button(tr("Confirm reviewed operation"), runRemoteReview, 'vw-primary'), button(tr("Discard remote review"), () => perform(async () => { await request('workspace:git:remote:cancel', { id: review.reviewId }); remoteReview = null; })));
      section.append(panel);
    }
    if (remoteResult) { const result = node('div', '', 'vw-remote-result'); result.append(node('strong', remoteResult.state), node('p', remoteResult.message, 'vw-hint')); if (remoteResult.result?.url) result.append(node('code', remoteResult.result.url)); section.append(result); }
    if (!chosen?.github) { section.append(node('p', tr("Pull requests require a configured github.com HTTPS/SSH remote and an authenticated GitHub CLI."), 'vw-hint')); return; }
    const prActions = node('div', '', 'vw-actions'); prActions.append(button(tr("List pull requests"), () => perform(async () => { prList = await request('workspace:git:pr:list', { remote: remoteName }); prDetail = null; })), button(tr("Create pull request"), () => ask(tr("Prepare pull request"), [{ key: 'base', label: tr("Base branch"), required: true }, { key: 'title', label: tr("Title"), required: true }, { key: 'body', label: tr("Description"), type: 'textarea' }, { key: 'draft', label: tr("Initial state"), type: 'select', options: [['true', tr("Draft")], ['false', tr("Ready for review")]], value: 'true' }, { type: 'notice', label: tr("Push this exact local branch first. This prepares a review; publishing requires confirmation.") }], values => prepareRemote('create', { ...values, draft: values.draft === 'true' }, true), 'Prepare review'))); section.append(prActions);
    if (prList) for (const item of prList.pullRequests) section.append(button(`#${item.number} · ${item.state} · ${item.title}`, () => perform(async () => { prDetail = await request('workspace:git:pr:detail', { remote: remoteName, number: item.number }); }), 'vw-artifact-row'));
    if (prDetail) {
      const pr = prDetail.pullRequest, panel = node('section', '', 'vw-pr-detail'); panel.append(node('h3', `#${pr.number} · ${pr.title}`), node('code', pr.url), node('p', `${pr.state}${pr.draft ? ' · draft' : ''}${pr.merged ? ' · merged' : ''} · ${pr.head} → ${pr.base}`, 'vw-hint'), node('pre', pr.body, 'vw-diff'), node('pre', prDetail.diff, 'vw-diff'));
      if (pr.bodyTruncated) panel.append(node('p', tr("Description truncated at 50,000 characters."), 'vw-notice'));
      if (prDetail.diffTruncated) panel.append(node('p', 'Diff preview truncated at ' + prDetail.diffLimitBytes.toLocaleString(globalThis.WiekI18n?.locale()) + ' bytes. Review the full diff with your Git client before merging.', 'vw-notice'));
      const toolbar = node('div', '', 'vw-actions'); toolbar.append(button(tr("Review comment"), () => ask(tr("Prepare PR comment"), [{ key: 'body', label: tr("Comment"), type: 'textarea', required: true }], values => prepareRemote('comment', { number: pr.number, body: values.body }, true), 'Prepare review')));
      if (!pr.merged) toolbar.append(button(pr.state === 'open' ? tr("Review close") : tr("Review reopen"), () => prepareRemote(pr.state === 'open' ? 'close' : 'reopen', { number: pr.number }, true)));
      if (pr.state === 'open' && !pr.draft) toolbar.append(button(tr("Review merge"), () => ask(tr("Prepare PR merge"), [{ key: 'method', label: tr("Merge method"), type: 'select', options: [['merge', tr("Merge commit")], ['squash', tr("Squash")], ['rebase', tr("Rebase")]], value: 'merge' }, { type: 'notice', label: tr("Review the exact PR head commit before confirming. Server branch protection still applies.") }], values => prepareRemote('merge', { number: pr.number, method: values.method }, true), 'Prepare review'), 'vw-danger'));
      panel.append(toolbar); section.append(panel);
    }
  }
  function gitView(body) {
    const section = node('section', '', 'vw-wide'); const heading = node('div', '', 'vw-section-heading'); heading.append(node('h2', git.status ? tr("Git · {0}", (git.status.branch)) : tr("Local Git")), button(tr("Refresh"), () => perform(loadGit))); section.append(heading);
    section.append(node('p', tr("Local operations use your Git configuration. Remote writes require a fresh review and explicit confirmation."), 'vw-hint'));
    if (gitError) section.append(node('div', gitError, 'vw-error'));
    if (!git.status) { body.append(section); return; }
    remoteView(section);
    const branchActions = node('div', '', 'vw-actions');
    const branches = node('select'); branches.setAttribute('aria-label', tr("Local Git branch")); for (const branch of git.branches?.branches || []) { const option = node('option', branch.name); option.value = branch.name; branches.append(option); } branches.value = git.status.branch;
    branchActions.append(branches, button(tr("Switch branch"), () => confirmAction(tr("Switch branch"), tr("Switch to “{0}”? Git will reject conflicting local changes.", (branches.value)), () => gitMutation('branch:switch', { name: branches.value }))), button(tr("New branch"), () => ask(tr("Create branch"), [{ key: 'name', label: tr("Branch name"), required: true }], values => gitMutation('branch:create', { name: values.name, checkout: true })))); section.append(branchActions);
    const changes = node('div', '', 'vw-changes'); changes.append(node('h3', tr("Changed files")));
    if (!git.status.entries.length) changes.append(node('p', tr("Working tree is clean."), 'vw-hint'));
    for (const item of git.status.entries) {
      const row = node('div', '', 'vw-change-row'); const open = button(`${item.status}  ${item.path}`, () => perform(async () => { git.diff = await request('workspace:git:diff', { path: item.path, staged }); }), 'vw-change-file'); row.append(open);
      const paths = item.originalPath ? [item.path, item.originalPath] : [item.path];
      if (item.worktree !== ' ' || item.index === '?') row.append(button(tr("Stage"), () => gitMutation('stage', { paths })));
      if (item.index !== ' ' && item.index !== '?') row.append(button(tr("Unstage"), () => gitMutation('unstage', { paths }))); changes.append(row);
    }
    section.append(changes);
    const commit = node('form', '', 'vw-commit-form'), message = node('textarea'); message.placeholder = tr("Commit message for staged changes"); message.value = commitMessage; message.dataset.focus = 'commit'; message.required = true; message.setAttribute('aria-label', tr("Commit message")); message.oninput = () => commitMessage = message.value;
    const submit = node('button', tr("Commit staged changes"), 'vw-button vw-primary'); submit.disabled = busy > 0; commit.append(message, submit); commit.onsubmit = event => { event.preventDefault(); confirmAction(tr("Commit staged changes"), tr("Create a local commit with the staged files? Repository hooks and signing follow your Git configuration."), async () => { const result = await gitMutation('commit', { message: commitMessage }); if (result !== undefined || !error) commitMessage = ''; }); }; section.append(commit);
    const diffHead = node('div', '', 'vw-section-heading'); diffHead.append(node('h3', staged ? tr("Staged diff") : tr("Working tree diff")), button(staged ? tr("Show unstaged") : tr("Show staged"), () => perform(async () => { staged = !staged; git.diff = await request('workspace:git:diff', { staged }); }))); section.append(diffHead, node('pre', git.diff?.stdout || tr("No diff in this view."), 'vw-diff'));
    const stashHead = node('div', '', 'vw-section-heading'); stashHead.append(node('h3', tr("Stashes")), button(tr("Stash changes"), () => ask(tr("Stash local changes"), [{ key: 'message', label: tr("Description"), value: 'Wiek workspace stash' }, { key: 'includeUntracked', label: tr("Include untracked files"), type: 'select', options: [['false', tr("Tracked changes only")], ['true', tr("Include untracked files")]], value: 'false' }], values => gitMutation('stash:push', { message: values.message, includeUntracked: values.includeUntracked === 'true' })))); section.append(stashHead);
    for (const stash of git['stash:list']?.stashes || []) { const row = node('div', '', 'vw-stash-row'); row.append(node('span', `${stash.id} · ${stash.description}`)); for (const operation of ['apply', 'pop', 'drop']) row.append(button(operation, () => confirmAction(tr("{0} stash", (operation)), `${operation} ${stash.id}? ${operation === 'drop' ? 'This permanently removes that saved stash.' : 'Git will report any conflicts.'}`, () => gitMutation(`stash:${operation}`, { stash: stash.id })), operation === 'drop' ? 'vw-danger' : '')); section.append(row); }
    const checkpointHead = node('div', '', 'vw-section-heading'); checkpointHead.append(node('h3', tr("Project file backups")), button(tr("Back up project files"), () => ask(tr("Create file backup"), [{key:'name',label:tr("Backup name"),required:true}, {type:'notice',label:tr("Saves the real staged index, unstaged files and nonignored untracked files. The index and working files stay in place.")}], values => perform(async () => { const saved = await request('workspace:git:checkpoint:create', {name:values.name}); checkpointNotice = 'Saved file backup “' + saved.checkpoint.name + '”.'; await loadGit(); }, true), 'Back up project files'))); section.append(checkpointHead);
    section.append(node('p', tr("Restoring files requires a fresh preview and confirmation. It preserves a safety checkpoint of your current state. File backups apply on their original HEAD commit; ignored files, symlinks and submodules are excluded or refused."), 'vw-hint'));
    if (checkpointNotice) section.append(node('div', checkpointNotice, 'vw-notice'));
    for (const saved of git['checkpoint:list']?.checkpoints || []) { const row=node('div','','vw-checkpoint-row'); row.append(node('span',saved.name),node('small',formatDate(saved.createdAt)+' · '+saved.files+' files'),button(tr("Preview file restore"),()=>perform(async()=>{checkpointPreview=await request('workspace:git:checkpoint:preview',{id:saved.id});}))); section.append(row); }
    if (!(git['checkpoint:list']?.checkpoints || []).length) section.append(node('p',tr("No named checkpoints in this repository."),'vw-hint'));
    if (checkpointPreview) { const saved=checkpointPreview.checkpoint, panel=node('section','','vw-checkpoint-preview'), head=node('div','','vw-section-heading'); head.append(node('h3','Restore preview · '+saved.name),button(tr("Close preview"),()=>{checkpointPreview=null;render();})); panel.append(head,node('p',checkpointPreview.changes.length+' working-file changes; staged index will match this saved checkpoint.','vw-hint'));
      for (const change of checkpointPreview.changes) panel.append(node('code',change.kind+'  '+change.path,'vw-checkpoint-change'));
      panel.append(node('h3',tr("Saved staged changes")),node('pre',checkpointPreview.stagedDiff||tr("No staged changes."),'vw-diff'),node('h3',tr("Saved unstaged and untracked changes")),node('pre',checkpointPreview.worktreeDiff||tr("No unstaged changes."),'vw-diff'));
      panel.append(button(tr("Restore file backup"),()=>{
        if(dirty){error='Save or reload your unsaved editor buffer before restoring a checkpoint.';render();return;}
        const selected=checkpointPreview;
        ask('Restore “'+saved.name+'”', [{type:'notice',label:tr("This replaces current staged, unstaged and nonignored untracked state with this file backup. A named safety checkpoint preserves the current state. Type the checkpoint name to confirm.")},{key:'confirmation',label:tr("Backup name"),required:true}],values=>{
          if(values.confirmation!==saved.name){error='The confirmation name does not match.';render();return;}
          return perform(async()=>{const result=await request('workspace:git:checkpoint:restore',{id:saved.id,expectedState:selected.expectedState,confirm:true});checkpointNotice='Restored “'+saved.name+'”. Backup of the previous files: '+result.backupCheckpoint.name;checkpointPreview=null;file=null;preview=null;dirty=false;changed=false;await Promise.all([loadGit(),loadTree()]);},true);
        },'Restore file backup');
      },'vw-danger')); section.append(panel);
    }
    section.append(node('h3', tr("Recent commits")));
    for (const commit of git.log?.commits || []) { const row = node('div', '', 'vw-log-row'); row.append(node('code', commit.shortHash), node('span', commit.subject), node('small', `${commit.author} · ${formatDate(commit.date)}`)); section.append(row); }
    body.append(section);
  }
  function dialogNode() {
    const backdrop = node('div', '', 'vw-modal'), form = node('form', '', 'vw-dialog'); form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-label', dialog.title); form.append(node('h2', dialog.title));
    for (const field of dialog.fields) { if (field.type === 'notice') { form.append(node('p', field.label, 'vw-hint')); continue; } const label = node('label', field.label), input = node(field.type === 'select' ? 'select' : field.type === 'textarea' ? 'textarea' : 'input'); if (field.type === 'select') for (const [value, name] of field.options) { const option = node('option', name); option.value = value; input.append(option); } input.value = dialog.values[field.key]; input.required = Boolean(field.required); input.placeholder = field.placeholder || ''; input.dataset.focus = `dialog-${field.key}`; input.oninput = () => dialog.values[field.key] = input.value; input.disabled = busy > 0; label.append(input); form.append(label); }
    const actions = node('div', '', 'vw-actions'); actions.append(button(tr("Cancel"), () => { dialog = null; error = ''; render(); })); const save = node('button', dialog.submitLabel, 'vw-button vw-primary'); save.disabled = busy > 0; actions.append(save); form.append(actions);
    if (error) form.append(node('div', (globalThis.WiekI18n?.error(error) ?? (error)), 'vw-error')); form.onsubmit = async event => { event.preventDefault(); try { await dialog.submit({ ...dialog.values }); } catch (failure) { error = failure.message; render(); } }; backdrop.append(form); return backdrop;
  }
  function render() {
    if (globalThis.WiekI18n?.deferWhileComposing(root, render)) return;
    if (!root?.isConnected) return;
    const active = root.contains(document.activeElement) ? document.activeElement : null, focus = active?.dataset.focus;
    const selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const oldScroll = root.querySelector('.vw-wide')?.scrollTop || 0;
    root.classList.add('vek-workspace-panel'); root.replaceChildren(header());
    if (!projectId) { if (error) root.append(node('div', (globalThis.WiekI18n?.error(error) ?? (error)), 'vw-error')); root.append(node('div', tr("Add a real project folder in Agent workspace to use files and local Git."), 'vw-empty')); return; }
    const meta = node('div', '', 'vw-project-meta'); meta.append(node('code', currentProject()?.path || ''), node('span', state.watches.some(watch => watch.projectId === projectId) ? tr("Watching for changes") : tr("Watch inactive"))); root.append(meta);
    const nav = node('nav', '', 'vw-tabs'); nav.setAttribute('aria-label', tr("Workspace sections"));
    for (const [id, label] of [['files', tr("Files")], ['search', tr("Search")], ['artifacts', tr("Artifacts")], ['git', tr("Git")], ['servers',tr("Local services")]]) nav.append(button(label, async () => { tab = id; render(); if (id === 'git') await perform(loadGit); if (id === 'artifacts') await perform(async () => artifacts = await request('workspace:artifacts', { hidden: true })); }, tab === id ? 'is-active' : '')); root.append(nav);
    if (error && !dialog) { const alert = node('div', (globalThis.WiekI18n?.error(error) ?? (error)), 'vw-error'); alert.role = 'alert'; root.append(alert); }
    const body = node('div', '', `vw-body ${tab === 'files' ? 'vw-files-layout' : ''}`); if (tab === 'files') filesView(body); else if (tab === 'search') searchView(body); else if (tab === 'artifacts') artifactsView(body); else if(tab==='servers')serversView(body);else gitView(body); root.append(body);
    if (dialog) root.append(dialogNode()); const wide = root.querySelector('.vw-wide'); if (wide) wide.scrollTop = oldScroll;
    if (focus) { const input = [...root.querySelectorAll('[data-focus]')].find(item => item.dataset.focus === focus); input?.focus({ preventScroll: true }); if (input && selection && typeof input.setSelectionRange === 'function') try { input.setSelectionRange(...selection); } catch {} }
  }
  function update(next) {
    const data = next?.workspace || next; const incomingProjects = data?.projects || next?.agents?.projects;
    if (Array.isArray(incomingProjects)) state = { ...state, ...data, projects: incomingProjects };
    const valid = state.projects.some(project => project.id === projectId);
    if (!valid && state.projects.length) { dirty = false; perform(() => selectProject(state.projects[0].id)); return; }
    if (!state.projects.length) projectId = '';
    if (data?.lastEvent?.sequence && data.lastEvent.sequence !== lastEvent) {
      lastEvent = data.lastEvent.sequence;
      if (data.lastEvent.projectId === projectId) { changed = Boolean(file); if (root?.isConnected && !busy) loadTree().then(render).catch(failure => { error = failure.message; render(); }); }
    }
    render();
  }
  window.WiekWorkspacePanel = {
    mount(target, dispatch) { root = target; invoke = dispatch; render(); invoke('workspace:snapshot', {}).then(update).catch(failure => { error = failure.message; render(); }); },
    update,
  };
})();

'use strict';
(() => {
  function createPanel(root, invoke, initialContext = {}) {
    let data = { integrations: [], tasks: [], grants: [], connections: [], gateway: null }, context = initialContext;
    let projectId = context.projects?.[0]?.id || '', threadId = '', view = 'integrations', error = '', pending = false, dialog = null, destroyed = false;
    const tools = new Map();
    const make = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
    const button = (label, action, cls = '') => { const node = make('button', label, `vm-button ${cls}`); node.type = 'button'; node.onclick = action; node.disabled = pending; return node; };
    const scope = () => ({ projectId, ...(threadId ? { threadId } : {}) });
    const scopeName = value => `${context.projects?.find(p => p.id === value?.projectId)?.name || value?.projectId || 'Project'}${value?.threadId ? ' / ' + (context.threads?.find(t => t.id === value.threadId)?.title || value.threadId) : ' / all threads'}`;
    const visible = owner => owner?.projectId === projectId && (!owner.threadId || owner.threadId === threadId);
    function update(next, nextContext) {
      if (nextContext) context = nextContext;
      if (next?.agents) context = { ...context, projects: next.agents.projects || context.projects, threads: next.agents.threads || context.threads };
      const incoming = next?.mcp || next;
      if (Array.isArray(incoming?.integrations) && Array.isArray(incoming?.tasks)) data = incoming;
      if (!context.projects?.some(p => p.id === projectId)) { projectId = context.projects?.[0]?.id || ''; threadId = ''; }
      render();
    }
    async function action(name, payload, { close = true } = {}) {
      pending = true; error = ''; render();
      try {
        const result = await invoke(name, payload);
        if (result?.error) throw new Error(result.error);
        if (result?.integrations && result?.tasks) update(result);
        else { const snapshot = await invoke('mcp:snapshot', {}); update(snapshot); }
        if (close) dialog = null;
        return result;
      } catch (failure) { error = failure.message || String(failure); }
      finally { pending = false; render(); }
    }
    function field(label, key, value = '', multiline = false) { return { label, key, value, multiline }; }
    function editIntegration(item, transport = 'stdio') {
      if (!projectId) return;
      if ((item?.transport || transport) === 'http') {
        dialog = {title:item?'Configure HTTP MCP server':'Add an HTTP MCP server',fields:[field('Name','name',item?.name||''),field('MCP endpoint URL','url',item?.url||'https://'),field('Protocol version — 2025-11-25 (session) or 2026-07-28 (per request)','protocolVersion',item?.protocolVersion||'2025-11-25'),field('Header references — JSON object, for example {\"Authorization\":\"env:MCP_AUTH_HEADER\"}','headerRefs',JSON.stringify(item?.headerRefs||{}),true),field('Allow HTTP for loopback only — true or false','allowInsecureHttp',String(item?.allowInsecureHttp===true))],notice:`Scope: ${scopeName(item?.scope||scope())}. Each thread has an isolated connection. The selected protocol controls session or per-request behavior. Referenced environment variables contain complete header values (for example Bearer …). OAuth sign-in is not supported.`,submit:values=>{let refs;try{refs=JSON.parse(values.headerRefs)}catch{throw new Error('Header references must be valid JSON.')}if(!refs||typeof refs!=='object'||Array.isArray(refs))throw new Error('Header references must be a JSON object.');if(!['true','false'].includes(values.allowInsecureHttp))throw new Error('Allow HTTP must be true or false.');return action('mcp:integrations:save',{...(item?{id:item.id}:{}),name:values.name,transport:'http',url:values.url,protocolVersion:values.protocolVersion,headerRefs:refs,allowInsecureHttp:values.allowInsecureHttp==='true',scope:item?.scope||scope(),enabled:item?.enabled!==false})}};render();return;
      }
      dialog = { title: item ? 'Configure MCP server' : 'Add a local MCP server', fields: [field('Name', 'name', item?.name || ''), field('Executable name or absolute path', 'command', item?.command || ''), field('Arguments — JSON array, without secrets', 'args', JSON.stringify(item?.args || []), true), field('Credential references — JSON object, for example {"API_KEY":"env:MY_API_KEY"}', 'credentialRefs', JSON.stringify(item?.credentialRefs || {}), true)], notice: `Scope: ${scopeName(item?.scope || scope())}. Each thread gets a separate server process. Use credential references; their values are never entered in this form.`, submit: values => {
        let args, refs; try { args = JSON.parse(values.args); refs = JSON.parse(values.credentialRefs); } catch { throw new Error('Arguments and credential references must be valid JSON.'); }
        if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !refs || Array.isArray(refs) || typeof refs !== 'object') throw new Error('Arguments must be an array of strings and references an object.');
        return action('mcp:integrations:save', { ...(item ? { id: item.id } : {}), name: values.name, command: values.command, args, credentialRefs: refs, scope: item?.scope || scope(), enabled: item?.enabled !== false });
      } }; render();
    }
    function toolCall(integration, tool) {
      dialog = { title: tool.name, notice: tool.description || 'Run this tool in the selected project/thread scope.', fields: [field('Arguments — JSON object', 'arguments', '{}', true), field('Timeout in milliseconds', 'timeoutMs', '30000')], submit: async values => {
        let args; try { args = JSON.parse(values.arguments); } catch { throw new Error('Arguments must be valid JSON.'); }
        const result = await action('mcp:tasks:create', { integrationId: integration.id, scope: scope(), name: tool.name, arguments: args, timeoutMs: Number(values.timeoutMs) });
        if (result) { view = 'tasks'; render(); }
      } }; render();
    }
    async function listTools(integration) {
      const result = await action('mcp:tools:list', { integrationId: integration.id, scope: scope() });
      if (result) tools.set(`${integration.id}:${projectId}:${threadId}`, result.tools); render();
    }
    function pairClient() {
      const ids = data.integrations.filter(i => visible(i.scope)).map(i => i.id);
      dialog = { title: 'Pair a local MCP client', notice: 'A one-time code grants the selected project/thread only. Exchange it locally for a bearer token; revoke the client here when finished.', fields: [field('Client name', 'name', 'Local client'), field('Allowed integration IDs — JSON array', 'integrationIds', JSON.stringify(ids), true), field('Allowed browser methods — JSON array; choose only the capabilities needed', 'browserMethods', '[]', true)], submit: async values => {
        let integrationIds, browserMethods; try { integrationIds = JSON.parse(values.integrationIds); browserMethods = JSON.parse(values.browserMethods); } catch { throw new Error('Allowlists must be JSON arrays.'); }
        const result = await action('mcp:pairing:create', { scope: scope(), name: values.name, integrationIds, browserMethods });
        if (result) { dialog = { title: 'Pairing code', notice: `Expires ${new Date(result.expiresAt).toLocaleString()}. This code is shown only in this dialog and can be exchanged once.`, readonly: true, fields: [field('One-time code', 'code', result.code), field('POST exchange endpoint', 'exchangeUrl', result.exchangeUrl)] }; render(); }
      } }; render();
    }
    function connectionFor(id) { return data.connections.find(c => c.integrationId === id && c.scope.projectId === projectId && (c.scope.threadId || '') === threadId); }
    function integrations(body) {
      const list = data.integrations.filter(item => visible(item.scope));
      if (!list.length) body.append(make('div', 'No MCP integrations in this scope. Add a stdio or HTTP MCP server to connect tools to this project.', 'vm-empty'));
      for (const item of list) {
        const card = make('article', '', 'vm-card'), head = make('div', '', 'vm-row'), info = make('div', '', 'vm-grow'), connection = connectionFor(item.id);
        info.append(make('h3', item.name), make('p', scopeName(item.scope)), make('code', item.transport === 'http' ? `HTTP · ${item.url}` : [item.command, ...(item.args || [])].join(' '), 'vm-command'));
        head.append(info, make('span', connection?.status || 'disconnected', `vm-status vm-${connection?.status || 'disconnected'}`)); card.append(head);
        const actions = make('div', '', 'vm-actions');
        actions.append(button(connection?.status === 'connected' ? 'Disconnect' : 'Connect', () => action(`mcp:integrations:${connection?.status === 'connected' ? 'disconnect' : 'connect'}`, { id: item.id, scope: scope() })), button('List tools', () => listTools(item)), button('Configure', () => editIntegration(item)), button('Remove', () => { dialog = { title: 'Remove integration?', notice: `Disconnect ${item.name} and remove its configuration.`, fields: [], submit: () => action('mcp:integrations:remove', { id: item.id }) }; render(); })); card.append(actions);
        if (connection?.error) card.append(make('div', connection.error, 'vm-error'));
        if (connection?.stderr) card.append(make('p', connection.stderr, 'vm-muted'));
        for (const tool of tools.get(`${item.id}:${projectId}:${threadId}`) || connection?.tools || []) { const row = make('div', '', 'vm-tool'), description = make('div', '', 'vm-grow'); description.append(make('strong', tool.name), make('p', tool.description || 'No description supplied')); row.append(description, button('Run tool', () => toolCall(item, tool))); card.append(row); }
        body.append(card);
      }
    }
    function tasks(body) {
      const list = [...data.tasks].reverse().filter(t => t.scope.projectId === projectId && (!threadId || t.scope.threadId === threadId));
      if (!list.length) body.append(make('div', 'Tool calls appear here with their real status and result.', 'vm-empty'));
      for (const task of list) {
        const card = make('article', '', 'vm-card'), row = make('div', '', 'vm-row'), info = make('div', '', 'vm-grow');
        info.append(make('h3', task.name), make('p', `${scopeName(task.scope)} · ${new Date(task.createdAt).toLocaleString()}`)); row.append(info, make('span', task.status, `vm-status vm-${task.status}`));
        if (['queued', 'running'].includes(task.status)) row.append(button('Cancel', () => action('mcp:tasks:cancel', { id: task.id, scope: task.scope })));
        card.append(row); if (task.error) card.append(make('div', task.error, 'vm-error'));
        if (task.result !== undefined) { const details = make('details'); details.append(make('summary', 'Tool result'), make('pre', JSON.stringify(task.result, null, 2), 'vm-result')); card.append(details); } body.append(card);
      }
    }
    function clients(body) {
      body.append(make('p', data.gateway ? `Local gateway: ${data.gateway.url}/mcp` : 'Start pairing to create the local loopback gateway.', 'vm-muted'));
      const list = data.grants.filter(g => g.scope.projectId === projectId && (!threadId || g.scope.threadId === threadId));
      if (!list.length) body.append(make('div', 'No paired clients in this scope.', 'vm-empty'));
      for (const grant of list) { const card = make('article', '', 'vm-card'), row = make('div', '', 'vm-row'), info = make('div', '', 'vm-grow'); info.append(make('h3', grant.name), make('p', scopeName(grant.scope)), make('p', `Expires ${new Date(grant.expiresAt).toLocaleString()} · ${grant.integrationIds.length} integrations · ${grant.browserMethods.join(', ') || 'no browser access'}`)); row.append(info, grant.revokedAt ? make('span', 'revoked', 'vm-status') : button('Revoke', () => action('mcp:grants:revoke', { id: grant.id }))); card.append(row); body.append(card); }
    }
    function dialogNode() {
      const overlay = make('div', '', 'vm-overlay'), form = make('form', '', 'vm-dialog'); form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.append(make('h2', dialog.title), make('p', dialog.notice || ''));
      for (const f of dialog.fields || []) { const label = make('label', f.label), input = make(f.multiline ? 'textarea' : 'input'); input.value = f.value; input.name = f.key; input.readOnly = Boolean(dialog.readonly); input.required = !dialog.readonly; input.dataset.focus = f.key; input.oninput = () => { f.value = input.value; }; label.append(input); form.append(label); }
      if (error) form.append(make('div', error, 'vm-error'));
      const buttons = make('div', '', 'vm-actions'); buttons.append(button(dialog.readonly ? 'Done' : 'Cancel', () => { dialog = null; error = ''; render(); }));
      if (!dialog.readonly) { const submit = make('button', pending ? 'Working…' : 'Save / continue', 'vm-button vm-primary'); submit.type = 'submit'; submit.disabled = pending; buttons.append(submit); }
      form.append(buttons); form.onsubmit = async event => { event.preventDefault(); error = ''; try { await dialog.submit(Object.fromEntries(dialog.fields.map(f => [f.key, f.value]))); } catch (failure) { error = failure.message; render(); } }; overlay.append(form); return overlay;
    }
    function render() {
      if (destroyed) return;
      const active = root.contains(document.activeElement) ? document.activeElement : null, focused = active?.dataset.focus, selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
      root.classList.add('vek-mcp-panel'); root.replaceChildren();
      const header = make('div', '', 'vm-header'), intro = make('div'); intro.append(make('h1', 'Connected tools'), make('p', 'MCP servers over stdio or HTTP, scoped tool tasks, and paired clients.')); header.append(intro, button('Add MCP server', () => editIntegration(), 'vm-primary'), button('Add HTTP server', () => editIntegration(null, 'http'))); root.append(header);
      const selectors = make('div', '', 'vm-selectors'), project = make('select'), thread = make('select'); project.setAttribute('aria-label', 'Project scope'); thread.setAttribute('aria-label', 'Thread scope');
      for (const p of context.projects || []) { const option = make('option', p.name); option.value = p.id; option.selected = p.id === projectId; project.append(option); }
      const all = make('option', 'All threads in project'); all.value = ''; thread.append(all);
      for (const t of (context.threads || []).filter(t => t.projectId === projectId)) { const option = make('option', t.title || t.id); option.value = t.id; option.selected = t.id === threadId; thread.append(option); }
      project.onchange = () => { projectId = project.value; threadId = ''; render(); }; thread.onchange = () => { threadId = thread.value; render(); };
      selectors.append(make('span', 'Scope'), project, thread, button('Refresh', () => action('mcp:snapshot', {}))); root.append(selectors);
      const tabs = make('nav', '', 'vm-tabs'); for (const [id, label] of [['integrations', 'Integrations'], ['tasks', 'Tool tasks'], ['clients', 'Paired clients']]) tabs.append(button(label, () => { view = id; render(); }, view === id ? 'is-active' : '')); root.append(tabs);
      if (error && !dialog) root.append(make('div', error, 'vm-error'));
      const body = make('section', '', 'vm-body');
      if (!projectId) body.append(make('div', 'Add a project in the agent workspace before configuring scoped integrations.', 'vm-empty'));
      else if (view === 'integrations') integrations(body); else if (view === 'tasks') tasks(body); else { body.append(button('Pair a local client', pairClient, 'vm-primary')); clients(body); }
      root.append(body); if (dialog) root.append(dialogNode());
      if (focused) { const input = [...root.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focused); input?.focus({ preventScroll: true }); try { if (selection) input?.setSelectionRange(...selection); } catch {} }
    }
    render(); return { update, destroy() { destroyed = true; dialog = null; tools.clear(); root.replaceChildren(); root.classList.remove('vek-mcp-panel'); } };
  }
  let mounted;
  window.createVekMcpPanel = createPanel;
  window.VekMcpPanel = { mount(root, invoke, context) { mounted?.destroy(); mounted = createPanel(root, invoke, context); return mounted; }, update(next, context) { mounted?.update(next, context); }, destroy() { mounted?.destroy(); mounted = null; } };
})();

'use strict';

(() => {
  const tr = (message, ...values) => globalThis.WiekI18n?.t(message, ...values) ?? message.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
  let root, invoke, snapshot = { providers: [], projects: [], threads: [], automations: [] };
  let selectedId = null, view = 'threads', error = '', pending = false, editor = null, showArchived = false;
  let fileChanges=null;
  const drafts = new Map();
  const make = (tag, content, cls) => {
    const node = document.createElement(tag);
    if (content !== undefined && content !== null) node.textContent = String(content);
    if (cls) node.className = cls;
    return node;
  };
  const button = (label, callback, cls = '') => {
    const node = make('button', label, `va-button ${cls}`); node.type = 'button'; node.disabled = pending;
    node.onclick = callback; return node;
  };
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(globalThis.WiekI18n?.locale()) : '—';
  const dateInZone = (value, timeZone) => { if (!value || !Number.isFinite(Date.parse(value))) return '—'; try { return `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timeZone || 'UTC' }).format(new Date(value))} · ${timeZone || 'UTC'}`; } catch { return date(value); } };
  function cronTimeZones(selected = 'UTC') {
    let zones; try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney']; }
    let local = 'UTC'; try { local = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    return [...new Set(['UTC', selected, local, ...zones])].filter(zone => { try { new Intl.DateTimeFormat(undefined, { timeZone: zone }); return true; } catch { return false; } }).map(zone => [zone, zone]);
  }
  const stringify = value => typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '—');
  const provider = id => snapshot.providers.find(item => item.id === id);
  const project = id => snapshot.projects.find(item => item.id === id);
  const thread = () => snapshot.threads.find(item => item.id === selectedId);
  const usable = item => item.available === true && item.enabled !== false;
  const compact = value => String(value || '').replace(/\s+/g, ' ').slice(0, 120);
  function apply(next) {
    const data = next?.agents || next?.agentService || next;
    if (Array.isArray(data?.providers) && Array.isArray(data?.threads)) snapshot = {
      ...data, projects: data.projects || [], automations: data.automations || [],
    };
    if (!snapshot.threads.some(item => item.id === selectedId)) selectedId = snapshot.threads[0]?.id || null;
  }
  async function action(name, payload, closeEditor = false) {
    if (pending) return;
    pending = true; error = ''; render();
    try {
      const result = await invoke(name, payload);
      if (result?.error) throw new Error(result.error);
      apply(result); if (closeEditor) editor = null;
      return result;
    } catch (failure) { error = failure.message || String(failure); }
    finally { pending = false; render(); }
  }
  function openEditor(title, fields, submit, initial = {}) {
    editor = { title, fields, submit, values: { ...initial } };
    for (const field of fields) if (editor.values[field.key] === undefined) editor.values[field.key] = field.value ?? '';
    render(); queueMicrotask(() => root?.querySelector('.va-dialog input, .va-dialog textarea, .va-dialog select')?.focus());
  }
  function askDelete(title, description, callback) {
    openEditor(title, [{ key: 'notice', type: 'notice', label: description }], callback);
  }
  async function chooseThread(id) {
    selectedId = id; error = ''; render();
    try {
      const result = await invoke('agents:threads:read', { id });
      if (result?.id === id && Array.isArray(result.messages)) snapshot.threads = snapshot.threads.map(item => item.id === id ? result : item);
      else apply(result);
      render();
    } catch (failure) { error = failure.message || String(failure); render(); }
  }
  async function importClaude() {
    if (!snapshot.projects.length) return newProject();
    if (!snapshot.providers.length) { view = 'providers'; render(); return; }
    const result = await action('agents:file:claude:preview', {}), preview = result?.claudeImportPreview;
    if (!preview) return;
    openEditor(tr('Import Claude conversation'), [
      { key: 'notice', type: 'notice', label: tr("{0} · {1} branches · {2} sidechain/meta entries excluded · {3} missing parent boundaries. Images/PDFs and external file references are not copied. Continuing creates a new provider session with copied text; it does not resume the source CLI session.", (preview.sourceName), (preview.branches.length), (preview.excludedEntries), (preview.missingParents)) },
      { key: 'leafId', label: tr("Conversation branch"), type: 'select', onChange: async value => { const current = editor; const result = await action('agents:claude:branch', { token: preview.token, leafId: value }); if (editor === current && result?.claudeBranchPreview) { current.fields.find(field => field.key === 'preview').label = tr("Selected branch preview:\n{0}", (result.claudeBranchPreview.text)); render(); } }, options: preview.branches.map(item => [item.id, item.label]), value: preview.branches[0].id },
      { key: 'projectId', label: tr("Import into project"), type: 'select', options: snapshot.projects.map(item => [item.id, item.name]), value: snapshot.projects[0].id },
      { key: 'providerId', label: tr("Agent for future prompts"), type: 'select', options: snapshot.providers.map(item => [item.id, item.name]), value: snapshot.providers.find(item => item.protocol === 'claude-stream-json')?.id || snapshot.providers[0].id },
      { key: 'title', label: tr("Conversation title"), value: `Claude: ${preview.sourceName}` },
      { key: 'preview', type: 'notice', label: tr("Selected branch preview:\n{0}", (preview.previewText)) },
    ], async values => { const imported = await action('agents:claude:import', { ...values, token: preview.token }, true); if (imported?.importedThreadId) { selectedId = imported.importedThreadId; view = 'threads'; render(); } });
    editor.onCancel = () => invoke('agents:claude:discard', { token: preview.token }).catch(() => {});
  }
  async function importCodex() {
    if (!snapshot.projects.length) return newProject();
    if (!snapshot.providers.length) { view='providers';render();return; }
    const result=await action('agents:file:codex:preview',{}),preview=result?.codexImportPreview;if(!preview)return;
    openEditor(tr('Import Codex conversation'),[
      {key:'notice',type:'notice',label:tr("{0} · {1} messages · {2} generated context entries excluded · {3} attachments omitted. Copy visible text into a new session; source tools and paths are display evidence only. {4} compactions and {5} rollback markers applied to the effective visible context. Encrypted-only or unknown edit layouts remain unsupported.", (preview.sourceName), (preview.messageCount), (preview.contextEntries), (preview.attachmentsOmitted), (preview.replay?.compactions||0), (preview.replay?.rollbackEvents||0))},
      {key:'projectId',label:tr("Import into project"),type:'select',options:snapshot.projects.map(p=>[p.id,p.name]),value:snapshot.projects[0].id},
      {key:'providerId',label:tr("Agent for future prompts"),type:'select',options:snapshot.providers.map(p=>[p.id,p.name]),value:snapshot.providers.find(p=>p.protocol==='codex-app-server')?.id||snapshot.providers[0].id},
      {key:'title',label:tr("Conversation title"),value:`Codex: ${preview.sourceName}`},
      {key:'preview',type:'notice',label:tr("Conversation preview:\n{0}", (preview.previewText))}
    ],async values=>{const imported=await action('agents:codex:import',{...values,token:preview.token},true);if(imported?.importedThreadId){selectedId=imported.importedThreadId;view='threads';render();}});
    editor.onCancel=()=>invoke('agents:codex:discard',{token:preview.token}).catch(()=>{});
  }
  function nativeActivity(record, label) {
    const section = make('details', '', 'va-run-details'); section.append(make('summary', label));
    if (record.nativeEventsTruncated || record.toolEventsTruncated) section.append(make('p', tr("Activity display reached its storage limit; some content is omitted."), 'va-hint'));
    for (const event of record.toolEvents || []) {
      const row = make('details'); row.append(make('summary', `${event.name} · ${event.status || 'observed'}${event.parentToolUseId ? ' · nested' : ''}`));
      if (event.input !== undefined) row.append(make('strong', tr("Input")), make('pre', event.input));
      if (event.result !== undefined) row.append(make('strong', tr("Result")), make('pre', event.result || tr("(empty result)")));
      if (event.elapsedSeconds !== undefined) row.append(make('p', tr("{0} seconds reported", (event.elapsedSeconds))));
      if (event.endReason) row.append(make('p', event.endReason, 'va-hint')); section.append(row);
    }
    for (const child of record.subagents || []) {
      const row = make('details'); row.append(make('summary', tr("Subagent · {0} · {1}", (child.description || child.id), (child.status))));
      if (child.summary) row.append(make('p', child.summary));
      for (const message of child.messages || []) row.append(make('strong', message.role === 'assistant' ? tr("Agent") : tr("Tool/user message")), make('pre', message.content));
      if (child.usage) row.append(make('pre', JSON.stringify(child.usage)));
      if (child.endReason) row.append(make('p', child.endReason, 'va-hint')); section.append(row);
    }
    return section;
  }
  function newProject() {
    openEditor(tr('Add a project'), [
      { key: 'name', label: tr("Project name"), required: true, placeholder: tr("My project") },
      { key: 'path', label: tr("Absolute folder path"), required: true, placeholder: '/Users/you/projects/my-project' },
    ], values => action('agents:projects:create', values, true));
  }
  function newThread() {
    if (!snapshot.projects.length) return newProject();
    const available = snapshot.providers.filter(usable);
    if (!available.length) { view = 'providers'; render(); return; }
    openEditor(tr('Start a conversation'), [
      { key: 'title', label: tr("Title"), placeholder: tr("A new idea") },
      { key: 'projectId', label: tr("Project"), type: 'select', options: snapshot.projects.map(item => [item.id, `${item.name} · ${item.path}`]), value: snapshot.projects[0].id },
      { key: 'providerId', label: tr("Agent"), type: 'select', options: available.map(item => [item.id, item.name]), value: available[0].id },
      { key: 'model', label: tr("Model (optional; must be supported by your CLI)"), placeholder: tr("Leave empty for the CLI default") },
    ], async values => {
      const previous = new Set(snapshot.threads.map(item => item.id));
      const result = await action('agents:threads:create', values, true);
      if (result) { selectedId = snapshot.threads.find(item => !previous.has(item.id))?.id || selectedId; view = 'threads'; render(); }
    });
  }
  function modelEditor(t) {
    if (!automationOwned(t)&&['opencode-acp','codex-app-server','claude-stream-json'].includes(provider(t.providerId)?.protocol)) {
      if (!t.nativeCatalog) return action('agents:threads:discover-models', { id: t.id });
      const codex=provider(t.providerId)?.protocol==='codex-app-server',claude=provider(t.providerId)?.protocol==='claude-stream-json',efforts=codex||claude;
      const effortOptions=model=>[['',tr('Agent default')],...(t.nativeCatalog.models.find(m=>m.id===(model||(claude?'default':''))||(claude&&m.resolvedModel===model)||(!model&&codex&&m.isDefault))?.reasoningEfforts||[]).map(e=>[e,e])];
      const models=t.nativeCatalog.models.map(m=>[m.id,m.name]);
      if(claude&&t.model&&!models.some(([id])=>id===t.model)){const resolved=t.nativeCatalog.models.find(m=>m.resolvedModel===t.model);if(resolved)models.push([t.model,`${resolved.name} · ${t.model}`]);}
      const fields=[
        {key:'notice',type:'notice',label:tr("Observed from the native agent on {0}{1}. A catalogue can be bundled or cached and does not verify account access. Empty model keeps the agent default.", (date(t.nativeCatalog.observedAt)), (t.nativeCatalog.truncated?' · catalogue limited to 256 models':''))},
        {key:'model',label:tr("Model"),type:'select',options:[['',codex?tr("Use agent catalogue default"):claude?tr("Use Claude process default"):tr("Keep current agent model")],...models],value:t.model||'',...(efforts?{onChange:value=>{editor.values.reasoningEffort='';editor.fields.find(f=>f.key==='reasoningEffort').options=effortOptions(value);render();}}:{})},
        ...(efforts?[{key:'reasoningEffort',label:tr("Reasoning effort"),type:'select',options:effortOptions(t.model),value:t.reasoningEffort||''}]:[]),
        ...(claude?[{key:'claude-capabilities',type:'notice',label:t.nativeCatalog.models.map(m=>`${m.name}: effort ${m.supportsEffort===undefined?'unknown':m.supportsEffort?'supported':'unsupported'} · ${(m.reasoningEfforts||[]).join(', ')||'no declared levels'}`).join('\n')}]:[]),
        ...(codex?[{key:'capabilities',type:'notice',label:t.nativeCatalog.models.map(m=>`${m.name}: ${(m.inputModalities||[]).join(', ')} · efforts ${(m.reasoningEfforts||[]).join(', ')||'unspecified'}`).join('\n')}]:[])
      ];
      return openEditor(tr('Native session model'),fields,values=>action('agents:threads:model',{id:t.id,model:values.model,...(efforts?{reasoningEffort:values.reasoningEffort}:{})},true));
    }
    openEditor(tr('Conversation model'), [{ key: 'model', label: tr("Model name · configured catalogue: {0}", ((provider(t.providerId)?.models || []).join(', ') || 'none (CLI default available)')), value: t.model || '' }], values => action('agents:threads:model', { id: t.id, model: values.model }, true));
  }
  function configureProvider(item) {
    openEditor(item ? tr('Configure agent') : tr('Add a local agent'), [
      { key: 'name', label: tr("Name"), required: true, placeholder: tr("Local agent") },
      { key: 'command', label: tr("Executable name or absolute path"), required: true, placeholder: 'my-agent' },
      { key: 'args', label: tr("Arguments as a JSON array"), required: true, placeholder: '["exec"]' },
      { key: 'inputMode', label: tr("How the CLI receives your prompt"), type: 'select', options: [['stdin', tr("Standard input")], ['argv', tr("Replace {prompt} in an argument")]], value: 'stdin' },
      { key: 'protocol', label: tr("Provider protocol"), type: 'select', options: [['cli', tr("Plain CLI process")], ['codex-app-server', tr("Codex native JSON-RPC session (opt-in)")], ['claude-stream-json', tr("Claude native streaming session (opt-in)")], ['opencode-acp', tr("OpenCode native ACP v1 session (opt-in)")]], value: 'cli' },
      { key: 'enabled', label: tr("Enabled"), type: 'select', options: [['true', tr("Enabled")], ['false', tr("Disabled")]], value: 'true' },
      { key: 'models', label: tr("Your model catalogue (comma separated)"), placeholder: tr("Optional model names verified by you") },
      { key: 'modelArgs', label: tr("Model arguments as a JSON array"), placeholder: '["--model","{model}"]', value: '[]' },
      { key: 'usageFormat', label: tr("Usage reporting"), type: 'select', options: [['', tr("Unavailable / plain CLI output")], ['codex-jsonl', tr("Actual Codex JSONL turn.completed usage events")]], value: '' },
      { key: 'notice', type: 'notice', label: tr("This runs your installed CLI in the project folder. Use non-interactive arguments supported by that CLI. Authentication stays with the local agent. Claude native mode adds its protocol flags: use an empty arguments array for the claude executable and empty model arguments. For OpenCode ACP use arguments [\"acp\"], stdin and empty model arguments. Its own project config, plugins and MCP servers still apply. Claude and OpenCode follow-ups queue until the active turn finishes.") },
    ], values => {
      let args; try { args = JSON.parse(values.args); } catch { throw new Error(tr("Arguments must be a JSON array of strings.")); }
      if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error(tr("Arguments must be a JSON array of strings."));
      let modelArgs; try { modelArgs = JSON.parse(values.modelArgs || '[]'); } catch { throw new Error(tr("Model arguments must be a JSON array.")); }
      return action('agents:providers:configure', { ...(item ? { id: item.id } : {}), name: values.name, command: values.command, args, inputMode: values.inputMode, protocol: values.protocol, enabled: values.enabled === 'true', models: values.models.split(',').map(value => value.trim()).filter(Boolean), modelArgs, usageFormat: values.usageFormat }, true);
    }, item ? { ...item, args: JSON.stringify(item.args || []), modelArgs: JSON.stringify(item.modelArgs || []), models: (item.models || []).join(', '), enabled: String(item.enabled !== false) } : { args: '[]' });
  }
  async function branch(t, kind) {
    const previous = new Set(snapshot.threads.map(item => item.id));
    const result = await action(`agents:threads:${kind}`, { id: t.id });
    if (result) { selectedId = snapshot.threads.find(item => !previous.has(item.id))?.id || selectedId; showArchived = false; render(); }
  }
  function notesEditor(t) {
    openEditor(tr('Notes and goal'), [
      { key: 'notes', label: tr("Local conversation notes"), type: 'textarea' },
      { key: 'goal', label: tr("Goal (local tracking; does not start an agent)"), type: 'textarea' },
      { key: 'status', label: tr("Goal status"), type: 'select', options: [['active', tr("Active")], ['complete', tr("Complete")]], value: 'active' },
    ], async values => { const saved = await action('agents:threads:notes', { id: t.id, notes: values.notes }); if (saved) await action('agents:threads:goal', { id: t.id, goal: values.goal, status: values.status }, true); }, { notes: t.notes || '', goal: t.goal?.text || '', status: t.goal?.status || 'active' });
  }
  function editMessage(t, message, resend) {
    openEditor(resend ? tr('Edit and resend') : tr('Edit transcript'), [
      { key: 'content', label: tr("Message"), type: 'textarea', required: true },
      { key: 'notice', type: 'notice', label: tr("Later messages move to revision history. This changes the transcript only; it does not undo files, browser actions, or external effects.") },
    ], values => action(resend ? 'agents:threads:resend' : 'agents:threads:edit', { id: t.id, messageId: message.id, content: values.content }, true), { content: message.content });
  }
  function childAgentEditor(t, handoff = false) {
    openEditor(handoff ? tr('Hand off to a new local agent') : tr('Create a child agent'), [
      { key: 'title', label: tr("Title"), value: `${handoff ? 'Handoff' : 'Child'}: ${t.title}` },
      { key: 'prompt', label: tr("Task prompt"), type: 'textarea', required: true },
      { key: 'notice', type: 'notice', label: handoff ? tr("Stops the source run and sends copied transcript context to a new local conversation. This does not transfer a native provider session.") : tr("Runs a real local CLI process in the same project. It consumes the provider’s normal usage allowance.") },
    ], async values => {
      const previous = new Set(snapshot.threads.map(item => item.id));
      const result = await action(handoff ? 'agents:control:handoff' : 'agents:control:create', { ...(handoff ? { fromThreadId: t.id } : { parentThreadId: t.id }), ...values }, true);
      if (result) { selectedId = snapshot.threads.find(item => !previous.has(item.id))?.id || selectedId; render(); }
    });
  }
  function scheduleEditor(item) {
    if (!snapshot.threads.length) { view = 'threads'; newThread(); return; }
    const localTime = value => {
      const d = new Date(value || Date.now() + 3600000);
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    openEditor(item ? tr('Edit automation') : tr('New automation'), [
      { key: 'name', label: tr("Name"), placeholder: tr("Daily project check") },
      { key: 'threadId', label: tr("Conversation / settings template"), type: 'select', options: snapshot.threads.map(t => [t.id, `${t.title} · ${project(t.projectId)?.name || 'Project'}`]), value: selectedId || snapshot.threads[0].id },
      { key: 'executionMode', label: tr("Execution mode"), type:'select',options:[['heartbeat',tr("Heartbeat · continue this conversation")],['standalone',tr("Standalone · new conversation every run")],['dedicated',tr("Dedicated · one automation-owned conversation")]],value:'heartbeat' },
      { key: 'prompt', label: tr("Prompt"), type: 'textarea', required: true, placeholder: tr("What should the agent do?") },
      { key: 'kind', label: tr("Schedule"), type: 'select', options: [['at', tr("Once at a date and time")], ['interval', tr("Repeat at an interval")], ['cron', tr("Cron expression · timezone")], ['heartbeat', tr("Heartbeat with local memory")]], value: 'at' },
      { key: 'at', label: tr("Date and time (your local timezone)"), type: 'datetime-local', value: localTime(), show: values => values.kind === 'at' },
      { key: 'minutes', label: tr("Interval in minutes"), type: 'number', min: '0.0167', step: 'any', value: '60', show: values => ['interval', 'heartbeat'].includes(values.kind) },
      { key: 'cron', label: tr("Five-field cron (minute hour day month weekday)"), value: '0 9 * * 1-5', show: values => values.kind === 'cron' },
      { key: 'timeZone', label: tr("Cron timezone (IANA)"), type: 'select', options: cronTimeZones(item?.timeZone || 'UTC'), value: 'UTC', show: values => values.kind === 'cron' },
      { key: 'dstNotice', type: 'notice', label: tr("Missing clock minutes are skipped. Repeated clock minutes run once at their first occurrence. Closed-app runs need a reviewed login job or an explicit worker tick."), show: values => values.kind === 'cron' },
      { key: 'memory', label: tr("Automation memory (32 KiB UTF-8; latest 8 KiB injected)"), type: 'textarea' },
      { key:'heartbeatCooldownSeconds',label:tr("Activity cooldown in seconds (scheduled continuation after manual activity)"),type:'number',min:'0',step:'any',value:'60'},
      { key:'completionType',label:tr("Stop condition evaluation"),type:'select',options:[['none',tr("Off")],['ai-evaluated',tr("Explicit local CLI evaluator")]],value:'none'},
      { key:'stopWhen',label:tr("Stop when (sent with this run to your chosen evaluator)"),type:'textarea',show:v=>v.completionType==='ai-evaluated'},
      { key:'completionCommand',label:tr("Evaluator executable (runs with project access; no shell)"),show:v=>v.completionType==='ai-evaluated'},
      { key:'completionArgs',label:tr("Evaluator arguments (JSON array)"),value:'[]',show:v=>v.completionType==='ai-evaluated'},
      { key:'confidenceThreshold',label:tr("Required confidence (0 to 1)"),type:'number',min:'0',max:'1',step:'any',value:'0.9',show:v=>v.completionType==='ai-evaluated'},
      { key:'stopAfterConsecutiveFailures',label:tr("Pause after consecutive provider failures (optional)"),type:'number',min:'1',step:'1'},
      { key: 'maxRuns', label: tr("Maximum started runs (optional)"), type: 'number', min: '1', step: '1' },
      { key: 'stopAfter', label: tr("Stop after (optional, local timezone)"), type: 'datetime-local' },
      { key: 'stopOnFailure', label: tr("On provider failure"), type: 'select', options: [['false', tr("Keep the schedule")], ['true', tr("Pause the schedule")]], value: 'false' },
      {key:'closedAppAllowed',label:tr("Allow a closed-app worker tick"),type:'select',options:[['false',tr("Off · browser only")],['true',tr("On · CLI tick or reviewed login job")]],value:'false'},
      { key: 'notice', type: 'notice', label: tr("Standalone/dedicated copy only project, provider and model settings, never the source messages or attachments. Closed-app ticks support plain CLI providers only. Review a login job separately in Settings → Background scheduling.") },
    ], values => {
      const payload = { name: values.name, threadId: values.threadId, prompt: values.prompt, kind: values.kind,executionMode:values.executionMode,closedAppAllowed:values.closedAppAllowed==='true' };
      if (values.kind === 'at') {
        const timestamp = new Date(values.at); if (!Number.isFinite(timestamp.getTime())) throw new Error(tr("Choose a valid date and time.")); payload.at = timestamp.toISOString();
      } else if (values.kind === 'cron') { payload.cron = values.cron; payload.timeZone = values.timeZone || 'UTC'; }
      else {
        payload.intervalMs = Math.round(Number(values.minutes) * 60000);
        if (!Number.isFinite(payload.intervalMs) || payload.intervalMs <= 0) throw new Error(tr("Enter a positive interval."));
      }
      payload.heartbeatCooldownSeconds=Number(values.heartbeatCooldownSeconds??60);payload.stopAfterConsecutiveFailures=values.stopAfterConsecutiveFailures?Number(values.stopAfterConsecutiveFailures):null;payload.completionPolicy=values.completionType==='ai-evaluated'?{type:'ai-evaluated',stopWhen:values.stopWhen,command:values.completionCommand,args:JSON.parse(values.completionArgs||'[]'),confidenceThreshold:Number(values.confidenceThreshold)}:{type:'none'};payload.memory = values.memory || ''; payload.maxRuns = values.maxRuns ? Number(values.maxRuns) : null; payload.stopAfter = values.stopAfter ? new Date(values.stopAfter).toISOString() : null; payload.stopOnFailure = values.stopOnFailure === 'true';
      return action(item ? 'agents:automations:update' : 'agents:automations:create', { ...(item ? { id: item.id } : {}), ...payload }, true);
    }, item ? { ...item,completionType:item.completionPolicy?.type||'none',stopWhen:item.completionPolicy?.stopWhen||'',completionCommand:item.completionPolicy?.command||'',completionArgs:JSON.stringify(item.completionPolicy?.args||[]),confidenceThreshold:String(item.completionPolicy?.confidenceThreshold??0.9),heartbeatCooldownSeconds:String(item.heartbeatCooldownSeconds??60),stopAfterConsecutiveFailures:item.stopAfterConsecutiveFailures||'',executionMode:item.executionMode||'heartbeat',closedAppAllowed:String(!!item.closedAppAllowed), at: localTime(item.at), stopAfter: item.stopAfter ? localTime(item.stopAfter) : '', maxRuns: item.maxRuns || '', stopOnFailure: String(!!item.stopOnFailure), minutes: String((item.intervalMs || 3600000) / 60000) } : {});
  }
  const automationOwned=t=>t?.automationMode==='dedicated'&&snapshot.automations.some(a=>a.id===t.automationOwnerId);
  function messageList(t) {
    const list = make('div', '', 'va-messages'); list.dataset.scroll = 'messages'; list.setAttribute('aria-live', 'polite'); list.setAttribute('aria-label', tr("Conversation messages"));
    if (!t.messages?.length) {
      const empty = make('div', '', 'va-conversation-empty'); empty.append(make('span', '✳', 'va-spark'), make('h3', tr("What are you working on?")), make('p', tr("Send a prompt to {0} in {1}.", (provider(t.providerId)?.name || 'your local agent'), (project(t.projectId)?.name || 'this project')))); list.append(empty);
    }
    for (const message of t.messages || []) {
      const row = make('article', '', `va-message va-message-${['user', 'assistant', 'system'].includes(message.role) ? message.role : 'system'}`);
      const meta = make('div', '', 'va-message-meta'); meta.append(make('strong', message.role === 'user' ? tr("You") : message.role === 'assistant' ? provider(t.providerId)?.name || tr("Agent") : tr("System")), make('time', date(message.createdAt)));
      const tools = make('div', '', 'va-message-tools');
      if (t.status !== 'running'&&!automationOwned(t)) {
        if (message.role === 'user') tools.append(button(tr("Edit"), () => editMessage(t, message, false)), button(tr("Edit & resend"), () => editMessage(t, message, true)));
        tools.append(button(tr("Rollback here"), () => askDelete(tr('Rollback transcript'), 'Keep messages through this point and save the current transcript as a revision? Files, browser actions, and external effects remain unchanged.', () => action('agents:threads:rollback', { id: t.id, messageId: message.id }, true))));
      }
      tools.append(button(tr("Bookmark"), () => openEditor(tr('Bookmark message'), [{ key: 'label', label: tr("Label"), required: true, value: 'Bookmark' }], values => action('agents:threads:marker:add', { id: t.id, messageId: message.id, label: values.label }, true))));
      row.append(meta, make('div', message.content, 'va-message-body'));
      if (message.attachments?.length) { const files = make('div', '', 'va-attachments'); for (const file of message.attachments) { const link = button(`📎 ${file.name}`, () => action('agents:files:open', { id: t.id, attachmentId: file.id })); link.disabled = pending || file.available === false; files.append(link); } row.append(files); }
      row.append(tools); list.append(row);
    }
    if (['running', 'discovering'].includes(t.status)) list.append(make('div', tr("Agent is running…"), 'va-running-note'));
    return list;
  }
  function configureCheckpoints(item){openEditor(tr('Automatic file backups'),[
    {key:'notice',type:'notice',label:tr("Back up project files and staged changes before and after each Agent reply. Requires a supported Git repository (2 MiB per file, 32 MiB total). Capture failure prevents the provider from starting. Restoring files requires a preview and confirmation.")},
    {key:'enabled',label:tr("Back up files for each message"),type:'select',options:[['false',tr("Off")],['true',tr("On for this project")]],value:String(item.checkpointsEnabled===true)}
  ],values=>action('agents:projects:checkpoints',{id:item.id,enabled:values.enabled==='true'},true));}
  async function showFileChanges(t,run,previewTarget){
    const payload={id:t.id,...(run?{runId:run.id}:{scope:'thread'}),...(previewTarget?{target:previewTarget}:{})};
    const data=await action(previewTarget?'agents:changes:preview':'agents:changes:diff',payload);
    if(data){fileChanges={mode:previewTarget?'preview':'diff',threadId:t.id,runId:run?.id,target:previewTarget,data,confirmation:''};render();}
  }
  function renderFileChanges(){
    const overlay=make('div','','va-modal'),form=make('form','','va-dialog va-file-changes');form.setAttribute('role','dialog');form.setAttribute('aria-modal','true');form.setAttribute('aria-label',tr("Project file changes"));
    const current=fileChanges,data=current.data;form.append(make('h2',current.mode==='preview'?tr("Preview file restore"):current.mode==='restored'?tr("Files restored"):tr("Project file changes")));
    if(error)form.append(make('p',(globalThis.WiekI18n?.error(error) ?? (error)),'va-error'));
    if(current.mode==='restored')form.append(make('p',tr("Files and index were restored. Backup of the previous files: {0} ({1}).", (data.backupCheckpoint.name), (data.backupCheckpoint.id))));
    else{
      form.append(make('p',current.mode==='preview'?tr("Restore project files from backup: {0}. This changes real files and the staged index. A backup preserves the current files before restoring.", (data.checkpoint.name)):data.notice,'va-hint'));
      if(data.headChanged)form.append(make('p',tr("HEAD changed during this span. Snapshot diff is available; restoring an earlier HEAD is refused."),'va-hint'));
      const list=make('div','','va-file-change-list');for(const row of data.changes||[])list.append(make('div',`${row.kind} · ${row.path}${row.staged?' · index':''}${row.worktree?' · files':''}`));if(!data.changes?.length)list.append(make('p',tr("No file content changes.")));form.append(list);
      for(const [key,label]of [['worktreeDiff',current.mode==='preview'?tr("Saved working state"):tr("Working-file diff")],['stagedDiff',current.mode==='preview'?tr("Saved staged state"):tr("Staged-index diff")]]){const details=make('details');details.append(make('summary',label),make('pre',data[key]||tr("No diff.")));form.append(details);}
    }
    const actions=make('div','','va-dialog-actions');actions.append(button(tr("Close"),()=>{fileChanges=null;error='';render();}));
    if(current.mode==='preview'){
      const label=make('label',tr("Type “{0}” to confirm", (data.checkpoint.name))),input=make('input');input.setAttribute('aria-label',tr("Confirm backup name"));input.dataset.focus='restore-snapshot';input.value=current.confirmation;label.append(input);form.append(label);
      const restore=button(tr("Restore files and index"),async()=>{if(current.confirmation!==data.checkpoint.name)return;const result=await action('agents:changes:restore',{id:current.threadId,runId:current.runId,target:current.target,expectedState:data.expectedState,confirm:true});if(result){fileChanges={mode:'restored',data:result};render();}},'va-danger');restore.disabled=pending||current.confirmation!==data.checkpoint.name;input.oninput=()=>{current.confirmation=input.value;restore.disabled=pending||input.value!==data.checkpoint.name;};actions.append(restore);
    }
    form.onsubmit=event=>event.preventDefault();form.onkeydown=event=>{if(event.key==='Escape'&&!pending){event.preventDefault();fileChanges=null;render();}};form.append(actions);overlay.append(form);root.append(overlay);
  }
  function threadsView(body) {
    const rail = make('section', '', 'va-thread-rail');
    const projects = make('div', '', 'va-projects');
    const projectHead = make('div', '', 'va-section-label'); projectHead.append(make('span', tr("PROJECTS")), button('+', newProject, 'va-icon-button')); projects.append(projectHead);
    for (const item of snapshot.projects) {
      const row = make('div', '', 'va-project-row'); row.append(make('span', item.name)); row.title = item.path;
      row.append(button(item.checkpointsEnabled?tr("Snapshots on"):tr("Snapshots off"),()=>configureCheckpoints(item),'va-snapshot-setting'),button('×', () => askDelete(tr('Remove project'), `Remove “${item.name}” from Wiek? Files on disk are not deleted.`, () => action('agents:projects:delete', { id: item.id }, true)), 'va-icon-button')); projects.append(row);
    }
    if (!snapshot.projects.length) projects.append(make('p', tr("Add a folder to give your agent a working directory."), 'va-hint'));
    rail.append(projects);
    const threadHead = make('div', '', 'va-section-label'); threadHead.append(make('span', tr("CONVERSATIONS")), button('+', newThread, 'va-icon-button')); rail.append(threadHead);
    rail.append(button(showArchived ? tr("Show active conversations") : tr("Show archive"), () => { showArchived = !showArchived; render(); }, 'va-archive-toggle'));
    for (const item of [...snapshot.threads].filter(item => !!item.archived === showArchived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
      const entry = button('', () => chooseThread(item.id), `va-thread ${item.id === selectedId ? 'is-active' : ''}`);
      entry.append(make('span', `${item.pinned ? '★ ' : ''}${item.title || tr('Untitled conversation')}`, 'va-thread-title'), make('small', `${item.kind === 'sidechat' ? 'Sidechat · ' : ''}${project(item.projectId)?.name || 'Project'} · ${item.status}`)); rail.append(entry);
    }
    body.append(rail);
    const main = make('section', '', 'va-conversation'); const t = thread();
    if (!t) {
      const empty = make('div', '', 'va-conversation-empty'); empty.append(make('span', '✳', 'va-spark'), make('h3', tr("A little room to think.")), make('p', tr("Start a conversation with a local agent in your project.")), button(!snapshot.projects.length ? tr("Add a project") : snapshot.providers.some(usable) ? tr("New conversation") : tr("Set up an agent"), newThread, 'va-primary')); main.append(empty); body.append(main); return;
    }
    const toolbar = make('div', '', 'va-conversation-heading');
    const title = make('div'); title.append(make('h2', t.title), make('p', `${provider(t.providerId)?.name || t.providerId} · ${project(t.projectId)?.path || 'Project unavailable'}`));
    const actions = make('div', '', 'va-actions'); actions.append(make('span', tr(t.status), `va-status va-status-${t.status}`), button(tr("Rename"), () => openEditor(tr('Rename conversation'), [{ key: 'title', label: tr("Title"), required: true }], values => action('agents:threads:rename', { id: t.id, title: values.title }, true), { title: t.title })));if(!automationOwned(t))actions.append(button(tr("Delete"), () => askDelete(tr('Delete conversation'), `Delete “${t.title}”, its stored messages, and linked automations?`, () => action('agents:threads:delete', { id: t.id }, true)), 'va-danger'));
    const more = make('details', '', 'va-thread-more'); more.append(make('summary', tr("Conversation tools")));
    const extras = make('div', '', 'va-actions'); extras.append(button(t.pinned ? tr("Unpin") : tr("Pin"), () => action(t.pinned ? 'agents:threads:unpin' : 'agents:threads:pin', { id: t.id })), button(t.archived ? tr("Unarchive") : tr("Archive"), () => action(t.archived ? 'agents:threads:unarchive' : 'agents:threads:archive', { id: t.id })), button(tr("Notes & goal"), () => notesEditor(t)), button(tr("Fork"), () => branch(t, 'fork')), button(tr("Sidechat"), () => branch(t, 'sidechat')));if(!automationOwned(t))extras.append(button(tr("Model"),()=>modelEditor(t)));
    if (['opencode-acp','codex-app-server','claude-stream-json'].includes(provider(t.providerId)?.protocol)) { const refresh = button(tr("Discover models"), () => action('agents:threads:discover-models', { id: t.id })); refresh.disabled = pending || ['running', 'discovering'].includes(t.status); extras.append(refresh); }
    extras.append(button(tr("Child agent"), () => childAgentEditor(t)), button(tr("Hand off"), () => childAgentEditor(t, true)),button(tr("Conversation file diff"),()=>showFileChanges(t))); more.append(extras); toolbar.append(title, actions); main.append(toolbar, more);
    if (t.goal) main.append(make('p', tr("Goal · {0}: {1}", tr(t.goal.status), (t.goal.text)), 'va-goal'));
    if (t.markers?.length) { const markers = make('div', '', 'va-markers'); for (const marker of t.markers) markers.append(button(`★ ${marker.label} ×`, () => action('agents:threads:marker:remove', { id: t.id, markerId: marker.id }))); main.append(markers); }
    main.append(messageList(t));
    if (t.status === 'discovering') main.append(make('p', tr("Discovering native model catalogue. No prompt is sent."), 'va-hint'));
    if (t.modelDiscovery?.error) main.append(make('p', tr("Model discovery: {0}", (t.modelDiscovery.error)), 'va-hint'));
    if (t.revisions?.length) { const history = make('details', '', 'va-run-details'); history.append(make('summary', tr("{0} transcript revisions", (t.revisions.length)))); for (const revision of [...t.revisions].reverse()) { const entry = make('details'); entry.append(make('summary', `${revision.kind} · ${date(revision.createdAt)}`), make('pre', revision.messages.map(message => `${message.role}: ${message.content}`).join('\n\n'))); history.append(entry); } main.append(history); }
    const runs = t.runs || []; const latest = runs[runs.length - 1];
    if(runs.some(run=>run.fileChanges)){
      const history=make('details','','va-run-details');history.append(make('summary',tr("File backups for each message")));
      for(const [index,run]of runs.entries())if(run.fileChanges){const changes=run.fileChanges,row=make('section','','va-turn-snapshot');row.append(make('strong',tr("Turn {0} · {1} · {2}", (index+1), tr(run.status), tr(changes.status))));if(changes.error)row.append(make('p',changes.error,'va-hint'));const actions=make('div','','va-actions');if(changes.before&&changes.after)actions.append(button(tr("View file changes"),()=>showFileChanges(t,run)));if(!['running','discovering'].includes(t.status)){if(changes.before)actions.append(button(tr("Restore before…"),()=>showFileChanges(t,run,'before')));if(changes.after)actions.append(button(tr("Restore after…"),()=>showFileChanges(t,run,'after')));}row.append(actions);history.append(row);}main.append(history);
    }
    if (t.claudeHistory || t.codexHistory || runs.some(run => run.toolEvents?.length || run.subagents?.length)) {
      const activity = make('details', '', 'va-run-details va-native-history'); activity.append(make('summary', tr("Native activity history")));
      if (t.codexHistory) activity.append(make('p',tr("Imported Codex history · {0} · copied transcript, new session on continuation", (t.codexHistory.sourceName)),'va-hint'),nativeActivity(t.codexHistory.activity||{},tr('Imported Codex activity')));
      if(t.codexHistory?.replay)activity.append(make('p',tr("{0} compactions · {1} rollbacks · effective visible context", (t.codexHistory.replay.compactions), (t.codexHistory.replay.rollbackEvents)),'va-hint'));
      if (t.claudeHistory) { const source = t.claudeHistory; activity.append(make('p', tr("Imported Claude history · {0} · copied transcript, new session on continuation", (source.sourceName)), 'va-hint'), nativeActivity(source.activity || {}, tr('Imported Claude activity'))); }
      for (const [index, run] of runs.entries()) if (run.toolEvents?.length || run.subagents?.length) activity.append(nativeActivity(run, `Turn ${index + 1} native activity`));
      main.append(activity);
    }
    for (const approval of latest?.approvals || []) if (approval.status === 'pending') {
      const card = make('section', '', 'va-approval'); card.append(make('strong', tr("Local agent needs approval")), make('p', approval.title), make('pre', `${approval.cwd}\n${approval.command || approval.kind}`));
      const actions = make('div', '', 'va-actions'); for (const [decision, label] of [['accept', tr("Approve this request")], ['decline', tr("Decline")], ['cancel', tr("Cancel turn")]]) { const control = button(label, () => action('agents:control:approval', { id: t.id, approvalId: approval.id, decision }), decision === 'accept' ? 'va-primary' : ''); if (decision === 'accept' && approval.canAccept === false) control.disabled = true; actions.append(control); }
      card.append(actions); main.append(card);
    }
    if (latest) {
      const details = make('details', '', 'va-run-details'); details.append(make('summary', tr("Latest run: {0}{1}{2}", (latest.status), (latest.exitCode !== undefined ? ` · exit ${latest.exitCode}` : ''), (latest.truncated ? ' · output truncated' : ''))));
      if (latest.stdout) details.append(make('strong', tr("Standard output")), make('pre', latest.stdout));
      if (latest.stderr) details.append(make('strong', tr("Standard error")), make('pre', latest.stderr));
      if (Number.isSafeInteger(latest.usage?.inputTokens) && Number.isSafeInteger(latest.usage?.outputTokens)) details.append(make('p', tr("Reported tokens: {0} input · {1} output{2}", (latest.usage.inputTokens), (latest.usage.outputTokens), (latest.usage.cachedInputTokens !== undefined ? ` · ${latest.usage.cachedInputTokens} cached input` : ''))));
      if (latest.nativeStopReason) details.append(make('p', tr("Provider stop reason: {0}", (latest.nativeStopReason))));
      if (latest.contextUsage) details.append(make('p', tr("Context: {0} / {1} tokens", (latest.contextUsage.used), (latest.contextUsage.size))));
      if (latest.usage?.sessionCostUsd !== undefined) details.append(make('p', tr("Provider session cost estimate: ${0} · cumulative, not a per-turn bill", (latest.usage.sessionCostUsd.toFixed(6)))));
      if (!latest.stdout && !latest.stderr) details.append(make('pre', tr("No process output recorded."))); main.append(details);
    }
    if(automationOwned(t)){main.append(make('p',tr("This conversation belongs to an automation. Use its Run now and Stop controls; delete the automation to release the conversation."),'va-hint'));body.append(main);return;}
    const composer = make('form', '', 'va-composer');
    const attachments = make('details', '', 'va-attachment-manager'); attachments.append(make('summary', tr("Attachments · {0}/10 active", ((t.attachments || []).filter(file => !file.detachedAt).length))));
    for (const file of t.attachments || []) {
      const row = make('div', '', 'va-attachment-row');
      const link = button(`${file.name}${file.available === false ? ' · unavailable' : ''}`, () => action('agents:files:open', { id: t.id, attachmentId: file.id })); link.disabled = pending || file.available === false;
      const toggle = button(file.detachedAt ? tr("Restore") : tr("Detach"), () => action(file.detachedAt ? 'agents:attachments:restore' : 'agents:attachments:remove', { id: t.id, attachmentId: file.id })); toggle.disabled = pending || ['running', 'discovering'].includes(t.status) || (file.detachedAt && file.available === false);
      row.append(link, make('span', tr("{0} · {1} KiB{2}", (file.mimeType), ((Number(file.bytes || 0) / 1024).toFixed(1)), (file.detachedAt ? ' · detached' : '')), 'va-hint'), toggle); attachments.append(row);
    }
    attachments.append(make('p', tr("Up to 10 active files, 20 MiB each. Detaching keeps the local copy recoverable; original files are unchanged."), 'va-hint')); composer.append(attachments);
    const prompt = make('textarea'); prompt.placeholder = tr("Ask {0}…", (provider(t.providerId)?.name || 'your agent')); prompt.setAttribute('aria-label', tr("Message your agent")); prompt.dataset.focus = 'prompt'; prompt.value = drafts.get(t.id) || ''; prompt.rows = 3;
    prompt.oninput = () => drafts.set(t.id, prompt.value); prompt.disabled = t.status === 'discovering' || !usable(provider(t.providerId) || {});
    const footer = make('div', '', 'va-composer-footer'); footer.append(make('span', tr("{0} running{1}", (snapshot.runningCount || 0), (snapshot.maxConcurrentRuns ? ` / ${snapshot.maxConcurrentRuns} allowed` : '')), 'va-hint'));
    const attach = button(tr("Attach files"), () => action('agents:files:attach', { id: t.id })); attach.disabled = pending || ['running', 'discovering'].includes(t.status); footer.append(attach);
    const send = make('button', t.status === 'discovering' ? tr("Discovering models…") : t.status === 'running' ? tr("Queue follow-up") : tr("Send prompt"), 'va-button va-primary'); send.disabled = pending || t.status === 'discovering' || !usable(provider(t.providerId) || {});
    if (['running', 'discovering'].includes(t.status)) footer.append(button(tr("Stop agent"), () => action('agents:control:stop', { id: t.id }), 'va-danger'));
    if (t.pendingFollowUps?.length) footer.append(make('span', tr("{0} queued for the next CLI turn", (t.pendingFollowUps.length)), 'va-hint'));
    footer.append(send); composer.append(prompt, footer);
    composer.onsubmit = async event => {
      event.preventDefault();
      if (t.status === 'discovering') return;
      const value = (drafts.get(t.id) || '').trim(); if (!value) { prompt.focus(); return; }
      const result = await action(['running', 'discovering'].includes(t.status) ? 'agents:control:steer' : 'agents:threads:prompt', { id: t.id, prompt: value });
      if (result) { drafts.delete(t.id); render(); }
    };
    prompt.onkeydown = event => { if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); composer.requestSubmit(); } };
    main.append(composer); body.append(main);
  }
  function providersView(body) {
    const section = make('section', '', 'va-wide-section'); const heading = make('div', '', 'va-section-heading');
    heading.append(make('h2', tr("Local agents")), button(tr("Refresh availability"), () => action('agents:providers:discover', {})), button(tr("Add agent"), () => configureProvider(), 'va-primary')); section.append(heading);
    section.append(make('p', tr("Wiek runs the agents installed on this computer. Install and sign in to the CLI separately, then refresh its availability."), 'va-hint'));
    if (!snapshot.providers.length) section.append(make('div', tr("No local agents configured. Add an installed CLI to begin. No generated reply will appear until a real agent runs."), 'va-empty-card'));
    for (const item of snapshot.providers) {
      const card = make('div', '', 'va-provider-card'); const info = make('div'); info.append(make('h3', item.name), make('code', `${item.command} ${(item.args || []).join(' ')}`), make('p', item.available ? item.enabled === false ? tr("Installed · disabled") : tr("Installed · ready") : tr("Not installed or executable not found"), 'va-hint'));
      const actions = make('div', '', 'va-actions'); actions.append(make('span', usable(item) ? tr("Ready") : item.available ? tr("Disabled") : tr("Unavailable"), `va-status ${usable(item) ? 'va-status-completed' : 'va-status-failed'}`), button(tr("Configure"), () => configureProvider(item)), button(tr("Remove"), () => askDelete(tr('Remove agent'), `Remove the “${item.name}” configuration? This does not uninstall the CLI.`, () => action('agents:providers:remove', { id: item.id }, true)), 'va-danger')); card.append(info, actions); section.append(card);
    }
    body.append(section);
  }
  function schedulesView(body) {
    const section = make('section', '', 'va-wide-section'); const heading = make('div', '', 'va-section-heading'); heading.append(make('h2', tr("Automations")), button(tr("New automation"), () => scheduleEditor(), 'va-primary')); section.append(heading);
    section.append(make('p', tr("Schedule a prompt once, by interval, by cron in an IANA timezone, or as a heartbeat with local memory. Normal scheduling runs while Wiek is open. Opted-in plain CLI tasks can also run through an explicit closed-app worker tick; review a macOS login job in Settings → Background scheduling. Proposed tasks run only after you choose Approve & run."), 'va-hint'));
    if(snapshot.recoveryBlocks?.length){for(const block of snapshot.recoveryBlocks)section.append(make('p',tr("Interrupted provider · PID {0} · {1}", (block.pid), (block.reason)),'va-hint'));section.append(button(tr("Refresh recovery status"),()=>action('agents:recovery:refresh')));}
    if (!snapshot.automations.length) section.append(make('div', tr("No automations yet. Choose a conversation and schedule its next prompt."), 'va-empty-card'));
    for (const item of snapshot.automations) {
      const card = make('article', '', 'va-automation-card'); const heading = make('div', '', 'va-section-heading'); heading.append(make('h3', item.name || tr("Automation")), make('span', item.status, `va-status va-status-${item.status}`)); card.append(heading);
      card.append(make('p', item.prompt, 'va-automation-prompt'));
      const meta = make('dl', '', 'va-schedule-meta');
      for (const [key, value] of [ ['Conversation / template', snapshot.threads.find(t => t.id === item.threadId)?.title || tr('Conversation unavailable')],['Execution mode',item.executionMode||'heartbeat'],[tr('Dedicated conversation'),snapshot.threads.find(t=>t.id===item.ownedThreadId)?.title||'—'],[tr('Last run conversation'),snapshot.threads.find(t=>t.id===item.lastRunThreadId)?.title||'—'],['Closed-app worker',item.closedAppAllowed?'CLI tick / reviewed login job allowed':'Off'], ['Schedule', item.kind === 'at' ? tr("Once · {0}", (date(item.at))) : item.kind === 'cron' ? `${item.cron} · ${item.timeZone || 'UTC'}` : tr("{0}Every {1} minutes", (item.kind === 'heartbeat' ? 'Heartbeat · ' : ''), (Number(item.intervalMs) / 60000))], ...(item.kind === 'cron' ? [['DST policy', tr('Skip missing minutes · first occurrence only')]] : []), [tr('Next run'), item.kind === 'cron' ? dateInZone(item.nextRunAt, item.timeZone) : date(item.nextRunAt)], [tr('Last run'), date(item.lastRunAt)], [tr('Last outcome'), stringify(item.lastOutcome)], [tr('Started runs'), `${item.runCount || 0}${item.maxRuns ? ` / ${item.maxRuns} maximum` : ''}`], [tr('Stop date'), date(item.stopAfter)], [tr('Stop reason'), item.stopReason || '—'], ['Memory', item.memory || '—'], [tr('Last error'), item.lastError || '—'],['Deferral',item.deferred?tr("{0} · retry {1} · expires {2}", (item.deferred.reason), (date(item.deferred.until)), (date(item.deferred.deadline))):'—'],[tr('Activity cooldown'),`${item.heartbeatCooldownSeconds??60} seconds`],[tr('Stop condition'),item.completionPolicy?.type==='ai-evaluated'?item.completionPolicy.stopWhen:'Off'],['Result',item.lastResult?`${item.lastResult.decision} · ${item.lastResult.unread?'unread':'read'} · ${item.lastResult.summary||''}`:'—'], ...(item.lastScheduleError ? [[tr('Schedule error'), item.lastScheduleError]] : []) ]) meta.append(make('dt', key), make('dd', value));
      card.append(meta); const evaluated=snapshot.threads.flatMap(t=>t.runs||[]).find(r=>r.id===item.lastRunId)?.completionEvaluation;if(evaluated)card.append(make('p',tr("Stop evaluation: {0}{1}{2}", (evaluated.status), (evaluated.reason?' · '+evaluated.reason:''), (evaluated.stalePolicy?' · policy changed; result not applied':'')),'va-hint')); const actions = make('div', '', 'va-actions');if(item.lastResult?.unread)actions.append(button(tr("Mark result read"),()=>action('agents:automations:mark-read',{id:item.id}))); actions.append(button(tr("Edit"), () => scheduleEditor(item)), button(item.status === 'active' ? tr("Pause") : tr("Resume"), () => action(item.status === 'active' ? 'agents:automations:pause' : 'agents:automations:resume', { id: item.id })), button(tr("Run now"), () => action('agents:automations:run', { id: item.id })), button(tr("Stop run"), () => action('agents:automations:stop', { id: item.id })), button(tr("Propose task"), () => openEditor(tr('Add a proposed task'), [{ key: 'title', label: tr("Title"), required: true }, { key: 'prompt', label: tr("Proposed prompt (manual local draft)"), type: 'textarea', required: true }], values => action('agents:proposals:create', { automationId: item.id, ...values }, true))), button(tr("Delete"), () => askDelete(tr('Delete automation'), `Delete “${item.name || 'Automation'}”?`, () => action('agents:automations:delete', { id: item.id }, true)), 'va-danger')); card.append(actions); section.append(card);
    }
    if (snapshot.proposals?.length) {
      section.append(make('h2', tr("Proposed tasks"), 'va-proposal-heading'));
      for (const proposal of snapshot.proposals) {
        const card = make('article', '', 'va-automation-card'); card.append(make('h3', proposal.title), make('p', proposal.prompt, 'va-automation-prompt'), make('p', `${proposal.status} · ${proposal.source === 'provider-output' ? tr('Quoted from recorded provider output') : proposal.source === 'imported' ? tr('Imported draft') : tr('Manual draft')}`, 'va-hint'));
        if (proposal.status === 'pending') { const actions = make('div', '', 'va-actions'); actions.append(button(tr("Approve & run"), () => action('agents:proposals:accept', { proposalId: proposal.id }), 'va-primary'), button(tr("Reject"), () => action('agents:proposals:reject', { proposalId: proposal.id }))); card.append(actions); }
        section.append(card);
      }
    }
    body.append(section);
  }
  function renderEditor() {
    const backdrop = make('div', '', 'va-modal'); const form = make('form', '', 'va-dialog'); form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-label', editor.title); form.append(make('h2', editor.title));
    for (const field of editor.fields) {
      if (field.show && !field.show(editor.values)) continue;
      if (field.type === 'notice') { form.append(make('p', field.label, 'va-hint')); continue; }
      const label = make('label', field.label); let input;
      if (field.type === 'select') { input = make('select'); for (const [value, name] of field.options) { const option = make('option', name); option.value = value; input.append(option); } }
      else input = make(field.type === 'textarea' ? 'textarea' : 'input');
      if (!['select', 'textarea'].includes(field.type)) input.type = field.type || 'text';
      input.value = editor.values[field.key]; input.dataset.focus = `editor-${field.key}`; input.required = Boolean(field.required); input.disabled = pending;
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.min) input.min = field.min; if(field.max)input.max=field.max; if (field.step) input.step = field.step;
      input.oninput = () => { editor.values[field.key] = input.value; };
      if (field.onChange) input.onchange = () => { editor.values[field.key] = input.value; void field.onChange(input.value); };
      if (['kind','completionType'].includes(field.key)) input.onchange = () => { editor.values[field.key] = input.value; render(); };
      label.append(input); form.append(label);
    }
    const actions = make('div', '', 'va-dialog-actions'); const cancel = button(tr("Cancel"), () => { editor.onCancel?.(); editor = null; error = ''; render(); });
    const save = make('button', pending ? tr("Saving…") : tr("Save"), 'va-button va-primary'); save.disabled = pending; actions.append(cancel, save); form.append(actions);
    if (error) { const message = make('div', (globalThis.WiekI18n?.error(error) ?? (error)), 'va-error'); message.role = 'alert'; form.append(message); }
    form.onsubmit = async event => { event.preventDefault(); try { await editor.submit({ ...editor.values }); } catch (failure) { error = failure.message || String(failure); render(); } };
    backdrop.append(form); return backdrop;
  }
  function render() {
    if (globalThis.WiekI18n?.deferWhileComposing(root, render)) return;
    if (!root?.isConnected) return;
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const focus = active?.dataset.focus; const selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const oldMessages = root.querySelector('[data-scroll="messages"]'); const atEnd = !oldMessages || oldMessages.scrollHeight - oldMessages.scrollTop - oldMessages.clientHeight < 50; const oldScroll = oldMessages?.scrollTop || 0;
    root.classList.add('vek-agent-panel'); root.replaceChildren();
    const head = make('div', '', 'va-header'); const title = make('div'); title.append(make('h1', tr("Agent workspace")), make('p', tr("Your projects, conversations, and local agents.")));
    const globalActions = make('div', '', 'va-actions'); globalActions.append(button(tr("Import JSON"), () => action('agents:file:import', {})), button(tr("Import Claude history"), importClaude), button(tr("Import Codex history"), importCodex), button(tr("Export JSON"), () => action('agents:file:export', {})), button(tr("Export without files"), () => action('agents:file:export', { metadataOnly: true })), button(tr("New conversation"), newThread, 'va-primary')); head.append(title, globalActions); root.append(head);
    const tabs = make('nav', '', 'va-tabs'); tabs.setAttribute('aria-label', tr("Agent workspace sections"));
    for (const [id, name] of [['threads', tr("Conversations")], ['automations', tr("Automations")], ['providers', tr("Agents")]]) { const tab = button(name, () => { view = id; error = ''; render(); }, view === id ? 'is-active' : ''); tab.setAttribute('aria-current', view === id ? 'page' : 'false'); tabs.append(tab); } root.append(tabs);
    if (error && !editor) { const alert = make('div', (globalThis.WiekI18n?.error(error) ?? (error)), 'va-error'); alert.role = 'alert'; root.append(alert); }
    if (view === 'threads' && !snapshot.providers.some(usable)) { const notice = make('div', '', 'va-notice'); notice.append(make('span', tr("No available local agent. Install or configure a CLI, then refresh availability.")), button(tr("Set up an agent"), () => { view = 'providers'; render(); })); root.append(notice); }
    const body = make('div', '', `va-body ${view === 'threads' ? 'va-thread-layout' : ''}`);
    if (view === 'threads') threadsView(body); else if (view === 'automations') schedulesView(body); else providersView(body); root.append(body);
    if (editor) root.append(renderEditor());
    if(fileChanges)renderFileChanges();
    const messages = root.querySelector('[data-scroll="messages"]'); if (messages) messages.scrollTop = atEnd ? messages.scrollHeight : oldScroll;
    if (focus) { const input = [...root.querySelectorAll('[data-focus]')].find(item => item.dataset.focus === focus); input?.focus({ preventScroll: true }); if (input && selection && typeof input.setSelectionRange === 'function') { try { input.setSelectionRange(...selection); } catch {} } }
  }
  window.WiekAgentPanel = {
    mount(target, dispatch) { root = target; invoke = dispatch; render(); },
    update(next) { apply(next); render(); },
    appendDraft(text) { if (typeof text !== 'string' || !text.trim() || !thread() || automationOwned(thread())) return false; drafts.set(selectedId, [drafts.get(selectedId) || '', text.trim()].filter(Boolean).join('\n')); render(); return true; },
  };
})();

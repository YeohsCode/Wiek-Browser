'use strict';

(() => {
  const tr = (message, ...values) => globalThis.WiekI18n?.t(message, ...values) ?? message.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
  function createPanel(root, invoke, { embedded = false } = {}) {
    let data, error = '', pending = false, editor = null, draft = '', dirty = false, destroyed = false;
    let memoryData = null, memoryQuery = '', memoryMode = 'literal', memoryResults = null, memoryDocument = null, memoryProjectId = '', memoryProjects = [], memoryNotice = '';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const make = (tag, value, cls) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (cls) node.className = cls; return node; };
    const button = (value, fn, cls = '') => { const node = make('button', value, `vp-button ${cls}`); node.type = 'button'; node.disabled = pending; node.onclick = fn; return node; };
    function update(next) {
      if(next?.agents?.projects){memoryProjects=next.agents.projects;if(!memoryProjects.some(p=>p.id===memoryProjectId))memoryProjectId=memoryProjects[0]?.id||'';}
      const corpus=Array.isArray(next?.memory?.documents)?next.memory:(Array.isArray(next?.documents)&&next?.profileId?next:null);
      if(corpus){if(memoryData?.profileId!==corpus.profileId){memoryResults=null;memoryDocument=null;memoryNotice='';memoryQuery='';}memoryData=corpus;const live=new Map(corpus.documents.map(row=>[row.id,row.sha256]));if(memoryResults)memoryResults.results=memoryResults.results.filter(row=>live.get(row.id)===row.sha256);if(memoryDocument&&live.get(memoryDocument.id)!==memoryDocument.sha256)memoryDocument=null;}
      const value = next?.preferences || next; if (value?.theme && value?.shortcuts) { data = value; if (!dirty) draft = data.instructions; } render(); }
    async function action(name, payload = {}) { const requestedProfile=memoryData?.profileId; pending = true; error = ''; render(); try { const result = await invoke(name, payload); if (result?.error) throw new Error(result.error); if(name.startsWith('memory:')&&requestedProfile&&memoryData?.profileId!==requestedProfile)return; update(result); if(name.startsWith('memory:'))update(await invoke('memory:snapshot',{})); return result; } catch (failure) { error = failure.message || String(failure); } finally { pending = false; render(); } }
    function toggle(parent, label, description, checked, change, disabled = false) {
      const row = make('label', '', 'vp-toggle-row'), copy = make('div', '', 'vp-grow'); copy.append(make('strong', label), make('p', description));
      const input = make('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = disabled || pending; input.setAttribute('aria-label', label); input.onchange = () => change(input.checked); row.append(copy, input); parent.append(row);
    }
    function select(parent, label, value, options, onChange) { const row = make('label', '', 'vp-select-row'); row.append(make('strong', label)); const input = make('select'); for (const [id,name] of options) { const option = make('option', name); option.value = id; option.selected = id === value; input.append(option); } input.setAttribute('aria-label', label); input.disabled = pending; input.onchange = () => onChange(input.value); row.append(input); parent.append(row); }
    function section(title, description) { const node = make('section', '', 'vp-card'); node.append(make('h2', title), make('p', description, 'vp-description')); root.append(node); return node; }
    function editShortcut(item) { editor = { action: item.id, label: item.label, value: data.shortcuts[item.id], validation: null, recording: false }; render(); }
    async function validateEditor() { if (!editor) return; const current = editor; try { const result = await invoke('preferences:shortcuts:validate', { action: current.action, accelerator: current.value }); if (editor === current) { editor.validation = result; render(); } } catch (failure) { error = failure.message; render(); } }
    function chord(event) { const parts = []; if (event.metaKey) parts.push('Command'); if (event.ctrlKey) parts.push('Control'); if (event.altKey) parts.push('Alt'); if (event.shiftKey) parts.push('Shift'); const key = event.key === ' ' ? 'Space' : event.key === '+' ? 'Plus' : event.key.replace(/^Arrow/, ''); if (!['Meta','Control','Alt','Shift'].includes(key)) parts.push(key.length === 1 ? key.toUpperCase() : key); return parts.join('+'); }
    function shortcutEditor() {
      const overlay = make('div', '', 'vp-overlay'), form = make('form', '', 'vp-editor'); form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.append(make('h2', tr(editor.label)), make('p', tr("Record a key combination or type an Electron accelerator. Leave empty to remove this shortcut.")));
      const input = make('input'); input.value = editor.value; input.dataset.focus = 'shortcut'; input.setAttribute('aria-label', tr("Shortcut accelerator")); input.placeholder = 'CommandOrControl+Shift+K'; input.readOnly = editor.recording; input.oninput = () => { editor.value = input.value; editor.validation = null; };
      input.onkeydown = event => { if (!editor.recording) return; event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') { editor.recording = false; render(); return; } if (['Meta','Control','Alt','Shift'].includes(event.key)) return; editor.value = chord(event); editor.recording = false; validateEditor(); };
      form.append(input, button(editor.recording ? tr("Press keys… (Esc cancels)") : tr("Record keys"), () => { editor.recording = true; render(); root.querySelector('[data-focus=shortcut]')?.focus(); }));
      if (editor.validation) form.append(make('div', editor.validation.valid ? editor.validation.normalized || tr("Unassigned") : editor.validation.error, editor.validation.valid ? 'vp-success' : 'vp-error'));
      if (error) form.append(make('div', (globalThis.WiekI18n?.error(error) ?? (error)), 'vp-error'));
      const actions = make('div', '', 'vp-actions'); actions.append(button(tr("Cancel"), () => { editor = null; error = ''; render(); }), button(tr("Check conflicts"), validateEditor), button(tr("Clear"), () => { editor.value = ''; editor.validation = null; render(); }));
      const save = make('button', tr("Save shortcut"), 'vp-button vp-primary'); save.type = 'submit'; save.disabled = pending; actions.append(save); form.append(actions);
      form.onsubmit = async event => { event.preventDefault(); const result = await action('preferences:shortcuts:set', { action: editor.action, accelerator: editor.value }); if (result) { editor = null; render(); } };
      overlay.append(form); return overlay;
    }
    function memoryIndex() {
      if (!memoryData) return;
      const card = section(tr("Saved text search"), tr("Explicitly save page text or selected project text files for local search. Saved copies stay in this profile until removed; disabling a memory category deletes its saved copies. Search by keywords or use on-device semantic search where available."));
      card.append(make('p', tr("{0} documents in this profile. Copies are not refreshed automatically and are not automatically sent to agents.", (memoryData.documents.length)), 'vp-description'));
      const actions = make('div', '', 'vp-actions'); const page = button(tr("Save current page text"), () => action('memory:index:page')); page.disabled = pending || !data.memory.browserActivity; actions.append(page);
      const projects = make('select'); projects.setAttribute('aria-label', tr("Source project")); projects.disabled = pending;
      for (const project of memoryProjects) { const option = make('option', project.name); option.value = project.id; option.selected = project.id === memoryProjectId; projects.append(option); } projects.onchange = () => { memoryProjectId = projects.value; }; actions.append(projects);
      const files = button(tr("Save text from files"), async () => { const result = await action('memory:choose-files', { projectId: memoryProjectId }); if (result?.indexed !== undefined) memoryNotice = {indexed:result.indexed,warnings:result.warnings||[]}; render(); }); files.disabled = pending || !data.memory.localFiles || !memoryProjectId; actions.append(files, button(tr("Delete saved text"), () => { memoryResults = null; memoryDocument = null; return action('memory:clear'); }));
      if (memoryData.busy) { const cancel = button(tr("Cancel indexing"), async () => { try { update(await invoke('memory:cancel', {})); } catch (failure) { error = failure.message; render(); } }); cancel.disabled = false; actions.append(cancel); } card.append(actions);
      if (memoryNotice) {
        card.append(make('p', tr('Indexed {0} files.', memoryNotice.indexed), 'vp-description'));
        for (const row of memoryNotice.warnings) card.append(make('p', tr('{0}: {1}', row.source, tr(row.error)), 'vp-description'));
      }
      const form = make('form', '', 'vp-memory-search'), query = make('input'); query.type = 'search'; query.value = memoryQuery; query.dataset.focus = 'memory-search'; query.setAttribute('aria-label', tr("Search saved text")); query.placeholder = tr("Search saved text"); query.maxLength = 512; query.oninput = () => { memoryQuery = query.value; };
      const mode = make('select'); mode.setAttribute('aria-label', tr('Search mode'));
      for (const [id, label] of [['literal','Keywords'], ['semantic','On-device semantic search']]) {
        const option = make('option', tr(label)); option.value = id; option.disabled = id === 'semantic' && !memoryData.semanticAvailable;
        mode.append(option);
      }
      mode.value = memoryData.semanticAvailable ? memoryMode : 'literal';
      mode.onchange = () => { memoryMode = mode.value; };
      const submit = make('button', tr("Search saved text"), 'vp-button'); submit.type = 'submit'; submit.disabled = pending; form.append(query, mode, submit); form.onsubmit = async event => { event.preventDefault(); const result = await action('memory:search', { query: memoryQuery, mode: mode.value }); if (result) memoryResults = result; render(); }; card.append(form);
      if (memoryResults) card.append(make('p', tr("{0} displayed results.", (memoryResults.results.length)), 'vp-description'));
      for (const document of memoryResults ? memoryResults.results : memoryData.documents) { const row = make('div', '', 'vp-memory-item'), info = make('div', '', 'vp-grow'); info.append(make('strong', document.title || document.source), make('p', tr("{0} · {1} · saved {2}", tr(document.kind === 'file' ? 'File' : 'Page'), (document.source), (new Date(document.indexedAt).toLocaleString(globalThis.WiekI18n?.locale()))), 'vp-description')); if (document.snippet) info.append(make('p', document.snippet, 'vp-memory-snippet')); row.append(info, button(tr("View saved text"), async () => { const result = await action('memory:read', { id: document.id }); if (result) memoryDocument = result; render(); }), button(tr("Delete saved copy"), () => action('memory:remove', { id: document.id }))); card.append(row); }
      if (memoryDocument) { const detail = make('details'); detail.open = true; detail.append(make('summary', memoryDocument.title || memoryDocument.source), make('pre', memoryDocument.text, 'vp-memory-text'), button(tr("Close saved text"), () => { memoryDocument = null; render(); })); card.append(detail); }
    }
    function render() {
    if (globalThis.WiekI18n?.deferWhileComposing(root, render)) return;
      if (destroyed) return;
      const active = root.contains(document.activeElement) ? document.activeElement : null, focus = active?.dataset.focus, selection = active && 'selectionStart' in active ? [active.selectionStart,active.selectionEnd] : null;
      root.classList.add('vek-preferences-panel'); root.dataset.theme = data?.theme === 'system' ? media.matches ? 'dark' : 'light' : data?.theme || 'light'; root.replaceChildren();
      const heading = make('div', '', 'vp-heading'); if (!embedded) heading.append(make('h1', tr("Preferences"))); heading.append(button(tr("Refresh"), async () => update(await invoke('preferences:snapshot', {})))); root.append(heading);
      if (!data) { root.append(make('p', tr("Loading preferences…"))); return; }
      if (error && !editor) root.append(make('div', (globalThis.WiekI18n?.error(error) ?? (error)), 'vp-error'));
      const appearance = section(tr("Appearance"), tr("Choose how your browser workspace looks."));
      select(appearance, tr("Theme"), data.theme, [['system',tr("Follow system")],['light',tr("Light")],['dark',tr("Dark")]], theme => action('preferences:update', {theme}));
      select(appearance, tr("Tab bar"), data.tabLayout, [['horizontal',tr("Horizontal")],['vertical',tr("Vertical")]], tabLayout => action('preferences:update', {tabLayout}));
      const selectionCard = section(tr("Selected text"), tr("Choose the quick actions offered when you select text on a page."));
      toggle(selectionCard, tr("Show quick actions"), tr("Offer a small toolbar beside your selected text."), data.selectionToolbar.enabled, enabled => action('preferences:update', {selectionToolbar:{enabled}}));
      for (const [id,label,description] of [['copy',tr("Copy"),tr("Copy selected text.")],['ask',tr("Ask agent"),tr("Start a question with selected text.")],['save',tr("Save selected text"),tr("Keep a local copy of selected text.")]]) toggle(selectionCard,label,description,data.selectionToolbar[id],value=>action('preferences:update',{selectionToolbar:{[id]:value}}));
      toggle(selectionCard, tr("Translate"), tr("Open selected text in Translation. Configure a local provider in that panel."), data.selectionToolbar.translate, value=>action('preferences:update',{selectionToolbar:{translate:value}}));
      const memory = section(tr("Context and instructions"), tr("Control which scoped context can be used by your agents."));
      toggle(memory,tr("Browser activity"),tr("Use task tab group activity as context and allow explicit page text indexing."),data.memory.browserActivity,browserActivity=>action('preferences:update',{memory:{browserActivity}}));
      toggle(memory,tr("Project file context"),tr("Use project file names as context and allow explicit text file indexing inside a chosen project."),data.memory.localFiles,localFiles=>action('preferences:update',{memory:{localFiles}}));
      const label=make('label',tr("Instructions for agents (up to 8 KiB)"),'vp-instructions'), input=make('textarea'); input.value=draft; input.placeholder=tr("How should your agents respond? (up to 8 KiB)"); input.dataset.focus='instructions'; input.oninput=()=>{draft=input.value;dirty=true}; label.append(input); memory.append(label,button(tr("Save instructions"),async()=>{const result=await action('preferences:update',{instructions:draft});if(result){dirty=false;draft=result.instructions;render()}},'vp-primary'));
      memoryIndex();
      const runtime=section(tr("Local browser behavior"),tr("Manage local speech models and background tasks."));
      toggle(runtime,tr("Keep running in the tray"),tr("Continue active tasks after all browser windows close."),data.backgroundMode,backgroundMode=>action('preferences:update',{backgroundMode}));
      toggle(runtime,tr("On-device speech model"),tr("Allow the bundled local speech model to be used. Other AI model capabilities depend on your configured agents."),data.onDeviceModels,onDeviceModels=>action('preferences:update',{onDeviceModels}));
      const shortcuts=section(tr("Keyboard shortcuts"),tr("Conflicting app and common system shortcuts are rejected."));
      for(const item of data.actions||[]){const row=make('div','','vp-shortcut-row');row.append(make('span',tr(item.label)),make('kbd',data.shortcuts[item.id]||tr("Unassigned")),button(tr("Change"),()=>editShortcut(item)),button(tr("Reset"),()=>action('preferences:shortcuts:reset',{action:item.id})));shortcuts.append(row)}
      shortcuts.append(button(tr("Restore all shortcuts"),()=>action('preferences:shortcuts:reset',{})));
      if(editor)root.append(shortcutEditor());
      if(focus){const input=[...root.querySelectorAll('[data-focus]')].find(n=>n.dataset.focus===focus);input?.focus({preventScroll:true});try{if(selection)input?.setSelectionRange(...selection)}catch{}}
    }
    const onTheme=()=>render();media.addEventListener?.('change',onTheme);render();
    return {update,destroy(){destroyed=true;media.removeEventListener?.('change',onTheme);editor=null;root.replaceChildren();root.classList.remove('vek-preferences-panel')}};
  }
  let mounted;window.createWiekPreferencesPanel=createPanel;window.WiekPreferencesPanel={mount(root,invoke,options){mounted?.destroy();mounted=createPanel(root,invoke,options);return mounted},update(value){mounted?.update(value)},destroy(){mounted?.destroy();mounted=null}};
})();

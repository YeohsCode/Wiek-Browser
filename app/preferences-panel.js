'use strict';
(() => {
  function createPanel(root, invoke) {
    let data, error = '', pending = false, editor = null, draft = '', dirty = false, destroyed = false;
    let memoryData = null, memoryQuery = '', memoryResults = null, memoryDocument = null, memoryProjectId = '', memoryProjects = [], memoryNotice = '';
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
      const overlay = make('div', '', 'vp-overlay'), form = make('form', '', 'vp-editor'); form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.append(make('h2', editor.label), make('p', 'Record a key combination or type an Electron accelerator. Leave empty to remove this shortcut.'));
      const input = make('input'); input.value = editor.value; input.dataset.focus = 'shortcut'; input.setAttribute('aria-label', 'Shortcut accelerator'); input.placeholder = 'CommandOrControl+Shift+K'; input.readOnly = editor.recording; input.oninput = () => { editor.value = input.value; editor.validation = null; };
      input.onkeydown = event => { if (!editor.recording) return; event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') { editor.recording = false; render(); return; } if (['Meta','Control','Alt','Shift'].includes(event.key)) return; editor.value = chord(event); editor.recording = false; validateEditor(); };
      form.append(input, button(editor.recording ? 'Press keys… (Esc cancels)' : 'Record keys', () => { editor.recording = true; render(); root.querySelector('[data-focus=shortcut]')?.focus(); }));
      if (editor.validation) form.append(make('div', editor.validation.valid ? editor.validation.normalized || 'Unassigned' : editor.validation.error, editor.validation.valid ? 'vp-success' : 'vp-error'));
      if (error) form.append(make('div', error, 'vp-error'));
      const actions = make('div', '', 'vp-actions'); actions.append(button('Cancel', () => { editor = null; error = ''; render(); }), button('Check conflicts', validateEditor), button('Clear', () => { editor.value = ''; editor.validation = null; render(); }));
      const save = make('button', 'Save shortcut', 'vp-button vp-primary'); save.type = 'submit'; save.disabled = pending; actions.append(save); form.append(actions);
      form.onsubmit = async event => { event.preventDefault(); const result = await action('preferences:shortcuts:set', { action: editor.action, accelerator: editor.value }); if (result) { editor = null; render(); } };
      overlay.append(form); return overlay;
    }
    function memoryIndex() {
      if (!memoryData) return;
      const card = section('Indexed memory', 'Explicitly save page text or selected project text files for local search. Saved copies stay in this profile until removed; disabling a memory category deletes its saved copies. Search uses literal words, including Chinese text.');
      card.append(make('p', `${memoryData.documents.length} documents in this profile. Copies are not refreshed automatically and are not automatically sent to agents.`, 'vp-description'));
      const actions = make('div', '', 'vp-actions'); const page = button('Index current page', () => action('memory:index:page')); page.disabled = pending || !data.memory.browserActivity; actions.append(page);
      const projects = make('select'); projects.setAttribute('aria-label', 'Memory project'); projects.disabled = pending;
      for (const project of memoryProjects) { const option = make('option', project.name); option.value = project.id; option.selected = project.id === memoryProjectId; projects.append(option); } projects.onchange = () => { memoryProjectId = projects.value; }; actions.append(projects);
      const files = button('Choose files to index', async () => { const result = await action('memory:choose-files', { projectId: memoryProjectId }); if (result?.indexed !== undefined) memoryNotice = `Indexed ${result.indexed} file(s). ${(result.warnings || []).map(row => `${row.source}: ${row.error}`).join(' ')} `; render(); }); files.disabled = pending || !data.memory.localFiles || !memoryProjectId; actions.append(files, button('Clear indexed memory', () => { memoryResults = null; memoryDocument = null; return action('memory:clear'); }));
      if (memoryData.busy) { const cancel = button('Cancel indexing', async () => { try { update(await invoke('memory:cancel', {})); } catch (failure) { error = failure.message; render(); } }); cancel.disabled = false; actions.append(cancel); } card.append(actions);
      if (memoryNotice) card.append(make('p', memoryNotice, 'vp-description'));
      const form = make('form', '', 'vp-memory-search'), query = make('input'); query.type = 'search'; query.value = memoryQuery; query.dataset.focus = 'memory-search'; query.setAttribute('aria-label', 'Search indexed memory'); query.placeholder = 'Search saved text'; query.maxLength = 512; query.oninput = () => { memoryQuery = query.value; };
      const submit = make('button', 'Search memory', 'vp-button'); submit.type = 'submit'; submit.disabled = pending; form.append(query, submit); form.onsubmit = async event => { event.preventDefault(); const result = await action('memory:search', { query: memoryQuery }); if (result) memoryResults = result; render(); }; card.append(form);
      if (memoryResults) card.append(make('p', `${memoryResults.results.length} displayed results.`, 'vp-description'));
      for (const document of memoryResults ? memoryResults.results : memoryData.documents) { const row = make('div', '', 'vp-memory-item'), info = make('div', '', 'vp-grow'); info.append(make('strong', document.title || document.source), make('p', `${document.kind} · ${document.source} · saved ${new Date(document.indexedAt).toLocaleString()}`, 'vp-description')); if (document.snippet) info.append(make('p', document.snippet, 'vp-memory-snippet')); row.append(info, button('View saved text', async () => { const result = await action('memory:read', { id: document.id }); if (result) memoryDocument = result; render(); }), button('Forget', () => action('memory:remove', { id: document.id }))); card.append(row); }
      if (memoryDocument) { const detail = make('details'); detail.open = true; detail.append(make('summary', memoryDocument.title || memoryDocument.source), make('pre', memoryDocument.text, 'vp-memory-text'), button('Close saved text', () => { memoryDocument = null; render(); })); card.append(detail); }
    }
    function render() {
      if (destroyed) return;
      const active = root.contains(document.activeElement) ? document.activeElement : null, focus = active?.dataset.focus, selection = active && 'selectionStart' in active ? [active.selectionStart,active.selectionEnd] : null;
      root.classList.add('vek-preferences-panel'); root.dataset.theme = data?.theme === 'system' ? media.matches ? 'dark' : 'light' : data?.theme || 'light'; root.replaceChildren();
      const heading = make('div', '', 'vp-heading'); heading.append(make('h1', 'Preferences'), button('Refresh', async () => update(await invoke('preferences:snapshot', {})))); root.append(heading);
      if (!data) { root.append(make('p', 'Loading preferences…')); return; }
      if (error && !editor) root.append(make('div', error, 'vp-error'));
      const appearance = section('Appearance', 'Choose how your browser workspace looks.');
      select(appearance, 'Theme', data.theme, [['system','Follow system'],['light','Light'],['dark','Dark']], theme => action('preferences:update', {theme}));
      select(appearance, 'Tab bar', data.tabLayout, [['horizontal','Horizontal'],['vertical','Vertical']], tabLayout => action('preferences:update', {tabLayout}));
      const selectionCard = section('Selected text', 'Choose the quick actions offered when you select text on a page.');
      toggle(selectionCard, 'Show quick actions', 'Offer a small toolbar beside your selected text.', data.selectionToolbar.enabled, enabled => action('preferences:update', {selectionToolbar:{enabled}}));
      for (const [id,label,description] of [['copy','Copy','Copy selected text.'],['ask','Ask agent','Start a question with selected text.'],['save','Save to Library','Keep selected text in your local Library.']]) toggle(selectionCard,label,description,data.selectionToolbar[id],value=>action('preferences:update',{selectionToolbar:{[id]:value}}));
      toggle(selectionCard, 'Translate', 'Open selected text in Translation. Configure a local provider in that panel.', data.selectionToolbar.translate, value=>action('preferences:update',{selectionToolbar:{translate:value}}));
      const memory = section('Context and instructions', 'Control which scoped context can be used by your agents.');
      toggle(memory,'Browser activity','Use task Space activity as context and allow explicit page text indexing.',data.memory.browserActivity,browserActivity=>action('preferences:update',{memory:{browserActivity}}));
      toggle(memory,'Project file context','Use project file names as context and allow explicit text file indexing inside a chosen project.',data.memory.localFiles,localFiles=>action('preferences:update',{memory:{localFiles}}));
      const label=make('label','Instructions for agents (up to 8 KiB)','vp-instructions'), input=make('textarea'); input.value=draft; input.placeholder='How should your agents respond? (up to 8 KiB)'; input.dataset.focus='instructions'; input.oninput=()=>{draft=input.value;dirty=true}; label.append(input); memory.append(label,button('Save instructions',async()=>{const result=await action('preferences:update',{instructions:draft});if(result){dirty=false;draft=result.instructions;render()}},'vp-primary'));
      memoryIndex();
      const runtime=section('Local browser behavior','Manage local speech models and background tasks.');
      toggle(runtime,'Keep running in the tray','Continue active tasks after all browser windows close.',data.backgroundMode,backgroundMode=>action('preferences:update',{backgroundMode}));
      toggle(runtime,'On-device speech model','Allow the bundled local speech model to be used. Other AI model capabilities depend on your configured agents.',data.onDeviceModels,onDeviceModels=>action('preferences:update',{onDeviceModels}));
      const shortcuts=section('Keyboard shortcuts','Conflicting app and common system shortcuts are rejected.');
      for(const item of data.actions||[]){const row=make('div','','vp-shortcut-row');row.append(make('span',item.label),make('kbd',data.shortcuts[item.id]||'Unassigned'),button('Change',()=>editShortcut(item)),button('Reset',()=>action('preferences:shortcuts:reset',{action:item.id})));shortcuts.append(row)}
      shortcuts.append(button('Restore all shortcuts',()=>action('preferences:shortcuts:reset',{})));
      if(editor)root.append(shortcutEditor());
      if(focus){const input=[...root.querySelectorAll('[data-focus]')].find(n=>n.dataset.focus===focus);input?.focus({preventScroll:true});try{if(selection)input?.setSelectionRange(...selection)}catch{}}
    }
    const onTheme=()=>render();media.addEventListener?.('change',onTheme);render();
    return {update,destroy(){destroyed=true;media.removeEventListener?.('change',onTheme);editor=null;root.replaceChildren();root.classList.remove('vek-preferences-panel')}};
  }
  let mounted;window.createWiekPreferencesPanel=createPanel;window.WiekPreferencesPanel={mount(root,invoke){mounted?.destroy();mounted=createPanel(root,invoke);return mounted},update(value){mounted?.update(value)},destroy(){mounted?.destroy();mounted=null}};
})();

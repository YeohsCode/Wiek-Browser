'use strict';
let state, currentPanel = null, addressEditing = false;
const $ = id => document.getElementById(id);
const text = (tag, content, cls) => { const e = document.createElement(tag); e.textContent = content; if (cls) e.className = cls; return e; };
async function act(name, value) { try { if(['navigate','space:select','tab:new','tab:select','tab:close'].includes(name))window.WiekToolsPanel.dispose();const next = await window.vek.action(name, value); if (next) render(next); return next; } catch (e) { toast(e.message); } }
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function activeSpace() { return state?.spaces.find(s => s.id === state.selectedSpaceId); }
function render(next) {
  state = next;
  if(next.panelOpen===false&&currentPanel){if(currentPanel==='voice')window.WiekToolsPanel.dispose();currentPanel=null;}
  if(currentPanel!=='translation')window.WiekTranslationPanel?.dispose();
  if(currentPanel!=='desktop')window.WiekDesktopPanel?.dispose();
  if(currentPanel!=='scheduler')window.WiekSchedulerPanel?.dispose();
  document.documentElement.dataset.theme=next.darkMode?'dark':'light';document.body.dataset.tabLayout=next.preferences?.tabLayout||'horizontal';
  $('version').textContent = next.version;
  const spaces = $('spaces'); spaces.replaceChildren();
  for (const s of next.spaces) {
    const button = text('button', '', `space${s.id === next.selectedSpaceId ? ' active' : ''}`);button.title=s.detached?'Open this Space window':s.name;
    button.append(text('span', s.pinned?'⌖':s.name.slice(0,1).toUpperCase(), 'space-icon'), text('span', s.name, 'space-title'));
    if (s.ownership === 'agent') button.append(text('span', '', 'agent-dot'));
    else button.append(text('span', s.ownership === 'agentDelegatedToUser' ? 'You' : '', 'space-status'));
    button.onclick = () => { currentPanel = null; $('panel-content').hidden = true; $('empty').hidden = false; act('space:select', s.id); }; spaces.append(button);
  }
  $('tabs').replaceChildren();
  for (const t of next.tabs) {
    const button = text('div', '', `tab${t.targetId === next.activeTabId ? ' active' : ''}`);
    button.role = 'tab'; button.tabIndex = 0;
    const icon = text('div', '◌', 'tab-favicon');
    if (typeof t.favicon === 'string' && t.favicon.startsWith('data:image/')) {
      const image = document.createElement('img'); image.src = t.favicon; image.alt = ''; image.width = 14; image.height = 14;
      image.onerror = () => { icon.textContent = '◌'; }; icon.replaceChildren(image);
    }
    button.append(icon, text('span', t.title || (t.url === 'about:blank' ? 'New tab' : t.url)));
    const close = text('button', '×', 'tab-close'); close.title = 'Close tab'; close.onclick = e => { e.stopPropagation(); act('tab:close', t.targetId); };
    button.append(close); button.onclick = () => { currentPanel = null; act('tab:select', t.targetId); }; button.onkeydown = e => { if (e.key === 'Enter') button.click(); };
    $('tabs').append(button);
  }
  const tab = next.tabs.find(t => t.targetId === next.activeTabId);
  if (!addressEditing) $('address').value = tab?.url === 'about:blank' ? '' : tab?.url || '';
  $('back').disabled = !next.canGoBack; $('forward').disabled = !next.canGoForward; $('reload').textContent = next.loading ? '×' : '↻';
  const s = activeSpace(); const own = $('ownership');
  own.className = s?.ownership === 'agent' ? 'agent' : s?.ownership === 'agentDelegatedToUser' ? 'delegated' : '';
  own.textContent = s?.ownership === 'agent' ? '◉ Agent working' : s?.ownership === 'agentDelegatedToUser' ? '↗ You have control' : 'Your space';
  own.title = next.taskState || (s?.ownership === 'agent' ? 'Take control from the agent' : s?.ownership === 'agentDelegatedToUser' ? 'Return control to the agent' : 'This space belongs to you');
  $('download-count').textContent = next.downloads.filter(d => d.state === 'progressing').length || '';
  $('bookmark').textContent = next.bookmarks.some(b => b.url === tab?.url) ? '★' : '☆';
  $('home-pins').replaceChildren();for(const pin of next.homePins||[]){const item=text('div','','home-pin'),link=text('button',pin.title);link.title=pin.url;link.onclick=()=>act('navigate',pin.url);const edit=text('button','⋯');edit.title='Edit shortcut';edit.onclick=()=>editHomePin(pin);const remove=text('button','×');remove.title='Remove shortcut';remove.onclick=()=>act('homepin:remove',pin.id);item.append(link,edit,remove);$('home-pins').append(item);}
  $('empty').hidden = Boolean(currentPanel);
  $('panel-content').hidden = !currentPanel;
  if (currentPanel) renderPanel();
}
async function showPanel(name) { if (currentPanel === 'voice' && name !== 'voice') window.WiekToolsPanel.dispose(); currentPanel = name; await act('panel', true); renderPanel(); }
function renderPanel() {
  const p = $('panel-content'); p.hidden = false; $('empty').hidden = true;
  if (['workspace','mcp','catalog','voice','preferences','library','recorder','desktop','scheduler'].includes(currentPanel)) {
    const name = currentPanel, titles = { workspace:'Workspace & Git', mcp:'MCP integrations', catalog:'Skills & commands', voice:'Voice input',preferences:'Browser preferences',library:'Library & screenshots',recorder:'Action recordings',desktop:'Desktop tools',scheduler:'Background scheduling' };
    let root = document.getElementById(`workbench-${name}`);
    if (!root) {
      p.replaceChildren(); const header = text('div','','panel-heading'); header.append(text('h1',titles[name]));
      const close = text('button','Back to browser','subtle-button'); close.onclick = () => { window.WiekToolsPanel.dispose(); currentPanel=null; p.hidden=true; $('empty').hidden=false; act('panel',false); }; header.append(close); p.append(header);
      root=text('div','','tools-root'); root.id=`workbench-${name}`; p.append(root);
      const dispatch=(action,payload)=>window.vek.action(action,payload);
      if (name==='workspace') window.WiekWorkspacePanel.mount(root,dispatch);
      else if (name==='mcp') window.WiekMcpPanel.mount(root,dispatch,state.agents || {});
      else if (name==='desktop') window.WiekDesktopPanel.mount(root,dispatch);
      else if(name==='scheduler')window.WiekSchedulerPanel.mount(root,dispatch);
      else if (name==='preferences') window.WiekPreferencesPanel.mount(root,dispatch);
      else if (name==='library') window.WiekLibraryPanel.mount(root,dispatch);
      else if (name==='recorder') window.WiekRecorderPanel.mount(root,dispatch);
      else window.WiekToolsPanel.mount(root,dispatch,state,name);
    }
    if (name==='workspace') window.WiekWorkspacePanel.update(state);
    else if (name==='mcp') window.WiekMcpPanel.update(state);
    else if (name==='desktop') window.WiekDesktopPanel.update(state);
    else if(name==='scheduler')window.WiekSchedulerPanel.update(state);
    else if (name==='preferences') window.WiekPreferencesPanel.update(state);
    else if (name==='library') window.WiekLibraryPanel.update(state.library);
    else if (name==='recorder') window.WiekRecorderPanel.update(state.recorder);
    else window.WiekToolsPanel.update(state);
    return;
  }
  if(currentPanel==='translation'){if(!document.getElementById('translation-root')){p.replaceChildren();const root=text('div','','tools-root');root.id='translation-root';p.append(root);window.WiekTranslationPanel.mount(root,(name,payload)=>window.vek.action(name,payload));}window.WiekTranslationPanel.update(state.translation);return;}
  if(currentPanel==='spaces')return spacesPanel(p);
  if (currentPanel === 'agents') {
    let root = document.getElementById('agent-root');
    if (!root) {
      p.replaceChildren();
      const header = text('div', '', 'panel-heading');
      header.append(text('h1', 'Agents & automations'));
      const back = text('button', 'Back to browser', 'subtle-button');
      back.onclick = () => { currentPanel = null; p.hidden = true; $('empty').hidden = false; act('panel', false); };
      header.append(back); p.append(header);
      root = text('div', ''); root.id = 'agent-root'; p.append(root);
      window.WiekAgentPanel.mount(root, (name, payload) => window.vek.action(name, payload));
    }
    window.WiekAgentPanel.update(state.agents || {});
    return;
  }
  p.replaceChildren();
  const labels = { bookmarks: ['Bookmarks', 'A place for the pages you want to keep.'], history: ['History', 'Your recent browsing, stored on this device.'], downloads: ['Downloads', 'Files from your browsing sessions.'], settings: ['Settings', 'Profiles, browser data, and local preferences.'] };
  const heading = text('div', '', 'panel-heading'), left = text('div', ''); left.append(text('h1', labels[currentPanel][0]), text('p', labels[currentPanel][1])); heading.append(left);
  const close = text('button', 'Back to browser', 'subtle-button'); close.onclick = () => { currentPanel = null; p.hidden = true; $('empty').hidden = false; act('panel', false); }; heading.append(close); p.append(heading);
  if (currentPanel === 'settings') return settingsPanel(p);
  const list = state[currentPanel]; const card = text('div', '', 'card');
  if (!list.length) card.append(text('div', `No ${currentPanel} yet.`, 'empty-list'));
  for (const item of list) {
    const row = text('div', '', 'row'), main = text('div', '', 'row-main');
    row.append(text('div', currentPanel === 'downloads' ? '↓' : currentPanel === 'bookmarks' ? '☆' : '◷', 'row-icon'));
    main.append(text('div', item.title || item.name || item.url, 'row-title'), text('div', currentPanel === 'downloads' ? `${item.paused?'paused':item.state} · ${(item.received / 1024).toFixed(1)} KB${item.total ? ` / ${(item.total / 1024).toFixed(1)} KB` : ''}` : item.url, 'row-sub')); row.append(main);
    if (currentPanel === 'downloads') {
      if(item.state==='completed'||item.state==='progressing'){const b = text('button', item.state === 'completed' ? 'Open file' : 'Cancel'); b.onclick = () => act(item.state === 'completed' ? 'download:open' : 'download:cancel', item.id); row.append(b);}
      if(item.state==='progressing'||item.canResume){const resume=item.paused||item.state==='interrupted',b=text('button',resume?'Resume':'Pause');b.disabled=resume&&!item.canResume;b.onclick=()=>act(resume?'download:resume':'download:pause',item.id);row.append(b);}
      if (item.state === 'completed') { const show = text('button', 'Show in folder'); show.onclick = () => act('download:show', item.id); row.append(show); }
    } else { const open = text('button', 'Open →'); open.onclick = () => { currentPanel = null; act('navigate', item.url); }; row.append(open); if (currentPanel === 'bookmarks') { const del = text('button', '×'); del.onclick = () => act('bookmark:remove', item.url); row.append(del); } }
    card.append(row);
  }
  p.append(card);
  if (currentPanel === 'history' && list.length) { const clear = text('button', 'Clear history', 'subtle-button'); clear.onclick = () => act('history:clear'); p.append(clear); }
}
function settingsPanel(p) {
  function card(title, description) { const c = text('div', '', 'card'); c.append(text('h3', title), text('p', description)); p.append(c); return c; }
  const preferences=card('Make Wiek yours','Appearance, tab layout, shortcuts, background tasks, local context, and selection actions.');const openPreferences=text('button','Appearance & shortcuts…','subtle-button');openPreferences.onclick=()=>showPanel('preferences');preferences.append(openPreferences);
  const profiles = card('Browser profiles', 'Each profile keeps its own cookies, sessions, cache, and local storage. Spaces using the same profile share login state.');
  for (const profile of state.profiles) { const row = text('div', '', 'row'); row.append(text('div', profile.name, 'row-main')); if (profile.isDefault) row.append(text('span', 'DEFAULT', 'badge')); else { const button = text('button', 'Make default'); button.onclick = () => act('profile:default', profile.id); row.append(button); } profiles.append(row); }
  const add = text('button', '＋ Add profile', 'subtle-button'); add.onclick = async () => { const name = await askText('Profile name'); if (name) act('profile:create', name); }; profiles.append(add);
  const data = card('Sessions and browsing data', `Current profile: ${activeSpace()?.profileName || 'Personal'}. Import a selected Chromium profile folder. Source files stay read-only; unsupported encrypted records and partitioned cookies are reported.`);
  const migration = text('div', '', 'settings-actions');
  const source = document.createElement('select'); source.setAttribute('aria-label', 'Source browser');
  for (const [value, label] of [['chrome','Google Chrome'],['chromium','Chromium'],['edge','Microsoft Edge'],['brave','Brave']]) { const option = text('option', label); option.value = value; source.append(option); }
  migration.append(source);
  const choices = {};
  for (const category of ['bookmarks','history','cookies','passwords']) { const label = text('label', category); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = ['bookmarks','history'].includes(category); choices[category] = check; label.prepend(check); migration.append(label); }
  const migrate = text('button', 'Choose source profile…'); migrate.onclick = () => act('profile:import', { sourceBrowser: source.value, ...Object.fromEntries(Object.entries(choices).map(([key, input]) => [key, input.checked])) }); migration.append(migrate); data.append(migration);
  if (state.importResult) { const result = text('div', '', 'import-result'); result.append(text('p', `Imported: ${Object.entries(state.importResult.counts).map(([key, count]) => `${count} ${key}`).join(', ')}.`)); for (const warning of state.importResult.warnings) result.append(text('p', `${warning.category}: ${warning.count} skipped — ${warning.reason}`)); data.append(result); }
  const actions = text('div', '', 'settings-actions');
  const imp = text('button', 'Import cookie JSON'); imp.onclick = () => act('cookies:import');
  const clear = text('button', 'Clear profile site data'); clear.onclick = () => { if (confirm('Clear cookies and site data for the current profile?')) act('data:clear'); };
  actions.append(imp, clear); data.append(actions);
  const scheduler=card('Background scheduling','Review a macOS login job for opted-in plain CLI automations. Default off; foreground Wiek takes priority.');const schedulerButton=text('button','Background scheduling…');schedulerButton.onclick=()=>showPanel('scheduler');scheduler.append(schedulerButton);
  const desktop=card('Desktop tools','Choose a screen region or read selected text once with a global shortcut. OS permissions and explicit selected-text enablement are required; captures are previewed before use.');const desktopButton=text('button','Desktop capture & global shortcuts…');desktopButton.onclick=()=>showPanel('desktop');desktop.append(desktopButton);
  const archive=card('Encrypted profile archive','Export tabs, bookmarks, history and cookies from this profile. Saved logins and web storage are optional. Web storage covers current top-level origins in open tabs, with separate tab sessions; it can contain login tokens. Archives require a passphrase and restore into a new profile. IndexedDB, iframe storage, permissions and extension binaries are excluded.');
  const archiveOptions=text('div','','settings-actions'),includeLabel=text('label','Include saved logins'),include=document.createElement('input');include.type='checkbox';includeLabel.prepend(include);const storageLabel=text('label','Include web storage from open tabs'),storage=document.createElement('input');storage.type='checkbox';storageLabel.prepend(storage);const exportProfile=text('button','Export encrypted profile…');exportProfile.onclick=()=>act('profile:file:export',{includePasswords:include.checked,includeWebStorage:storage.checked});const restoreLabel=text('label','Open restored tabs'),restore=document.createElement('input');restore.type='checkbox';restore.checked=true;restoreLabel.prepend(restore);const importProfile=text('button','Import encrypted profile…');importProfile.onclick=()=>act('profile:file:import',{restoreTabs:restore.checked});archiveOptions.append(includeLabel,storageLabel,exportProfile,restoreLabel,importProfile);archive.append(archiveOptions);
  if(state.profileArchiveResult){archive.append(text('p',`${state.profileArchiveResult.message} ${Object.entries(state.profileArchiveResult.counts).map(([key,count])=>`${count} ${{spaces:'Spaces',cookies:'cookies',passwords:'saved logins',bookmarks:'bookmarks',history:'history entries',localStorageOrigins:'local storage origins',sessionStorageTabs:'tab sessions'}[key]||key}`).join(', ')}.`));for(const warning of state.profileArchiveResult.warnings)archive.append(text('p',warning));}
  const logins = card('Saved logins', 'Passwords imported into this profile are encrypted using the system credential store. Fill requires the active page to match the saved origin exactly; it does not submit the form.');
  for (const login of state.savedLogins || []) { const row = text('div', '', 'row'); row.append(text('div', `${login.origin} · ${login.username}`, 'row-main')); const fill = text('button', 'Fill active page'); fill.onclick = async () => { const result = await act('logins:fill', login.id); if (result) { currentPanel = null; $('panel-content').hidden = true; $('empty').hidden = false; } }; const remove = text('button', 'Remove'); remove.onclick = () => act('logins:remove', login.id); row.append(fill, remove); logins.append(row); }
  if (!state.savedLogins?.length) logins.append(text('p', 'No imported saved logins in this profile.'));
  const permissions = card('Site permissions', 'Allow, block, or ask for each website in the current profile. Embedded websites have separate rules. Existing device streams stop when you reload or close their page. System permissions still apply.');
  const permissionData=state.sitePermissions||{rules:[],capabilities:{}};
  function permissionSelect(rule){const select=document.createElement('select');select.setAttribute('aria-label',`${permissionData.capabilities[rule.permission]||rule.permission} for ${rule.requestingOrigin||rule.origin}`);for(const [value,label]of [['ask','Ask'],['block','Block'],['allow','Allow']]){const option=text('option',label);option.value=value;option.selected=value===(rule.decision||'ask');select.append(option);}select.onchange=()=>act('permissions:set',{...rule,decision:select.value});return select;}
  let activeOrigin;try{const url=new URL(state.tabs.find(tab=>tab.targetId===state.activeTabId)?.url);if(['https:','http:'].includes(url.protocol))activeOrigin=url.origin;}catch{}
  if(activeOrigin){const details=document.createElement('details');details.append(text('summary',`Permissions for ${activeOrigin}`));for(const [permission,label]of Object.entries(permissionData.capabilities)){const rule=permissionData.rules.find(row=>row.origin===activeOrigin&&row.requestingOrigin===activeOrigin&&row.permission===permission)||{origin:activeOrigin,requestingOrigin:activeOrigin,permission,decision:'ask'};const row=text('div','','row');row.append(text('span',label,'row-main'),permissionSelect(rule));details.append(row);}permissions.append(details);}
  for(const rule of permissionData.rules){const row=text('div','','row');row.append(text('div',`${rule.requestingOrigin}${rule.origin!==rule.requestingOrigin?` within ${rule.origin}`:''} · ${permissionData.capabilities[rule.permission]||rule.permission}`,'row-main'),permissionSelect(rule));permissions.append(row);}
  if(!permissionData.rules.length)permissions.append(text('p','No saved decisions. Sites will ask when they need access.'));
  const extensions = card('Unpacked extensions', 'Load a local extension directory containing manifest.json. Compatibility depends on Electron’s supported extension APIs.');
  for (const ext of state.extensions) { const row = text('div', '', 'row'); row.append(text('div', `${ext.name} · ${ext.version}${ext.error ? ` · ${ext.error}` : ''}`, 'row-main')); const toggle = text('button', ext.enabled === false ? 'Enable' : 'Disable'); toggle.onclick = () => act('extensions:toggle', ext.id); const del = text('button', 'Remove'); del.onclick = () => act('extensions:remove', ext.id); row.append(toggle, del); extensions.append(row); }
  const load = text('button', 'Load unpacked extension', 'subtle-button'); load.onclick = () => act('extensions:load'); extensions.append(load);
  card('Agent connection', 'Agent scripts connect to a token protected loopback bridge. Browser pages cannot read its token or access the browser’s Node.js environment.');
  card('About Wiek Browser', `Version ${state.version}. Built with Electron and Chromium. The agent SDK is based on citrolabs/ego-lite under the MIT license.`);
}
function spacesPanel(p){
  p.replaceChildren();const heading=text('div','','panel-heading');heading.append(text('h1','Manage Spaces'));const back=text('button','Back to browser','subtle-button');back.onclick=()=>{currentPanel=null;act('panel',false);};heading.append(back);p.append(heading);
  const card=text('div','','card'),selected=new Set();
  for(const space of state.spaces){const row=text('div','','row'),label=text('label',`${space.name} · ${space.ownership==='agent'?'Agent running':space.ownership==='agentDelegatedToUser'?'You have control':'Personal'}`,'row-main'),check=document.createElement('input');check.type='checkbox';check.onchange=()=>check.checked?selected.add(space.id):selected.delete(space.id);label.prepend(check);row.append(label);const pin=text('button',space.pinned?'Unpin':'Pin');pin.onclick=()=>act('space:pin',{id:space.id,pinned:!space.pinned});const detach=text('button',space.detached?'Return to main window':'Open in new window');detach.onclick=()=>act(space.detached?'space:attach-window':'space:open-window',space.id);row.append(pin,detach);card.append(row);}
  const actions=text('div','','settings-actions'),pinned=text('label','Include pinned Spaces'),pinnedCheck=document.createElement('input');pinnedCheck.type='checkbox';pinned.prepend(pinnedCheck);const running=text('label','Include Agent tasks (stop linked runs)'),runningCheck=document.createElement('input');runningCheck.type='checkbox';running.prepend(runningCheck);const close=text('button','Close selected');close.onclick=()=>act('spaces:close',{ids:[...selected],includePinned:pinnedCheck.checked,includeRunning:runningCheck.checked});actions.append(pinned,running,close);card.append(actions);p.append(card);
  const closed=text('div','','card');closed.append(text('h3','Recently closed Spaces'),text('p','Restore saved tabs into a personal Space. Restoring does not restart an Agent task.'));
  for(const space of state.closedSpaces||[]){const row=text('div','','row');row.append(text('div',`${space.name} · ${space.tabCount} tabs`,'row-main'));const restore=text('button','Restore');restore.onclick=()=>{currentPanel=null;act('space:restore',space.id);};row.append(restore);closed.append(row);}p.append(closed);
}
$('new-space').onclick = async () => { await act('panel', true); $('space-profile').replaceChildren(...state.profiles.map(p => { const o = text('option', p.name); o.value = p.id; o.selected = p.isDefault; return o; })); $('space-modal').hidden = false; $('space-name').focus(); };
$('manage-spaces').onclick=()=>showPanel('spaces');
$('add-home-pin').onclick=()=>editHomePin();
async function editHomePin(pin){const url=await askText('Website URL',pin?.url||'https://');if(!url)return;const title=await askText('Shortcut title',pin?.title||'');if(title)await act('homepin:save',{id:pin?.id,url,title});}
$('cancel-space').onclick = () => { $('space-modal').hidden = true; act('panel', Boolean(currentPanel)); };
$('space-form').onsubmit = async e => { e.preventDefault(); $('space-modal').hidden = true; currentPanel = null; await act('space:create', { name: $('space-name').value, profileId: $('space-profile').value }); $('space-name').value = ''; };
$('new-tab').onclick = () => { currentPanel = null; act('tab:new'); $('address').focus(); };
$('address-form').onsubmit = e => { e.preventDefault(); currentPanel = null; addressEditing = false; $('address').blur(); act('navigate', $('address').value); };
$('address').onfocus = () => addressEditing = true; $('address').onblur = () => addressEditing = false;
$('welcome-form').onsubmit = e => { e.preventDefault(); currentPanel = null; act('navigate', $('welcome-search').value); };
for (const action of ['back', 'forward', 'reload']) $(action).onclick = () => act(action);
$('bookmark').onclick = () => { act('bookmark:add'); toast('Bookmark saved'); };
$('ownership').onclick = () => { if (activeSpace()?.ownership !== 'user') act('space:control'); };
$('menu').onclick = async () => { const opening = $('space-menu').hidden; $('space-menu').hidden = !opening; await act('panel', opening || Boolean(currentPanel)); };
$('rename-space').onclick = async () => { $('space-menu').hidden = true; const name = await askText('Space name', activeSpace()?.name); if (name) act('space:rename', name); closeMenu(); };
$('finish-task').onclick = () => { act('space:finish'); closeMenu(); };
$('close-space').onclick = () => { if (confirm('Close this space and all of its tabs?')) act('space:close'); closeMenu(); };
function closeMenu() { $('space-menu').hidden = true; act('panel', Boolean(currentPanel)); }
for (const b of document.querySelectorAll('[data-panel]')) b.onclick = () => showPanel(b.dataset.panel);
window.addEventListener('vek:show-panel', event => { if (['agents','voice','catalog','workspace','mcp','preferences','library','recorder','spaces','desktop','scheduler'].includes(event.detail)) void showPanel(event.detail); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('space-modal').hidden) $('cancel-space').click(); closeMenu(); } });
window.WiekDesktopActions={openImage:async value=>{await showPanel('library');if(window.WiekLibraryPanel.hasDraft()&&!confirm('Replace your unsaved screenshot edits with this desktop capture?'))return false;await window.WiekLibraryPanel.openCapture(value);return true;}};
window.addEventListener('vek:desktop-text',async event=>{await showPanel('agents');if(!window.WiekAgentPanel.appendDraft(event.detail))toast('Select a conversation first, then use the selection again.');});
window.vek.onState(render); window.vek.onHighlight(({ x,y }) => { const mark = $('highlight'); mark.style.left = `${x + (state.chromeBounds?.x||230)}px`; mark.style.top = `${y + (state.chromeBounds?.y||116)}px`; mark.hidden = false; setTimeout(() => mark.hidden = true, 700); });
window.vek.onOpenPanel(async({name,intent})=>{await showPanel(name);if(name==='library'&&intent==='capture')try{await window.WiekLibraryPanel.capture();}catch(error){toast(error.message);}});
window.vek.onTranslation(async text=>{await showPanel('translation');window.WiekTranslationPanel.setText(text);});
window.vek.onDraft(async text=>{await showPanel('agents');if(!window.WiekAgentPanel.appendDraft(text))toast('Select a conversation first, then use Ask again.');});
window.vek.onError(toast);
window.vek.onSecretRequest(({id,title,confirm})=>{
  const modal=text('div','','modal'),form=text('form','','dialog');form.append(text('h2',title));const first=document.createElement('input');first.type='password';first.autocomplete='new-password';first.required=true;first.minLength=8;first.setAttribute('aria-label','Profile archive passphrase');const label=text('label','Passphrase (at least 8 characters)');label.append(first);form.append(label);
  let repeat;if(confirm){repeat=document.createElement('input');repeat.type='password';repeat.autocomplete='new-password';repeat.required=true;repeat.setAttribute('aria-label','Confirm archive passphrase');const again=text('label','Confirm passphrase');again.append(repeat);form.append(again);}
  const actions=text('div','','dialog-actions'),cancel=text('button','Cancel'),save=text('button',confirm?'Export':'Unlock','primary');cancel.type='button';actions.append(cancel,save);form.append(actions);modal.append(form);document.body.append(modal);
  const finish=value=>{modal.remove();void act('secret:respond',{id,text:value});};cancel.onclick=()=>finish(null);form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(null);}};form.onsubmit=e=>{e.preventDefault();if(repeat&&first.value!==repeat.value){repeat.setCustomValidity('Passphrases do not match');repeat.reportValidity();return;}finish(first.value);};if(repeat)repeat.oninput=()=>repeat.setCustomValidity('');first.focus();
});
window.vek.state().then(render);

async function askText(title, initial = '') {
  await act('panel', true);
  return new Promise(resolve => {
    const modal = text('div', '', 'modal'), form = text('form', '', 'dialog');
    const input = document.createElement('input'); input.value = initial; input.required = true;
    const label = text('label', title); label.append(input);
    const actions = text('div', '', 'dialog-actions'), cancel = text('button', 'Cancel'), save = text('button', 'Save', 'primary');
    cancel.type = 'button'; actions.append(cancel, save); form.append(text('h2', title), label, actions); modal.append(form); document.body.append(modal);
    const finish = value => { modal.remove(); act('panel', Boolean(currentPanel)); resolve(value); };
    form.onsubmit = e => { e.preventDefault(); finish(input.value); }; form.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(null);}};cancel.onclick = () => finish(null); input.focus(); input.select();
  });
}

window.vek.onDialog(async data => { const answer = await askText(data.message, data.defaultPrompt); await act('dialog:respond', {accept: answer !== null, text: answer}); });

window.vek.onFocusAddress(() => { $('address').focus(); $('address').select(); });
window.vek.onFindOpen(() => { $('findbar').hidden = false; $('findtext').focus(); $('findtext').select(); });
function findText(forward = true, next = false) { if ($('findtext').value) act('find', {text: $('findtext').value, forward, next}); }
window.vek.onFindNext(forward => findText(forward, true));
window.vek.onFindResult(result => { $('find-count').textContent = `${result.activeMatchOrdinal}/${result.matches}`; });
$('findbar').onsubmit = e => { e.preventDefault(); findText(true, true); };
let findTimer; $('findtext').oninput = () => { clearTimeout(findTimer); findTimer = setTimeout(() => findText(true, false), 100); };
$('find-prev').onclick = () => findText(false, true); $('find-next').onclick = () => findText(true, true);
$('find-close').onclick = () => { $('findbar').hidden = true; act('find:close'); };
$('findtext').onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); $('find-close').click(); } };

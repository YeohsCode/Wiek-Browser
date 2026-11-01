'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, session, dialog, shell, Menu, safeStorage, nativeTheme, nativeImage, Tray, clipboard } = require('electron');
const { WebSocketServer } = require('ws');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { snapshotPage } = require('./snapshot.cjs');
const { createAgentService } = require('./agent-service.cjs');
const { sendOrdered } = require('./cdp-transport.cjs');
const { inspectProfile, readProfile, createCredentialVault } = require('./profile-import.cjs');
const { createWorkspaceService } = require('./workspace-service.cjs');
const { createMcpService, createBrowserGateway } = require('./mcp-service.cjs');
const { createCatalogService } = require('./catalog-service.cjs');
const { createVoiceService } = require('./voice-service.cjs');
const { createPreferencesService } = require('./preferences-service.cjs');
const { createLibraryService } = require('./library-service.cjs');
const { createActionRecorder } = require('./action-recorder.cjs');
const { createMemoryService } = require('./memory-service.cjs');
const { createProfileArchive } = require('./profile-archive.cjs');
const { createSitePermissions } = require('./site-permissions.cjs');
const { createTurnCheckpoints } = require('./turn-checkpoints.cjs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

app.setName('Vek Browser');
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'Vek Browser'));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.resolve(process.env.VEK_DATA_DIR || process.env.VEK_BROWSER_DATA_DIR || (app.isPackaged ? app.getPath('userData') : path.join(ROOT, 'data')));
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(DATA, 'profile'));
const INSTANCE = crypto.randomUUID();
let window, server, wss, runtimeFile, saving, closing = false, agentService, workspaceService, mcpService, catalogService, voiceService, preferencesService, memoryService, libraryService, recorderService, tray, importResult;
const vaults = new Map();
const voiceMutedTabs = new Map();
const spaceWindows = new Map();
let pendingCaptureTarget,turnCheckpointService;
let browserStoreReady=false;
const secretRequests=new Map();
let profileArchiveResult;
function requestSecret(title,confirm=false){const id=crypto.randomUUID(),previous=panelOpen;window.show();window.focus();panelOpen=true;layout();return new Promise(resolve=>{secretRequests.set(id,{resolve:value=>{panelOpen=previous;layout();resolve(value);}});window.webContents.send('vek:secret-request',{id,title,confirm});});}
function vaultFor(profileId) {
  if (!vaults.has(profileId)) {
    const directory = path.join(DATA, 'vaults', crypto.createHash('sha256').update(profileId).digest('hex'));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    vaults.set(profileId, createCredentialVault({ dataDir: directory, encrypt: value => { if (!safeStorage.isEncryptionAvailable()) throw new Error('System credential encryption is unavailable'); return safeStorage.encryptString(value); }, decrypt: bytes => safeStorage.decryptString(bytes) }));
  }
  return vaults.get(profileId);
}
let store = { nextSpace: 1, selected: null, profiles: [{ id: 'Default', name: 'Personal', isDefault: true }], spaces: [], bookmarks: [], history: [] };
if (process.env.VEK_NO_RESTORE !== '1' && !process.argv.includes('--no-restore')) { try { store = { ...store, ...JSON.parse(fs.readFileSync(path.join(DATA, 'browser.json'), 'utf8')) }; } catch (failure) { if(failure.code!=='ENOENT')throw new Error('Browser state could not be restored; existing data was preserved'); } }
store.permissions ||= {}; store.extensionPaths ||= {}; store.closedSpaces ||= []; store.homePins ||= {};
const tabs = new Map(), connections = new Set(), attachedSessions = new Map(), downloads = (store.downloads || []).map(d => ({...d, paused:false, canResume:false, state: d.state === 'progressing' ? 'interrupted' : d.state }));
const initializedProfiles = new Set();
const belongsToProfile=(row,profileId)=>(row.profileId||'Default')===profileId;
const sitePermissions=createSitePermissions({initial:store.sitePermissions||[],legacy:store.permissions,onChange:rules=>{store.sitePermissions=rules;persist();publish();},onPrompt:({contents,permission})=>{
  const tab=[...tabs.values()].find(t=>t.view.webContents===contents),space=tab&&getSpace(tab.spaceId);
  if(space?.ownership==='agent'){space.ownership='agentDelegatedToUser';space.controlReason=permission;persist();publish();}
},prompt:async({contents,origin,requestingOrigin,permissions,signal})=>{
  const tab=[...tabs.values()].find(t=>t.view.webContents===contents);
  if(!tab)return 'block-once';
  const owner=spaceWindows.get(tab.spaceId)?.window||window;
  const result=await dialog.showMessageBox(owner,{signal,type:'question',title:'Website permission',message:`${requestingOrigin} requests ${permissions.map(p=>p.label).join(', ')}`,detail:origin===requestingOrigin?'This decision applies to this browser profile.':`Embedded in ${origin}. This decision applies only within this top-level website and profile.`,buttons:['Block once','Always block','Allow once','Always allow'],defaultId:0,cancelId:0});
  return ['block-once','block','allow-once','allow'][result.response]||'block-once';
}});
store.sitePermissions=sitePermissions.snapshot().rules;delete store.permissions;
const error = (message, error_code = 'EGO_OPERATION_FAILED') => Object.assign(new Error(message), { error_code });
function persist() {
  clearTimeout(saving);
  saving = setTimeout(writeBrowserStore, 120);
}
function writePrivateFile(target,contents){const temporary=path.join(path.dirname(target),`.vek-${crypto.randomUUID()}.tmp`);let fd;try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,contents);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,target);}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch{}}}
function writeBrowserStore(){if(!browserStoreReady)return;const data={...store,downloads:downloads.map(({item,...d})=>d),spaces:store.spaces.map(s=>({...s,tabs:s.tabs.map(id=>tabs.get(id)).filter(Boolean).map(t=>{const destroyed=t.view.webContents.isDestroyed();return {url:destroyed?t.url:t.view.webContents.getURL()||t.url,title:destroyed?'':t.view.webContents.getTitle(),active:s.activeTab===t.id};})}))};writePrivateFile(path.join(DATA,'browser.json'),JSON.stringify(data,null,2));}
function profile(id) { return store.profiles.find(p => p.id === id) || store.profiles[0]; }
function getSpace(id) {
  if (id === undefined || id === null) throw error('Task space not selected', 'EGO_TASK_SPACE_NOT_SELECTED');
  const space = store.spaces.find(s => s.id === id);
  if (!space) throw error(`Task space not found: ${id}`, 'EGO_TASK_SPACE_NOT_FOUND');
  return space;
}
function controlled(id) {
  const space = getSpace(id);
  if (space.ownership === 'user') throw error('Task space is inactive', 'EGO_TASK_SPACE_INACTIVE');
  if (space.ownership !== 'agent') throw error(space.controlReason || 'manual_takeover', 'EGO_TASK_SPACE_USER_IN_CONTROL');
  return space;
}
function descriptor(s) { return { id: s.id, taskId: s.name, name: s.name, detached:spaceWindows.has(s.id), pinned:Boolean(s.pinned), ownership: s.ownership, createdBy: s.createdBy, profileId: s.profileId, profileName: profile(s.profileId).name, recentTabTitles: s.tabs.map(id => tabs.get(id)?.view.webContents.getTitle() || '').slice(-5) }; }
function chromeBounds() { return preferencesService?.snapshot().tabLayout === 'vertical' ? {x:410,y:64} : {x:230,y:116}; }
function tabDescriptor(t, index = 0) { return { targetId: t.id, ...(t.openerId ? { openerId: t.openerId } : {}), ...(t.favicon ? { favicon: t.favicon } : {}), title: t.view.webContents.getTitle() || '', url: t.view.webContents.getURL() || t.url, active: getSpace(t.spaceId).activeTab === t.id, index }; }
function uiState(selectedSpaceId = store.selected) {
  const s = store.spaces.find(s => s.id === selectedSpaceId);
  const active = s && tabs.get(s.activeTab);
  return { agents: agentService?.snapshot(), preferences:preferencesService?.snapshot(), memory:s ? memoryService?.snapshot(s.profileId) : null, library:libraryService?.snapshot(), recorder:recorderService?.snapshot(), darkMode:nativeTheme.shouldUseDarkColors, panelOpen, chromeBounds:chromeBounds(), closedSpaces:store.closedSpaces.map(({tabs,...s})=>({...s,tabCount:tabs.length})), workspace: workspaceService?.snapshot(), mcp: mcpService?.snapshot(), homePins: s ? store.homePins[s.profileId] || [] : [], savedLogins: s ? vaultFor(s.profileId).list() : [], importResult, profileArchiveResult, sitePermissions:sitePermissions.snapshot(s?.profileId), version: app.getVersion(), browserInstanceId: INSTANCE, profiles: store.profiles, spaces: [...store.spaces].sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned))).map(descriptor), selectedSpaceId: s?.id, tabs: s ? s.tabs.map((id, i) => tabs.get(id) && tabDescriptor(tabs.get(id), i)).filter(Boolean) : [], activeTabId: active?.id, canGoBack: active?.view.webContents.navigationHistory.canGoBack() || false, canGoForward: active?.view.webContents.navigationHistory.canGoForward() || false, loading: active?.view.webContents.isLoading() || false, taskState: s?.taskState || '', bookmarks: store.bookmarks.filter(row=>belongsToProfile(row,s?.profileId)), history: store.history.filter(row=>belongsToProfile(row,s?.profileId)).slice(-200).reverse(), downloads: downloads.filter(row=>belongsToProfile(row,s?.profileId)).map(d => ({ id: d.id, name: d.name, path: d.path, url: d.url, state: d.state, paused:Boolean(d.paused), canResume:Boolean(d.canResume), received: d.received, total: d.total })), extensions: s ? (store.extensionPaths[s.profileId] || []).map(e => ({ ...e, loaded: Boolean(sessionFor(s.profileId).extensions.getExtension(e.id)) })) : [] };
}
function publish() { if (window && !window.isDestroyed()) window.webContents.send('vek:state', uiState());for(const [id,record]of spaceWindows)if(!record.window.isDestroyed())record.window.webContents.send('vek:state',uiState(id)); }
let panelOpen = false;
function layout() {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  const bounds=chromeBounds();
  for (const t of tabs.values()) {
    const secondary=spaceWindows.get(t.spaceId)?.window;
    const visible = (secondary||!panelOpen&&t.spaceId===store.selected) && t.view.webContents.getURL() !== 'about:blank' && t.view.webContents.getURL() !== '' && getSpace(t.spaceId).activeTab === t.id;
    t.view.setVisible(visible);
    if (visible) {if(secondary){const [w,h]=secondary.getContentSize();t.view.setBounds({x:0,y:88,width:Math.max(1,w),height:Math.max(1,h-88)});}else t.view.setBounds({ x: bounds.x, y: bounds.y, width: Math.max(1, width - bounds.x), height: Math.max(1, height - bounds.y) });}
  }
}
function sessionFor(profileId) {
  const ses = session.fromPartition(`persist:vek-${profileId}`, { cache: true });
  if (!initializedProfiles.has(profileId)) {
    initializedProfiles.add(profileId);
    for (const ext of store.extensionPaths[profileId] || []) if (ext.enabled !== false) ses.extensions.loadExtension(ext.path).then(loaded => { ext.id = loaded.id; ext.name = loaded.name; ext.version = loaded.version; ext.error = undefined; publish(); }).catch(e => { ext.error = e.message; publish(); });
    ses.setPermissionCheckHandler((contents,permission,requestingOrigin,details)=>sitePermissions.check({profileId,contents,permission,requestingOrigin,details}));
    ses.setPermissionRequestHandler((contents,permission,callback,details)=>sitePermissions.request({profileId,contents,permission,details},callback));
    ses.on('will-download', (event, item, contents) => {
      const d = { id: crypto.randomUUID(), profileId, item, name: item.getFilename(), path: item.getSavePath(), url: item.getURL(), state: 'progressing', paused:false, canResume:false, received: 0, total: item.getTotalBytes() };
      downloads.unshift(d);
      item.on('updated', (_, state) => { d.state = state; d.path = item.getSavePath(); d.received = item.getReceivedBytes(); d.paused=item.isPaused();d.canResume=item.canResume();publish(); persist(); });
      item.once('done', (_, state) => { d.state = state; d.path = item.getSavePath();d.received=item.getReceivedBytes();d.paused=false;d.canResume=state==='interrupted'&&item.canResume();publish(); persist(); });
      publish();
    });
  }
  return ses;
}
function makeTab(space, url = 'about:blank', { activate = true, reveal = false, nativeOptions, openerId } = {}) {
  const view = new WebContentsView({ ...(nativeOptions?.webContents ? { webContents: nativeOptions.webContents } : {}), webPreferences: { ...nativeOptions?.webPreferences, session: sessionFor(space.profileId), preload: path.join(__dirname, 'page-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, safeDialogs: false } });
  const t = { id: '', spaceId: space.id, view, url, openerId, rootSession: null, childSessions: new Set(), favicon: null }; 
  (spaceWindows.get(space.id)?.window||window).contentView.addChildView(view);
  view.setVisible(false);
  const wc = view.webContents;
  wc.on('preload-error', (_, file, error) => console.error('Page preload:', file, error));
  wc.on('context-menu',(_event,params)=>showPageContextMenu(t,params));
  wc.setWindowOpenHandler(details => ({ action: 'allow', outlivesOpener: true, createWindow: options => {
    // Returning the real WebContents through Electron's native creation hook
    // preserves Chromium's opener/window proxy and Target discovery metadata.
    const popup = makeTab(space, details.url, { nativeOptions: options, openerId: t.id });
    popup.ready.catch(err => console.error('Popup:', err));
    return popup.view.webContents;
  } }));
  wc.on('will-navigate', (event, url) => { if (!/^(https?:|file:|about:|data:|blob:)/i.test(url)) event.preventDefault(); });
  wc.on('page-title-updated', () => { publish(); persist(); });
  wc.on('did-start-loading', publish);
  wc.on('did-start-navigation',(_event,_url,isInPlace)=>{if(!isInPlace)sitePermissions.invalidate(wc);});
  wc.once('destroyed',()=>sitePermissions.invalidate(wc));
  wc.on('found-in-page', (_, result) => (spaceWindows.get(t.spaceId)?.window||window).webContents.send('vek:find-result', result));
  wc.on('did-stop-loading', () => { publish(); persist(); });
  wc.on('did-navigate-in-page', () => { publish(); persist(); });
  wc.on('dom-ready', () => {loadFavicons(t);sendPageConfig(t);});
  wc.on('page-favicon-updated', (_, urls) => loadFavicons(t, urls));
  wc.on('did-navigate', (_, url) => { t.url = url; t.favicon = null; layout(); store.history.push({ url, profileId:space.profileId, spaceId:space.id, title: wc.getTitle(), at: new Date().toISOString() }); store.history = store.history.slice(-20000); publish(); persist(); });
  wc.on('before-input-event', (_, input) => {
    if (input.type === 'keyDown' && space.ownership === 'agent' && Date.now() > (t.agentInputUntil || 0)) { space.ownership = 'agentDelegatedToUser'; space.controlReason = 'manual_takeover'; publish(); persist(); }
  });
  wc.on('before-mouse-event', (_, input) => {
    if (input.type === 'mouseDown' && space.ownership === 'agent' && Date.now() > (t.agentInputUntil || 0)) { space.ownership = 'agentDelegatedToUser'; space.controlReason = 'manual_takeover'; publish(); persist(); }
  });
  const initialize = async () => {
  // A debugger per real webContents preserves Chromium's DOM, input, frames, and network semantics.
  wc.debugger.attach('1.3');
  const info = await wc.debugger.sendCommand('Target.getTargetInfo');
  t.id = info.targetInfo.targetId;
  t.openerId ||= info.targetInfo.openerId;
  tabs.set(t.id, t);
  space.tabs.push(t.id);
  wc.debugger.on('message', (_, method, params, sessionId) => onDebuggerEvent(t, method, params, sessionId));
  wc.on('destroyed', () => { tabs.delete(t.id); space.tabs = space.tabs.filter(id => id !== t.id); });
  if (activate) space.activeTab = t.id;
  if (reveal) { const secondary=spaceWindows.get(space.id)?.window;if(secondary){secondary.show();secondary.focus();}else{store.selected = space.id; panelOpen = false;} }
  layout(); publish(); persist();
  // Match native createTab: return after dispatching navigation; SDK waits for load.
  if (!nativeOptions) wc.loadURL(normalizeURL(url)).catch(err => { console.warn('Navigation:', err.message); });
  return t;
  };
  t.ready = nativeOptions ? new Promise((resolve, reject) => setImmediate(() => initialize().then(resolve, reject))) : initialize();
  return t;
}
async function createTab(...args) { return makeTab(...args).ready; }
async function loadFavicons(t, declaredUrls) {
  const wc = t.view.webContents;
  if (wc.isDestroyed() || !/^https?:/.test(wc.getURL())) return;
  const pageUrl = wc.getURL();
  try {
    const favicon = await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: `(() => {
      const provided = ${JSON.stringify(declaredUrls || null)};
      const declared = provided?.length ? provided : [...document.querySelectorAll('link[rel]')].filter(link => link.rel.split(/\\s+/).some(rel => rel.toLowerCase() === 'icon')).map(link => link.href);
      const urls = declared.length ? declared : [new URL('/favicon.ico', location.href).href];
      const cache = globalThis.__vekFaviconCache ||= new Map();
      return Promise.all(urls.map(url => {
        if (cache.has(url)) return cache.get(url);
        const request = new Promise(resolve => {
          const image = new Image();
          image.onload = () => { try { const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext('2d').drawImage(image,0,0); resolve(canvas.toDataURL()); } catch { resolve(null); } };
          image.onerror = () => resolve(null); image.src = url;
        }); cache.set(url, request); return request;
      })).then(values => values.find(Boolean) || null);
    })()` }]);
    if (!wc.isDestroyed() && wc.getURL() === pageUrl && favicon) { t.favicon = favicon; publish(); }
  } catch {}
}
function normalizeURL(input) {
  input = String(input || '').trim();
  if (!input) return 'about:blank';
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(input)) return `http://${input}`;
  if (/^[\w.-]+:\d+(?:\/.*)?$/.test(input)) return `http://${input}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input;
  if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(input) && (input.includes('.') || input.startsWith('localhost'))) return `https://${input}`;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}
async function createSpace(name, profileId = 'Default', ownership = 'agent') {
  if (!store.profiles.some(p => p.id === profileId)) throw error('Profile not found', 'EGO_PROFILE_NOT_FOUND');
  if (ownership === 'agent' && store.spaces.some(s => s.name === name)) throw error(`Task space name in use: ${name}`, 'EGO_TASK_SPACE_NAME_IN_USE');
  const s = { id: store.nextSpace++, name, profileId, ownership, createdBy: ownership === 'agent' ? 'agent' : 'user', tabs: [], activeTab: null, taskState: '' };
  store.spaces.push(s);
  await createTab(s, 'about:blank', { reveal: ownership === 'user' });
  return s;
}
function activateTab(t) { const secondary=spaceWindows.get(t.spaceId)?.window;if(secondary){secondary.show();secondary.focus();}else{store.selected = t.spaceId;panelOpen = false;}getSpace(t.spaceId).activeTab = t.id; layout(); publish(); persist(); }
function closeTab(t) {
  const s = getSpace(t.spaceId);
  for (const [id, route] of attachedSessions) if (route.tab === t) attachedSessions.delete(id);
  if (t.promptDialog) resolvePrompt(t, false);
  (spaceWindows.get(t.spaceId)?.window||window).contentView.removeChildView(t.view);
  tabs.delete(t.id); s.tabs = s.tabs.filter(id => id !== t.id);
  if (s.activeTab === t.id) s.activeTab = s.tabs.at(-1) || null;
  t.view.webContents.close({ waitForBeforeUnload: false });
  for (const c of connections) emitCDP(c, { method: 'Target.targetDestroyed', params: { targetId: t.id } });
  layout(); publish(); persist();
}
function recordClosedSpace(s) {
  attachSpaceWindow(s.id);
  const saved={id:crypto.randomUUID(),name:s.name,profileId:s.profileId,pinned:Boolean(s.pinned),closedAt:new Date().toISOString(),tabs:s.tabs.map(id=>tabs.get(id)).filter(Boolean).map(t=>({url:t.view.webContents.getURL()||t.url,title:t.view.webContents.getTitle()}))};
  store.closedSpaces.unshift(saved);store.closedSpaces=store.closedSpaces.slice(0,30);
  for(const id of [...s.tabs])closeTab(tabs.get(id));store.spaces=store.spaces.filter(x=>x!==s);
}
function attachSpaceWindow(id) {
  const record=spaceWindows.get(id);if(!record)return;
  const space=store.spaces.find(s=>s.id===id);
  for(const target of space?.tabs||[]){const t=tabs.get(target);if(t){record.window.contentView.removeChildView(t.view);window.contentView.addChildView(t.view);}}
  spaceWindows.delete(id);if(!record.window.isDestroyed())record.window.destroy();if(!closing&&!window.isVisible()){window.show();window.focus();}layout();publish();
}
async function openSpaceWindow(space) {
  if(spaceWindows.has(space.id)){spaceWindows.get(space.id).window.show();spaceWindows.get(space.id).window.focus();return;}
  const secondary=new BrowserWindow({width:1100,height:800,minWidth:600,minHeight:400,title:`${space.name} — Vek Browser`,backgroundColor:'#f6f7fb',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  spaceWindows.set(space.id,{window:secondary});
  for(const id of space.tabs){const t=tabs.get(id);if(t){window.contentView.removeChildView(t.view);secondary.contentView.addChildView(t.view);}}
  secondary.on('resize',layout);secondary.on('close',event=>{if(!closing){event.preventDefault();attachSpaceWindow(space.id);}});
  secondary.webContents.on('page-title-updated',event=>event.preventDefault());await secondary.loadFile(path.join(__dirname,'space-window.html'));
  if(store.selected===space.id){const other=store.spaces.find(s=>s.id!==space.id&&!spaceWindows.has(s.id));if(other)store.selected=other.id;}
  layout();publish();secondary.show();secondary.focus();
}
function routeRoot(t, client) {
  if (!t.rootSession) { t.rootSession = `vek-${crypto.randomUUID()}`; attachedSessions.set(t.rootSession, { tab: t, child: null }); }
  if (client) client.sessions.add(t.rootSession);
  return t.rootSession;
}
function emitCDP(client, payload) { if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ event: 'cdp', payload: JSON.stringify(payload) })); }
function onDebuggerEvent(t, method, params, child) {
  const root = routeRoot(t);
  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    attachedSessions.set(params.sessionId, { tab: t, child: params.sessionId, targetId: params.targetInfo?.targetId });
    t.childSessions.add(params.sessionId);
  }
  if (method === 'Target.detachedFromTarget' && params?.sessionId) attachedSessions.delete(params.sessionId);
  const sid = child || root;
  for (const c of connections) {
    if (![...c.sessions].some(id => attachedSessions.get(id)?.tab === t) && !(method.startsWith('Target.') && c.discoverySpaces?.has(t.spaceId))) continue;
    if (method === 'Target.attachedToTarget') c.sessions.add(params.sessionId);
    emitCDP(c, { method, params, sessionId: sid });
  }
}
function targetFor(s, targetId) {
  const t = tabs.get(targetId || s.activeTab);
  if (!t || t.spaceId !== s.id) throw error('No target with given id found', 'EGO_WEB_CONTENTS_UNAVAILABLE');
  return t;
}
async function sendCDP(s, method, params = {}, sessionId, client) {
  let t, child;
  if (sessionId) {
    const route = attachedSessions.get(sessionId);
    if (!route) throw new Error('Session with given id not found');
    t = route.tab; child = route.child;
    if (t.spaceId !== s.id) throw error('Target is outside selected task space', 'EGO_TASK_SPACE_NOT_FOUND');
  } else t = targetFor(s);
  if (method === 'Target.setDiscoverTargets' && client) { if (params.discover) client.discoverySpaces.add(s.id); else client.discoverySpaces.delete(s.id); }
  if (method === 'Page.handleJavaScriptDialog' && t.promptDialog) { resolvePrompt(t, params.accept, params.promptText); return {}; }
  if (method === 'Target.getTargets') {
    if (method.startsWith('Input.')) t.agentInputUntil = Date.now() + 350;
  const result = await sendOrdered(t.view.webContents.debugger, method, params, child || undefined);
    // Expose only this Space's page targets plus their renderer child targets.
    const allowed = new Set(s.tabs);
    const visit = tree => { if (tree?.frame?.id) allowed.add(tree.frame.id); for (const child of tree?.childFrames || []) visit(child); };
    for (const id of s.tabs) { const tab = tabs.get(id); if (tab) { try { visit((await tab.view.webContents.debugger.sendCommand('Page.getFrameTree')).frameTree); } catch {} } }
    for (const route of attachedSessions.values()) if (route.tab.spaceId === s.id && route.targetId) allowed.add(route.targetId);
    return { targetInfos: result.targetInfos.filter(i => allowed.has(i.targetId) || i.openerId && allowed.has(i.openerId)).map(i => i.type === 'iframe' && !i.parentId && i.parentFrameId ? { ...i, parentId: i.parentFrameId } : i) };
  }
  if (method === 'Target.attachToTarget' && tabs.has(params.targetId)) {
    const target = targetFor(s, params.targetId); const sid = routeRoot(target, client);
    return { sessionId: sid };
  }
  if (method === 'Target.detachFromTarget' && attachedSessions.get(params.sessionId)?.child === null) { client?.sessions.delete(params.sessionId); return {}; }
  if (method === 'Target.activateTarget') { activateTab(targetFor(s, params.targetId)); return {}; }
  if (method === 'Target.closeTarget') { closeTab(targetFor(s, params.targetId)); return { success: true }; }
  if (method === 'Target.createTarget') { const created = await createTab(s, params.url); return { targetId: created.id }; }
  if (method === 'Target.getTargetInfo' && params.targetId && tabs.has(params.targetId)) { const target = targetFor(s, params.targetId); return target.view.webContents.debugger.sendCommand('Target.getTargetInfo'); }
  if (method.startsWith('Input.')) t.agentInputUntil = Date.now() + 350;
  const result = await sendOrdered(t.view.webContents.debugger, method, params, child || undefined);
  if (method === 'Target.attachToTarget' && result.sessionId) { attachedSessions.set(result.sessionId, { tab: t, child: result.sessionId, targetId: params.targetId }); client?.sessions.add(result.sessionId); }
  return result;
}
function validateArgs(method, args) {
  const spec = { getBrowserVersion: [0,0], listProfiles: [0,0], listTaskSpaces: [0,0], useTaskSpace: [1,1,'number'], createTaskSpace: [1,2,'string','string'], claimTaskSpace: [1,2,'number','string'], createTab: [1,1,'string'], listTabs: [0,0], snapshot: [0,1,'object'], closeTaskSpace: [0,0], completeTaskSpace: [0,0], handOffTaskSpace: [0,0], takeOverTaskSpace: [0,0], setAgentTaskState: [1,1,'string'], animationHighlightMouseToPosition: [2,2,'number','number'], sendCDPMessage: [1,1,'string'] }[method];
  if (!spec) return;
  if (args.length < spec[0] || args.length > spec[1] || args.some((a, i) => typeof a !== spec[i+2] || a === null || typeof a === 'number' && !Number.isFinite(a))) throw error(`Invalid arguments for ${method}`, 'EGO_INVALID_ARGUMENT');
}
async function rpc(client, method, args = [], spaceId) {
  validateArgs(method, args);
  const sid = spaceId === undefined ? client.selectedSpace : spaceId;
  if (method === 'getBrowserVersion') return { currentVersion: app.getVersion(), updateAvailable: false };
  if (method === 'browserInfo') return { version: app.getVersion(), browserInstanceId: INSTANCE, pid: process.pid, dataDir: DATA };
  if (method === 'getState') {if(sid!=null)getSpace(sid);return uiState(sid??undefined);}
  if (method === 'workbenchAction') { if (typeof args[0] !== 'string') throw error('Expected an action name', 'EGO_INVALID_ARGUMENT');if(sid!=null)getSpace(sid);return uiAction(args[0], args[1],sid??undefined); }
  if (method === 'captureChrome') return { data: (await window.webContents.capturePage()).toPNG().toString('base64') };
  if (method === 'shutdown') { setTimeout(() => app.quit(), 200); return true; }
  if (method === 'listProfiles') return { profiles: store.profiles };
  if (method === 'listTaskSpaces') return { taskSpaces: store.spaces.map(descriptor) };
  if (method === 'useTaskSpace') { client.selectedSpace = args[0]; return args[0]; }
  if (method === 'createTaskSpace') {
    if (!args[0].trim()) throw error('Task space name is empty', 'EGO_INVALID_ARGUMENT');
    const pid = !args[1] || args[1] === 'default' ? store.profiles.find(p => p.isDefault).id : args[1];
    return descriptor(await createSpace(args[0], pid));
  }
  if (method === 'claimTaskSpace') { const s = getSpace(args[0]); s.ownership = 'agent'; s.controlReason = null; if (args[1] !== undefined) s.name = args[1]; publish(); persist(); return descriptor(s); }
  if (method === 'takeOverTaskSpace') { const s = getSpace(sid); if (s.ownership === 'user') throw error('Task space is inactive', 'EGO_TASK_SPACE_INACTIVE'); s.ownership = 'agent'; s.controlReason = null; publish(); persist(); return `${s.id} has been taken over by the agent.`; }
  if (method === 'sendCDPMessage') {
    let payload;
    try { const s = controlled(sid); payload = JSON.parse(args[0]); sendCDP(s, payload.method, payload.params || {}, payload.sessionId, client).then(result => emitCDP(client, { id: payload.id, result, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}) })).catch(err => emitCDP(client, { id: payload.id, error: { code: -32000, message: err.message }, ...(payload.sessionId ? { sessionId: payload.sessionId } : {}) })); }
    catch (err) { client.ws.send(JSON.stringify({ event: 'cdp-error', message: err.message, error_code: err.error_code || 'EGO_CDP_SEND_FAILED' })); }
    return null;
  }
  const s = controlled(sid);
  if (method === 'createTab') return tabDescriptor(await createTab(s, args[0]));
  if (method === 'listTabs') return { tabs: s.tabs.map((id, i) => tabDescriptor(tabs.get(id), i)) };
  if (method === 'snapshot') { const t = targetFor(s); const sessionId = routeRoot(t, client); return snapshotPage({ sendCDP: (method, params, sid) => sendCDP(s, method, params, sid || sessionId, client), targetId: t.id, sessionId, options: args[0] || {} }); }
  if (method === 'handOffTaskSpace') { s.ownership = 'agentDelegatedToUser'; s.controlReason = 'manual_takeover'; s.taskState = ''; publish(); persist(); return `${s.id} has been handed off to the user.`; }
  if (method === 'completeTaskSpace') { s.ownership = 'user'; s.taskState = ''; publish(); persist(); return `${s.id} task space completed.`; }
  if (method === 'closeTaskSpace') { for (const id of [...s.tabs]) closeTab(tabs.get(id)); store.spaces = store.spaces.filter(x => x !== s); if (store.selected === s.id) store.selected = store.spaces[0]?.id; layout(); publish(); persist(); return `${s.id} task space closed.`; }
  if (method === 'setAgentTaskState') { s.taskState = args[0]; publish(); return `${s.id} state updated.`; }
  if (method === 'animationHighlightMouseToPosition') { window.webContents.send('vek:highlight', { x: args[0], y: args[1] }); return `${s.id} mouse highlight shown.`; }
  throw error(`Unknown native method: ${method}`, 'EGO_INVALID_ARGUMENT');
}
function resolvePrompt(t, accept, promptText) {
  const pending = t.promptDialog;
  if (!pending) return;
  t.promptDialog = null;
  const value = accept ? String(promptText === undefined ? pending.params.defaultPrompt : promptText) : null;
  pending.event.returnValue = value;
  const params = { result: Boolean(accept), userInput: value || '' };
  const sid = routeRoot(t);
  for (const c of connections) if ([...c.sessions].some(id => attachedSessions.get(id)?.tab === t)) emitCDP(c, { method: 'Page.javascriptDialogClosed', params, sessionId: sid });
  panelOpen = false; layout(); publish();
}
async function startRPC() {
  const token = crypto.randomBytes(32).toString('hex');
  server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'vek-browser', version: app.getVersion() })); return; }
    res.writeHead(404); res.end();
  });
  wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/rpc' || url.searchParams.get('token') !== token || req.headers.origin) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const c = { ws, selectedSpace: null, sessions: new Set(), discoverySpaces: new Set() }; connections.add(c);
    ws.on('close', () => connections.delete(c));
    ws.on('message', async data => {
      let r;
      try { r = JSON.parse(data); const result = await rpc(c, r.method, r.args || [], r.spaceId); if (ws.readyState === 1) ws.send(JSON.stringify({ id: r.id, result })); }
      catch (err) { if (ws.readyState === 1) ws.send(JSON.stringify({ id: r?.id, error: { message: err.message, error_code: err.error_code || 'EGO_OPERATION_FAILED' } })); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  runtimeFile = path.join(DATA, 'runtime.json');
  const runtime = { port: server.address().port, token, pid: process.pid, browserInstanceId: INSTANCE, version: app.getVersion(), wsUrl: `ws://127.0.0.1:${server.address().port}/rpc?token=${token}` };
  fs.writeFileSync(runtimeFile, JSON.stringify(runtime, null, 2), { mode: 0o600 }); fs.chmodSync(runtimeFile, 0o600);
  console.log(`Vek Browser ready on 127.0.0.1:${runtime.port}`);
}
function visibleTab() { const focused=BrowserWindow.getFocusedWindow(),secondary=[...spaceWindows].find(([,record])=>record.window===focused);const s = store.spaces.find(s => s.id === (secondary?secondary[0]:store.selected)); return s && tabs.get(s.activeTab); }
function userControl(s) { if (s?.ownership === 'agent') { s.ownership = 'agentDelegatedToUser'; s.controlReason = 'manual_takeover'; publish(); persist(); } }
function showPageContextMenu(tab,params) {
  const wc=tab.view.webContents;if(wc.isDestroyed())return;
  const space=getSpace(tab.spaceId),owner=spaceWindows.get(space.id)?.window||window,items=[];
  userControl(space);
  const guarded=fn=>()=>{if(!wc.isDestroyed())Promise.resolve().then(fn).catch(error=>owner.webContents.send('vek:error',error.message));};
  const selection=String(params.selectionText||'').trim().slice(0,50000),link=String(params.linkURL||'').slice(0,16384);
  if(link){
    if(/^https?:\/\//i.test(link))items.push({label:'Open link in new tab',click:guarded(()=>createTab(space,link,{activate:false}))},{label:'Open link in new Space',click:guarded(async()=>{const created=await createSpace('New Space',space.profileId,'user');await tabs.get(created.activeTab).view.webContents.loadURL(link);})},{label:'Save link as…',click:guarded(()=>wc.downloadURL(link))});
    items.push({label:'Copy link address',click:()=>clipboard.writeText(link)},{type:'separator'});
  }
  if(params.mediaType==='image'){
    items.push({label:'Copy image',click:guarded(()=>wc.copyImageAt(params.x,params.y))});
    if(/^(https?:|data:image\/|blob:)/i.test(params.srcURL||''))items.push({label:'Save image as…',click:guarded(()=>wc.downloadURL(params.srcURL))});
    items.push({type:'separator'});
  }
  if(params.isEditable){
    for(const suggestion of (params.dictionarySuggestions||[]).slice(0,6))items.push({label:suggestion,click:guarded(()=>wc.replaceMisspelling(suggestion))});
    if(params.misspelledWord)items.push({label:'Add to spelling dictionary',click:guarded(()=>wc.session.addWordToSpellCheckerDictionary(params.misspelledWord))},{type:'separator'});
    items.push({role:'undo'},{role:'redo'},{type:'separator'},{role:'cut',enabled:params.editFlags.canCut},{role:'copy',enabled:params.editFlags.canCopy},{role:'paste',enabled:params.editFlags.canPaste},{role:'selectAll'},{type:'separator'});
  }else if(selection)items.push({role:'copy'},{type:'separator'});
  if(selection)items.push({label:'Save selection to Library',click:guarded(()=>saveSelection(selection,tab))},{label:'Ask Agent about selection',click:()=>{openPanel('agents');window.webContents.send('vek:draft',selection);}},{label:'Search web for selection',click:guarded(()=>createTab(space,`https://www.google.com/search?q=${encodeURIComponent(selection.slice(0,500))}`,{reveal:true}))},{type:'separator'});
  items.push({label:'Back',enabled:wc.navigationHistory.canGoBack(),click:guarded(()=>wc.navigationHistory.goBack())},{label:'Forward',enabled:wc.navigationHistory.canGoForward(),click:guarded(()=>wc.navigationHistory.goForward())},{label:'Reload',click:guarded(()=>wc.reload())},{type:'separator'},{label:'Inspect element',click:guarded(()=>wc.inspectElement(params.x,params.y))});
  Menu.buildFromTemplate(items).popup({window:owner});
}
function focusedChrome() { const t=visibleTab();return t&&spaceWindows.get(t.spaceId)?.window||window; }
function menuAction(action,value){const t=visibleTab();return uiAction(action,value,t&&spaceWindows.has(t.spaceId)?t.spaceId:undefined);}
function focusAddress() { const target=focusedChrome();target.webContents.focus(); target.webContents.send('vek:focus-address'); }
function showFind() { const t = visibleTab(); if (!t) return; userControl(getSpace(t.spaceId)); const target=focusedChrome();target.webContents.focus(); target.webContents.send('vek:find-open'); }
function zoomPage(delta) { const t = visibleTab(); if (t) { userControl(getSpace(t.spaceId)); t.view.webContents.setZoomLevel(delta === null ? 0 : Math.max(-5, Math.min(5, t.view.webContents.getZoomLevel() + delta))); } }
function browserMenu() {
  const shortcuts=preferencesService?.snapshot().shortcuts || {};
  const shortcut=(action,fallback)=>Object.hasOwn(shortcuts,action)?shortcuts[action]||undefined:fallback;
  return [{ label: 'Vek Browser', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'New Tab', accelerator: shortcut('newTab','CmdOrCtrl+T'), click: () => menuAction('tab:new') },
      { label: 'Close Tab', accelerator: shortcut('closeTab','CmdOrCtrl+W'), click: () => { const t = visibleTab(); if (t) menuAction('tab:close', t.id); else window.close(); } },
      { type: 'separator' }, { label: 'Open Location…', accelerator: shortcut('openLocation','CmdOrCtrl+L'), click: focusAddress },
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => { const t = visibleTab(); if (t) { userControl(getSpace(t.spaceId)); t.view.webContents.print({ silent: false, printBackground: true }); } } }
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { label: 'Find in Page…', accelerator: shortcut('find','CmdOrCtrl+F'), click: showFind }, { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => focusedChrome().webContents.send('vek:find-next', true) }, { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: () => focusedChrome().webContents.send('vek:find-next', false) }] },
    { label: 'View', submenu: [{ label: 'Reload Page', accelerator: shortcut('reload','CmdOrCtrl+R'), click: () => menuAction('reload') }, { type: 'separator' }, { label: 'Zoom In', accelerator: shortcut('zoomIn','CmdOrCtrl+Plus'), click: () => zoomPage(0.5) }, { label: 'Zoom Out', accelerator: shortcut('zoomOut','CmdOrCtrl+-'), click: () => zoomPage(-0.5) }, { label: 'Actual Size', accelerator: shortcut('zoomReset','CmdOrCtrl+0'), click: () => zoomPage(null) }, { type: 'separator' }, { role: 'togglefullscreen' }, { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => uiAction('devtools') }] },
    { label: 'History', submenu: [{ label: 'Back', accelerator: shortcut('back','CmdOrCtrl+['), click: () => menuAction('back') }, { label: 'Forward', accelerator: shortcut('forward','CmdOrCtrl+]'), click: () => menuAction('forward') }] },
    { label:'Workbench', submenu: [
      ...[['voiceInput','Voice input','voice'],['screenshot','Capture screenshot','library'],['chat','Agent chat','agents'],['spaceManager','Manage Spaces','spaces']].map(([action,label,name])=>({label,accelerator:shortcut(action),click:()=>openPanel(name,action==='screenshot'?'capture':undefined)})),
      {label:'Save selection to Library',accelerator:shortcut('clip'),click:()=>void saveSelection().catch(e=>window.webContents.send('vek:error',e.message))},
      {label:'Next Space',accelerator:shortcut('switchSpace'),click:()=>{const index=store.spaces.findIndex(s=>s.id===store.selected);const next=store.spaces[(index+1)%store.spaces.length];if(next)void uiAction('space:select',next.id);}},
    ]},
    { role: 'windowMenu' }];
}
function openPanel(name,intent) { if(name==='library'&&intent==='capture')pendingCaptureTarget=visibleTab()?.id;window.show();window.focus();panelOpen=true;layout();window.webContents.send('vek:open-panel',{name,intent}); }
async function saveSelection(text,tab=visibleTab()) {
  if (!tab) throw new Error('Open a page first');
  text ||= await tab.view.webContents.executeJavaScript('window.getSelection()?.toString() || ""');
  if (!text.trim()) throw new Error('Select some text on the active page first');
  if (!libraryService) throw new Error('Library is not available');
  await libraryService.dispatch('library:items:create',{kind:'text',title:tab.view.webContents.getTitle(),url:tab.view.webContents.getURL(),text:text.slice(0,50000)});openPanel('library');
}
function configureTray(enabled) {
  if (!enabled) {tray?.destroy();tray=null;return;}
  if (tray) return;
  const pixels=Buffer.alloc(18*18*4);
  for(let y=3;y<15;y++)for(let x=3;x<15;x++)if(Math.abs(x-(5+(y-3)/3))<1.3||Math.abs(x-(13-(y-3)/3))<1.3){const at=(y*18+x)*4;pixels[at+3]=255;}
  const icon=nativeImage.createFromBitmap(pixels,{width:18,height:18});icon.setTemplateImage(true);tray=new Tray(icon);tray.setToolTip('Vek Browser');tray.setContextMenu(Menu.buildFromTemplate([{label:'Show Vek Browser',click:()=>{window.show();window.focus();}},{label:'Agents & automations',click:()=>openPanel('agents')},{type:'separator'},{label:'Quit Vek Browser',click:()=>app.quit()}]));tray.on('click',()=>{window.show();window.focus();});
}
function applyPreferences() {
  if(!preferencesService)return;const settings=preferencesService.snapshot();nativeTheme.themeSource=settings.theme;
  if(window&&!window.isDestroyed()){Menu.setApplicationMenu(Menu.buildFromTemplate(browserMenu()));configureTray(settings.backgroundMode);for(const t of tabs.values())sendPageConfig(t);layout();publish();}
}
function sendPageConfig(t) {
  if(t.view.webContents.isDestroyed())return;
  const state=recorderService?.snapshot(),active=state?.sessions.find(s=>s.id===state.activeSessionId);
  t.view.webContents.send('vek:page-config',{selectionToolbar:preferencesService?.snapshot().selectionToolbar,recording:Boolean(state?.recording&&active?.targetId===t.id)});
}
async function captureTabImage(t) {
  // A hidden WebContentsView may have no current Viz surface after a resize.
  // Briefly render the requested page at its real viewport before capture,
  // then restore the chrome/panel layout even when the compositor fails.
  const wc=t.view.webContents,owner=spaceWindows.get(t.spaceId)?.window||window;
  const [width,height]=owner.getContentSize(),bounds=spaceWindows.has(t.spaceId)?{x:0,y:88}:chromeBounds();
  const current=()=>!wc.isDestroyed()&&getSpace(t.spaceId).activeTab===t.id&&(spaceWindows.has(t.spaceId)||t.spaceId===store.selected);
  if(!current())throw new Error('The page changed before screenshot capture');
  try{
    t.view.setBounds({x:bounds.x,y:bounds.y,width:Math.max(1,width-bounds.x),height:Math.max(1,height-bounds.y)});t.view.setVisible(true);wc.invalidate();
    await new Promise(resolve=>setTimeout(resolve,45));
    for(let attempt=0;attempt<3;attempt++){
      if(!current())throw new Error('The page changed before screenshot capture');
      try{const image=await wc.capturePage(undefined,{stayAwake:true});if(image.isEmpty())throw new Error('Screenshot returned no pixels');return image;}
      catch(failure){if(attempt===2||!/Viz|surface/i.test(failure.message))throw failure;wc.invalidate();await new Promise(resolve=>setTimeout(resolve,60));}
    }
  }finally{layout();}
}
async function uiAction(action, value, selectedSpaceId) {
  if(action==='secret:respond'){const request=secretRequests.get(value?.id);if(request){secretRequests.delete(value.id);request.resolve(typeof value.text==='string'?value.text:null);}return uiState();}
  if(action.startsWith('preferences:')){const result=await preferencesService.dispatch(action,value);memoryService?.syncPolicy();return result;}
  if(action.startsWith('memory:')){
    const selected=getSpace(selectedSpaceId??store.selected);if(!selected)throw new Error('Select a browser profile');const profileId=selected.profileId;
    if(action==='memory:index:page'){
      if(!preferencesService.snapshot().memory.browserActivity)throw new Error('Enable Browser activity memory first');
      const tab=tabs.get(selected.activeTab);if(!tab)throw new Error('Open a page to index');const wc=tab.view.webContents,before=wc.getURL();
      if(!/^https?:/i.test(before))throw new Error('Memory capture supports HTTP(S) pages');
      const page=await wc.executeJavaScript("({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,65536)})");
      if(wc.isDestroyed()||wc.getURL()!==before||page.url!==before||!tabs.has(tab.id)||selected.activeTab!==tab.id)throw new Error('Page changed during memory capture');
      return memoryService.indexPage(profileId,{...page,spaceId:selected.id});
    }
    if(action==='memory:choose-files'){const project=agentService.snapshot().projects.find(p=>p.id===value?.projectId);if(!project)throw new Error('Choose a project');if(!preferencesService.snapshot().memory.localFiles)throw new Error('Enable Project file context first');const pick=await dialog.showOpenDialog(window,{defaultPath:project.path,properties:['openFile','multiSelections'],filters:[{name:'Text files',extensions:['txt','md','csv','json','js','ts','py','rs','go','html','css','yaml','toml','sql','log']}]});if(pick.canceled)return memoryService.snapshot(profileId);return memoryService.dispatch('memory:index:files',{profileId,projectId:project.id,paths:pick.filePaths});}
    return memoryService.dispatch(action,{...value,profileId});
  }
  if(action.startsWith('library:'))return libraryService.dispatch(action,value);
  if(action==='recorder:file:export') {const result=await recorderService.dispatch('recorder:export',value);const pick=await dialog.showSaveDialog(window,{defaultPath:result.exportData.filename,filters:[{name:'Action recording',extensions:['json']}]});if(!pick.canceled&&pick.filePath)writePrivateFile(pick.filePath,result.exportData.content);return recorderService.snapshot();}
  if(action.startsWith('recorder:'))return recorderService.dispatch(action,value);
  if (action === 'voice:recording') {
    if (value?.active && value?.mute) for (const t of tabs.values()) { if (!voiceMutedTabs.has(t.id)) voiceMutedTabs.set(t.id,t.view.webContents.isAudioMuted());t.view.webContents.setAudioMuted(true); }
    else for (const [id,muted] of voiceMutedTabs) { const t=tabs.get(id);if(t&&!t.view.webContents.isDestroyed())t.view.webContents.setAudioMuted(muted);voiceMutedTabs.delete(id); }
    return voiceService.snapshot();
  }
  if (action === 'voice:history:save-audio') {
    const audio=await voiceService.dispatch('voice:history:audio',value);
    const extension=({'audio/wav':'wav','audio/webm':'webm','audio/ogg':'ogg','audio/mp4':'m4a','audio/mpeg':'mp3'})[audio.mime]||'audio';
    const pick=await dialog.showSaveDialog(window,{defaultPath:`Vek recording.${extension}`});if(!pick.canceled&&pick.filePath)fs.writeFileSync(pick.filePath,Buffer.from(audio.base64,'base64'),{mode:0o600});
    return voiceService.snapshot();
  }
  if (action==='workspace:git:checkpoint:restore')return turnCheckpointService.withRestoreLease(value.projectId,()=>workspaceService.dispatch(action,value));
  if (action.startsWith('workspace:')) return workspaceService.dispatch(action, value);
  if (action.startsWith('mcp:')) return mcpService.dispatch(action, value);
  if (action.startsWith('voice:')) { if(action==='voice:transcribe'&&preferencesService.snapshot().onDeviceModels===false&&voiceService.snapshot().config?.command===path.join(__dirname,'bin/whisper-cli'))throw new Error('Enable on-device models in Preferences to use the bundled transcriber');return voiceService.dispatch(action, value); }
  if (action.startsWith('catalog:')) {
    if (action === 'catalog:select') {const thread=agentService.snapshot().threads.find(t=>t.id===value?.threadId&&(!value.projectId||t.projectId===value.projectId));if(!thread)throw new Error('Conversation not found in this project');value={...value,projectId:thread.projectId};}
    return catalogService.dispatch(action, value);
  }
  if(action==='agents:files:attach'){const pick=await dialog.showOpenDialog(window,{title:'Attach files to this conversation',properties:['openFile','multiSelections']});if(pick.filePaths.length)await agentService.dispatch('agents:attachments:add',{id:value?.id,paths:pick.filePaths});return agentService.snapshot();}
  if(action==='agents:files:open'){const result=await agentService.dispatch('agents:attachments:read',value);if(result.attachmentData?.storedPath)shell.showItemInFolder(result.attachmentData.storedPath);return agentService.snapshot();}
  if (action === 'agents:file:export') {
    const result = await agentService.dispatch('agents:export', value || {});
    const data = result.exportData;
    if (!data) throw new Error('Agent export did not produce an archive');
    const pick = await dialog.showSaveDialog(window, { defaultPath: data.filename || 'vek-agents.json' });
    if (!pick.canceled && pick.filePath) writePrivateFile(pick.filePath,data.content);
    return uiState();
  }
  if (action === 'agents:file:import') {
    const pick = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Vek agent archive', extensions: ['json'] }] });
    if (pick.filePaths[0]) { if (fs.statSync(pick.filePaths[0]).size > 32 * 1024 * 1024) throw new Error('Agent archive exceeds 32 MiB'); await agentService.dispatch('agents:import', { data: JSON.parse(fs.readFileSync(pick.filePaths[0], 'utf8')) }); }
    return uiState();
  }
  if (action === 'agents:file:codex:preview') {
    const pick = await dialog.showOpenDialog(window, {title:'Select a Codex rollout JSONL file',properties:['openFile'],filters:[{name:'Codex rollout',extensions:['jsonl']}]});
    if(!pick.canceled && pick.filePaths[0])return agentService.dispatch('agents:codex:preview',{path:pick.filePaths[0]});
    return agentService.snapshot();
  }
  if (action === 'agents:file:claude:preview') {
    const pick = await dialog.showOpenDialog(window, { title: 'Select a Claude conversation JSONL file', properties: ['openFile'], filters: [{ name: 'Claude conversation', extensions: ['jsonl'] }] });
    if (!pick.canceled && pick.filePaths[0]) return agentService.dispatch('agents:claude:preview', { path: pick.filePaths[0] });
    return agentService.snapshot();
  }
  if (action.startsWith('agents:')) return agentService.dispatch(action, value);
  const s = store.spaces.find(s => s.id === (selectedSpaceId??store.selected));
  const t = s && tabs.get(s.activeTab);
  if (['navigate', 'back', 'forward', 'reload', 'tab:new', 'tab:close'].includes(action)) userControl(s);
  switch (action) {
    case 'space:create': await createSpace(value.name || 'New space', value.profileId || 'Default', 'user'); break;
    case 'space:select': if(spaceWindows.has(Number(value))){spaceWindows.get(Number(value)).window.show();spaceWindows.get(Number(value)).window.focus();}else{store.selected = Number(value); panelOpen = false;} break;
    case 'space:open-window': await openSpaceWindow(getSpace(Number(value??s?.id)));break;
    case 'space:attach-window': attachSpaceWindow(Number(value??s?.id));break;
    case 'space:rename': if (s && value.trim()) s.name = value.trim(); break;
    case 'space:pin': { const space=getSpace(Number(value?.id ?? s?.id));space.pinned=value?.pinned ?? !space.pinned; } break;
    case 'spaces:close': {
      if(!Array.isArray(value?.ids)||value.ids.some(id=>!Number.isSafeInteger(id)))throw new Error('Select Spaces to close');
      for(const id of [...new Set(value.ids)]){const space=store.spaces.find(s=>s.id===id);if(!space||space.pinned&&!value.includePinned||space.ownership==='agent'&&!value.includeRunning)continue;
        if(space.ownership==='agent')for(const thread of agentService.snapshot().threads)if(thread.status==='running'&&(space.agentScopeKey?.endsWith(`:${thread.id}`)||space.name===`agent-${thread.id}`))await agentService.dispatch('agents:threads:stop',{id:thread.id});recordClosedSpace(space);}
      if(!store.spaces.length)await createSpace('Personal',store.profiles.find(p=>p.isDefault).id,'user');if(!store.spaces.some(s=>s.id===store.selected))store.selected=store.spaces[0].id;
    } break;
    case 'space:restore': { const saved=store.closedSpaces.find(s=>s.id===value);if(!saved)throw new Error('Closed Space not found');const restored=await createSpace(saved.name,profile(saved.profileId).id,'user');restored.pinned=saved.pinned;const blank=restored.tabs[0];for(const tab of saved.tabs)await createTab(restored,tab.url,{activate:false});if(saved.tabs.length)closeTab(tabs.get(blank));restored.activeTab=restored.tabs[0];store.selected=restored.id;store.closedSpaces=store.closedSpaces.filter(s=>s!==saved);panelOpen=false; } break;
    case 'space:close': if (s) { recordClosedSpace(s);if(!store.spaces.length)await createSpace('Personal',store.profiles.find(p=>p.isDefault).id,'user');store.selected=store.spaces[0].id; } break;
    case 'space:control': if (s) { s.ownership = s.ownership === 'agent' ? 'agentDelegatedToUser' : s.ownership === 'agentDelegatedToUser' ? 'agent' : 'user'; s.controlReason = 'manual_takeover'; } break;
    case 'space:finish': if (s) { s.ownership = 'user'; s.taskState = ''; } break;
    case 'tab:new': if (s) await createTab(s, 'about:blank', { reveal: selectedSpaceId===undefined }); break;
    case 'tab:select': if (tabs.has(value)&&(!selectedSpaceId||tabs.get(value).spaceId===selectedSpaceId)) activateTab(tabs.get(value)); break;
    case 'tab:close': if (tabs.has(value)&&(!selectedSpaceId||tabs.get(value).spaceId===selectedSpaceId)) closeTab(tabs.get(value)); break;
    case 'navigate': if (t) { if(selectedSpaceId===undefined)panelOpen = false; await t.view.webContents.loadURL(normalizeURL(value)).catch(() => {}); } break;
    case 'back': if (t?.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack(); break;
    case 'forward': if (t?.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); break;
    case 'reload': if (t) t.view.webContents.isLoading() ? t.view.webContents.stop() : t.view.webContents.reload(); break;
    case 'panel': panelOpen = Boolean(value); break;
    case 'bookmark:add': if (t) { const url = t.view.webContents.getURL(); if (!store.bookmarks.some(b => belongsToProfile(b,s.profileId)&&b.url === url)) store.bookmarks.push({ profileId:s.profileId, title: t.view.webContents.getTitle() || url, url }); } break;
    case 'bookmark:remove': if(s)store.bookmarks = store.bookmarks.filter(b => !belongsToProfile(b,s.profileId)||b.url !== value); break;
    case 'history:clear': if(s)store.history = store.history.filter(row=>!belongsToProfile(row,s.profileId)); break;
    case 'homepin:save': if(s){const url=normalizeURL(value?.url||'');if(!/^https?:/i.test(url))throw new Error('Website shortcuts require an HTTP(S) URL');store.homePins[s.profileId] ||= [];const existing=value.id&&store.homePins[s.profileId].find(p=>p.id===value.id);if(existing){existing.url=url;existing.title=String(value.title||new URL(url).hostname).slice(0,100);}else{if(store.homePins[s.profileId].length>=24)throw new Error('At most 24 home shortcuts per profile');store.homePins[s.profileId].push({id:crypto.randomUUID(),url,title:String(value.title||new URL(url).hostname).slice(0,100)});}}break;
    case 'homepin:remove': if(s)store.homePins[s.profileId]=(store.homePins[s.profileId]||[]).filter(p=>p.id!==value);break;
    case 'profile:create': { const p = { id: `profile-${crypto.randomUUID()}`, name: value.trim() || 'Profile', isDefault: false }; store.profiles.push(p); break; }
    case 'profile:default': for (const p of store.profiles) p.isDefault = p.id === value; break;
    case 'data:clear': if (s) await sessionFor(s.profileId).clearStorageData(); break;
    case 'profile:file:export': if(s){
      const pick=await dialog.showSaveDialog(window,{defaultPath:`${profile(s.profileId).name}.vek-profile.json`,filters:[{name:'Encrypted Vek profile',extensions:['json']}]});if(pick.canceled||!pick.filePath)break;
      const passphrase=await requestSecret('Protect this exported profile with a passphrase',true);if(passphrase===null)break;
      const supported=url=>/^https?:\/\//i.test(url)||url==='about:blank';
      const spaces=store.spaces.filter(space=>space.profileId===s.profileId).map(space=>{const rows=space.tabs.map(id=>tabs.get(id)).filter(Boolean).map(t=>({url:t.view.webContents.getURL()||t.url,title:t.view.webContents.getTitle()})).filter(t=>supported(t.url));const active=space.tabs.indexOf(space.activeTab);return {name:space.name,pinned:Boolean(space.pinned),tabs:rows,...(rows.length?{activeTabIndex:Math.max(0,Math.min(active,rows.length-1))}:{})};});
      const rows=await sessionFor(s.profileId).cookies.get({});
      const cookies=rows.map(row=>Object.fromEntries(['domain','name','value','path','secure','httpOnly','hostOnly','session','sameSite','expirationDate'].filter(key=>row[key]!==undefined&&!(key==='expirationDate'&&row.session)).map(key=>[key,row[key]])));
      const passwords=value?.includePasswords?vaultFor(s.profileId).list().map(row=>({origin:row.origin,...vaultFor(s.profileId).forOrigin(row.id,row.origin)})):[];
      const payload={profile:{name:profile(s.profileId).name,id:s.profileId},spaces,bookmarks:store.bookmarks.filter(row=>belongsToProfile(row,s.profileId)&&/^https?:/i.test(row.url)).map(row=>({url:row.url,title:row.title||row.url,...(row.folder?{folder:row.folder}:{})})),history:store.history.filter(row=>(row.profileId===s.profileId||!row.profileId&&s.profileId==='Default')&&/^https?:/i.test(row.url)).map(row=>({url:row.url,title:row.title||row.url,at:row.at})),cookies,passwords,extensionsMetadata:(store.extensionPaths[s.profileId]||[]).map(row=>({id:row.id,name:row.name||'Extension',version:row.version||'0',enabled:row.enabled!==false}))};
      const encoded=await createProfileArchive().encode(payload,passphrase);writePrivateFile(pick.filePath,encoded);
      profileArchiveResult={message:'Encrypted profile exported.',counts:{spaces:spaces.length,cookies:cookies.length,passwords:passwords.length},warnings:['Only HTTP(S) and blank tabs are included. Extension metadata is included; extension binaries, IndexedDB and local storage are outside this portable format.']};
    }break;
    case 'profile:file:import': {
      const pick=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'Encrypted Vek profile',extensions:['json']}]});if(!pick.filePaths[0])break;if(fs.statSync(pick.filePaths[0]).size>32*1024*1024)throw new Error('Profile archive exceeds 32 MiB');
      const passphrase=await requestSecret('Unlock the selected Vek profile archive');if(passphrase===null)break;
      const {payload}=await createProfileArchive().decode(fs.readFileSync(pick.filePaths[0]),passphrase);
      const answer=await dialog.showMessageBox(window,{type:'question',title:'Restore profile',message:`Create a profile “${payload.profile.name}” with ${payload.cookies.length} cookies, ${payload.passwords.length} saved logins and ${payload.spaces.length} Spaces?`,detail:value?.restoreTabs===false?'Tabs will remain closed. Existing profiles remain available.':'Restored HTTP(S) tabs will open in the new profile. Extension metadata does not install extensions.',buttons:['Cancel','Restore'],defaultId:0,cancelId:0});if(answer.response!==1)break;
      const created={id:`profile-${crypto.randomUUID()}`,name:`${payload.profile.name} (imported)`,isDefault:false};store.profiles.push(created);const ses=sessionFor(created.id),warnings=[],counts={cookies:0,passwords:0,spaces:0,bookmarks:0,history:0};
      for(const row of payload.cookies){const cookie={...row};delete cookie.hostOnly;delete cookie.session;if(row.hostOnly)delete cookie.domain;try{await ses.cookies.set(cookie);counts.cookies++;}catch{warnings.push('A cookie was rejected by the browser.');}}
      if(payload.passwords.length)try{counts.passwords=vaultFor(created.id).import(payload.passwords);}catch{warnings.push('System encryption was unavailable; saved logins were not imported.');}
      for(const row of payload.bookmarks)if(!store.bookmarks.some(b=>belongsToProfile(b,created.id)&&b.url===row.url)){store.bookmarks.push({...row,profileId:created.id});counts.bookmarks++;}
      for(const row of payload.history){store.history.push({...row,profileId:created.id});counts.history++;}store.history.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));store.history=store.history.slice(-20000);
      if(value?.restoreTabs!==false)for(const saved of payload.spaces){const space=await createSpace(saved.name,created.id,'user');space.pinned=saved.pinned;const blank=space.tabs[0];for(const tab of saved.tabs)await createTab(space,tab.url,{activate:false});if(saved.tabs.length){closeTab(tabs.get(blank));space.activeTab=space.tabs[saved.activeTabIndex||0];}counts.spaces++;}
      if(!store.spaces.some(space=>space.profileId===created.id)){await createSpace(created.name,created.id,'user');counts.spaces++;}
      if(payload.extensionsMetadata.length)warnings.push(`${payload.extensionsMetadata.length} extension references were recorded; load their unpacked folders separately.`);
      created.importedExtensions=payload.extensionsMetadata;profileArchiveResult={message:'Profile restored into a new profile.',counts,warnings:[...new Set(warnings)]};panelOpen=true;
    }break;
    case 'permissions:snapshot': return sitePermissions.snapshot(s?.profileId);
    case 'permissions:set': if(!s)throw new Error('Select a browser profile');sitePermissions.set({...value,profileId:s.profileId});break;
    case 'permissions:remove': if(s)sitePermissions.reset(s.profileId,typeof value==='string'?value:value.origin);break;
    case 'profile:import': if (s) {
      const pick = await dialog.showOpenDialog(window, { title: 'Select a Chromium profile folder (e.g. Default or Profile 1)', properties: ['openDirectory'] });
      if (!pick.filePaths[0]) break;
      const source = await inspectProfile(pick.filePaths[0]);
      const options = { bookmarks: value?.bookmarks !== false, history: value?.history !== false, cookies: value?.cookies === true, passwords: value?.passwords === true };
      if (options.cookies || options.passwords) {
        const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Import protected browser data', message: 'Import selected login data into this Vek profile?', detail: `Source: ${source.path}\nCookies and saved passwords will be decrypted using the selected browser’s macOS Safe Storage key. macOS may request Keychain access. Passwords are encrypted again in Vek’s local vault. Unsupported records will be reported.`, buttons: ['Cancel', 'Import'], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) break;
      }
      const services = { chrome: 'Chrome Safe Storage', chromium: 'Chromium Safe Storage', edge: 'Microsoft Edge Safe Storage', brave: 'Brave Safe Storage' };
      const serviceName = services[value?.sourceBrowser || 'chrome'];
      if (!serviceName) throw new Error('Unknown source browser');
      const imported = await readProfile({ directory: source.path, ...options, getPassword: async () => {
        if (process.platform !== 'darwin') throw new Error('Encrypted migration is supported on macOS');
        try { const result = await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', serviceName, '-w'], { timeout: 60000, maxBuffer: 4096 }); return result.stdout.replace(/\r?\n$/, ''); }
        catch { throw new Error('Source browser key access was denied or unavailable'); }
      } });
      const counts = { bookmarks: 0, history: 0, cookies: 0, passwords: 0 };
      for (const item of imported.bookmarks) if (!store.bookmarks.some(b => belongsToProfile(b,s.profileId)&&b.url === item.url)) { store.bookmarks.push({...item,profileId:s.profileId}); counts.bookmarks++; }
      for (const item of imported.history) if (!store.history.some(h => belongsToProfile(h,s.profileId)&&h.url === item.url && h.at === item.at)) { store.history.push({...item,profileId:s.profileId}); counts.history++; }
      store.history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); store.history = store.history.slice(-20000);
      for (const cookie of imported.cookies) try { await sessionFor(s.profileId).cookies.set(cookie); counts.cookies++; } catch { const warning = imported.warnings.find(w => w.category === 'cookies' && w.reason === 'Cookie rejected by Chromium'); if (warning) warning.count++; else imported.warnings.push({ category: 'cookies', reason: 'Cookie rejected by Chromium', count: 1 }); }
      if (imported.passwords.length) try { counts.passwords = vaultFor(s.profileId).import(imported.passwords); } catch { imported.warnings.push({ category: 'passwords', reason: 'System encryption unavailable; passwords were not saved', count: imported.passwords.length }); }
      importResult = { counts, warnings: imported.warnings, at: new Date().toISOString() };
    } break;
    case 'logins:remove': if (s) vaultFor(s.profileId).remove(value); break;
    case 'logins:fill': if (s && t) {
      const origin = new URL(t.view.webContents.getURL()).origin;
      const login = vaultFor(s.profileId).forOrigin(value, origin);
      const filled = await t.view.webContents.executeJavaScriptInIsolatedWorld(994, [{ code: `(() => { if (location.origin !== ${JSON.stringify(origin)}) throw new Error('Page navigated before fill'); const password = document.querySelector('input[type=password]'); if (!password) return false; const form = password.form || document; const username = form.querySelector('input[autocomplete=username],input[type=email],input[type=text]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; function fill(field, value) { setter.call(field, value); field.dispatchEvent(new Event('input', {bubbles:true})); field.dispatchEvent(new Event('change', {bubbles:true})); } if (username) fill(username, ${JSON.stringify(login.username)}); fill(password, ${JSON.stringify(login.password)}); return true; })()` }]);
      if (!filled) throw new Error('No password field found on the active page');
      panelOpen = false;
    } break;
    case 'cookies:import': if (s) { const pick = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Cookie JSON', extensions: ['json'] }] }); if (pick.filePaths[0]) { const cookies = JSON.parse(fs.readFileSync(pick.filePaths[0], 'utf8')); if (!Array.isArray(cookies)) throw new Error('Expected an array of cookies'); for (const cookie of cookies) { const protocol = cookie.secure ? 'https' : 'http'; const payload = { ...cookie, url: cookie.url || `${protocol}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}` }; delete payload.hostOnly; delete payload.session; delete payload.storeId; await sessionFor(s.profileId).cookies.set(payload); } } } break;
    case 'extensions:load': if (s) { const pick = await dialog.showOpenDialog(window, { properties: ['openDirectory'] }); if (pick.filePaths[0]) { const ext = await sessionFor(s.profileId).extensions.loadExtension(pick.filePaths[0]); store.extensionPaths[s.profileId] ||= []; if (!store.extensionPaths[s.profileId].some(e => e.id === ext.id)) store.extensionPaths[s.profileId].push({ id: ext.id, path: pick.filePaths[0], name: ext.name, version: ext.version, enabled: true }); } } break;
    case 'extensions:toggle': if (s) { const ext = store.extensionPaths[s.profileId]?.find(e => e.id === value); if (!ext) throw new Error('Extension not found'); if (ext.enabled !== false) { sessionFor(s.profileId).extensions.removeExtension(ext.id); ext.enabled = false; } else { const loaded = await sessionFor(s.profileId).extensions.loadExtension(ext.path); ext.id = loaded.id; ext.enabled = true; ext.error = undefined; } } break;
    case 'extensions:remove': if (s) { sessionFor(s.profileId).extensions.removeExtension(value); store.extensionPaths[s.profileId] = (store.extensionPaths[s.profileId] || []).filter(e => e.id !== value); } break;
    case 'download:open': { const d = downloads.find(d => d.id === (value?.id||value)&&belongsToProfile(d,s?.profileId)); if (d?.state === 'completed') await shell.openPath(d.path); break; }
    case 'download:show': { const d = downloads.find(d => d.id === (value?.id||value)&&belongsToProfile(d,s?.profileId)); if (d?.path) shell.showItemInFolder(d.path); break; }
    case 'download:cancel': downloads.find(d => d.id === (value?.id||value)&&belongsToProfile(d,s?.profileId))?.item?.cancel(); break;
    case 'download:pause': {const d=downloads.find(d=>d.id===(value?.id||value)&&belongsToProfile(d,s?.profileId));if(!d?.item||d.state!=='progressing')throw new Error('This download is not active');d.item.pause();d.paused=d.item.isPaused();d.canResume=d.item.canResume();break;}
    case 'download:resume': {const d=downloads.find(d=>d.id===(value?.id||value)&&belongsToProfile(d,s?.profileId));if(!d?.item||!d.item.canResume())throw new Error('This download cannot resume in the current session');d.item.resume();d.paused=d.item.isPaused();d.canResume=d.item.canResume();break;}
    case 'find': if (t && value.text) { t.view.webContents.findInPage(String(value.text), { forward: value.forward !== false, findNext: Boolean(value.next) }); } break;
    case 'find:close': if (t) { t.view.webContents.stopFindInPage('clearSelection'); t.view.webContents.focus(); } break;
    case 'dialog:respond': if (t?.promptDialog) resolvePrompt(t, Boolean(value.accept), value.text); break;
    case 'devtools': t?.view.webContents.openDevTools({ mode: 'detach' }); break;
    default: throw new Error(`Unknown UI action: ${action}`);
  }
  layout(); publish(); persist(); return uiState(selectedSpaceId??store.selected);
}
async function resolveAgentScope(scope) {
  const state = agentService.snapshot(), project = state.projects.find(p => p.id === scope.projectId);
  if (!project) throw new Error('Scoped project no longer exists');
  if (scope.threadId && !state.threads.some(t => t.id === scope.threadId && t.projectId === project.id)) throw new Error('Conversation does not belong to the scoped project');
  return { ...scope, projectPath: project.path };
}
const creatingScopedSpaces = new Map();
async function spaceForScope(scope) {
  const key = `${scope.projectId}:${scope.threadId || 'project'}`;
  let space = store.spaces.find(s => s.agentScopeKey === key);
  if (!space) {
    if (!creatingScopedSpaces.has(key)) creatingScopedSpaces.set(key, createSpace(`Agent ${scope.threadId || scope.projectId}`, store.profiles.find(p => p.isDefault).id).then(s => { s.agentScopeKey = key; persist(); publish(); return s; }).finally(() => creatingScopedSpaces.delete(key)));
    space = await creatingScopedSpaces.get(key);
  }
  return controlled(space.id);
}
function agentPromptPrefix(thread,project) {
  const preferences=preferencesService.snapshot();
  let memory='';
  if(preferences.memory.browserActivity){const scopeIds=new Set(store.spaces.filter(s=>s.name===`agent-${thread.id}`||s.agentScopeKey===`${thread.projectId}:${thread.id}`||s.id===thread.browserSpaceId).map(s=>s.id));const recent=store.history.filter(row=>scopeIds.has(row.spaceId)).slice(-6).map(row=>{try{const url=new URL(row.url);return `${String(row.title||'').slice(0,120)}: ${(url.origin+url.pathname).slice(0,240)}`;}catch{return '';}}).filter(Boolean);if(recent.length)memory+=`\nUser-enabled recent browser activity (query strings and fragments omitted):\n${recent.join('\n')}`;}
  if(preferences.memory.localFiles){const files=fs.readdirSync(project.path,{withFileTypes:true}).filter(entry=>!entry.name.startsWith('.')&&entry.name!=='node_modules').slice(0,30).map(entry=>`${entry.name.slice(0,80)}${entry.isDirectory()?'/':''}`);memory+=`\nUser-enabled local project context (names only, not file bodies):\n${files.join('\n')}`;}
  return `You are running in Vek Browser with a local browser automation CLI. To use it, run node with the path in VEK_BROWSER_CLI and the nodejs subcommand; pipe JavaScript on stdin or use -e. Read its skill subcommand first for the full SDK guide. VEK_DATA_DIR selects this browser instance. Use taskSpace(${JSON.stringify('agent-'+thread.id)}) to keep this conversation's browser work in its own persistent Space. The browser SDK requires its documented Space ownership and user handoff. Do not read other browser profile files or credentials. The api subcommand accepts a workbench action and --json payload, including workspace:*, agents:control:* and mcp:*; use only user-authorized task scope.\n${preferences.instructions?`User instructions:\n${preferences.instructions}`:''}${memory}${catalogService?.promptForThread(thread)||''}`;
}
app.whenReady().then(async () => {
  const reservedShortcuts=[['CommandOrControl+C','Copy'],['CommandOrControl+X','Cut'],['CommandOrControl+V','Paste'],['CommandOrControl+A','Select all'],['CommandOrControl+Z','Undo'],['CommandOrControl+Shift+Z','Redo'],['CommandOrControl+P','Print'],['CommandOrControl+G','Find next'],['CommandOrControl+Shift+G','Find previous'],['Alt+CommandOrControl+I','Developer tools']].map(([accelerator,label])=>({accelerator,label}));
  preferencesService=createPreferencesService({dataDir:DATA,reservedShortcuts,onChange:applyPreferences});nativeTheme.themeSource=preferencesService.snapshot().theme;
  memoryService=createMemoryService({dataDir:DATA,policy:()=>preferencesService.snapshot().memory,projects:()=>agentService?.snapshot().projects||[],onChange:publish});
  nativeTheme.on('updated',()=>publish());
  agentService = createAgentService({ dataDir: DATA, onChange: () => publish(), turnCheckpoints:{before:args=>turnCheckpointService.before(args),after:args=>turnCheckpointService.after(args),locked:id=>turnCheckpointService?.locked(id)||false,dispatch:(...args)=>turnCheckpointService.dispatch(...args)}, runContext: ({thread,project}) => ({
    env: { VEK_BROWSER_CLI: path.join(ROOT, 'cli/vek-browser.mjs'), VEK_DATA_DIR: DATA, VEK_THREAD_ID: thread.id, VEK_PROJECT_ID: thread.projectId, VEK_BROWSER_INSTANCE_ID: INSTANCE },
    promptPrefix: agentPromptPrefix(thread,project),
  }) });
  workspaceService = createWorkspaceService({ projects: () => agentService.snapshot().projects, onChange: publish });
  turnCheckpointService=createTurnCheckpoints({dataDir:DATA,workspace:workspaceService,projects:()=>agentService.snapshot().projects,isRunning:project=>{const state=agentService.snapshot(),ids=new Set(state.projects.filter(p=>p.path===project.path).map(p=>p.id));return state.threads.some(t=>ids.has(t.projectId)&&['running','discovering'].includes(t.status));},onChange:publish});
  agentService.recoverFileChanges(turnCheckpointService.records());
  catalogService = createCatalogService({ dataDir: DATA, projects: () => agentService.snapshot().projects });
  const whisperCommand = path.join(__dirname, 'bin/whisper-cli'), whisperModel = path.join(ROOT, 'models/ggml-tiny.bin');
  voiceService = createVoiceService({ dataDir: DATA, defaultConfig: fs.existsSync(whisperCommand) && fs.existsSync(whisperModel) ? { command:whisperCommand, args:['-m',whisperModel,'-f','{audio}','-l','{language}','-nt','-np','-ng'], output:'stdout' } : null });
  libraryService=createLibraryService({dataDir:DATA,onChange:publish,capture:async()=>{const t=pendingCaptureTarget?tabs.get(pendingCaptureTarget):visibleTab();pendingCaptureTarget=undefined;if(!t)throw new Error('Open a page to capture');const image=await captureTabImage(t);return {pngBase64:image.toPNG().toString('base64'),url:t.view.webContents.getURL(),title:t.view.webContents.getTitle()};},activePage:async()=>{const t=visibleTab();if(!t)throw new Error('Open a page to save');return {url:t.view.webContents.getURL(),title:t.view.webContents.getTitle()};},exportImage:async({pngBase64,suggestedName})=>{const pick=await dialog.showSaveDialog(window,{defaultPath:suggestedName,filters:[{name:'PNG image',extensions:['png']}]});if(pick.canceled||!pick.filePath)return {saved:false};fs.writeFileSync(pick.filePath,Buffer.from(pngBase64,'base64'),{mode:0o600});return {saved:true,path:pick.filePath};},openUrl:async url=>{const s=getSpace(store.selected);userControl(s);await createTab(s,url,{reveal:true});return {opened:true};}});
  recorderService=createActionRecorder({dataDir:DATA,onChange:()=>{for(const t of tabs.values())sendPageConfig(t);publish();},activePage:()=>{const t=visibleTab();return t?{targetId:t.id,url:t.view.webContents.getURL(),title:t.view.webContents.getTitle()}:null;},capture:async({targetId})=>{const t=tabs.get(targetId);if(!t||t.view.webContents.isDestroyed())throw new Error('Recorded page was closed');return {pngBase64:(await captureTabImage(t)).toPNG().toString('base64')};}});
  const browserGateway = createBrowserGateway({ resolveScope: resolveAgentScope, callbacks: {
    listTabs: async ({scope}) => { const s = await spaceForScope(scope); return { tabs: s.tabs.map((id, i) => tabDescriptor(tabs.get(id), i)) }; },
    createTab: async ({scope, arguments:args}) => { const s = await spaceForScope(scope); const url = normalizeURL(args.url); if (!/^(https?:|about:blank$)/i.test(url)) throw new Error('MCP navigation permits HTTP(S) or a blank page'); return tabDescriptor(await createTab(s, url)); },
    navigate: async ({scope, arguments:args}) => { const s = await spaceForScope(scope), t = targetFor(s, args.targetId); const url = normalizeURL(args.url); if (!/^https?:/i.test(url)) throw new Error('MCP navigation permits HTTP(S)'); await t.view.webContents.loadURL(url); return tabDescriptor(t); },
    snapshot: async ({scope, arguments:args}) => { const s = await spaceForScope(scope), t = targetFor(s,args.targetId), sessionId = routeRoot(t); return snapshotPage({ sendCDP: (method, params, sid) => sendCDP(s, method, params, sid || sessionId), targetId:t.id, sessionId, options:args.options || {} }); },
  } });
  mcpService = createMcpService({ dataDir: DATA, resolveScope: resolveAgentScope, resolveCredential: ref => { if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('Only explicit environment credential references are supported'); const name=ref.slice(4); if (!process.env[name]) throw new Error('Referenced credential is unavailable'); return process.env[name]; }, browserGateway, onChange: publish });
  window = new BrowserWindow({ width: 1380, height: 930, minWidth: 900, minHeight: 600, title: 'Vek Browser', backgroundColor: '#f6f7fb', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  Menu.setApplicationMenu(Menu.buildFromTemplate(browserMenu()));
  window.on('close',event=>{if(!closing&&(preferencesService.snapshot().backgroundMode||spaceWindows.size)){event.preventDefault();window.hide();}});
  window.on('close',()=>{if(!closing){clearTimeout(saving);writeBrowserStore();}});
  app.on('activate',()=>{if(window&&!window.isDestroyed()){window.show();window.focus();}});
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>{callback(contents===window.webContents&&permission==='media');});
  ipcMain.on('vek:page-prompt', (event, message, defaultPrompt) => {
    const t = [...tabs.values()].find(t => t.view.webContents === event.sender);
    if (process.env.VEK_DEBUG_DIALOGS) console.log('prompt ipc', Boolean(t), Boolean(t?.promptDialog), typeof message, typeof defaultPrompt);
    if (!t || t.promptDialog || typeof message !== 'string' || typeof defaultPrompt !== 'string') { event.returnValue = null; return; }
    const params = { url: event.senderFrame?.url || event.sender.getURL(), type: 'prompt', message, defaultPrompt, hasBrowserHandler: true };
    t.promptDialog = { event, params };
    const sid = routeRoot(t);
    for (const c of connections) if ([...c.sessions].some(id => attachedSessions.get(id)?.tab === t)) emitCDP(c, { method: 'Page.javascriptDialogOpening', params, sessionId: sid });
    if (getSpace(t.spaceId).ownership !== 'agent') { store.selected = t.spaceId; getSpace(t.spaceId).activeTab = t.id; panelOpen = true; layout(); window.webContents.send('vek:dialog', params); }
  });
  ipcMain.on('vek:page-action',(event,data)=>{const t=[...tabs.values()].find(t=>t.view.webContents===event.sender);if(!t||!data||typeof data!=='object')return;void recorderService.record({...data,targetId:t.id,url:event.senderFrame?.url||event.sender.getURL()}).catch(error=>console.error('Recorder:',error.message));});
  ipcMain.on('vek:selection-action',(event,data)=>{
    const t=visibleTab(),settings=preferencesService.snapshot().selectionToolbar;
    if(!t||event.sender!==t.view.webContents||!settings.enabled||!data||typeof data.text!=='string'||data.text.length>50000||!['copy','ask','save'].includes(data.action)||!settings[data.action])return;
    if(data.action==='copy')clipboard.writeText(data.text);
    else if(data.action==='ask'){openPanel('agents');window.webContents.send('vek:draft',data.text);}
    else void saveSelection(data.text,t).catch(error=>window.webContents.send('vek:error',error.message));
  });
  ipcMain.handle('vek:state', event => { if (event.sender === window.webContents)return uiState();const secondary=[...spaceWindows].find(([,record])=>record.window.webContents===event.sender);if(!secondary)throw new Error('Invalid sender');return uiState(secondary[0]); });
  ipcMain.handle('vek:action', (event, action, value) => { if(event.sender===window.webContents)return uiAction(action,value);const secondary=[...spaceWindows].find(([,record])=>record.window.webContents===event.sender);if(!secondary||!['navigate','back','forward','reload','tab:new','tab:select','tab:close','bookmark:add','space:control','space:attach-window','find','find:close'].includes(action))throw new Error('Invalid sender or detached-window action');return uiAction(action,value,secondary[0]); });
  await window.loadFile(path.join(__dirname, 'index.html'));
  applyPreferences();
  window.on('resize', layout);
  const savedSpaces = store.spaces; store.spaces = [];
  for (const saved of savedSpaces) {
    const savedTabs = saved.tabs; const s = { ...saved, tabs: [], activeTab: null }; store.spaces.push(s);
    for (const tab of savedTabs) if (tab && typeof tab === 'object') { const t = await createTab(s, tab.url, { activate: false }); if (tab.active) s.activeTab = t.id; }
    if (!s.tabs.length) await createTab(s, 'about:blank', { activate: false });
    s.activeTab ||= s.tabs[0];
  }
  if (!store.spaces.length) await createSpace('Personal', 'Default', 'user');
  store.selected = store.spaces.some(s => s.id === store.selected) ? store.selected : store.spaces[0].id;
  browserStoreReady=true;persist();layout(); publish(); await startRPC();
}).catch(err => { console.error(err); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (closing) return; closing = true;
  clearTimeout(saving);
  writeBrowserStore();
  sitePermissions.close();
  for(const request of secretRequests.values())request.resolve(null);secretRequests.clear();
  if (runtimeFile) { try { const r = JSON.parse(fs.readFileSync(runtimeFile)); if (r.pid === process.pid) fs.unlinkSync(runtimeFile); } catch {} }
  for (const c of connections) c.ws.close(); server?.close();
  tray?.destroy();
  if (agentService || mcpService || voiceService || workspaceService) { event.preventDefault(); void Promise.allSettled([agentService?.close(), mcpService?.close(), voiceService?.close(), libraryService?.close(), preferencesService?.close(),memoryService?.close(),recorderService?.close()]).then(async()=>{turnCheckpointService?.close();await workspaceService?.close();}).finally(() => app.quit()); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const electron = createRequire(import.meta.url)('electron'), root = resolve(import.meta.dirname, '..');
test('resource and memory panels operate through Electron IPC with real services and inert text', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'vek-p2-p3-panel-'));
 try {
  await writeFile(join(dir, 'preload.cjs'), "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('bridge',{invoke:(a,p)=>ipcRenderer.invoke('test',a,p)});");
  await writeFile(join(dir, 'panel.html'), `<!doctype html><meta charset="utf-8"><main id="mcp"></main><main id="preferences"></main>${['mcp-panel','preferences-panel'].map(n=>`<link rel="stylesheet" href="${pathToFileURL(join(root,'app',n+'.css'))}"><script src="${pathToFileURL(join(root,'app',n+'.js'))}"></script>`).join('')}`);
  await writeFile(join(dir, 'main.cjs'), `
const {app,BrowserWindow,ipcMain}=require('electron'),assert=require('node:assert/strict');
const {createMcpService}=require(${JSON.stringify(join(root,'app/mcp-service.cjs'))}),{createMemoryService}=require(${JSON.stringify(join(root,'app/memory-service.cjs'))}),{createPreferencesService}=require(${JSON.stringify(join(root,'app/preferences-service.cjs'))});app.setPath('userData',${JSON.stringify(join(dir,'electron'))});
app.whenReady().then(async()=>{
const project={id:'p',name:'Fixture',path:${JSON.stringify(dir)}},scope={projectId:'p'};
const preferences=createPreferencesService({dataDir:project.path}),memory=createMemoryService({dataDir:project.path,policy:()=>preferences.snapshot().memory,projects:()=>[project]}),mcp=createMcpService({dataDir:project.path,resolveScope:async s=>({...s,projectPath:project.path})});
await preferences.dispatch('preferences:update',{memory:{browserActivity:true,localFiles:true}});memory.syncPolicy();memory.indexPage('one',{url:'https://fixture.test/',title:'Memory <img id=bad>',text:'Chinese 中文全文检索 <img id=attack onerror=steal()>',spaceId:1});
await mcp.dispatch('mcp:integrations:save',{name:'Resource peer',command:process.execPath,args:[${JSON.stringify(join(root,'tests/fixtures/mcp-resource-peer.cjs'))}],scope});
ipcMain.handle('test',async(_,a,p)=>{if(a.startsWith('mcp:'))return mcp.dispatch(a,p);if(a.startsWith('memory:'))return memory.dispatch(a,{...p,profileId:'one'});const result=await preferences.dispatch(a,p);memory.syncPolicy();return result;});
const w=new BrowserWindow({show:false,width:1180,height:1000,webPreferences:{preload:${JSON.stringify(join(dir,'preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await w.loadFile(${JSON.stringify(join(dir,'panel.html'))});const e=code=>w.webContents.executeJavaScript(code);
await e("window.click=(root,text)=>[...document.querySelectorAll('#'+root+' button')].find(b=>b.textContent===text)?.click();window.ui=createVekMcpPanel(document.getElementById('mcp'),bridge.invoke,{projects:[{id:'p',name:'Fixture'}]});window.prefs=createVekPreferencesPanel(document.getElementById('preferences'),bridge.invoke);undefined");
const update=async()=>e('ui.update('+JSON.stringify(mcp.snapshot())+');prefs.update('+JSON.stringify({preferences:preferences.snapshot(),memory:memory.snapshot('one'),agents:{projects:[project]}})+');undefined');await update();
async function wait(code){for(let i=0;i<100;i++){if(await e(code))return;await new Promise(r=>setTimeout(r,20));}throw new Error('Panel wait timed out: '+code);}
await e("click('mcp','Connect');undefined");await wait("!!document.querySelector('#mcp details[data-resource-key]')");
await e("document.querySelector('#mcp details').open=true;click('mcp','List resources');undefined");await wait("!![...document.querySelectorAll('#mcp button')].find(b=>b.textContent==='Read resource')");
assert.equal(await e("document.getElementById('untrusted')===null"),true);assert.equal(await e("document.querySelector('#mcp details').open"),true);
await e("click('mcp','Subscribe');undefined");await wait("document.querySelector('#mcp').textContent.includes('changed — read again')");
await e("click('mcp','Read latest');undefined");await wait("!!document.querySelector('#mcp textarea[name=contents]')");assert.match(await e("document.querySelector('#mcp textarea[name=contents]').value"),/revision 0/);await e("click('mcp','Done');click('mcp','Unsubscribe');undefined");await wait("!document.querySelector('#mcp').textContent.includes('updates 1')");
assert.equal(await e("document.getElementById('bad')===null"),true);await e("var q=document.querySelector('[aria-label=\\\"Search indexed memory\\\"]');q.value='全文检索';q.dispatchEvent(new Event('input'));q.form.requestSubmit();undefined");await wait("document.querySelector('#preferences').textContent.includes('1 displayed results')");
await e("click('preferences','View saved text');undefined");await wait("!!document.querySelector('.vp-memory-text')");assert.match(await e("document.querySelector('.vp-memory-text').textContent"),/onerror=steal/);assert.equal(await e("document.getElementById('attack')===null"),true);
await e("click('preferences','Forget');undefined");await wait("!document.querySelector('.vp-memory-text')");assert.equal(memory.snapshot('one').documents.length,0);
await e("document.querySelector('#preferences input[aria-label=\\\"Browser activity\\\"]').click();undefined");await wait("document.querySelector('#preferences input[aria-label=\\\"Browser activity\\\"]').checked===false");assert.equal(await e("!!document.querySelector('[aria-label=\\\"Search indexed memory\\\"]')"),true);assert.equal(await e("!document.querySelector('#preferences .vp-error')"),true);
console.log(JSON.stringify({ok:true,checks:14}));await mcp.close();memory.close();preferences.close();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(dir, 'main.cjs')], { env, stdio: ['ignore','pipe','pipe'] }); let output = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000); const code = await new Promise(r => child.once('close', r)); clearTimeout(timer);
  assert.equal(code, 0, output); assert.match(output, /"ok":true/);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const electron = createRequire(import.meta.url)('electron'), root = resolve(import.meta.dirname, '..');
test('Electron OAuth UI reviews permissions before opening, authorizes a fixture, redacts tools and signs out', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'vek-oauth-panel-'));
 try {
  await writeFile(join(dir, 'preload.cjs'), "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('bridge',{invoke:(a,p)=>ipcRenderer.invoke('test',a,p)});");
  await writeFile(join(dir, 'panel.html'), `<!doctype html><meta charset="utf-8"><main id="mcp"></main><link rel="stylesheet" href="${pathToFileURL(join(root,'app/mcp-panel.css'))}"><script src="${pathToFileURL(join(root,'app/mcp-panel.js'))}"></script>`);
  await writeFile(join(dir, 'main.cjs'), `
const {app,BrowserWindow,ipcMain}=require('electron'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');const {createMcpService}=require(${JSON.stringify(join(root,'app/mcp-service.cjs'))}),{createOAuthPeer}=require(${JSON.stringify(join(root,'tests/fixtures/oauth-mcp-server.cjs'))});app.setPath('userData',${JSON.stringify(join(dir,'electron'))});
app.whenReady().then(async()=>{
let w,ready=false;const peer=await createOAuthPeer(),opened=[],key=crypto.randomBytes(32),scope={projectId:'p'};
const service=createMcpService({dataDir:${JSON.stringify(dir)},resolveScope:async s=>({...s,projectPath:${JSON.stringify(dir)}}),oauthOptions:{available:()=>true,encrypt:value=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body])},decrypt:bytes=>{const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')},openExternal:async value=>opened.push(value)},onChange:()=>{if(ready&&!w.isDestroyed())void w.webContents.executeJavaScript('ui.update('+JSON.stringify(service.snapshot())+');undefined').catch(()=>{})}});
const saved=await service.dispatch('mcp:integrations:save',{name:'OAuth fixture',transport:'http',url:peer.url,allowInsecureHttp:true,scope,oauth:{clientId:'vek-public-fixture'}});ipcMain.handle('test',(_,a,p)=>service.dispatch(a,p));
w=new BrowserWindow({show:false,width:1180,height:950,webPreferences:{preload:${JSON.stringify(join(dir,'preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await w.loadFile(${JSON.stringify(join(dir,'panel.html'))});const e=code=>w.webContents.executeJavaScript(code);
await e('window.ui=createWiekMcpPanel(document.getElementById("mcp"),bridge.invoke,{projects:[{id:"p",name:"Fixture"}]});window.click=text=>[...document.querySelectorAll("button")].find(b=>b.textContent===text)?.click();ui.update('+JSON.stringify(saved)+');undefined');ready=true;
async function wait(code){for(let i=0;i<100;i++){if(await e(code))return;await new Promise(r=>setTimeout(r,20));}throw new Error('UI wait failed: '+code)}
await e("click('Prepare sign-in');undefined");await wait("document.querySelector('.vm-dialog h2')?.textContent==='Review OAuth sign-in'");assert.equal(opened.length,0);assert.equal(await e("document.querySelector('[name=issuer]').readOnly"),true);assert.equal(await e("document.querySelector('[name=scopes]').value"),'notes:read');
await e("click('Cancel');undefined");await e("click('Cancel sign-in');undefined");await wait("document.body.textContent.includes('OAuth: cancelled')");assert.equal(opened.length,0);
await e("click('Prepare sign-in');undefined");await wait("!!document.querySelector('.vm-dialog')");await e("click('Open sign-in page');undefined");await wait("!document.querySelector('.vm-dialog')&&document.body.textContent.includes('OAuth: authorizing')");assert.equal(opened.length,1);
const grant=new URL(opened[0]);grant.pathname='/grant';const redirect=await fetch(grant,{redirect:'manual'});assert.equal(redirect.status,302);const callback=await fetch(redirect.headers.get('location'));assert.equal(callback.status,200,await callback.text());await wait("document.body.textContent.includes('Signed in with')");
await e("click('Connect');undefined");await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Disconnect')");await e("click('List tools');undefined");await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Run tool')");await e("click('Run tool');document.querySelector('form').requestSubmit();undefined");await wait("document.body.textContent.includes('completed')");const task=service.snapshot().tasks.at(-1);assert.match(task.result.content[0].text,/redacted/);assert.ok(!JSON.stringify(service.snapshot()).includes(peer.tokens[0].access_token));
await e("click('Integrations');click('Sign out');undefined");await wait("[...document.querySelectorAll('button')].some(b=>b.textContent==='Prepare sign-in')");assert.equal(service.snapshot().oauth.credentials.length,0);assert.equal(await e("!document.body.textContent.includes('Signed in with')"),true);
await service.close();await peer.close();console.log(JSON.stringify({ok:true,checks:13,modelCalls:0,externalAccountActions:0}));app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [join(dir, 'main.cjs')], { env, stdio: ['ignore','pipe','pipe'] }); let output = '';
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000); const code = await new Promise(r => child.once('close', r)); clearTimeout(timer); assert.equal(code, 0, output); assert.match(output, /"ok":true/);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

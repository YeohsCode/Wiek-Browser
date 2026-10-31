import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const electron=createRequire(import.meta.url)('electron'),root=resolve(import.meta.dirname,'..');
test('HTTP MCP configuration works through actual Electron IPC with reference-only credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vek-http-panel-')),html=join(dir,'panel.html'),preload=join(dir,'preload.cjs'),script=join(dir,'main.cjs');try{
 await writeFile(preload,"const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testMcp',{invoke:(name,p)=>ipcRenderer.invoke('test-mcp',name,p)});");
 await writeFile(html,`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(root,'app/mcp-panel.css'))}"><main id="panel"></main><script src="${pathToFileURL(join(root,'app/mcp-panel.js'))}"></script>`);
 await writeFile(script,`
const{app,BrowserWindow,ipcMain}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs');const{createMcpService}=require(${JSON.stringify(join(root,'app/mcp-service.cjs'))});app.setPath('userData',${JSON.stringify(join(dir,'electron'))});
app.whenReady().then(async()=>{const service=createMcpService({dataDir:${JSON.stringify(dir)},resolveScope:async scope=>({...scope,projectPath:${JSON.stringify(dir)}})});ipcMain.handle('test-mcp',(_,name,p)=>service.dispatch(name,p));const w=new BrowserWindow({show:false,width:1080,height:850,webPreferences:{preload:${JSON.stringify(preload)},sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await w.loadFile(${JSON.stringify(html)});const e=code=>w.webContents.executeJavaScript(code);let assertions=0;
await e("window.ui=createVekMcpPanel(document.getElementById('panel'),testMcp.invoke,{projects:[{id:'p',name:'Fixture project'}]});window.clickText=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text)?.click();window.fill=(name,value)=>{const i=document.querySelector('[name='+name+']');i.value=value;i.dispatchEvent(new Event('input'))};clickText('Add HTTP server');undefined");assert.equal(await e("document.querySelector('.vm-dialog h2').textContent"),'Add an HTTP MCP server');assertions++;
await e("fill('name','HTTP fixture');fill('url','http://127.0.0.1:9000/mcp');fill('headerRefs',JSON.stringify({Authorization:'literal-secret'}));document.querySelector('form').requestSubmit();new Promise(r=>setTimeout(r,40))");assert.match(await e("document.querySelector('.vm-error').textContent"),/HTTPS|loopback/);assertions++;
await e("fill('allowInsecureHttp','true');document.querySelector('form').requestSubmit();new Promise(r=>setTimeout(r,40))");assert.match(await e("document.querySelector('.vm-error').textContent"),/env:VARIABLE/);assertions++;
await e("fill('headerRefs',JSON.stringify({Authorization:'env:FIXTURE_AUTH'}));document.querySelector('form').requestSubmit();new Promise(r=>setTimeout(r,40))");const config=service.snapshot().integrations[0];assert.equal(config.transport,'http');assertions++;assert.equal(config.headerRefs.Authorization,'env:FIXTURE_AUTH');assertions++;assert.equal(await e("document.querySelector('.vm-command').textContent"),'HTTP · http://127.0.0.1:9000/mcp');assertions++;assert.equal(await e("document.querySelector('.vm-dialog')===null"),true);assertions++;
await e("clickText('Configure');undefined");assert.equal(await e("document.querySelector('[name=url]').value"),'http://127.0.0.1:9000/mcp');assertions++;await e("clickText('Cancel')");await new Promise(r=>setTimeout(r,250));fs.writeFileSync(${JSON.stringify(join(root,'reports/mcp-http-panel.png'))},(await w.webContents.capturePage()).toPNG());await service.close();console.log(JSON.stringify({ok:true,assertions,screenshot:'reports/mcp-http-panel.png'}));app.quit();}).catch(error=>{console.error(error);app.exit(1)});
`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[script],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{output+=chunk});const timeout=setTimeout(()=>child.kill('SIGKILL'),20000);const code=await new Promise(resolve=>child.once('close',resolve));clearTimeout(timeout);await writeFile(join(root,'reports/mcp-http-panel-test.log'),output);assert.equal(code,0,output);assert.match(output,/"assertions":8/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

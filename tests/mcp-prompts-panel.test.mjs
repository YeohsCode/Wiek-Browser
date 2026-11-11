import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const electron=createRequire(import.meta.url)('electron'),root=process.env.WIEK_MCP_APP_ROOT||resolve(import.meta.dirname,'..'),peer=resolve(import.meta.dirname,'fixtures/modern-stdio-mcp.cjs');
test('modern stdio and prompt preview operate through real Electron IPC without executing server text',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wiek-prompts-panel-'));
 try{
  await writeFile(join(dir,'preload.cjs'),"const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('bridge',{invoke:(a,p)=>ipcRenderer.invoke('fixture',a,p),onState:fn=>ipcRenderer.on('state',(_,s)=>fn(s))});");
  await writeFile(join(dir,'panel.html'),`<!doctype html><meta charset="utf-8"><main id="root"></main><script src="${pathToFileURL(join(root,'app/mcp-panel.js'))}"></script>`);
  await writeFile(join(dir,'main.cjs'),`
const{app,BrowserWindow,ipcMain}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs'),{createMcpService}=require(${JSON.stringify(join(root,'app/mcp-service.cjs'))});
app.setPath('userData',${JSON.stringify(join(dir,'electron'))});let service,w;
app.whenReady().then(async()=>{const scope={projectId:'p'};let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++};
service=createMcpService({dataDir:${JSON.stringify(dir)},resolveScope:async s=>({...s,projectPath:${JSON.stringify(dir)}}),onChange:s=>{if(w&&!w.isDestroyed())w.webContents.send('state',s);}});
await service.dispatch('mcp:integrations:save',{name:'Modern local fixture',scope,command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(peer)}],protocolVersion:'2026-07-28'});const id=service.snapshot().integrations[0].id;
ipcMain.handle('fixture',(_,action,payload)=>service.dispatch(action,payload));w=new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{preload:${JSON.stringify(join(dir,'preload.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
await w.loadFile(${JSON.stringify(join(dir,'panel.html'))});const e=code=>w.webContents.executeJavaScript(code),wait=async code=>{for(let i=0;i<300;i++){if(await e(code))return;await new Promise(r=>setTimeout(r,10));}throw Error('Panel condition timed out: '+code);};
await e('window.ui=createWiekMcpPanel(document.getElementById("root"),bridge.invoke,{projects:[{id:"p",name:"Fixture"}]});bridge.onState(s=>ui.update(s));window.click=text=>[...document.querySelectorAll("button")].find(b=>b.textContent===text&&!b.disabled)?.click();undefined');
await e('ui.update('+JSON.stringify(service.snapshot())+');click("Configure");undefined');await wait('!!document.querySelector("select[name=protocolVersion]")');eq(await e('document.querySelector("select[name=protocolVersion]").value'),'2026-07-28');await e('click("Save / continue");undefined');await wait('!document.querySelector("form[role=dialog]")');eq(service.snapshot().integrations[0].protocolVersion,'2026-07-28');
await e('click("Connect");undefined');await wait('document.body.textContent.includes("connected")&&!![...document.querySelectorAll("summary")].find(b=>b.textContent==="Prompts")');eq(service.snapshot().connections[0].serverInfo.name,'Modern stdio fixture');eq(service.snapshot().connections[0].notificationStreams.activeStreams,0);
await e('[...document.querySelectorAll("details")].find(d=>d.querySelector("summary")?.textContent==="Prompts").open=true;click("List prompts");undefined');await wait('[...document.querySelectorAll("button")].filter(b=>b.textContent==="Preview prompt").length===2');eq(await e('document.getElementById("untrusted")===null'),true);
await e('click("Preview prompt");undefined');await wait('!!document.querySelector("textarea[name=arguments]")');await e('click("Read prompt");undefined');await wait('document.body.textContent.includes("arguments do not match")');
await e('const input=document.querySelector("textarea[name=arguments]");input.value=JSON.stringify({subject:"Reviewed subject"});input.dispatchEvent(new Event("input"));click("Read prompt");undefined');await wait('!!document.querySelector("textarea[name=messages]")');eq(await e('document.querySelector("textarea[name=messages]").readOnly'),true);eq(await e('document.querySelector("textarea[name=messages]").value.includes("PRIVATE_PROMPT")'),true);eq(await e('typeof window.promptExecuted'),'undefined');eq(service.snapshot().tasks.length,0);eq(fs.readFileSync(${JSON.stringify(join(dir,'mcp/state.json'))},'utf8').includes('PRIVATE_PROMPT'),false);
await e('click("Done");click("Watch list changes");undefined');await wait('document.body.textContent.includes("List updates: subscribed")');eq(service.snapshot().connections[0].notificationStreams.lists.notifications.promptsListChanged,true);
const task=await service.dispatch('mcp:tools:call',{integrationId:id,scope,name:'control',arguments:{action:'emit',method:'notifications/prompts/list_changed'}});await service.dispatch('mcp:tasks:wait',{id:task.id,scope,timeoutMs:3000});await wait('[...document.querySelectorAll("button")].filter(b=>b.textContent==="Preview prompt").length===0');eq(service.snapshot().connections[0].prompts,null);
await e('click("Stop watching lists");undefined');await wait('document.body.textContent.includes("List updates: off")');eq(service.snapshot().connections[0].notificationStreams.activeStreams,0);
await e('click("Disconnect");undefined');await wait('document.body.textContent.includes("disconnected")');eq(service.snapshot().connections.length,0);
console.log(JSON.stringify({ok:true,checks,actualElectronIPC:true,realStdioPeer:true,inertPromptPreview:true,modelCalls:0,accountActions:0}));await service.close();w.destroy();app.exit(0);
}).catch(async error=>{console.error(error);await service?.close();app.exit(1);});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[join(dir,'main.cjs')],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),25000),code=await new Promise(resolve=>child.once('close',resolve));clearTimeout(timer);assert.equal(code,0,output);assert.match(output,/"ok":true/);process.stdout.write(output.split('\n').filter(line=>line.startsWith('{')).join('\n')+'\n');
 }finally{await rm(dir,{recursive:true,force:true});}
});

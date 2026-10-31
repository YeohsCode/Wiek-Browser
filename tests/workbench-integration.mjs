#!/usr/bin/env node
// End-to-end workbench test through the real host's authenticated loopback API.
// Only synthetic providers, disposable local files and loopback pages are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
const dataDir = path.resolve(process.env.VEK_DATA_DIR || 'data/workbench-e2e');
const cli = path.resolve(process.env.VEK_WORKBENCH_CLI || 'cli/vek-browser.mjs');
execFileSync(process.execPath,[cli,'start'],{env:{...process.env,VEK_DATA_DIR:dataDir},stdio:'pipe'});
const runtime = JSON.parse(await fs.readFile(path.join(dataDir,'runtime.json'),'utf8'));
const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/rpc?token=${encodeURIComponent(runtime.token)}`);
await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
let seq=0,checks=0,cdpId=0; const pending=new Map(),cdpPending=new Map();
socket.on('message',raw=>{ const msg=JSON.parse(String(raw));if(msg.event==='cdp'){const response=JSON.parse(msg.payload),waiting=cdpPending.get(response.id);if(waiting){cdpPending.delete(response.id);clearTimeout(waiting.timer);response.error?waiting.reject(new Error(response.error.message)):waiting.resolve(response.result);}return;}const p=pending.get(msg.id); if(!p)return; pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result); });
const rpc=(method,args=[],spaceId)=>new Promise((resolve,reject)=>{ const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RPC timeout: ${method}`));},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,args,...(spaceId!==undefined?{spaceId}:{})})); });
const action=async(name,payload={})=>{try{return await rpc('workbenchAction',[name,payload]);}catch(failure){failure.message=`${name}: ${failure.message}`;throw failure;}};
const cdp=(spaceId,method,params={})=>new Promise((resolve,reject)=>{const id=++cdpId,timer=setTimeout(()=>{cdpPending.delete(id);reject(new Error(`CDP timeout ${method}`));},10000);cdpPending.set(id,{resolve,reject,timer});void rpc('sendCDPMessage',[JSON.stringify({id,method,params})],spaceId).catch(reject);});
const check=(condition,message)=>{ assert.ok(condition,message); checks++; };
async function waitThread(id) { const limit=Date.now()+20000; while(Date.now()<limit) { const t=await action('agents:threads:read',{id});if(!['running','queued'].includes(t.status))return t;await new Promise(r=>setTimeout(r,40)); } throw new Error('Thread did not complete'); }
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'vek-workbench-e2e-'));
const downloadBytes=Buffer.alloc(2*1024*1024,77);
const web=http.createServer((req,res)=>{
  if(req.url==='/slow-download'){
    const offset=Number(req.headers.range?.match(/^bytes=(\d+)-$/)?.[1]||0);
    res.writeHead(offset?206:200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="pause-resume-fixture.bin"','Content-Length':downloadBytes.length-offset,'Accept-Ranges':'bytes','ETag':'"vek-fixture-v1"','Last-Modified':'Tue, 01 Sep 2026 00:00:00 GMT',...(offset?{'Content-Range':`bytes ${offset}-${downloadBytes.length-1}/${downloadBytes.length}`}:{})});
    let cursor=offset;const timer=setInterval(()=>{if(cursor>=downloadBytes.length){clearInterval(timer);res.end();return;}res.write(downloadBytes.subarray(cursor,cursor+16384));cursor+=16384;},25);res.on('close',()=>clearInterval(timer));return;
  }
  res.setHeader('Content-Type','text/html');res.end('<h1>Scoped local fixture</h1><input aria-label="Name"><button onclick="document.querySelector(\'h1\').textContent=\'Hi \'+document.querySelector(\'input\').value">Apply</button>');});
await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${web.address().port}/`;
let projectId,providerId;
try {
  await fs.writeFile(path.join(directory,'note.txt'),'before\n');
  let snapshot=await action('agents:projects:create',{name:'Workbench fixture',path:directory});projectId=snapshot.projects.at(-1).id;
  const before=await action('workspace:read',{projectId,path:'note.txt'});check(before.content==='before\n','workspace reads real file');
  await action('workspace:write',{projectId,path:'note.txt',content:'after\n',expectedHash:before.hash});
  check((await fs.readFile(path.join(directory,'note.txt'),'utf8'))==='after\n','workspace writes real file');
  await assert.rejects(action('workspace:write',{projectId,path:'note.txt',content:'stale\n',expectedHash:before.hash}),/conflict|changed/i);checks++;
  await assert.rejects(action('workspace:read',{projectId,path:'../outside'}));checks++;
  execFileSync('git',['init','-q',directory]);execFileSync('git',['-C',directory,'config','user.name','Vek fixture']);execFileSync('git',['-C',directory,'config','user.email','fixture@localhost']);execFileSync('git',['-C',directory,'add','--','note.txt']);execFileSync('git',['-C',directory,'commit','-qm','Local fixture']);
  const checkpoint=(await action('workspace:git:checkpoint:create',{projectId,name:'Host fixture'})).checkpoint;
  const note=await action('workspace:read',{projectId,path:'note.txt'});await action('workspace:write',{projectId,path:'note.txt',content:'changed after checkpoint\n',expectedHash:note.hash});
  const checkpointPreview=await action('workspace:git:checkpoint:preview',{projectId,id:checkpoint.id});check(checkpointPreview.changes.some(row=>row.path==='note.txt'),'host checkpoint preview describes actual local file change');
  await action('workspace:git:checkpoint:restore',{projectId,id:checkpoint.id,expectedState:checkpointPreview.expectedState,confirm:true});
  check(await fs.readFile(path.join(directory,'note.txt'),'utf8')==='after\n','host checkpoint restores real worktree bytes');
  check((await action('workspace:git:checkpoint:list',{projectId})).checkpoints.length===2,'host checkpoint preserves the pre-restore protection snapshot');
  const fake=path.join(directory,'provider.cjs');
  await fs.writeFile(fake,`const {spawnSync}=require('node:child_process');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!input.includes('Vek Browser with a local browser automation CLI'))process.exit(8);const source="const task=await taskSpace('agent-"+process.env.VEK_THREAD_ID+"');const page=task.page('p1');await page.goto("+JSON.stringify(${JSON.stringify(url)})+");await page.fill('input[aria-label=Name]','Vek');await page.click('button');console.log(await page.evaluate(()=>document.querySelector('h1').textContent));";const r=spawnSync(${JSON.stringify(process.execPath)},[process.env.VEK_BROWSER_CLI,'nodejs','-e',source],{env:process.env,encoding:'utf8',timeout:15000});if(r.status!==0){process.stderr.write(r.stderr||'CLI failed');process.exit(9);}console.log(r.stdout.trim());});`);
  snapshot=await action('agents:providers:configure',{name:'Fixture CLI',command:process.execPath,args:[fake],inputMode:'stdin'});providerId=snapshot.providers.at(-1).id;
  snapshot=await action('agents:threads:create',{projectId,providerId,title:'Fixture conversation'});const threadId=snapshot.threads.at(-1).id;
  await action('agents:threads:prompt',{id:threadId,prompt:'Run the synthetic browser test.'});
  let thread=await waitThread(threadId);check(thread.status==='completed','provider completes');check(thread.messages.some(m=>m.role==='assistant'&&m.content.includes('Hi Vek')),'provider actually calls Vek SDK using injected context');
  await action('agents:threads:pin',{id:threadId});await action('agents:threads:archive',{id:threadId});thread=await action('agents:threads:read',{id:threadId});check(thread.pinned&&thread.archived,'thread organization persists');
  await action('agents:threads:unarchive',{id:threadId});
  const catalog=await action('catalog:list',{projectId});check(Array.isArray(catalog.entries),'installed instruction catalog available');
  const pairing=await action('mcp:pairing:create',{name:'Browser integration fixture',scope:{projectId,threadId},browserMethods:['listTabs','createTab','navigate','snapshot']});
  const exchange=await fetch(pairing.exchangeUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:pairing.code})});
  const grant=await exchange.json();check(exchange.status===200&&Boolean(grant.token),'scoped pairing exchange');
  const endpoint=pairing.exchangeUrl.replace(/\/pair$/,'/mcp');let mid=0;
  async function mcp(method,params={}){const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${grant.token}`},body:JSON.stringify({jsonrpc:'2.0',id:++mid,method,params})});return res.json();}
  const inventory=await mcp('tools/list');check(inventory.result.tools.some(t=>t.name==='browser.snapshot'),'gateway exposes scoped browser tools');
  const created=await mcp('tools/call',{name:'browser.createTab',arguments:{url}});
  const task=JSON.parse(created.result.content[0].text);check(task.status==='completed'&&task.result.targetId,'MCP creates a real browser tab');
  const scopedState=await rpc('getState');const scopedSpace=scopedState.spaces.find(s=>s.name===`Agent ${threadId}`);check(Boolean(scopedSpace),'MCP browser Space is bound to thread');
  const stateTabs=await rpc('listTabs',[],scopedSpace.id);check(stateTabs.tabs.some(t=>t.targetId===task.result.targetId),'MCP tab exists in correct Space');
  const externalSpace=scopedState.spaces.find(s=>s.id!==scopedSpace.id);await rpc('claimTaskSpace',[externalSpace.id]);const foreignTabs=await rpc('listTabs',[],externalSpace.id);
  const rejected=await mcp('tools/call',{name:'browser.navigate',arguments:{targetId:foreignTabs.tabs[0].targetId,url}});check(rejected.result.isError===true,'MCP cannot navigate another Space target');
  await rpc('handOffTaskSpace',[],scopedSpace.id);
  const handedOff=await mcp('tools/call',{name:'browser.createTab',arguments:{url}});check(handedOff.result.isError===true,'manual handoff blocks scoped MCP mutation');
  await action('mcp:grants:revoke',{id:grant.grantId||grant.id});
  const denied=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${grant.token}`},body:JSON.stringify({jsonrpc:'2.0',id:999,method:'tools/list'})});check(denied.status===401||denied.status===403,'revoked gateway access rejected');
  // Exercise browser-native feature wiring through the same real host.
  let features=await action('space:create',{name:'Native feature fixture',profileId:'Default'});const featureSpace=features.selectedSpaceId;
  await action('navigate',url);
  await action('preferences:update',{theme:'dark',tabLayout:'vertical'});
  features=await rpc('getState');check(features.darkMode&&features.chromeBounds.x===410&&features.chromeBounds.y===64,'theme and real viewport layout wired');
  await rpc('claimTaskSpace',[featureSpace]);
  // Only query native permission state or explicitly block requests. No camera,
  // microphone, location service, system notification or clipboard is accessed.
  const permissionState=async(spaceId=featureSpace)=> (await cdp(spaceId,'Runtime.evaluate',{expression:"navigator.permissions.query({name:'notifications'}).then(p=>p.state)",awaitPromise:true,returnByValue:true})).result.value;
  await action('permissions:set',{origin:url,permission:'notifications',decision:'allow'});
  check(await permissionState()==='granted','real Chromium permission check observes saved per-site allow');
  await action('permissions:set',{origin:url,permission:'notifications',decision:'block'});
  check(await permissionState()==='denied','real Chromium permission check observes saved per-site block');
  const blockedRequest=(await cdp(featureSpace,'Runtime.evaluate',{expression:'Notification.requestPermission()',awaitPromise:true,returnByValue:true})).result.value;
  check(blockedRequest==='denied','real Chromium request is blocked without a native dialog');
  const permissionRules=await action('permissions:snapshot');check(permissionRules.rules.some(rule=>rule.origin===new URL(url).origin&&rule.permission==='notifications'&&rule.decision==='block'),'host stores canonical origin rules');
  await action('permissions:set',{origin:url,permission:'notifications',decision:'ask'});
  check(!(await action('permissions:snapshot')).rules.some(rule=>rule.origin===new URL(url).origin&&rule.permission==='notifications'),'reset removes persistent decision');
  await assert.rejects(action('permissions:set',{origin:'file:///tmp/invalid',permission:'camera',decision:'allow'}));checks++;
  await action('space:finish');
  await action('bookmark:add');
  const otherProfile=(await action('profile:create','Isolated fixture')).profiles.at(-1).id;
  const otherSpace=(await action('space:create',{name:'Other profile fixture',profileId:otherProfile})).selectedSpaceId;
  let isolated=await rpc('getState');check(!isolated.bookmarks.some(row=>row.url===url)&&!isolated.history.some(row=>row.url===url),'bookmark and history UI isolate profiles');
  await action('permissions:set',{origin:url,permission:'notifications',decision:'block'});
  await action('history:clear');await action('space:select',featureSpace);
  isolated=await rpc('getState');check(isolated.bookmarks.some(row=>row.url===url)&&isolated.history.some(row=>row.url===url),'clearing another profile preserves current profile data');
  check(!(await action('permissions:snapshot')).rules.some(rule=>rule.origin===new URL(url).origin),'another profile permission cannot leak into the selected profile');
  await rpc('workbenchAction',['permissions:set',{origin:url,permission:'geolocation',decision:'block'}],otherSpace);
  check(!(await action('permissions:snapshot')).rules.some(rule=>rule.permission==='geolocation'),'explicit RPC Space permissions do not mutate the UI-selected profile');
  check((await rpc('getState',[],otherSpace)).sitePermissions.rules.some(rule=>rule.permission==='geolocation'&&rule.decision==='block'),'explicit RPC state reads use the scoped profile');
  await action('space:select',otherSpace);await action('space:close');await action('space:select',featureSpace);
  await rpc('claimTaskSpace',[featureSpace]);await cdp(featureSpace,'Page.setDownloadBehavior',{behavior:'allow',downloadPath:directory});
  await cdp(featureSpace,'Runtime.evaluate',{expression:`Object.assign(document.createElement('a'),{href:${JSON.stringify(url+'slow-download')}}).click()`});
  async function waitDownload(predicate){const deadline=Date.now()+10000;while(Date.now()<deadline){const row=(await rpc('getState')).downloads.find(d=>d.name==='pause-resume-fixture.bin');if(row&&predicate(row))return row;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Download fixture did not reach expected state');}
  const live=await waitDownload(row=>row.received>0&&row.state==='progressing');await action('download:pause',{id:live.id});
  check((await rpc('getState')).downloads.find(d=>d.id===live.id)?.paused,'native download reports paused state');
  await new Promise(resolve=>setTimeout(resolve,150));const paused=(await rpc('getState')).downloads.find(d=>d.id===live.id);await new Promise(resolve=>setTimeout(resolve,200));
  check((await rpc('getState')).downloads.find(d=>d.id===live.id).received===paused.received,'paused download stops advancing received bytes');
  await action('download:resume',{id:live.id});const completed=await waitDownload(row=>row.state==='completed');
  // Page.setDownloadBehavior owns the destination and can leave Electron's
  // DownloadItem savePath empty; verify the actual path configured above.
  check((await fs.readFile(path.join(directory,completed.name))).equals(downloadBytes),'resumed native download produces the complete real fixture file');
  await action('space:finish');
  await assert.rejects(action('preferences:shortcuts:set',{action:'newTab',accelerator:'CommandOrControl+C'}),/Copy|conflict/);checks++;
  await action('panel',true);const screenshot=await action('library:capture');check(screenshot.width>0&&screenshot.height>0&&Buffer.from(screenshot.base64,'base64').subarray(1,4).toString()==='PNG','real page PNG capture');
  const library=await action('library:items:create',{kind:'image',pngBase64:screenshot.base64,title:'Captured fixture',url});check(library.items.some(item=>item.kind==='image'&&item.title==='Captured fixture'),'captured image is persisted in Library');
  const savedPage=await action('library:save-active');check(savedPage.items.some(item=>item.kind==='page'&&item.url===url),'active page is saved separately from bookmarks');
  await action('panel',false);const beforeDetach=(await rpc('listTaskSpaces')).taskSpaces.find(s=>s.id===featureSpace);check(Boolean(beforeDetach),'feature Space exists');
  await action('space:open-window',featureSpace);check((await rpc('getState')).spaces.find(s=>s.id===featureSpace).detached,'Space opens in its own native window');
  await action('space:attach-window',featureSpace);await action('space:select',featureSpace);check(!(await rpc('getState')).spaces.find(s=>s.id===featureSpace).detached,'Space returns to main native window');
  await action('space:pin',{id:featureSpace,pinned:true});await action('spaces:close',{ids:[featureSpace]});check((await rpc('getState')).spaces.some(s=>s.id===featureSpace),'bulk close preserves pinned Spaces by default');
  await action('spaces:close',{ids:[featureSpace],includePinned:true});let afterClose=await rpc('getState');const closed=afterClose.closedSpaces.find(s=>s.name==='Native feature fixture');check(Boolean(closed),'closed Space retains restore metadata');await action('space:restore',closed.id);check((await rpc('getState')).spaces.some(s=>s.name==='Native feature fixture'&&s.ownership==='user'),'closed Space restores as a personal Space');
  const voice=await action('voice:snapshot');check(voice.configured&&voice.config.command.includes('app/bin/whisper-cli'),'bundled local transcription is configured');
  const wav=await fs.readFile(path.resolve('downloads/voice/jfk.wav'));const transcribed=await action('voice:transcribe',{base64:wav.toString('base64'),mime:'audio/wav'});check(/fellow Americans/i.test(transcribed.text)&&/country can do/i.test(transcribed.text),'real host locally transcribes public audio');
  const restoredState=await rpc('getState'),restoredSpace=restoredState.selectedSpaceId;await rpc('claimTaskSpace',[restoredSpace]);
  const recording=await action('recorder:start',{name:'Real trusted input fixture'});const recordingId=recording.activeSessionId;
  await new Promise(resolve=>setTimeout(resolve,100));
  await cdp(restoredSpace,'Runtime.evaluate',{expression:"document.querySelector('button').click()"});
  await new Promise(resolve=>setTimeout(resolve,70));check((await action('recorder:read',{id:recordingId})).events.length===0,'untrusted page-script click is excluded from recording');
  const point=(await cdp(restoredSpace,'Runtime.evaluate',{expression:"(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",returnByValue:true})).result.value;
  await cdp(restoredSpace,'Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp(restoredSpace,'Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  let recorded;for(let i=0;i<100;i++){recorded=await action('recorder:read',{id:recordingId});if(recorded.events.length)break;await new Promise(resolve=>setTimeout(resolve,30));}
  check(recorded.events.length===1&&recorded.events[0].kind==='click'&&recorded.events[0].screenshotStatus==='captured','trusted native input records actual geometry and screenshot');await action('recorder:stop');
  await action('preferences:update',{theme:'light',tabLayout:'horizontal'});
  console.log(JSON.stringify({passed:true,checks,hostVersion:scopedState.version,paidModelCalls:0,externalAccountActions:0},null,2));
} finally {
  // Shut the disposable host down before removing any fixture it may watch.
  try { await rpc('shutdown'); } catch {}
  socket.close();for(const p of [...pending.values(),...cdpPending.values()])clearTimeout(p.timer);
  await new Promise(resolve=>web.close(resolve));await fs.rm(directory,{recursive:true,force:true});
}

#!/usr/bin/env node
// Standalone real Chromium probe. Uses this checkout's installed Electron,
// independent temporary user data, and only a local HTTP fixture.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'vek-snapshot-probe-'));
const entry = join(directory, 'probe.cjs');
const code = "const {app, BrowserWindow} = require('electron');\nconst http=require('node:http');\nconst {snapshotPage}=require(process.env.VEK_SNAPSHOT_MODULE);\nconst assert=require('node:assert/strict');\napp.setPath('userData', process.env.VEK_PROBE_DATA_DIR);\napp.commandLine.appendSwitch('site-per-process');\napp.whenReady().then(async()=>{\nconst server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url==='/frame') res.end('<body><h2>Child document</h2><button id=\"child\">Child action</button><input aria-label=\"Child field\">');else res.end(`<body><h1>Snapshot heading</h1><button aria-label=\"Increment counter\" id=\"button\">Click counter</button><a href=\"/same\">Duplicate1</a><a href=\"/same\">Duplicate2</a><a href=\"/unique\">Unique</a><div id=\"shadow\"></div><iframe src=\"/frame\" title=\"same\"></iframe><iframe src=\"http://127.0.0.1:${server.address().port}/frame\" title=\"cross\"></iframe><div style=\"height:3000px\"></div><button id=\"offscreen\">Offscreen button</button><script>document.querySelector(\"#shadow\").attachShadow({mode:\"open\"}).innerHTML=String.fromCharCode(60)+'input aria-label=\\\"Shadow field\\\"'+String.fromCharCode(62);</script>`);});\nawait new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));\nconst win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{sandbox:true}});\nawait win.loadURL(`http://localhost:${server.address().port}/`);\nconst d=win.webContents.debugger;d.attach('1.3');\nconst send=async(method,params={},sid)=>d.sendCommand(method,params,sid);\ntry{\nconst targetId=(await send('Target.getTargetInfo')).targetInfo.targetId;\n\nconst all=await snapshotPage({sendCDP:send,targetId,options:{scope:'full_page',includeStableLocator:true}});\nconsole.log(JSON.stringify({scope:'full_page',refCount:all.refs.length,frameRefs:all.refs.filter(x=>x.frameId).length}));\nassert(all.content.includes('Snapshot heading'));\nassert(all.content.includes('Shadow field'));\nassert.equal((all.content.match(/Child document/g)||[]).length,4);\nassert(all.content.includes('loc=href:/unique'));\nassert(!all.content.split('\\n').filter(x=>x.includes('url=\"/same\"')).some(x=>x.includes('loc=')));\nconst child=all.refs.find(x=>x.role==='button'&&x.frameId);\nassert(child);\nassert.equal((await send('DOM.describeNode',{backendNodeId:child.backendNodeId},child.sessionId)).node.nodeName,'BUTTON');\nawait send('Runtime.evaluate',{expression:\"document.querySelectorAll('iframe').forEach(x=>x.remove())\"});\nconst button=all.refs.find(x=>x.name==='Increment counter');\nconst subtree=await snapshotPage({sendCDP:send,targetId,options:{scope:'subtree',root:button.backendNodeId}});\nassert(subtree.content.includes('Click counter'));\nassert(!subtree.content.includes('Snapshot heading'));\nconst viewport=await snapshotPage({sendCDP:send,targetId,options:{scope:'only_within_viewport'}});\nassert(!viewport.content.includes('Offscreen button'));\nconsole.log('SNAPSHOT_SMOKE_PASS');\n}catch(e){console.error(e);process.exitCode=1;}finally{server.close();win.destroy();app.exit(process.exitCode || 0);}\n});\n";
try {
  await writeFile(entry, code);
  const executable = process.env.VEK_ELECTRON_PATH || require('electron');
  const child = spawn(executable, [entry], { stdio: 'inherit', env: { ...process.env, VEK_SNAPSHOT_MODULE: join(root, 'app/snapshot.cjs'), VEK_PROBE_DATA_DIR: join(directory, 'profile') } });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code ?? 1)); });
  process.exitCode = status;
} finally {
  await rm(directory, { recursive: true, force: true });
}

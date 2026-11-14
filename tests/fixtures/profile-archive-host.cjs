'use strict';
// Real application/IPC/renderer; only OS file/confirmation dialogs are injected.
const {app,dialog,webContents}=require('electron'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=process.env.VEK_STORAGE_APP_ROOT||path.resolve(__dirname,'../..'),file=path.join(process.env.VEK_DATA_DIR,'synthetic.vek-profile.json');let window,openCancelled=false,saveCancelled=false,answer=1,confirmations=0,requests=[];
dialog.showSaveDialog=async()=>({canceled:saveCancelled,filePath:saveCancelled?undefined:file});dialog.showOpenDialog=async()=>({canceled:openCancelled,filePaths:openCancelled?[]:[file]});dialog.showMessageBox=async(_w,options)=>{assert.equal(options.title,'Import browser profile');assert.match(options.detail,/1 local storage origins and 2 tab sessions/);confirmations++;return{response:answer}};
const server=http.createServer((req,res)=>{requests.push(req.url);res.setHeader('Content-Type','text/html; charset=utf-8');res.end(String.raw`<!doctype html><script>
window.before={local:localStorage.getItem("shared"),session:sessionStorage.getItem("tab")};
const seed=new URL(location.href).searchParams.get("seed");
if(seed){localStorage.setItem("shared","host shared");sessionStorage.setItem("tab",seed);}
window.dbBefore=null;
window.idbReady=(async()=>{
  const open=()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('Host portable',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('rows',{autoIncrement:true});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  if((await indexedDB.databases()).some(db=>db.name==='Host portable')){
    const db=await open();
    window.dbBefore=await new Promise((resolve,reject)=>{
      const tx=db.transaction('rows','readwrite'),store=tx.objectStore('rows');
      const saved=store.get('saved'),next=store.add('probe');
      let rolledBack=false;
      next.onsuccess=()=>{tx.abort();rolledBack=true;};
      tx.onabort=()=>rolledBack?resolve({saved:saved.result,next:next.result}):reject(tx.error);
    });
    db.close();
  }
  if(seed){
    const db=await open();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('rows','readwrite'),store=tx.objectStore('rows');
      store.put('host indexed','saved');
      store.put('deleted',75);store.delete(75);
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    });
    db.close();
  }
})();
</script><h1>Host archive fixture</h1>`);});
app.on('browser-window-created',(_event,w)=>{if(window)return;window=w;w.webContents.once('did-finish-load',()=>void run().catch(e=>{console.error(e);app.exit(1)}));});
async function run(){let checks=0;const equal=(a,b)=>{assert.deepEqual(a,b);checks++},e=code=>window.webContents.executeJavaScript(code),action=(name,value)=>e('vek.action('+JSON.stringify(name)+','+JSON.stringify(value)+')'),state=()=>e('vek.state()'),wait=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,15));}throw new Error('host fixture wait timed out')};await wait(async()=> (await state()).spaces.length>0);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 await action('navigate',origin+'/older');await action('navigate',origin+'/fixture?seed=one');await action('navigate',origin+'/newer');await action('back');await wait(()=>webContents.getAllWebContents().some(w=>w.getURL()===origin+'/fixture?seed=one'&&!w.isLoading()));await action('tab:new',{});await action('navigate',origin+'/fixture?seed=two');await wait(()=>{const rows=webContents.getAllWebContents().filter(w=>w.getURL().startsWith(origin+'/fixture'));return rows.length===2&&rows.every(w=>!w.isLoading());});const source=(await state()),sourceId=source.profiles[0].id,sourceSpaceId=source.selectedSpaceId;
 await Promise.all(webContents.getAllWebContents().filter(w=>w.getURL().startsWith(origin+'/fixture')).map(w=>w.executeJavaScript('idbReady')));
 equal((await Promise.all(webContents.getAllWebContents().filter(w=>w.getURL().startsWith(origin+'/fixture')).map(w=>w.executeJavaScript('sessionStorage.getItem("tab")')))).sort(),['one','two']);
 await e('window.archivePromise=vek.action("profile:file:export",{includeWebStorage:true,includeIndexedDB:true});undefined');await wait(()=>e('!!document.querySelector("input[aria-label=\\\"Confirm archive passphrase\\\"]")'));
 await assert.rejects(action('profile:file:export',{}),/already running/);checks++;
 const unlock=async cancel=>{await wait(()=>e('!!document.querySelector("input[aria-label=\\\"Profile archive passphrase\\\"]")'));await e(cancel?'document.querySelector(".modal:not([hidden]) .dialog button[type=button]").click();undefined':'[...document.querySelectorAll(".modal input[type=password]")].forEach(i=>i.value="public host fixture passphrase");document.querySelector(".modal:not([hidden]) form").requestSubmit();undefined');};
 await unlock(false);const exported=await e('archivePromise');equal(exported.profileArchiveResult.counts.localStorageOrigins,1);equal(exported.profileArchiveResult.counts.sessionStorageTabs,2);equal(exported.profileArchiveResult.counts.indexedDBDatabases,1);equal(exported.profileArchiveResult.counts.indexedDBSkippedDatabases,0);equal((fs.statSync(file).mode&0o777),0o600);equal(fs.readFileSync(file,'utf8').includes('host shared'),false);
 const exportedPayload = (await require(path.join(root,'app/profile-archive.cjs')).createProfileArchive().decode(fs.readFileSync(file),'public host fixture passphrase')).payload;
 equal(exportedPayload.spaces[0].tabs[0].navigation?.entries.map(entry=>entry.url), [origin+'/older',origin+'/fixture?seed=one',origin+'/newer']);
 const profileCount=(await state()).profiles.length,loaded=()=>requests.filter(v=>v.startsWith('/fixture')).length,loadedBefore=loaded();
 openCancelled=true;await action('profile:file:import',{});openCancelled=false;equal((await state()).profiles.length,profileCount);
 await e('window.archivePromise=vek.action("profile:file:import",{});undefined');await unlock(true);await e('archivePromise');equal((await state()).profiles.length,profileCount);equal(confirmations,0);
 answer=0;await e('window.archivePromise=vek.action("profile:file:import",{});undefined');await unlock(false);await e('archivePromise');equal((await state()).profiles.length,profileCount);equal(loaded(),loadedBefore);equal(confirmations,1);
 answer=1;await e('window.archivePromise=vek.action("profile:file:import",{restoreTabs:false});undefined');await unlock(false);const closed=await e('archivePromise');equal(closed.profiles.length,profileCount+1);equal(closed.profileArchiveResult.counts.localStorageOrigins,1);equal(closed.profileArchiveResult.counts.indexedDBDatabases,1);equal(closed.profileArchiveResult.counts.sessionStorageTabs,0);equal(closed.profileArchiveResult.warnings.some(v=>v.includes('left closed')),true);equal(loaded(),loadedBefore);
 await e('window.archivePromise=vek.action("profile:file:import",{restoreTabs:true});undefined');await unlock(false);const restored=await e('archivePromise'),restoredSpace=restored.spaces.find(s=>s.id===restored.selectedSpaceId);equal(restored.profiles.length,profileCount+2);equal(restoredSpace.profileId!==sourceId,true);equal(restored.profileArchiveResult.counts.sessionStorageTabs,2);equal(restored.profileArchiveResult.counts.localStorageOrigins,1);await wait(async()=> (await state()).tabs.find(t=>t.active)?.url===origin+'/fixture?seed=two');equal((await state()).tabs.find(t=>t.active)?.url,origin+'/fixture?seed=two');
 await wait(async()=>loaded()>=loadedBefore+2);await wait(()=>{const rows=webContents.getAllWebContents().filter(w=>w.session.getStoragePath()?.includes(restoredSpace.profileId)&&w.getURL().startsWith(origin+'/fixture'));return rows.length===2&&rows.every(w=>!w.isLoading());});const sourceTabs=webContents.getAllWebContents().filter(w=>w.getURL().startsWith(origin+'/fixture'));
 const importedContents=sourceTabs.filter(w=>w.session.getStoragePath().includes(restoredSpace.profileId));const first = importedContents.find(w => w.getURL().endsWith('seed=one'));
 const second = importedContents.find(w => w.getURL().endsWith('seed=two'));
 equal(first.navigationHistory.getAllEntries().map(entry => entry.url), [origin+'/older',origin+'/fixture?seed=one',origin+'/newer']);
 equal(first.navigationHistory.getActiveIndex(),1);
 equal(first.navigationHistory.canGoBack(),true);
 equal(first.navigationHistory.canGoForward(),true);
 equal(second.navigationHistory.canGoBack(),false);
 await Promise.all(sourceTabs.map(w=>w.executeJavaScript('idbReady')));
 const snapshots=await Promise.all(sourceTabs.map(async w=>({partition:w.session.getStoragePath(),url:w.getURL(),before:await w.executeJavaScript('before'),dbBefore:await w.executeJavaScript('dbBefore')})));
 const imported=snapshots.filter(row=>row.partition.includes(restoredSpace.profileId));equal(imported.length,2);equal(imported.map(row=>row.before.session).sort(),['one','two']);equal(imported.every(row=>row.before.local==='host shared'),true);equal(imported.map(row=>row.dbBefore),[{saved:'host indexed',next:76},{saved:'host indexed',next:76}]);equal(requests.includes('/'),false);
 await wait(()=>e('document.querySelector("#panel-content")?.hidden===false&&document.querySelector("#panel-content")?.textContent.includes("Profile restored into a new profile.")'));equal(await e('document.querySelector("#panel-content").textContent.includes("2 tab sessions")'),true);
 await action('space:select',sourceSpaceId);const original=await state();equal(original.profiles.some(p=>p.id===sourceId),true);equal(original.tabs.length,2);equal(await webContents.getAllWebContents().find(w=>w.getURL()===origin+'/fixture?seed=one'&&w.session.getStoragePath().includes('vek-default')).executeJavaScript('sessionStorage.getItem("tab")'),'one');
 saveCancelled=true;await action('profile:file:export',{});equal(fs.existsSync(file),true);equal(confirmations,3);
 await new Promise(r=>server.close(r));console.log(JSON.stringify({ok:true,checks,actualApplicationIPC:true,injectedNativeDialogs:true,realPassphraseModal:true,bootstrapNetworkRequests:requests.filter(v=>v==='/').length,modelCalls:0,externalAccountActions:0}));app.quit();}
require(path.join(root,'app/main.cjs'));

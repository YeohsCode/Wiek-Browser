'use strict';
const{app,WebContentsView,session}=require('electron'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const root=process.env.WIEK_INDEXEDDB_APP_ROOT||path.resolve(__dirname,'../..');
const{captureProfileIndexedDB,restoreProfileIndexedDB}=require(path.join(root,'app/profile-indexeddb.cjs')),{restoreArea}=require(path.join(root,'app/profile-web-storage.cjs')),{createProfileArchive}=require(path.join(root,'app/profile-archive.cjs'));
app.setPath('userData',path.join(process.env.WIEK_INDEXEDDB_TEST_DIR,'profile'));
app.whenReady().then(async()=>{
 let checks=0,requests=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},views=[],createContents=ses=>{const v=new WebContentsView({webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});views.push(v);return v.webContents;},make=ses=>{const w=createContents(ses);w.debugger.attach('1.3');return w;};
 const server=http.createServer((q,r)=>{requests++;r.setHeader('Content-Type','text/html');r.end('<!doctype html><title>Private synthetic IndexedDB fixture</title>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const source=session.fromPartition('source'),destination=session.fromPartition('destination'),w=make(source);await w.loadURL(origin+'/selected');
 await w.executeJavaScript(`(async()=>{
   const open=(name,upgrade)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,3);r.onupgradeneeded=()=>upgrade(r.result);r.onsuccess=()=>{r.result.close();resolve()};r.onerror=()=>reject(r.error)});
   await open('Portable',db=>{const out=db.createObjectStore('out');out.createIndex('byTag','tag');out.add({tag:'alpha',odd:'\\0\\ud800你好',when:new Date('2024-01-01'),bytes:new Uint16Array([1,65535])},['compound',1]);out.add({tag:'omega',infinite:true},Infinity);const inline=db.createObjectStore('inline',{keyPath:'id'});inline.createIndex('uniqueTag','tag',{unique:true});inline.add({id:'one',tag:'one',data:'original fixture',map:new Map([[1,new Set([2,3])]]),regex:/fixture/gi});});
   await open('Auto generator',db=>{
     const external=db.createObjectStore('external',{autoIncrement:true});
     external.add({value:'first'});external.add({value:'deleted'},100.5);external.delete(100.5);
     const inline=db.createObjectStore('inline',{keyPath:'details.id',autoIncrement:true});
     inline.createIndex('byId','details.id',{unique:true});inline.add({value:'first'});
     inline.add({details:{id:25},value:'deleted'});inline.delete(25);
     const exhausted=db.createObjectStore('exhausted',{autoIncrement:true});
     exhausted.add({},2**53);exhausted.clear();
     const last=db.createObjectStore('last',{autoIncrement:true});
     last.add({},2**53-1);last.clear();
     db.createObjectStore('unused',{autoIncrement:true});
   });
   await open('Blob unsupported',db=>db.createObjectStore('blobs').add(new Blob(['private blob']),'blob'));
 })()`);
 const tabs=[{name:'Selected',tabs:[{webContents:w}]}],captured=await captureProfileIndexedDB(tabs);eq(captured.counts,{indexedDBOrigins:1,indexedDBDatabases:2,indexedDBSkippedDatabases:1,indexedDBSkippedOrigins:0});eq(captured.warnings.length,1);eq(await w.executeJavaScript('indexedDB.databases().then(v=>v.length)'),3);
 eq((await captureProfileIndexedDB(tabs)).indexedDB,captured.indexedDB);
 const archive=createProfileArchive(),encoded=await archive.encode({profile:{name:'IndexedDB native'},indexedDB:captured.indexedDB},'public indexed native passphrase'),decoded=await archive.decode(encoded,'public indexed native passphrase');eq(decoded.metadata.version,3);
 const before=requests,result=await restoreProfileIndexedDB(destination,decoded.payload.indexedDB,{createContents});eq(result,{restoredOrigins:1,restoredDatabases:2,warnings:[]});eq(requests,before);
 const inspect=make(destination);await restoreArea(inspect,{origin,entries:[]},{isLocalStorage:false});const recaptured=await captureProfileIndexedDB([{name:'Destination',tabs:[{webContents:inspect}]}]);eq(recaptured.indexedDB,captured.indexedDB);eq(requests,before);
 eq(await inspect.executeJavaScript(`new Promise((resolve,reject)=>{const r=indexedDB.open('Portable');r.onsuccess=()=>{const db=r.result,tx=db.transaction('out'),q=tx.objectStore('out').index('byTag').get('alpha');q.onsuccess=()=>{const v=q.result;db.close();resolve({odd:[...Array(v.odd.length)].map((_,i)=>v.odd.charCodeAt(i)),date:v.when.toISOString(),bytes:[...v.bytes]})};q.onerror=()=>reject(q.error)}})`),{odd:[0,0xd800,0x4f60,0x597d],date:'2024-01-01T00:00:00.000Z',bytes:[1,65535]});
 eq(await inspect.executeJavaScript(`new Promise((resolve,reject)=>{const r=indexedDB.open('Portable');r.onsuccess=()=>{const db=r.result,q=db.transaction('inline').objectStore('inline').get('one');q.onsuccess=()=>{const v=q.result;db.close();resolve({map:v.map instanceof Map,set:v.map.get(1) instanceof Set,values:[...v.map.get(1)],regexp:v.regex instanceof RegExp,source:v.regex.source,flags:v.regex.flags})};q.onerror=()=>reject(q.error)}})`),{map:true,set:true,values:[2,3],regexp:true,source:'fixture',flags:'gi'});
 const conflict=await restoreProfileIndexedDB(destination,captured.indexedDB,{createContents});eq(conflict.restoredDatabases,0);eq(conflict.warnings.length,1);eq((await captureProfileIndexedDB([{name:'Still present',tabs:[{webContents:inspect}]}])).indexedDB,captured.indexedDB);
 const nextKeys=rollback=>`new Promise((resolve,reject)=>{
   const open=indexedDB.open('Auto generator');open.onerror=()=>reject(open.error);
   open.onsuccess=()=>{
     const db=open.result,tx=db.transaction(['external','inline','exhausted','last','unused'],'readwrite');
     const out={};
     for(const name of tx.objectStoreNames){
       const store=tx.objectStore(name),rows=store.count(),next=store.add({});
       rows.onsuccess=()=>{out[name]={rows:rows.result};};
       next.onsuccess=()=>{out[name].next=next.result;};
       next.onerror=event=>{event.preventDefault();out[name].next=next.error.name;};
     }
     let rolledBack=false;
     tx.oncomplete=()=>{db.close();resolve(out);};
     tx.onabort=()=>{db.close();if(rolledBack)resolve(out);else reject(tx.error);};
     if(${rollback})tx.objectStore('unused').count().onsuccess=()=>{tx.abort();rolledBack=true;};
   };
 })`;
 const expected={external:{rows:1,next:101},inline:{rows:1,next:26},exhausted:{rows:0,next:'ConstraintError'},last:{rows:0,next:2**53},unused:{rows:0,next:1}};
 eq(await inspect.executeJavaScript(nextKeys(false)),expected);
 // Probe the original independently and roll back the fixture's own writes as well.
 eq(await w.executeJavaScript(nextKeys(true)),expected);
 eq((await captureProfileIndexedDB(tabs)).indexedDB,captured.indexedDB);
 const partial=session.fromPartition('partial'),otherOrigin='https://other.fixture.test';let partialCreations=0;const twoOrigins={...captured.indexedDB,origins:[captured.indexedDB.origins[0],{...captured.indexedDB.origins[0],origin:otherOrigin}]};const failed=await restoreProfileIndexedDB(partial,twoOrigins,{createContents:ses=>{const wc=createContents(ses),original=wc.executeJavaScriptInIsolatedWorld.bind(wc);if(++partialCreations===1)wc.executeJavaScriptInIsolatedWorld=async(id,scripts)=>{const result=await original(id,scripts);if(scripts[0].code.includes('"mode":"write"'))throw new Error('Synthetic write failure');return result;};return wc;}});eq(failed.restoredDatabases,2);eq(failed.warnings.length,1);const partialInspect=make(partial);await restoreArea(partialInspect,{origin,entries:[]},{isLocalStorage:false});eq(await partialInspect.executeJavaScript('indexedDB.databases().then(v=>v.length)'),0);await restoreArea(partialInspect,{origin:otherOrigin,entries:[]},{isLocalStorage:false});eq(await partialInspect.executeJavaScript('indexedDB.databases().then(v=>v.length)'),2);
 const cancelled=session.fromPartition('cancelled'),controller=new AbortController();await assert.rejects(restoreProfileIndexedDB(cancelled,captured.indexedDB,{signal:controller.signal,createContents:ses=>{const wc=createContents(ses),original=wc.executeJavaScriptInIsolatedWorld.bind(wc);wc.executeJavaScriptInIsolatedWorld=async(id,scripts)=>{const value=await original(id,scripts);if(scripts[0].code.includes('"mode":"write"'))controller.abort();return value;};return wc;}}),/cancelled/);checks++;const cancelledInspect=make(cancelled);await restoreArea(cancelledInspect,{origin,entries:[]},{isLocalStorage:false});eq(await cancelledInspect.executeJavaScript('indexedDB.databases().then(v=>v.length)'),0);
 const quarantined=session.fromPartition('quarantined');let clearCalls=0,blocked;const originalClear=quarantined.clearStorageData.bind(quarantined);quarantined.clearStorageData=async options=>{clearCalls++;return originalClear(options);};await assert.rejects(restoreProfileIndexedDB(quarantined,captured.indexedDB,{createContents:ses=>{const wc=createContents(ses),original=wc.executeJavaScriptInIsolatedWorld.bind(wc),close=wc.close.bind(wc);blocked={wc,close};wc.executeJavaScriptInIsolatedWorld=async(id,scripts)=>{const result=await original(id,scripts);if(scripts[0].code.includes('"mode":"write"')){wc.close=()=>{throw new Error('Synthetic close failure')};throw new Error('Synthetic restore failure');}return result;};return wc;}}),error=>error.profileImportMustAbort===true);checks++;eq(clearCalls,0);blocked.wc.close=blocked.close;blocked.close({waitForBeforeUnload:false});
 const sourceCount=await w.executeJavaScript('indexedDB.databases().then(v=>v.length)');eq(sourceCount,3);eq(requests,before);
 for(const view of views)if(view.webContents&&!view.webContents.isDestroyed())view.webContents.close({waitForBeforeUnload:false});await new Promise(r=>server.close(r));console.log(JSON.stringify({ok:true,checks,bootstrapNetworkRequests:0,sourceProfileUnchanged:true,realBrowserIndexedDB:true,modelCalls:0,externalAccountActions:0}));app.quit();
}).catch(error=>{console.error(error);app.exit(1)});

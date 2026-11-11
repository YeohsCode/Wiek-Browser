'use strict';
const {ENCODING,LIMITS,portableCodec,validateIndexedDb}=require('./profile-indexeddb-data.cjs');
const {restoreArea,storageFrame,sameStorageFrame,closeContents,originOf}=require('./profile-web-storage.cjs');
const cancelled=signal=>{if(signal?.aborted)throw new Error('IndexedDB operation cancelled');};
// Fixed code, always executed in an isolated world. No archive text is code.
async function indexedDbScript(options,makeCodec) {
  if(location.href!==options.url||location.origin!==options.origin)throw new Error('IndexedDB document changed');
  const codec=makeCodec(),open=new Set(),transactions=new Set();let stopped=false;
  const check=()=>{if(stopped)throw new Error('IndexedDB operation stopped');};
  const database=(name,version,upgrade)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,version);r.onupgradeneeded=()=>{if(stopped||!upgrade){r.transaction.abort();return;}try{upgrade(r.result,r.transaction);}catch{r.transaction.abort();}};r.onblocked=()=>reject(new Error('IndexedDB is blocked'));r.onerror=()=>reject(new Error('IndexedDB open failed'));r.onsuccess=()=>{const db=r.result;if(stopped){db.close();reject(new Error('IndexedDB operation stopped'));return;}open.add(db);db.onversionchange=()=>db.close();resolve(db);};});
  const capture=async(db,name)=>{
    const names=Array.from(db.objectStoreNames);if(names.length>options.limits.stores)throw new Error('IndexedDB store limit');
    if(!names.length)return {name:codec.text(name),version:db.version,stores:[]};
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(names,'readonly');transactions.add(tx);const stores=[];let records=0,bytes=0,failure;
      const bad=error=>{failure=error;try{tx.abort();}catch{reject(error);}};
      try {for(const name of names){const source=tx.objectStore(name);if(source.autoIncrement)throw new Error('Auto-increment stores are not portable');
        const keyPath=value=>value===null?null:Array.isArray(value)?value.map(codec.text):codec.text(value);
        const indexes=Array.from(source.indexNames).map(name=>{const index=source.index(name);return{name:codec.text(name),keyPath:keyPath(index.keyPath),unique:index.unique,multiEntry:index.multiEntry};});if(indexes.length>options.limits.indexes)throw new Error('IndexedDB index limit');
        const store={name:codec.text(name),keyPath:keyPath(source.keyPath),autoIncrement:false,indexes,records:[]};stores.push(store);
        const cursor=source.openCursor();cursor.onsuccess=()=>{try{check();const row=cursor.result;if(!row)return;if(++records>options.limits.records)throw new Error('IndexedDB record limit');const record={key:codec.encode(row.primaryKey),value:codec.encode(row.value)};bytes+=record.key.length+record.value.length;if(bytes>options.limits.databaseBytes)throw new Error('IndexedDB byte limit');store.records.push(record);row.continue();}catch(error){bad(error);}};
      }}catch(error){bad(error);}
      tx.oncomplete=()=>{transactions.delete(tx);resolve({name:codec.text(name),version:db.version,stores});};tx.onabort=tx.onerror=()=>{transactions.delete(tx);reject(failure||new Error('IndexedDB read aborted'));};
    });
  };
  const operation=async()=>{
    check();const existing=await indexedDB.databases();check();if(existing.length>options.limits.databases)throw new Error('IndexedDB database limit');
    if(options.mode==='empty')return existing.length===0;
    if(options.mode==='read'){
      const databases=[],warnings=[];for(const item of existing){check();let db;try{if(typeof item.name!=='string'||!Number.isSafeInteger(item.version)||item.version<1)throw new Error('Unknown IndexedDB version');db=await database(item.name,item.version);databases.push(await capture(db,item.name));}catch{warnings.push('A changed, blocked, oversized or unsupported IndexedDB database was omitted.');}finally{db?.close();open.delete(db);}}
      return {databases,warnings,omittedDatabases:warnings.length};
    }
    if(existing.length)throw new Error('Destination IndexedDB is not empty');
    for(const saved of options.databases){check();const name=codec.untext(saved.name);let db;
      try {db=await database(name,saved.version,(created,tx)=>{
        for(const savedStore of saved.stores){const keyPath=savedStore.keyPath===null?null:Array.isArray(savedStore.keyPath)?savedStore.keyPath.map(codec.untext):codec.untext(savedStore.keyPath),store=created.createObjectStore(codec.untext(savedStore.name),{keyPath,autoIncrement:false});
          for(const index of savedStore.indexes)store.createIndex(codec.untext(index.name),Array.isArray(index.keyPath)?index.keyPath.map(codec.untext):codec.untext(index.keyPath),{unique:index.unique,multiEntry:index.multiEntry});
          for(const row of savedStore.records){const value=codec.decode(row.value);if(keyPath===null)store.add(value,codec.decode(row.key));else store.add(value);}
        }
      });check();if(JSON.stringify(await capture(db,name))!==JSON.stringify(saved))throw new Error('IndexedDB verification failed');
      }finally{db?.close();open.delete(db);}
    }
    return true;
  };
  let timer;try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>{stopped=true;for(const tx of transactions)try{tx.abort();}catch{}for(const db of open)db.close();reject(new Error('IndexedDB operation timed out'));},options.timeoutMs);})]);}finally{clearTimeout(timer);stopped=true;for(const tx of transactions)try{tx.abort();}catch{}for(const db of open)db.close();}
}
async function run(wc,options,{timeoutMs=5000}={}) {
  let timer;try{return await Promise.race([wc.executeJavaScriptInIsolatedWorld(1004,[{code:'('+indexedDbScript.toString()+')('+JSON.stringify({...options,limits:LIMITS,timeoutMs})+','+portableCodec.toString()+')'}]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('IndexedDB transport timed out')),timeoutMs+500);})]);}finally{clearTimeout(timer);}
}
async function captureProfileIndexedDB(spaces,{signal}={}) {
  const origins=[],seen=new Set(),warnings=[];let databases=0,total=0,skippedDatabases=0,skippedOrigins=0;
  for(const space of spaces)for(const tab of space.tabs){cancelled(signal);const wc=tab.webContents;let origin;
    try {const url=wc.getURL();origin=originOf(url);if(!origin||seen.has(origin))continue;const before=await storageFrame(wc);if(before.url!==url||before.origin!==origin)throw new Error('IndexedDB document changed');if(origins.length>=LIMITS.origins)throw new Error('IndexedDB origin limit');
      const result=await run(wc,{mode:'read',url:before.url,origin:before.origin});cancelled(signal);const after=await storageFrame(wc);if(!sameStorageFrame(before,after))throw new Error('IndexedDB document changed');
      const area={origin,databases:result.databases},validated=validateIndexedDb({encoding:ENCODING,origins:[area]}).origins[0],size=Buffer.byteLength(JSON.stringify(validated));if(total+size>LIMITS.totalBytes)throw new Error('IndexedDB total byte limit');total+=size;seen.add(origin);origins.push(validated);databases+=validated.databases.length;warnings.push(...result.warnings);skippedDatabases+=result.omittedDatabases;
    }catch{cancelled(signal);skippedOrigins++;warnings.push('IndexedDB from a changed, closed, partitioned or oversized tab was omitted.');}
  }
  return {indexedDB:{encoding:ENCODING,origins},counts:{indexedDBOrigins:origins.length,indexedDBDatabases:databases,indexedDBSkippedDatabases:skippedDatabases,indexedDBSkippedOrigins:skippedOrigins},warnings:[...new Set(warnings)]};
}
async function restoreProfileIndexedDB(ses,input,{createContents,signal}={}) {
  const validated=validateIndexedDb(input);let restoredOrigins=0,restoredDatabases=0;const warnings=[];
  for(const area of validated.origins){cancelled(signal);if(!area.databases.length)continue;const holder=createContents(ses),wc=holder.webContents||holder;let wrote=false;
    try {wc.debugger.attach('1.3');await restoreArea(wc,{origin:area.origin,entries:[]},{isLocalStorage:false,signal});cancelled(signal);
      const options={url:area.origin+'/',origin:area.origin};if(!await run(wc,{...options,mode:'empty'}))throw new Error('Destination IndexedDB is not empty');cancelled(signal);wrote=true;
      await run(wc,{...options,mode:'write',databases:area.databases});cancelled(signal);restoredOrigins++;restoredDatabases+=area.databases.length;
    }catch(failure){try{await closeContents(wc);}catch{const error=new Error('Imported IndexedDB document could not be closed; the incomplete profile must not be opened');error.profileImportMustAbort=true;throw error;}if(wrote){try{let timer;try{await Promise.race([ses.clearStorageData({origin:area.origin,storages:['indexdb']}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('IndexedDB cleanup timed out')),5000);})]);}finally{clearTimeout(timer);}}catch{const error=new Error('Imported IndexedDB cleanup failed; the incomplete profile must not be opened');error.profileImportMustAbort=true;throw error;}}cancelled(signal);warnings.push('An IndexedDB origin was not restored; existing databases were preserved and any new import was discarded.');}
    finally{if(!wc.isDestroyed())try{await closeContents(wc);}catch{const error=new Error('Imported IndexedDB document did not close; the incomplete profile must not be opened');error.profileImportMustAbort=true;throw error;}}
  }
  return {restoredOrigins,restoredDatabases,warnings:[...new Set(warnings)]};
}
module.exports={captureProfileIndexedDB,restoreProfileIndexedDB};

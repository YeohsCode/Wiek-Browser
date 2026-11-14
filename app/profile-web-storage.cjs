'use strict';
const { captureNavigation } = require('./profile-navigation.cjs');
const {ENCODING,LIMITS,exactOrigin,validateArea}=require('./profile-storage-data.cjs');
const blank=url=>url==='about:blank';
function originOf(url) {try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.origin:null;}catch{return null}}
function abort(signal) {if(signal?.aborted)throw new Error('Profile storage operation cancelled');}
async function bounded(promise,timeoutMs=5000) {let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Profile storage operation timed out')),timeoutMs);})]);}finally{clearTimeout(timer)}}
const send=(wc,method,params={})=>bounded(wc.debugger.sendCommand(method,params));
async function closeContents(wc) {if(wc.isDestroyed())return;let done;try{await bounded(new Promise(resolve=>{done=resolve;wc.once('destroyed',done);wc.close({waitForBeforeUnload:false});}));}finally{wc.removeListener('destroyed',done);}}
// Electron's CDP value conversion can replace unpaired UTF-16 surrogates.
// Transfer only ASCII base64 across that boundary. This fixed function runs in
// a private isolated world; neither page scripts nor archive text becomes code.
function storageScript(options) {
  if(location.href!==options.url||location.origin!==options.origin)throw new Error('Storage document changed');
  const encode=value=>{const bytes=new Uint8Array(value.length*2);for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);bytes[i*2]=c&255;bytes[i*2+1]=c>>>8;}let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);};
  const decode=value=>{const b=atob(value),units=new Uint16Array(b.length/2);for(let i=0;i<units.length;i++)units[i]=b.charCodeAt(i*2)|(b.charCodeAt(i*2+1)<<8);let result='';for(let i=0;i<units.length;i+=8192)result+=String.fromCharCode(...units.subarray(i,i+8192));return result;};
  const read=storage=>{if(storage.length>options.limits.entries)throw new Error('Storage entry limit');let size=0;const entries=[];for(let i=0;i<storage.length;i++){const key=Storage.prototype.key.call(storage,i),value=Storage.prototype.getItem.call(storage,key);if(key===null||value===null)throw new Error('Storage changed');size+=(key.length+value.length)*2;if(key.length*2>options.limits.keyBytes||value.length*2>options.limits.valueBytes||size>options.limits.areaBytes)throw new Error('Storage byte limit');entries.push([encode(key),encode(value)]);}return entries;};
  if(options.mode==='read')return {local:options.readLocal?read(localStorage):null,session:read(sessionStorage)};
  const storage=options.isLocalStorage?localStorage:sessionStorage;if(storage.length)throw new Error('Destination storage is not empty');
  for(const [key,value]of options.entries)Storage.prototype.setItem.call(storage,decode(key),decode(value));
  const sort=entries=>entries.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  if(JSON.stringify(sort(read(storage)))!==JSON.stringify(sort(options.entries)))throw new Error('Storage verification failed');return true;
}
const runStorage=(wc,options)=>bounded(wc.executeJavaScriptInIsolatedWorld(1003,[{code:'('+storageScript.toString()+')('+JSON.stringify({...options,limits:LIMITS})+')'}]));
async function frame(wc) {const {frameTree}=await send(wc,'Page.getFrameTree'),f=frameTree.frame,origin=originOf(f.url);if(!origin||f.securityOrigin!==origin)throw new Error('Unsupported top-level origin');const {storageKey}=await send(wc,'Storage.getStorageKeyForFrame',{frameId:f.id});if(storageKey!==origin+'/')throw new Error('Partitioned or opaque storage is not portable');return {id:f.id,loaderId:f.loaderId,url:f.url,origin,storageKey};}
const sameFrame=(a,b)=>a.id===b.id&&a.loaderId===b.loaderId&&a.url===b.url&&a.storageKey===b.storageKey;

// Capture existing, explicitly selected profile tabs only. Never navigate to
// discover other origins and never evaluate code supplied by the page/archive.
async function captureProfileTabs(spaces,{includeWebStorage=false,signal}={}) {
  const saved=[],local=new Map(),warnings=[],budget={bytes:0};let sessionAreas=0,skippedTabs=0;
  const admit=area=>{const next={bytes:budget.bytes};validateArea(area,next);budget.bytes=next.bytes;return area;};
  for(const space of spaces){abort(signal);const rows=[];let activeTabIndex;
    for(const tab of space.tabs){abort(signal);const wc=tab.webContents;let row;
      try {const url=wc.getURL()||tab.url;if(!blank(url)&&!originOf(url)){skippedTabs++;continue;}row={url,title:wc.getTitle()};const navigation=captureNavigation(wc,url);if(navigation)row.navigation=navigation;}catch{skippedTabs++;continue;}
      if(tab.id===space.activeTab)activeTabIndex=rows.length;rows.push(row);
      if(!includeWebStorage||blank(row.url))continue;
      try {
        const before=await frame(wc);if(before.url!==row.url)throw new Error('Page changed');
        // Read both before committing either; a navigation must not mix origins.
        const values=await runStorage(wc,{mode:'read',url:before.url,origin:before.origin,readLocal:!local.has(before.origin)}),localArea=values.local===null?null:validateArea({origin:before.origin,entries:values.local}),sessionArea=validateArea({origin:before.origin,entries:values.session}),after=await frame(wc);abort(signal);
        if(!sameFrame(before,after))throw new Error('Page changed');
        if(localArea){try{if(local.size>=LIMITS.origins)throw new Error('Origin limit');local.set(localArea.origin,admit(localArea));}catch{warnings.push('A local storage origin exceeded the portable limits and was omitted.');}}
        try{row.sessionStorage=admit(sessionArea);sessionAreas++;}catch{warnings.push('A tab session storage area exceeded the portable limits and was omitted.');}
      }catch{abort(signal);warnings.push('Web storage from a changed, closed, unsupported or oversized tab was omitted.');}
    }
    saved.push({name:space.name,pinned:Boolean(space.pinned),tabs:rows,...(rows.length?{activeTabIndex:activeTabIndex??0}:{})});
  }
  if(skippedTabs)warnings.push(`${skippedTabs} unsupported or closed tabs were omitted.`);
  return {spaces:saved,...(includeWebStorage?{webStorage:{encoding:ENCODING,localStorage:[...local.values()]}}:{}),counts:{localStorageOrigins:local.size,sessionStorageTabs:sessionAreas},warnings:[...new Set(warnings)]};
}
async function captureProfileCookies(ses,wc) {
  if(!wc||wc.isDestroyed()||wc.session!==ses)throw new Error('A tab in the selected profile is required to export cookies');
  // Electron Cookie omits Chromium's partition key. Use the actual session's
  // protocol cookie records so a CHIPS cookie is never widened on import.
  const {cookies}=await send(wc,'Network.getAllCookies');let skipped=0;
  const rows=cookies.filter(row=>{if(row.partitionKey||row.partitionKeyOpaque){skipped++;return false;}return true;}).map(row=>({domain:row.domain,name:row.name,value:row.value,path:row.path,secure:row.secure,httpOnly:row.httpOnly,hostOnly:!row.domain.startsWith('.'),session:row.session,sameSite:({None:'no_restriction',Lax:'lax',Strict:'strict'})[row.sameSite]||'unspecified',...(!row.session?{expirationDate:row.expires}:{})}));
  return {cookies:rows,skipped};
}

// Bootstrap a same-origin document through CDP Fetch.fulfillRequest. All request
// types are intercepted, never continued. The bootstrap runs no website or
// archive-supplied script and sends no requests or cookies to a server.
async function restoreArea(wc,area,{isLocalStorage,signal,timeoutMs=5000}={}) {
  validateArea(area);exactOrigin(area.origin);abort(signal);
  const url=area.origin+'/',debuggerApi=wc.debugger;
  let fatal,intercepting=false,wrote=false,closing=false;const commands=new Set();
  const close=async()=>{closing=true;await closeContents(wc);};
  const stop=()=>{fatal ||= new Error('Profile storage operation cancelled');void close().catch(()=>{});};
  const listener=(_event,method,params)=>{
    if(method!=='Fetch.requestPaused')return;
    const expected=params.request.url===url&&params.resourceType==='Document';
    if(!expected)fatal ||= new Error('Unexpected storage bootstrap request');
    const command=debuggerApi.sendCommand(expected?'Fetch.fulfillRequest':'Fetch.failRequest',expected?{requestId:params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'},{name:'Cache-Control',value:'no-store'},{name:'Content-Security-Policy',value:"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}],body:Buffer.from('<!doctype html><title>Restoring profile storage</title>').toString('base64')}:{requestId:params.requestId,errorReason:'Aborted'});
    commands.add(command);command.catch(()=>{fatal ||= new Error('Storage bootstrap interception failed');}).finally(()=>commands.delete(command));
  };
  debuggerApi.on('message',listener);signal?.addEventListener('abort',stop,{once:true});
  try {
    await bounded((async()=>{
      // Renderer domains can wait indefinitely before the initial document has
      // been created in a new Electron WebContents. Initialize locally first.
      await wc.loadURL('about:blank');abort(signal);
      await send(wc,'Network.setBypassServiceWorker',{bypass:true});abort(signal);
      await send(wc,'Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});intercepting=true;abort(signal);
      await wc.loadURL(url);abort(signal);if(fatal)throw fatal;
      const f=await frame(wc);if(f.url!==url||f.origin!==area.origin)throw new Error('Storage bootstrap origin changed');
      // Destination must be fresh. Refuse an existing keyset instead of clearing
      // unrelated data or trying to roll back concurrent site writes.
      const existing=await runStorage(wc,{mode:'read',url,origin:area.origin,readLocal:!!isLocalStorage});if((isLocalStorage?existing.local:existing.session).length)throw new Error('Destination storage is not empty');
      abort(signal);if(fatal)throw fatal;wrote=true;
      await runStorage(wc,{mode:'write',url,origin:area.origin,isLocalStorage:!!isLocalStorage,entries:area.entries});
      abort(signal);if(fatal)throw fatal;
    })(),timeoutMs);
  }catch(failure){try{await close();}catch{}failure.storageMayHaveChanged=wrote;throw failure;}
  finally {
    // After timeout/abort the destination is closed, so no late command can
    // mutate a later user's page. Successful bootstrap leaves no interception.
    signal?.removeEventListener('abort',stop);if(!closing&&!wc.isDestroyed()){
      try{if(intercepting)await send(wc,'Fetch.disable');await send(wc,'Network.setBypassServiceWorker',{bypass:false});}catch{await close();}
    }
    debuggerApi.removeListener('message',listener);
  }
  if(wc.isDestroyed())throw new Error('Storage destination closed during cleanup');
}
async function restoreLocalStorage(ses,areas,{createContents,signal}={}) {
  let restored=0;const warnings=[];
  for(const area of areas){abort(signal);const holder=createContents(ses),wc=holder.webContents||holder;try{wc.debugger.attach('1.3');await restoreArea(wc,area,{isLocalStorage:true,signal});restored++;}catch(failure){warnings.push('A local storage origin could not be fully restored.');if(failure.storageMayHaveChanged)try{await bounded(ses.clearStorageData({origin:area.origin,storages:['localstorage']}));}catch{warnings.push('Partial local storage cleanup failed for an imported origin.');}abort(signal);}finally{const live=holder.webContents||wc;if(!live.isDestroyed())await closeContents(live);}}
  return {restored,warnings:[...new Set(warnings)]};
}
module.exports={captureProfileTabs,captureProfileCookies,restoreArea,restoreLocalStorage,originOf,storageFrame:frame,sameStorageFrame:sameFrame,closeContents};

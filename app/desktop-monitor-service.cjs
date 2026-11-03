'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createActionRecorder}=require('./action-recorder.cjs');
const {inspectPng}=require('./library-service.cjs');
const fail=message=>Object.assign(new Error(message),{error_code:'VEK_DESKTOP_MONITOR_INVALID'});
const clone=value=>JSON.parse(JSON.stringify(value));
const bundle=value=>typeof value==='string'&&value.length<=255&&/^[-A-Za-z0-9]+(?:\.[-A-Za-z0-9]+)+$/.test(value);
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=100000;
function source(value){if(!value||!bundle(value.bundleId)||typeof value.appName!=='string'||value.appName.length>300||!Number.isSafeInteger(value.pid)||value.pid<=0)throw fail('Invalid desktop application');return {bundleId:value.bundleId,appName:value.appName,pid:value.pid};}
function createDesktopMonitorService({dataDir,native,onChange=()=>{},onSelection=()=>{},ownBundleId='app.wiek.browser',ownPid=process.pid,now=Date.now,draftMs=15000,recordingLimits={}}={}){
  if(!dataDir||!native)throw fail('Desktop monitor dependencies are missing');
  const directory=path.join(path.resolve(dataDir),'desktop'),file=path.join(directory,'monitor.json');
  if(fs.existsSync(directory)&&(fs.lstatSync(directory).isSymbolicLink()||!fs.lstatSync(directory).isDirectory()))throw fail('Invalid desktop directory');fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
  let config={version:1,enabled:false,excludedApps:[]},closed=false,watch=null,recordWatch=null,status='off',lastError='',epoch=0,recordEpoch=0,draft=null,timer,recordSource=null,eventContext=null,pending=0,queue=Promise.resolve(),mutation=Promise.resolve(),observedEvents=0,acceptedSelections=0;
  function validate(value){if(!value||value.version!==1||typeof value.enabled!=='boolean'||!Array.isArray(value.excludedApps)||value.excludedApps.length>128||value.excludedApps.some(v=>!bundle(v))||Object.keys(value).some(k=>!['version','enabled','excludedApps'].includes(k)))throw fail('Invalid selection monitor policy');return {version:1,enabled:value.enabled,excludedApps:[...new Set(value.excludedApps)]};}
  if(fs.existsSync(file)){const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile()||st.size>65536)throw fail('Invalid monitor settings');config=validate(JSON.parse(fs.readFileSync(file,'utf8')));fs.chmodSync(file,0o600);}
  function persist(value){const temp=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file)}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp)}catch{}}}
  const excluded=()=>[...new Set([...config.excludedApps,ownBundleId])];
  function clear(){clearTimeout(timer);draft=null;try{onSelection(null)}catch{}}
  function snapshot(){if(draft&&draft.expiresAt<=now())clear();return clone({version:1,...config,available:native.available===true,status,lastError,activity:{observedEvents,acceptedSelections},selection:draft?{id:draft.id,source:draft.source,characters:draft.text.length,createdAt:draft.createdAt,expiresAt:draft.expiresAt,point:draft.point}:null,recording:recorder.snapshot(),recordingApp:recordSource});}
  function changed(){try{onChange(snapshot())}catch{}}
  function acceptSelection(value,runEpoch){observedEvents++;if(closed||runEpoch!==epoch||!config.enabled||status==='lost')return;if(value.type==='clear'){if(draft){clear();changed();}return;}if(value.type!=='selection')return;
    try{const app=source(value.source);if((excluded().includes(app.bundleId)||app.pid===ownPid)||typeof value.text!=='string'||!value.text.trim()||!value.text.isWellFormed()||value.text.includes('\0')||Buffer.byteLength(value.text)>131072||value.secure===true){clear();return;}
      if(!value.point||!finite(value.point.x)||!finite(value.point.y))return;clear();acceptedSelections++;const createdAt=now();draft={id:crypto.randomUUID(),text:value.text,source:app,createdAt,expiresAt:createdAt+draftMs,point:{x:value.point.x,y:value.point.y}};timer=setTimeout(()=>{clear();changed()},draftMs);timer.unref?.();try{onSelection(clone({id:draft.id,source:draft.source,point:draft.point,expiresAt:draft.expiresAt}))}catch{}changed();
    }catch{clear();}
  }
  async function stopWatch(){epoch++;clear();const previous=watch;watch=null;if(previous)await previous.stop();status='off';}
  async function startWatch(){if(closed||!config.enabled)return;const current=++epoch;status='starting';changed();let next;
    try{next=native.watchSelections({excludedApps:excluded(),onMessage:value=>acceptSelection(value,current),onClose:code=>{if(current!==epoch||closed)return;watch=null;status='lost';lastError='Selection monitor stopped: '+String(code).slice(0,64)+'. Resume explicitly after checking permissions.';clear();changed()}});watch=next;await next.started;if(current!==epoch||closed)return;status='watching';lastError='';changed();}
    catch{if(current===epoch&&!closed){watch=null;status='lost';lastError='Selection monitoring could not start. Check Accessibility permission and resume explicitly.';clear();changed();}await next?.stop();}
  }
  const recorder=createActionRecorder({dataDir:path.join(dataDir,'desktop-native-recordings'),...recordingLimits,onChange:()=>changed(),activePage:()=>recordSource?{targetId:'native:'+recordSource.bundleId+':'+recordSource.pid,title:recordSource.appName,url:''}:null,capture:async()=>{
    if(!eventContext||!recordSource||eventContext.source.bundleId!==recordSource.bundleId||eventContext.source.pid!==recordSource.pid)throw fail('Recording scope changed');const current=eventContext,runEpoch=recordEpoch;
    const result=await native.captureWindow(current);if(closed||runEpoch!==recordEpoch||eventContext!==current||!recorder.snapshot().recording)throw fail('Recording stopped');if(!Buffer.isBuffer(result?.png))throw fail('No window capture');inspectPng(result.png);return {pngBase64:result.png.toString('base64')};
  }});
  async function stopRecording(){recordEpoch++;const previous=recordWatch;recordWatch=null;const stopped=recorder.dispatch('recorder:stop');await previous?.stop();await stopped;await queue;recordSource=null;eventContext=null;changed();}
  function acceptAction(value,runEpoch){if(closed||runEpoch!==recordEpoch||!recordSource||!recorder.snapshot().recording||value.type!=='action'||pending>=8)return;let app;
    try{app=source(value.source)}catch{return;}if(app.bundleId!==recordSource.bundleId||app.pid!==recordSource.pid||excluded().includes(app.bundleId)||value.secure===true||!Number.isSafeInteger(value.windowId)||value.windowId<=0||!['click','key','scroll'].includes(value.kind))return;
    const item={kind:value.kind,targetId:'native:'+app.bundleId+':'+app.pid,url:''};
    for(const key of ['x','y','deltaX','deltaY'])if(finite(value[key]))item[key]=value[key];
    if(value.box&&['x','y','width','height'].every(k=>finite(value.box[k]))&&value.box.width>=0&&value.box.height>=0)item.box=Object.fromEntries(['x','y','width','height'].map(k=>[k,value.box[k]]));
    if(value.kind==='key'){if(typeof value.key!=='string'||value.key.length>20)return;item.key=value.key;for(const key of ['ctrlKey','metaKey','altKey','shiftKey'])item[key]=value[key]===true;}
    const context={source:app,windowId:value.windowId};pending++;queue=queue.then(async()=>{if(closed||runEpoch!==recordEpoch)return;eventContext=context;try{await recorder.record(item)}finally{eventContext=null}if(!recorder.snapshot().recording&&runEpoch===recordEpoch){recordEpoch++;const previous=recordWatch;recordWatch=null;recordSource=null;void previous?.stop();changed();}}).catch(()=>{}).finally(()=>{pending--});
  }
  function interactive(context){if(closed)throw fail('Desktop monitoring is closed');if(context?.interactive!==true)throw fail('Desktop monitoring requires trusted Desktop controls');}
  function serialize(work){const task=mutation.then(work);mutation=task.catch(()=>{});return task;}
  async function apps(){const result=await native.apps();if(!Array.isArray(result)||result.length>512)throw fail('Invalid application inventory');return result.map(v=>{try{return source(v)}catch{return null}}).filter(v=>v&&v.pid!==ownPid&&!excluded().includes(v.bundleId)).slice(0,128);}
  async function dispatch(action,payload={},context={}){
    if(action==='desktop:monitor:snapshot')return snapshot();interactive(context);
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fail('Invalid desktop action');
    if(action==='desktop:monitor:apps')return {apps:await apps()};
    if(action==='desktop:monitor:policy')return serialize(async()=>{if(Object.keys(payload).some(k=>!['enabled','excludedApps'].includes(k)))throw fail('Unknown monitor policy');const next=validate({...config,...payload});persist(next);config=next;await stopWatch();if(recordSource&&excluded().includes(recordSource.bundleId))await stopRecording();if(config.enabled)await startWatch();lastError=status==='lost'?lastError:'';changed();return snapshot();});
    if(action==='desktop:monitor:resume')return serialize(async()=>{if(!config.enabled)throw fail('Enable the selection toolbar first');await stopWatch();await startWatch();return snapshot()});
    if(action==='desktop:monitor:dismiss'){dismiss(payload.id);return snapshot();}
    if(action==='desktop:monitor:read')return consume(payload.id);
    if(action==='desktop:recording:start')return serialize(async()=>{
      if(recordWatch||recorder.snapshot().recording)throw fail('Stop the current application recording first');if(!bundle(payload.bundleId)||excluded().includes(payload.bundleId))throw fail('Choose an allowed application');
      const available=await apps(),app=available.find(v=>v.bundleId===payload.bundleId&&(!payload.pid||v.pid===payload.pid));if(!app)throw fail('The selected application is no longer running');recordSource=app;const current=++recordEpoch;let next;
      try{await recorder.dispatch('recorder:start',{name:payload.name||('Application: '+app.appName)});next=native.watchActions({bundleId:app.bundleId,excludedApps:excluded(),onMessage:value=>acceptAction(value,current),onClose:code=>{if(current!==recordEpoch||closed)return;lastError='Application recording stopped: '+String(code).slice(0,64);void stopRecording()}});recordWatch=next;await next.started;if(current!==recordEpoch)throw fail('Recording monitor stopped');changed();return snapshot();}
      catch(e){await next?.stop();await stopRecording();throw e;}
    });
    if(action==='desktop:recording:stop')return serialize(async()=>{await stopRecording();return snapshot()});
    if(action.startsWith('desktop:recording:')){const method=action.slice('desktop:recording:'.length);if(!['list','read','export','delete','restore'].includes(method))throw fail('Unknown recording action');if(method==='delete'&&recorder.snapshot().activeSessionId===(payload.id||payload.sessionId))await stopRecording();const result=await recorder.dispatch('recorder:'+method,payload);return method==='list'?snapshot():result;}
    throw fail('Unknown desktop monitor action');
  }
  function consume(id){if(closed)throw fail('Desktop monitoring is closed');if(!draft||draft.id!==id||draft.expiresAt<=now()){clear();throw fail('Selection toolbar expired or was replaced')}return clone({id:draft.id,text:draft.text,source:draft.source});}
  function dismiss(id){if(id&&draft?.id!==id)return;clear();changed();}
  async function activate(){if(closed)return;if(config.enabled)await serialize(startWatch);}
  async function close(){if(closed)return;closed=true;epoch++;recordEpoch++;clear();const a=watch,b=recordWatch;watch=null;recordWatch=null;await Promise.allSettled([a?.stop(),b?.stop()]);await mutation;await recorder.close();await queue;recordSource=null;}
  persist(config);return {snapshot,dispatch,consume,dismiss,activate,close};
}
module.exports={createDesktopMonitorService};

'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {normalizeAccelerator,physicalChord}=require('./preferences-service.cjs');
const {inspectPng}=require('./library-service.cjs');
const ACTIONS=[{id:'screenshot',label:'Capture screen region'},{id:'selection',label:'Read selected text'},{id:'chat',label:'Open Agent chat'},{id:'voice',label:'Open voice input'}];
const defaults=()=>({version:1,selectionEnabled:false,excludedApps:[],shortcuts:Object.fromEntries(ACTIONS.map(a=>[a.id,'']))});
const fail=(message,code='VEK_DESKTOP_INVALID')=>Object.assign(new Error(message),{error_code:code});
const clone=value=>JSON.parse(JSON.stringify(value));
function createDesktopService({dataDir,platform=process.platform,registry,permissions=()=>({}),capture,selection,checkChord=()=>({valid:true}),onOpen=()=>{},onChange=()=>{},copyText=()=>{},saveText,now=Date.now,draftMs=180000}={}){
  if(!dataDir||!registry)throw fail('Desktop service dependencies are missing');
  const directory=path.join(path.resolve(dataDir),'desktop'),file=path.join(directory,'state.json');
  if(fs.existsSync(directory)&&(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink()))throw fail('Desktop state must be a real directory');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
  let config=defaults(),closed=false,active=false,draft=null,operation=null,epoch=0,timer,lastError='',statuses={};const owned=new Set();
  function validate(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['version','selectionEnabled','excludedApps','shortcuts'].includes(k))||input.version!==1||typeof input.selectionEnabled!=='boolean'||!Array.isArray(input.excludedApps)||input.excludedApps.length>128)throw fail('Invalid desktop settings');
    const next=defaults();next.selectionEnabled=input.selectionEnabled;
    for(const id of input.excludedApps){if(typeof id!=='string'||id.length>255||!/^[-A-Za-z0-9]+(?:\.[-A-Za-z0-9]+)+$/.test(id))throw fail('Use application bundle IDs, for example com.example.editor');next.excludedApps.push(id);}
    next.excludedApps=[...new Set(next.excludedApps)];
    if(!input.shortcuts||typeof input.shortcuts!=='object'||Array.isArray(input.shortcuts)||Object.keys(input.shortcuts).some(k=>!ACTIONS.some(a=>a.id===k)))throw fail('Invalid global shortcut action');
    const seen=new Set();for(const action of ACTIONS){const value=normalizeAccelerator(input.shortcuts[action.id]===undefined?'':input.shortcuts[action.id],platform),physical=physicalChord(value,platform);if(physical&&seen.has(physical))throw fail('Global shortcuts must be distinct');seen.add(physical);next.shortcuts[action.id]=physical;}return next;
  }
  if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>65536)throw fail('Invalid desktop state file');config=validate(JSON.parse(fs.readFileSync(file,'utf8')));fs.chmodSync(file,0o600);}
  function persist(next){const temp=file+'.'+crypto.randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(next,null,2));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp)}catch{}}}
  function drop(){clearTimeout(timer);timer=undefined;draft=null;}
  function snapshot(){if(draft&&draft.expiresAt<=now())drop();return clone({version:1,...config,actions:ACTIONS,platform,permissions:permissions(),capabilities:{screenshot:typeof capture==='function',selection:typeof selection==='function'},shortcutsStatus:statuses,busy:operation?{id:operation.id,kind:operation.kind}:null,draft:draft?{id:draft.id,kind:draft.kind,title:draft.title,source:draft.source,createdAt:draft.createdAt,expiresAt:draft.expiresAt,...(draft.kind==='image'?{width:draft.width,height:draft.height}:{characters:draft.text.length})}:null,lastError});}
  function changed(){try{onChange(snapshot())}catch{}}
  const ensure=()=>{if(closed)throw fail('Desktop tools are closed','VEK_DESKTOP_CLOSED');};
  const interactive=context=>{ensure();if(context?.interactive!==true)throw fail('Desktop capture requires the browser’s Desktop tools or a configured user shortcut','VEK_DESKTOP_INTERACTIVE_REQUIRED');};
  function reserved(){return [...new Set([...Object.values(config.shortcuts).filter(Boolean),...owned])].map(accelerator=>({accelerator,label:'Desktop global shortcut'}));}
  function unregister(key){try{registry.unregister(key);owned.delete(key);}catch{lastError='A global shortcut could not be released; it will be released when Vek exits.';}}
  function register(action,key){
    const check=checkChord(key);if(!check.valid)throw fail(check.error||'Shortcut conflicts with an application shortcut');
    const ok=registry.register(key,()=>{if(!closed&&active&&config.shortcuts[action]===key)void trigger(action).catch(()=>{});});
    if(ok)owned.add(key);if(!ok||!registry.isRegistered(key)){if(ok)unregister(key);throw fail('The operating system did not register this shortcut. It may be in use by another application.','VEK_DESKTOP_SHORTCUT_UNAVAILABLE');}
  }
  function activate(){ensure();if(active)return snapshot();active=true;for(const action of ACTIONS){const key=config.shortcuts[action.id];if(!key)continue;try{if(!owned.has(key))register(action.id,key);statuses[action.id]={status:'registered',accelerator:key};}catch(e){statuses[action.id]={status:'unavailable',accelerator:key,error:e.message};}}changed();return snapshot();}
  function changeShortcut(action,accelerator){
    if(!ACTIONS.some(a=>a.id===action))throw fail('Unknown global shortcut action');
    const next=validate({...config,shortcuts:{...config.shortcuts,[action]:accelerator}}),key=next.shortcuts[action],previous=config.shortcuts[action];
    if(key===previous&&owned.has(key))return snapshot();
    if(key)register(action,key);
    try{persist(next);}catch(e){if(key&&key!==previous)unregister(key);throw e;}
    config=next;if(previous&&previous!==key)unregister(previous);statuses[action]=key?{status:'registered',accelerator:key}:{status:'unassigned'};lastError='';changed();return snapshot();
  }
  async function collect(kind){
    ensure();if(operation)throw fail('Another desktop capture is in progress','VEK_DESKTOP_BUSY');
    if(kind==='selection'&&!config.selectionEnabled)throw fail('Enable one-time selected-text reading first');
    const provider=kind==='selection'?selection:capture;if(!provider)throw fail('This desktop capture is not supported on this platform');
    const current={id:crypto.randomUUID(),kind,controller:new AbortController(),epoch:++epoch};operation=current;lastError='';changed();
    const task=(async()=>{
      try{
        const result=await provider({signal:current.controller.signal,excludedApps:[...config.excludedApps]});
        if(closed||current.controller.signal.aborted||current.epoch!==epoch)return null;
        if(!result){lastError='No content was captured. If you did not cancel, check OS permissions.';return null;}
        const createdAt=now(),base={id:crypto.randomUUID(),createdAt,expiresAt:createdAt+draftMs};let nextDraft;
        if(kind==='selection'){
          if(typeof result.text!=='string'||!result.text.trim()||Buffer.byteLength(result.text)>131072||!result.text.isWellFormed()||result.text.includes('\0'))throw fail('No supported selected text, or selection exceeds 128 KiB');
          if(typeof result.bundleId!=='string'||typeof result.appName!=='string'||result.bundleId.length>255||result.appName.length>300||result.secure===true||config.excludedApps.includes(result.bundleId))throw fail('Selection from this application is excluded or protected');
          nextDraft={...base,kind:'text',title:'Selection from '+result.appName,text:result.text,source:{appName:result.appName,bundleId:result.bundleId}};
        }else{
          const bytes=result.png;if(!Buffer.isBuffer(bytes)||bytes.length>20*1024*1024)throw fail('Capture must be a PNG up to 20 MiB');const {width,height}=inspectPng(bytes);
          nextDraft={...base,kind:'image',title:'Desktop screenshot',pngBase64:bytes.toString('base64'),width,height,source:{capture:'macOS interactive region/window'}};
        }
        drop();draft=nextDraft;timer=setTimeout(()=>{drop();changed();},draftMs);timer.unref?.();return snapshot().draft;
      }catch(e){if(closed||current.controller.signal.aborted||current.epoch!==epoch)return null;if(!closed&&!current.controller.signal.aborted){lastError=e?.error_code?e.message:'Desktop capture was unavailable. Check OS permissions or try another supported application.';}throw e;}
      finally{if(operation===current)operation=null;changed();}
    })();current.promise=task;return task;
  }
  async function trigger(action){
    ensure();if(action==='chat'||action==='voice'){onOpen(action);return;}
    try{await collect(action==='selection'?'selection':'screenshot');}finally{if(!closed)onOpen('desktop');}
  }
  function requireDraft(id){snapshot();if(!draft||draft.id!==id)throw fail('Desktop draft expired or was replaced');return draft;}
  async function dispatch(action,payload={},context={}){
    ensure();if(action==='desktop:snapshot')return snapshot();interactive(context);
    if(action==='desktop:shortcut:set')return changeShortcut(payload.action,payload.accelerator);
    if(action==='desktop:reset'){const next=defaults();persist(next);config=next;epoch++;operation?.controller.abort();drop();for(const key of [...owned])unregister(key);statuses={};lastError='';changed();return snapshot();}
    if(action==='desktop:selection:policy'){
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!['selectionEnabled','excludedApps'].includes(k)))throw fail('Unknown selection policy field');
      const next=validate({...config,...payload});persist(next);config=next;if(operation?.kind==='selection'){epoch++;operation.controller.abort();}if(draft?.kind==='text'&&(!config.selectionEnabled||config.excludedApps.includes(draft.source.bundleId)))drop();changed();return snapshot();
    }
    if(action==='desktop:permissions:refresh'){changed();return snapshot();}
    if(action==='desktop:screenshot'||action==='desktop:selection:read'){await collect(action.endsWith(':read')?'selection':'screenshot');return snapshot();}
    if(action==='desktop:cancel'){epoch++;operation?.controller.abort();changed();return snapshot();}
    if(action==='desktop:draft:read'){const d=requireDraft(payload.id);return d.kind==='image'?{id:d.id,kind:'image',title:d.title,dataUrl:'data:image/png;base64,'+d.pngBase64,width:d.width,height:d.height}:{id:d.id,kind:'text',title:d.title,text:d.text,source:clone(d.source)};}
    if(action==='desktop:draft:discard'){requireDraft(payload.id);drop();changed();return snapshot();}
    if(action==='desktop:draft:copy'){const d=requireDraft(payload.id);if(d.kind!=='text')throw fail('Open the image editor to copy a screenshot');copyText(d.text);return {copied:true};}
    if(action==='desktop:draft:save'){const d=requireDraft(payload.id);if(d.kind!=='text'||!saveText)throw fail('Use the image editor to save screenshots');const id=d.id;await saveText({title:d.title,text:d.text});if(draft?.id===id)drop();changed();return snapshot();}
    throw fail('Unknown desktop action');
  }
  async function close(){if(closed)return;closed=true;active=false;epoch++;drop();operation?.controller.abort();for(const key of [...owned])unregister(key);await operation?.promise?.catch(()=>{});}
  persist(config);return {snapshot,dispatch,activate,trigger,reserved,close};
}
module.exports={createDesktopService,ACTIONS};

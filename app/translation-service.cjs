'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const fail=message=>Object.assign(new Error(message),{error_code:'VEK_TRANSLATION_INVALID'});
function createTranslationService({dataDir,defaultConfig=null,onChange=()=>{},timeoutMs=90000}={}){
  const directory=path.join(dataDir,'translation');fs.mkdirSync(directory,{recursive:true,mode:0o700});if(fs.lstatSync(directory).isSymbolicLink())throw fail('Translation directory must not be a symlink');fs.chmodSync(directory,0o700);
  const file=path.join(directory,'settings.json');let config=defaultConfig,closed=false,running=null,work=null;
  function validate(value){if(value===null)return null;if(!value||typeof value.command!=='string'||!path.isAbsolute(value.command)||value.command.includes('\0')||!Array.isArray(value.args)||value.args.length>64||value.args.some(x=>typeof x!=='string'||x.includes('\0')||x.length>4096))throw fail('Use an absolute translation executable and argument array');fs.accessSync(value.command,fs.constants.X_OK);return {command:value.command,args:[...value.args],source:language(value.source||'en'),target:language(value.target||'zh')};}
  function language(value){if(typeof value!=='string'||!/^([a-z]{2,3})(-[A-Za-z0-9]{2,8})?$/.test(value))throw fail('Use a language code such as en or zh');return value;}
  if(fs.existsSync(file)){if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>32768)throw fail('Invalid translation settings');config=validate(JSON.parse(fs.readFileSync(file,'utf8')));}else if(config)config=validate(config);
  function snapshot(){return {configured:!!config,config:config&&{...config,args:[...config.args]},running:!!running,capability:'local-json-cli',maxTextBytes:32768};}
  function changed(){try{onChange(snapshot());}catch{}}
  function stop(){if(!running)return;running.stopped=true;const child=running.child;const kill=signal=>{try{process.platform==='win32'?child.kill(signal):process.kill(-child.pid,signal);}catch{}};kill('SIGTERM');const timer=setTimeout(()=>kill('SIGKILL'),500);timer.unref();child.once('close',()=>clearTimeout(timer));}
  async function dispatch(action,payload={},context={}){
    if(action==='translation:snapshot')return snapshot();if(closed)throw fail('Translation service is closed');if(!context.interactive)throw fail('Use the browser translation controls');
    if(action==='translation:cancel'){stop();return snapshot();}
    if(action==='translation:configure'){if(running)throw fail('Cancel translation before changing its provider');const next=validate(payload.disabled?null:payload);const temp=file+'.'+randomUUID();fs.writeFileSync(temp,JSON.stringify(next),{flag:'wx',mode:0o600});fs.renameSync(temp,file);config=next;changed();return snapshot();}
    if(action!=='translation:run')throw fail('Unknown translation action');if(!config)throw fail('Configure a local translation provider first');if(running)throw fail('A translation is already running');
    if(typeof payload.text!=='string'||!payload.text.trim()||payload.text.includes('\0')||Buffer.byteLength(payload.text)>32768)throw fail('Translation text must be nonempty and at most 32 KiB');
    const source=language(payload.source||config.source),target=language(payload.target||config.target),settings={...config};
    const child=spawn(settings.command,settings.args,{shell:false,detached:process.platform!=='win32',cwd:directory,stdio:['pipe','pipe','pipe'],env:{...process.env,VEK_TRANSLATION_DATA:path.join(directory,'models'),PYTHONUNBUFFERED:'1'}});const current={child,stopped:false};running=current;changed();
    work=new Promise((resolve,reject)=>{let output=[],size=0,diagnostics=0,timedOut=false;const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{size+=chunk.length;if(size>262144)stop();else output.push(chunk);});child.stderr.on('data',chunk=>{diagnostics+=chunk.length;if(diagnostics>262144)stop();});child.once('error',()=>{clearTimeout(timer);reject(fail('Translation executable could not start'));});child.once('close',(code,signal)=>{clearTimeout(timer);if(timedOut||current.stopped||code!==0||signal||size>262144||diagnostics>262144)return reject(fail(timedOut?'Translation timed out':current.stopped?'Translation cancelled':'Translation provider failed'));try{const result=JSON.parse(Buffer.concat(output).toString('utf8'));if(typeof result.text!=='string'||!result.text.trim()||Buffer.byteLength(result.text)>131072)throw fail('Translation provider returned invalid text');resolve({text:result.text,source,target,provider:path.basename(settings.command)});}catch{reject(fail('Translation provider returned invalid JSON text'));}});child.stdin.end(JSON.stringify({text:payload.text,source,target})+'\n');});
    try{return await work;}finally{if(running===current){running=null;work=null;changed();}}
  }
  return {snapshot,dispatch,async close(){closed=true;stop();await work?.catch(()=>{});}};
}
module.exports={createTranslationService};

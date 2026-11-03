'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const control=require('./scheduler-control.cjs'),execute=promisify(execFile),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=message=>Object.assign(new Error(message),{error_code:'VEK_SCHEDULER_JOB'});
const xml=s=>String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
async function nativeLaunchctl(args){try{const result=await execute('/bin/launchctl',args,{timeout:20000,maxBuffer:65536});return {code:0,stdout:result.stdout};}catch(e){return {code:typeof e.code==='number'?e.code:-1,stdout:'',absent:/could not find service/i.test(e.stderr||'')};}}
function createSchedulerJob({dataDir,root=path.resolve(__dirname,'..'),executable=process.execPath,launchAgentsDir=path.join(os.homedir(),'Library/LaunchAgents'),uid=process.getuid?.(),platform=process.platform,launchctl=nativeLaunchctl,now=Date.now}={}){
 const directory=control.directory(dataDir),file=path.join(directory,'job.json'),bootstrap=path.join(directory,'launch.cjs'),lastFile=path.join(directory,'last-job.json');
 dataDir=path.dirname(directory);root=fs.realpathSync(root);executable=fs.realpathSync(executable);launchAgentsDir=path.resolve(launchAgentsDir);
 const label='app.vek.scheduler.'+sha(Buffer.from(dataDir)).slice(0,24),domain='gui/'+uid,plist=path.join(launchAgentsDir,label+'.plist');
 let config,configurationError='';try{config=control.read(file,131072)||{version:1,enabled:false,installation:null};if(config.version!==1||typeof config.enabled!=='boolean')throw Error();}catch{configurationError='Background settings could not be validated. Restore or repair this settings file before changing the login job.';config={version:1,enabled:false,installation:null};}let loaded=null,error='',plan=null,closed=false,queue=Promise.resolve();
 function receiptValid(r){return r&&r.label===label&&r.plist===plist&&r.dataDir===dataDir&&typeof r.id==='string'&&typeof r.plistSha256==='string'&&typeof r.bootstrapSha256==='string';}
 if(config.installation&&!receiptValid(config.installation)){configurationError='Background setup identity does not match this profile. Login-job changes are blocked until the settings are repaired.';config={version:1,enabled:false,installation:null};}
 const persist=()=>{if(configurationError)throw fail(configurationError);control.write(file,config);};
 function ownedFile(target,digest){try{const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>131072||sha(fs.readFileSync(fd))!==digest)throw fail('Scheduler setup file changed; it was not overwritten or removed');return true;}finally{fs.closeSync(fd);}}catch(e){if(e.code==='ENOENT')return false;throw e;}}
 function snapshot(){let installed=false,conflict='';try{if(config.installation)installed=ownedFile(plist,config.installation.plistSha256);}catch(e){conflict=e.message;}let last;try{last=control.read(lastFile);}catch{}return {supported:platform==='darwin'&&Number.isSafeInteger(uid),enabled:config.enabled,installed:configurationError?null:installed,configured:!!config.installation,loaded,availability:configurationError?'blocked':!config.enabled?'disabled':loaded===false?'unavailable':loaded===true?'registered':'unchecked',availabilityReason:config.enabled&&loaded===false?'The reviewed job is not registered in this GUI session. macOS background permission, logout or external removal may prevent execution. Review Settings and refresh; Wiek does not re-enable it automatically.':null,label,plist,bootstrap,domain,runtime:config.installation?.runtime?{root:config.installation.runtime.root,executable:config.installation.runtime.executable,version:config.installation.runtime.version,nodeVersion:config.installation.runtime.nodeVersion}:null,lastTick:last?.installationId===config.installation?.id&&typeof last?.at==='string'&&['completed','skipped-locked','yielded-foreground','disabled','cancelled','timed-out','needs-review','failed','unavailable'].includes(last?.status)?{at:last.at.slice(0,64),status:last.status,...(Number.isSafeInteger(last.attempted)?{attempted:last.attempted}:{}),...(Number.isSafeInteger(last.skipped)?{skipped:last.skipped}:{})}:null,error:configurationError||conflict||error,plan:plan?{token:plan.token,expiresAt:plan.expiresAt,executable,root,plist,bootstrap,calendar:'Every minute; missed checks coalesce after wake',timeoutMs:plan.receipt.timeoutMs,version:plan.receipt.runtime.version,nodeVersion:plan.receipt.runtime.nodeVersion}:null};}
 async function status(){const r=await launchctl(['print',domain+'/'+label]);if(r.code===0)return true;if(r.absent===true)return false;throw fail('Cannot query this login job in the current macOS GUI session');}
 async function runtime(){
  const records=[];for(const entry of fs.readdirSync(path.join(root,'app'),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)))if(entry.isFile()&&/\.(cjs|mjs|js)$/.test(entry.name)){const name='app/'+entry.name,target=path.join(root,name);if(fs.lstatSync(target).isSymbolicLink())throw fail('Runtime source must be a regular file');records.push({file:name,sha256:sha(fs.readFileSync(target))});}
  records.push({file:'package.json',sha256:sha(fs.readFileSync(path.join(root,'package.json')))});
  const probe=await execute(executable,['-p','JSON.stringify({node:process.versions.node})'],{env:{PATH:process.env.PATH||'/usr/bin:/bin',ELECTRON_RUN_AS_NODE:'1'},timeout:5000,maxBuffer:4096});let version;try{version=JSON.parse(probe.stdout).node;}catch{throw fail('Selected runtime did not provide Node.js');}if(typeof version!=='string'||!/^\d+\.\d+\.\d+$/.test(version)||Number(version.split('.')[0])<24)throw fail('Background scheduling requires Node.js 24 or later');
  return {root,executable,nodeVersion:version,executableSha256:sha(fs.readFileSync(executable)),version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,records};
 }
 function makePlist(receipt){return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>'+label+'</string><key>ProgramArguments</key><array><string>'+xml(executable)+'</string><string>'+xml(bootstrap)+'</string></array><key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string><key>PATH</key><string>'+xml(process.env.PATH||'/usr/bin:/bin:/usr/sbin:/sbin')+'</string></dict><key>StartCalendarInterval</key><dict/><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string><key>ExitTimeOut</key><integer>30</integer><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string><key>AssociatedBundleIdentifiers</key><string>app.wiek.browser</string></dict></plist>\n';}
 async function disable(remove){
  plan=null;config.enabled=false;persist();
  if(!config.installation){loaded=false;return snapshot();}
  const receipt=config.installation;ownedFile(plist,receipt.plistSha256);ownedFile(bootstrap,receipt.bootstrapSha256);
  await control.requestWorkerStop(dataDir,{reason:'disabled'});
  loaded=await status();if(loaded){const out=await launchctl(['bootout',domain+'/'+label]);if(out.code!==0)throw fail('The login job could not be unloaded. Execution consent is off; retry cleanup.');loaded=await status();if(loaded)throw fail('The login job is still loaded; execution consent is off.');}
  if(ownedFile(plist,receipt.plistSha256))fs.unlinkSync(plist);
  if(remove){if(ownedFile(bootstrap,receipt.bootstrapSha256))fs.unlinkSync(bootstrap);config.installation=null;persist();}
  error='';return snapshot();
 }
 async function act(action,payload){
  if(closed)throw fail('Scheduler settings are closed');if(action==='scheduler:snapshot')return snapshot();
  if(platform!=='darwin'||!Number.isSafeInteger(uid))throw fail('Login scheduling currently supports macOS only');
  error='';
  if(action==='scheduler:job:refresh'){loaded=await status();return snapshot();}
  if(action==='scheduler:job:cancel'){plan=null;return snapshot();}
  if(configurationError&&action!=='scheduler:job:refresh'&&action!=='scheduler:job:cancel')throw fail(configurationError);
  if(action==='scheduler:job:prepare'){
   if(config.enabled)throw fail('Disable the current login job before reviewing a replacement');
   const timeoutMs=payload.timeoutMs??60000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>3600000)throw fail('Worker timeout must be between one second and one hour');
   const r={id:crypto.randomUUID(),label,plist,dataDir,timeoutMs,runtime:await runtime()},source=fs.readFileSync(path.join(root,'app/scheduler-launch.cjs'));r.bootstrapSha256=sha(source);const body=makePlist(r);r.plistSha256=sha(Buffer.from(body));
   plan={token:crypto.randomUUID(),expiresAt:now()+180000,receipt:r,body,source,fingerprint:sha(Buffer.from(JSON.stringify(config)))};return snapshot();
  }
  if(action==='scheduler:job:enable'){
   const review=plan;plan=null;if(!review||review.token!==payload.token||review.expiresAt<=now()||review.fingerprint!==sha(Buffer.from(JSON.stringify(config))))throw fail('Background scheduling review expired or changed; prepare it again');
   if(JSON.stringify(await runtime())!==JSON.stringify(review.receipt.runtime))throw fail('Runtime changed after review; prepare again');
   if(config.installation){ownedFile(plist,config.installation.plistSha256);ownedFile(bootstrap,config.installation.bootstrapSha256);}else if(fs.existsSync(plist)||fs.existsSync(bootstrap))throw fail('A setup file already exists without a matching receipt');
   loaded=await status();if(loaded)throw fail('This job label is already loaded; no replacement was installed');
   if(fs.existsSync(launchAgentsDir)&&(!fs.lstatSync(launchAgentsDir).isDirectory()||fs.lstatSync(launchAgentsDir).isSymbolicLink()))throw fail('LaunchAgents must be a real directory');fs.mkdirSync(launchAgentsDir,{recursive:true});
   config={version:1,enabled:false,installation:review.receipt};persist();
   const put=(target,bytes)=>{try{if(fs.lstatSync(target).isSymbolicLink())throw fail('Setup paths cannot be symlinks');}catch(e){if(e.code!=='ENOENT')throw e;}const temporary=target+'.'+crypto.randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,target);}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch{}}};
   try{put(bootstrap,review.source);put(plist,review.body);config.enabled=true;persist();const r=await launchctl(['bootstrap',domain,plist]);if(r.code!==0)throw fail('macOS did not load the reviewed login job');loaded=await status();if(!loaded)throw fail('macOS did not confirm this job was loaded');}
   catch(e){config.enabled=false;persist();try{await disable(false);}catch{error='Installation failed and cleanup needs attention. Execution consent is off.';}throw e;}
   return snapshot();
  }
  if(action==='scheduler:job:disable')return disable(false);
  if(action==='scheduler:job:remove')return disable(true);
  throw fail('Unknown scheduler settings action');
 }
 function dispatch(action,payload={},context={}){if(action==='scheduler:snapshot')return Promise.resolve(snapshot());if(context.interactive!==true)return Promise.reject(fail('Use the browser Background scheduling settings to manage login jobs'));const task=queue.catch(()=>{}).then(()=>act(action,payload)).catch(e=>{error=e.message;throw e;});queue=task;return task;}
 return {snapshot,dispatch,close:async()=>{closed=true;plan=null;await queue.catch(()=>{});plan=null;}};
}
module.exports={createSchedulerJob,nativeLaunchctl};

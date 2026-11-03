'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {run,createNativeDesktop}=require('./desktop-native.cjs');
const fail=message=>Object.assign(new Error(message),{error_code:'VEK_DESKTOP_MONITOR_NATIVE'});
function stream(command,args,{input={},onMessage=()=>{},onClose=()=>{},spawnProcess=spawn,readyMs=4000}={}){
  const child=spawnProcess(command,args,{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8'}});
  let buffer='',closed=false,reason='',resolveReady,rejectReady,resolveExit,timer,killTimer,ready=false;
  const started=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject});
  // Callers may cancel before awaiting readiness.
  started.catch(()=>{});const exited=new Promise(resolve=>resolveExit=resolve);
  function stop(code='cancelled'){reason ||= code;if(!closed){child.kill('SIGTERM');killTimer ||= setTimeout(()=>child.kill('SIGKILL'),1000);}return exited;}
  child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
  timer=setTimeout(()=>stop('startup_timeout'),Math.max(10,readyMs));
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
    if(reason||closed)return;buffer+=chunk;if(Buffer.byteLength(buffer)>560000)return void stop('output_limit');
    let split;while((split=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,split);buffer=buffer.slice(split+1);if(!line||Buffer.byteLength(line)>280000)return void stop('invalid_frame');let value;try{value=JSON.parse(line)}catch{return void stop('invalid_frame')}
      if(!value||Array.isArray(value)||typeof value!=='object')return void stop('invalid_frame');
      if(value.type==='error')return void stop(typeof value.code==='string'&&/^[a-z_]{1,64}$/.test(value.code)?value.code:'native_error');
      if(!ready){if(value.type!=='ready')return void stop('missing_ready');ready=true;clearTimeout(timer);resolveReady();continue;}
      if(!['selection','clear','action'].includes(value.type))return void stop('invalid_frame');
      try{onMessage(value)}catch{void stop('consumer_failed')}
    }
  });
  child.once('error',()=>{reason ||= 'start_failed'});child.once('close',()=>{closed=true;clearTimeout(timer);clearTimeout(killTimer);if(!ready)rejectReady(fail('Desktop monitor could not start: '+(reason||'closed')));resolveExit();try{onClose(reason||'closed')}catch{}});
  return {started,stop,exited};
}
function createDesktopMonitorNative({dataDir,platform=process.platform,helper=path.join(__dirname,'bin/vek-desktop-monitor'),execute=run,startStream=stream,screenPermission=()=> 'unknown'}={}){
  const available=platform==='darwin'&&fs.existsSync(helper),capture=createNativeDesktop({dataDir,platform,execute,screenPermission});
  const assert=()=>{if(!available)throw fail('Native desktop monitoring is unavailable on this platform')};
  async function command(mode){assert();const r=await execute(helper,[mode],{timeoutMs:3000,maxBytes:131072});if(r.code!==0)throw fail('Desktop helper failed');let value;try{value=JSON.parse(r.stdout)}catch{throw fail('Desktop helper returned invalid data')}return value;}
  function watch(mode,options){assert();return startStream(helper,[mode],{...options,input:{excludedApps:options.excludedApps||[],...(mode==='--record'?{bundleId:options.bundleId}:{})}});}
  async function captureWindow({source,windowId,signal}={}){
    assert();if(!Number.isSafeInteger(windowId)||windowId<=0||!source?.bundleId||!Number.isSafeInteger(source.pid))throw fail('Invalid recording window');
    const before=await command('--frontmost');if(before.bundleId!==source.bundleId||before.pid!==source.pid)throw fail('Recorded application changed');
    const result=await capture.screenshot({signal,windowId});
    const after=await command('--frontmost');if(after.bundleId!==source.bundleId||after.pid!==source.pid)throw fail('Recorded application changed');return result;
  }
  return {available,apps:()=>command('--apps').then(v=>v.apps),status:()=>command('--status'),frontmost:()=>command('--frontmost'),watchSelections:options=>watch('--selection-watch',options),watchActions:options=>watch('--record',options),captureWindow};
}
module.exports={createDesktopMonitorNative,stream};

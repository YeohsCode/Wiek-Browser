'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const fail=(message,code='VEK_DESKTOP_NATIVE')=>Object.assign(new Error(message),{error_code:code});
// Fixed executables and argv only. No shell, simulated Copy, clipboard polling,
// event hook or background capture. Tests replace the process runner explicitly.
function run(command,args,{signal,input,timeoutMs=5000,maxBytes=300000}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(fail('Desktop operation cancelled'));
    const child=spawn(command,args,{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8'}});let output=[],size=0,reason,timer,killTimer;
    const stop=message=>{reason ||= fail(message);child.kill('SIGTERM');killTimer ||= setTimeout(()=>child.kill('SIGKILL'),1000);};
    const abort=()=>stop('Desktop operation cancelled');signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>stop('Desktop operation timed out'),timeoutMs);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)stop('Desktop helper output exceeded its limit');else output.push(chunk);});
    // stderr can contain private app/window details. Do not log or expose it.
    child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(input||'');
    child.once('error',()=>{reason ||= fail('Desktop helper could not start');});
    child.once('close',(code,term)=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);reason?reject(reason):resolve({code,signal:term,stdout:Buffer.concat(output).toString('utf8')});});
  });
}
function createNativeDesktop({dataDir,platform=process.platform,helper=path.join(__dirname,'bin/vek-selection'),execute=run,screenPermission=()=> 'unknown'}={}){
  const directory=path.join(path.resolve(dataDir),'desktop','temporary');
  const base=path.dirname(directory);if(fs.existsSync(base)&&(!fs.lstatSync(base).isDirectory()||fs.lstatSync(base).isSymbolicLink()))throw fail('Invalid desktop state directory');fs.mkdirSync(base,{recursive:true,mode:0o700});fs.chmodSync(base,0o700);
  if(fs.existsSync(directory)&&(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink()))throw fail('Invalid desktop capture temporary directory');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
  // Only directories created by this adapter, after the host's Library lock was
  // acquired. Never traverse external symlinks or inspect unrelated files.
  for(const name of fs.readdirSync(directory))if(/^capture-[A-Za-z0-9_-]+$/.test(name)){const target=path.join(directory,name);if(fs.lstatSync(target).isDirectory()&&!fs.lstatSync(target).isSymbolicLink())fs.rmSync(target,{recursive:true,force:true});}
  async function screenshot({signal,windowId}={}){
    if(platform!=='darwin')throw fail('Native region capture currently supports macOS');
    if(['denied','restricted'].includes(screenPermission()))throw fail('Screen Recording permission is not granted. Open macOS settings to enable capture.');
    const scratch=await fsp.mkdtemp(path.join(directory,'capture-')),file=path.join(scratch,'region.png');
    try{
      if(windowId!==undefined&&(!Number.isSafeInteger(windowId)||windowId<=0))throw fail('Invalid capture window');
      const args=windowId===undefined?['-i','-x','-t','png',file]:['-l',String(windowId),'-o','-x','-t','png',file];
      const result=await execute('/usr/sbin/screencapture',args,{signal,timeoutMs:120000,maxBytes:4096});
      if(signal?.aborted)throw fail('Desktop operation cancelled');
      let stat;try{stat=await fsp.lstat(file)}catch(e){if(['denied','restricted'].includes(screenPermission()))throw fail('Screen Recording permission is not granted.');if(e.code==='ENOENT'&&(result.code===0||result.code===1))return null;throw fail('The screenshot was not created. Check Screen Recording permission.');}
      if(result.code!==0||stat.isSymbolicLink()||!stat.isFile()||stat.size>20*1024*1024)throw fail('The screenshot could not be read safely');
      const fd=await fsp.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const opened=await fd.stat();if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size)throw fail('Capture changed before it was read');await fd.chmod(0o600);const png=await fd.readFile();if(png.length!==stat.size)throw fail('Capture changed while reading');return {png};}finally{await fd.close();}
    }finally{await fsp.rm(scratch,{recursive:true,force:true});}
  }
  async function selectedText({signal,excludedApps=[]}={}){
    if(platform!=='darwin'||!fs.existsSync(helper))throw fail('Native selected-text helper is unavailable');
    const result=await execute(helper,[],{signal,input:JSON.stringify({excludedApps}),timeoutMs:3000,maxBytes:280000});
    if(result.code!==0)throw fail('Selected text could not be read');let value;try{value=JSON.parse(result.stdout)}catch{throw fail('Selected-text helper returned invalid data');}
    if(value.ok!==true){const errors={accessibility_denied:'Accessibility permission is not granted. Enable Wiek in macOS settings before reading another application.',excluded:'Selected application is excluded.',secure:'Protected text controls are not captured.',no_selection:'No selected text is available in this control.',unsupported:'The application does not expose a supported text selection.',too_large:'Selected text exceeds 128 KiB.'};throw fail(errors[value.code]||'Selected text is unavailable');}
    return {text:value.text,appName:value.appName,bundleId:value.bundleId,secure:false};
  }
  return {screenshot:platform==='darwin'?screenshot:undefined,selection:platform==='darwin'&&fs.existsSync(helper)?selectedText:undefined};
}
module.exports={createNativeDesktop,run};

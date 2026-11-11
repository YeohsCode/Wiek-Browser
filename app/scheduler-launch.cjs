'use strict';
// Copied verbatim into the private scheduler directory only on reviewed enable.
// Built-ins only until consent, exact runtime paths and the code receipt verify.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function read(file){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>131072)throw Error('Invalid job metadata');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}
async function launch(directory=__dirname){
 const file=path.join(directory,'job.json');let config;try{config=read(file);}catch{return {status:'unavailable'};}
 if(!config.enabled||!config.installation)return {status:'disabled'};
 const receipt=config.installation,root=receipt.runtime?.root,dataDir=path.dirname(directory);let result;
 const record=value=>{try{const current=read(file);if(current.installation?.id!==receipt.id)return;const temp=path.join(directory,'.last-'+crypto.randomUUID());fs.writeFileSync(temp,JSON.stringify({at:new Date().toISOString(),installationId:receipt.id,...value}),{flag:'wx',mode:0o600});fs.renameSync(temp,path.join(directory,'last-job.json'));}catch{}};
 try{
  if(process.versions.node!==receipt.runtime?.nodeVersion||config.version!==1||receipt.dataDir!==dataDir||typeof root!=='string'||!path.isAbsolute(root)||fs.realpathSync(root)!==root||!Array.isArray(receipt.runtime.records)||receipt.runtime.records.length>256)throw Error();
  const codeEntries=fs.readdirSync(path.join(root,'app'),{withFileTypes:true}).filter(e=>/\.(cjs|mjs|js)$/.test(e.name));if(codeEntries.some(e=>!e.isFile()||e.isSymbolicLink()))throw Error();
  const expectedFiles=codeEntries.map(e=>'app/'+e.name).sort().concat('package.json');if(JSON.stringify(receipt.runtime.records.map(r=>r.file).sort())!==JSON.stringify(expectedFiles.sort()))throw Error();
  const executable=receipt.runtime.executable;if(fs.realpathSync(process.execPath)!==executable||typeof executable!=='string'||fs.realpathSync(executable)!==executable||hash(fs.readFileSync(executable))!==receipt.runtime.executableSha256)throw Error();
  for(const item of receipt.runtime.records){if(typeof item.file!=='string'||!(/^(?:app\/[A-Za-z0-9_-]+\.(?:cjs|mjs|js)|package\.json)$/.test(item.file))||item.file.split('/').includes('..'))throw Error();const target=path.join(root,item.file);if(fs.realpathSync(target)!==target||!fs.lstatSync(target).isFile()||hash(fs.readFileSync(target))!==item.sha256)throw Error();}
  if(!receipt.runtime.records.some(r=>r.file==='app/scheduler-worker.cjs')||!receipt.runtime.records.some(r=>r.file==='package.json'))throw Error();
 }catch{result={status:'needs-review',reason:'The reviewed runtime is missing, moved or changed. Disable and review this setup again.'};record(result);return result;}
 const guard=()=>{try{const current=read(file);return current.enabled===true&&current.installation?.id===receipt.id;}catch{return false;}};
 if(!guard())return {status:'disabled'};
 const priorNodeMode=process.env.ELECTRON_RUN_AS_NODE;delete process.env.ELECTRON_RUN_AS_NODE;
 const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGTERM',abort);process.once('SIGINT',abort);
 try{const tick=await require(path.join(root,'app/scheduler-worker.cjs')).runSchedulerTick({dataDir,timeoutMs:receipt.timeoutMs,signal:controller.signal,guard});result={status:tick.status,attempted:tick.attempted.length,skipped:tick.skipped.length};}
 catch{result={status:'failed',reason:'Background tick failed. Open Wiek to inspect configuration and recorded runs.'};}
 finally{process.removeListener('SIGTERM',abort);process.removeListener('SIGINT',abort);if(priorNodeMode===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=priorNodeMode;}
 record(result);return result;
}
module.exports={launch};
if(require.main===module)launch().then(result=>{if(['failed','needs-review'].includes(result.status))process.exitCode=1;}).catch(()=>{process.exitCode=1;});

'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{randomUUID,timingSafeEqual}=require('node:crypto');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function directory(dataDir){const dir=path.join(path.resolve(dataDir),'scheduler');if(fs.existsSync(dir)&&(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink()))throw new Error('Invalid scheduler directory');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);return fs.realpathSync(dir);}
function read(file,max=8192){try{const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>max)throw new Error('Invalid scheduler metadata');const bytes=Buffer.alloc(max+1),length=fs.readSync(fd,bytes,0,bytes.length,0);if(length>max||length!==st.size)throw new Error('Scheduler metadata changed while reading');return JSON.parse(bytes.subarray(0,length).toString('utf8'));}finally{fs.closeSync(fd);}}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function write(file,value){const temp=file+'.'+randomUUID()+'.tmp';let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
function ownedRemove(file,token){try{if(read(file)?.token===token)fs.unlinkSync(file);}catch{}}
function foregroundPresent(dataDir){try{fs.lstatSync(path.join(directory(dataDir),'foreground.lock'));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function startControl(dataDir,onStop){
 const dir=directory(dataDir),file=path.join(dir,'worker.json'),token=randomUUID(),instance=randomUUID();
 if(read(file)){const old=read(file);if(alive(old.pid))throw new Error('A scheduler worker control endpoint is already active');fs.unlinkSync(file);}
 const server=http.createServer((req,res)=>{
  const expected=Buffer.from('Bearer '+token),got=Buffer.from(req.headers.authorization||'');
  if(req.headers.origin!==undefined||got.length!==expected.length||!timingSafeEqual(got,expected)){res.writeHead(403);res.end();return;}
  if(req.method!=='POST'||req.url!=='/stop'){res.writeHead(404);res.end();return;}
  let body='',bytes=0;req.on('data',chunk=>{bytes+=chunk.length;if(bytes>256){res.writeHead(413);res.end();req.destroy();}else body+=chunk;});
  req.on('end',()=>{if(res.writableEnded)return;let value;try{value=JSON.parse(body);}catch{res.writeHead(400);res.end();return;}if(!['foreground','disabled'].includes(value.reason)){res.writeHead(400);res.end();return;}res.writeHead(202,{'Content-Type':'application/json'});res.end(JSON.stringify({accepted:true,instance}));onStop(value.reason);});
 });server.requestTimeout=2000;server.headersTimeout=2000;server.maxHeadersCount=20;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{write(file,{version:1,pid:process.pid,port:server.address().port,token,instance,dataDir:path.dirname(dir)});}catch(e){await new Promise(r=>server.close(r));throw e;}
 return {close:async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});ownedRemove(file,token);}};
}
async function requestWorkerStop(dataDir,{reason='foreground',timeoutMs=15000}={}){
 const dir=directory(dataDir),file=path.join(dir,'worker.json'),deadline=Date.now()+timeoutMs;let requestedInstance;
 while(Date.now()<deadline){
  const meta=read(file),lock=read(path.join(path.resolve(dataDir),'agents/service.lock'));
  if(!meta){if(!lock||!alive(lock.pid))return {settled:true};if(lock.role!=='scheduler'){if(reason==='disabled')return {settled:true};throw new Error('Another foreground Agent service is already using this directory');}await sleep(25);continue;}
  if(meta.version!==1||meta.dataDir!==path.dirname(dir)||!Number.isInteger(meta.port)||meta.port<1||meta.port>65535||!Number.isSafeInteger(meta.pid)||meta.pid<=0||![meta.token,meta.instance].every(v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v)))throw new Error('Invalid scheduler worker identity');
  if(!alive(meta.pid)){if(!lock||!alive(lock.pid))return {settled:true};await sleep(25);continue;}
  if(requestedInstance===meta.instance){await sleep(25);continue;}
  try{await new Promise((resolve,reject)=>{
   const req=http.request({host:'127.0.0.1',port:meta.port,path:'/stop',method:'POST',headers:{Authorization:'Bearer '+meta.token,'Content-Type':'application/json'},timeout:1500},res=>{let body='';res.on('data',b=>{body+=b;if(body.length>1024)req.destroy(new Error('Invalid scheduler response'));});res.on('end',()=>{try{const value=JSON.parse(body);if(res.statusCode!==202||!value.accepted||value.instance!==meta.instance)throw new Error('Scheduler identity changed');resolve();}catch(e){reject(e);}});});req.once('timeout',()=>req.destroy(new Error('Scheduler handoff timed out')));req.once('error',reject);req.end(JSON.stringify({reason}));
  });requestedInstance=meta.instance;}catch{if(Date.now()+100>=deadline)break;}
  await sleep(25);
 }
 throw new Error('The background worker has not released its data lease. Wait for it to finish and try again; no force-kill was sent.');
}
async function claimForeground(dataDir,{timeoutMs=15000}={}){
 const dir=directory(dataDir),file=path.join(dir,'foreground.lock'),token=randomUUID(),reaper=file+'.recovery';let fd;
 try{fd=fs.openSync(file,'wx',0o600);}catch(e){
  if(e.code!=='EEXIST')throw e;const old=read(file);if(!old||alive(old.pid))throw new Error('Another Wiek foreground host is starting or running');
  let recovery;try{recovery=fs.openSync(reaper,'wx',0o600);fs.writeFileSync(recovery,JSON.stringify({pid:process.pid,token}));const current=read(file);if(JSON.stringify(current)!==JSON.stringify(old)||alive(current.pid))throw new Error('Foreground identity changed during recovery');fs.unlinkSync(file);fd=fs.openSync(file,'wx',0o600);}finally{if(recovery!==undefined){fs.closeSync(recovery);ownedRemove(reaper,token);}}
 }
 try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 try{await requestWorkerStop(dataDir,{timeoutMs});return {release:()=>ownedRemove(file,token)};}catch(e){ownedRemove(file,token);throw e;}
}
module.exports={directory,read,write,alive,foregroundPresent,startControl,requestWorkerStop,claimForeground};

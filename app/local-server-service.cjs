'use strict';
// Independent project-scoped listener discovery and explicitly reviewed stop.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {readLocalTitle}=require('./local-server-title.cjs');
const fail=(message,code='WIEK_LOCAL_SERVER_INVALID')=>Object.assign(new Error(message),{error_code:code});
const allowed=new Set(['node','bun','deno','ruby','php','java','dotnet','uvicorn','gunicorn','go','air','python','python3','python3.11','python3.12','python3.13','python3.14']);
const contains=(root,cwd)=>cwd===root||cwd.startsWith(root+path.sep);
function execute(command,args,{input='',limit=2*1024*1024,timeoutMs=5000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{shell:false,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'}});
    let out='',size=0,ended=false;
    const finish=(error,result)=>{if(ended)return;ended=true;clearTimeout(timer);error?reject(error):resolve(result);};
    const stop=message=>{child.kill('SIGKILL');finish(fail(message,'WIEK_LOCAL_SERVER_DISCOVERY'));};
    const timer=setTimeout(()=>stop('Process discovery timed out'),timeoutMs);
    child.stdin.on('error',()=>{});child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>limit)stop('Process discovery output limit exceeded');else out+=chunk;});
    // Never retain stderr: diagnostics may contain unrelated local metadata.
    child.stderr.on('data',chunk=>{size+=chunk.length;if(size>limit)stop('Process discovery output limit exceeded');});
    child.once('error',()=>finish(fail('Process discovery could not start','WIEK_LOCAL_SERVER_DISCOVERY')));
    child.once('close',(code,signal)=>finish(null,{code,signal,out}));child.stdin.end(input);
  });
}
function parseListeners(text){
  const rows=[];let pid=null,name='';
  for(const line of text.split('\n')){
    if(line[0]==='p'){pid=Number(line.slice(1));name='';}
    else if(line[0]==='c')name=line.slice(1,257);
    else if(line[0]==='n'&&Number.isSafeInteger(pid)&&pid>1){
      const value=line.slice(1),match=/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value);
      if(!match)continue;const port=Number(match[3]);if(port<1||port>65535)continue;
      const address=match[1]||match[2];if(!/^[A-Za-z0-9.*:%_-]+$/.test(address))continue;
      if(!rows.some(row=>row.pid===pid&&row.port===port&&row.address===address))rows.push({pid,name,address,port});
      if(rows.length>512)throw fail('Too many listening endpoints; narrow the running services','WIEK_LOCAL_SERVER_CAPACITY');
    }
  }
  return rows;
}
function createNativeServerProbe({platform=process.platform,helper=path.join(__dirname,'bin/wiek-process-info'),run=execute}={}){
  const available=platform==='darwin'&&fs.existsSync(helper)&&fs.existsSync('/usr/sbin/lsof');
  async function inspect(pids){
    if(!available)throw fail('Native local service discovery is unavailable','WIEK_LOCAL_SERVER_UNAVAILABLE');
    if(pids.length>256)throw fail('Process inspection limit exceeded','WIEK_LOCAL_SERVER_CAPACITY');
    const result=await run(helper,[],{input:JSON.stringify(pids)});
    if(result.code!==0||result.signal)throw fail('Process identity inspection failed','WIEK_LOCAL_SERVER_DISCOVERY');
    let rows;try{rows=JSON.parse(result.out);}catch{throw fail('Invalid process identity response');}
    if(!Array.isArray(rows)||rows.length>pids.length||rows.some(row=>!pids.includes(row.pid)||!Number.isSafeInteger(row.ppid)||row.uid!==process.getuid()||typeof row.started!=='string'||!/^\d+:\d+$/.test(row.started)||!path.isAbsolute(row.cwd||'')||!path.isAbsolute(row.executable||'')||typeof row.zombie!=='boolean'))throw fail('Invalid process identity response');
    return rows;
  }
  return {available,inspect,async listeners(){
    if(!available)throw fail('Native local service discovery is unavailable','WIEK_LOCAL_SERVER_UNAVAILABLE');
    const result=await run('/usr/sbin/lsof',['-nP','-a','-u',String(process.getuid()),'-iTCP','-sTCP:LISTEN','-Fpcn']);
    if(result.code===1&&!result.out&&!result.signal)return [];
    if(result.code!==0||result.signal)throw fail('Listening port discovery failed','WIEK_LOCAL_SERVER_DISCOVERY');
    return parseListeners(result.out);
  }};
}
const identity=row=>crypto.createHash('sha256').update(JSON.stringify([row.pid,row.uid,row.started,row.executable,row.cwd])).digest('hex');
const endpoints=rows=>JSON.stringify(rows.map(({address,port})=>({address,port})).sort((a,b)=>a.port-b.port||a.address.localeCompare(b.address)));
function createLocalServerService({probe=createNativeServerProbe(),signal=(pid,value)=>process.kill(pid,value),now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),settleMs=1500,fetchTitle=readLocalTitle}={}){
  const reviews=new Map(),titleReads=new Set();let closed=false;
  const ensure=()=>{if(closed)throw fail('Local service manager is closed');};
  function expire(){for(const [id,review]of reviews)if(review.expires<=now())reviews.delete(id);}
  async function list(ctx){
    ensure();expire();
    const listeners=await probe.listeners(),pids=[...new Set(listeners.map(row=>row.pid))];
    if(pids.length>255)throw fail('Process inspection limit exceeded','WIEK_LOCAL_SERVER_CAPACITY');
    const metadata=await probe.inspect([...new Set([...pids,process.pid])]);
    const protectedPids=new Set([process.pid]);let ancestor=metadata.find(row=>row.pid===process.pid)?.ppid,lineageComplete=Number.isSafeInteger(ancestor);
    for(let depth=0;ancestor>1&&depth<32;depth++){
      if(protectedPids.has(ancestor)){lineageComplete=false;break;}
      protectedPids.add(ancestor);const parent=(await probe.inspect([ancestor]))[0];if(!parent||parent.ppid===ancestor){lineageComplete=false;break;}ancestor=parent.ppid;
    }
    if(ancestor>1)lineageComplete=false;
    const servers=[];
    for(const record of metadata){
      if(record.zombie||!contains(ctx.root,record.cwd)||!pids.includes(record.pid))continue;
      const ports=listeners.filter(row=>row.pid===record.pid).map(({address,port})=>({address,port})).sort((a,b)=>a.port-b.port||a.address.localeCompare(b.address));
      const urls=[...new Set(ports.flatMap(row=>['*','0.0.0.0','127.0.0.1','localhost','::','::1'].includes(row.address)?[`http://${row.address==='::1'?'[::1]':'127.0.0.1'}:${row.port}/`]:[]))];
      const name=path.basename(record.executable),isStoppable=lineageComplete&&!protectedPids.has(record.pid)&&allowed.has(name.toLowerCase());
      servers.push({pid:record.pid,name,cwd:record.cwd,ports,urls,isStoppable,stopDisabledReason:isStoppable?null:'This process is protected or its runtime is outside the supported stop list.',fingerprint:identity(record)});
    }
    ensure();return {projectId:ctx.project.id,generatedAt:new Date(now()).toISOString(),servers:servers.sort((a,b)=>a.ports[0].port-b.ports[0].port||a.pid-b.pid),automaticProbes:false};
  }
  async function dispatch(action,payload,ctx,authority={}){
    ensure();
    if(action==='workspace:servers:list')return list(ctx);
    if (action === 'workspace:servers:identify') {
      if (!authority.interactive) throw fail('Use the local service controls to identify services','WIEK_LOCAL_SERVER_INTERACTIVE');
      const result = await list(ctx);
      const tasks = result.servers.flatMap(row => row.urls.map(url => ({row, url}))).slice(0, 12);
      for (let offset = 0; offset < tasks.length; offset += 3) {
        await Promise.all(tasks.slice(offset, offset + 3).map(async ({row, url}) => {
          try {
            const value = await dispatch('workspace:servers:title', {pid:row.pid, fingerprint:row.fingerprint, url}, ctx, authority);
            (row.titles ??= {})[url] = value;
          } catch {
            // A failed or stale read leaves the original listener available.
          }
        }));
      }
      ensure();
      return {...result, attemptedTitles:tasks.length};
    }
    if(action==='workspace:servers:title'){
      if(!authority.interactive)throw fail('Use the local service controls to read a title','WIEK_LOCAL_SERVER_INTERACTIVE');
      if(titleReads.size>=4)throw fail('Too many title reads','WIEK_LOCAL_SERVER_CAPACITY');
      const controller=new AbortController();titleReads.add(controller);
      try{
        const row=(await list(ctx)).servers.find(row=>row.pid===payload.pid);
        if(!row||row.fingerprint!==payload.fingerprint||!row.urls.includes(payload.url))throw fail('The service changed; refresh the list','WIEK_LOCAL_SERVER_STALE');
        const result=await fetchTitle(payload.url,{signal:controller.signal});ensure();
        const current=(await list(ctx)).servers.find(item=>item.pid===row.pid);
        if(!current||current.fingerprint!==row.fingerprint||endpoints(current.ports)!==endpoints(row.ports))throw fail('The service changed during the title read','WIEK_LOCAL_SERVER_STALE');
        return {pid:row.pid,url:payload.url,...result};
      }finally{titleReads.delete(controller);}
    }
    if(!authority.interactive)throw fail('Use the local service controls to review and stop a process','WIEK_LOCAL_SERVER_INTERACTIVE');
    if(action==='workspace:servers:cancel'){const review=reviews.get(payload.reviewId);if(review&&review.projectId===ctx.project.id)reviews.delete(payload.reviewId);return {cancelled:true};}
    if(action==='workspace:servers:prepare-stop'){
      if(!Number.isSafeInteger(payload.pid)||payload.pid<=1)throw fail('Choose a listed local service');
      const row=(await list(ctx)).servers.find(row=>row.pid===payload.pid);if(!row)throw fail('The selected service is no longer in this project');
      if(!row.isStoppable)throw fail(row.stopDisabledReason);if(reviews.size>=64)throw fail('Stop review limit reached');
      const reviewId=crypto.randomUUID(),expires=now()+30000;
      reviews.set(reviewId,{projectId:ctx.project.id,root:ctx.root,row,expires});
      return {reviewId,expiresAt:new Date(expires).toISOString(),process:{pid:row.pid,name:row.name,cwd:row.cwd,ports:row.ports},signal:'SIGTERM'};
    }
    if(action!=='workspace:servers:stop')throw fail('Unknown local service action');
    if(payload.confirm!==true)throw fail('Review and explicitly confirm the selected process');
    expire();const review=reviews.get(payload.reviewId);
    if(!review||review.projectId!==ctx.project.id||review.root!==ctx.root)throw fail('The stop review expired or belongs to another project','WIEK_LOCAL_SERVER_STALE');
    reviews.delete(payload.reviewId);const row=(await list(ctx)).servers.find(row=>row.pid===review.row.pid);
    if(!row||!row.isStoppable||row.fingerprint!==review.row.fingerprint||endpoints(row.ports)!==endpoints(review.row.ports))throw fail('The process or listening ports changed; review it again','WIEK_LOCAL_SERVER_STALE');
    const fresh=(await probe.inspect([row.pid]))[0];ensure();
    if(!fresh||fresh.zombie||identity(fresh)!==row.fingerprint)throw fail('Process identity changed before stopping','WIEK_LOCAL_SERVER_STALE');
    try{signal(row.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw fail('The stop signal could not be delivered');}
    const deadline=now()+settleMs;
    for(let attempt=0;attempt<32;attempt++){
      const current=(await probe.inspect([row.pid]))[0];
      if(!current||current.zombie||identity(current)!==row.fingerprint)return {pid:row.pid,stopped:true,signal:'SIGTERM',message:'Process exited.'};
      if(now()>=deadline||closed)break;await pause(50);
    }
    return {pid:row.pid,stopped:false,signal:'SIGTERM',message:'Stop signal sent; process is still running. No force stop was sent.'};
  }
  return {available:probe.available,dispatch,close(){closed=true;reviews.clear();for(const controller of titleReads)controller.abort();titleReads.clear();}};
}
module.exports={createLocalServerService,createNativeServerProbe,parseListeners};

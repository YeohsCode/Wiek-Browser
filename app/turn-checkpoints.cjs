'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const clone=value=>JSON.parse(JSON.stringify(value));
const fail=message=>Object.assign(new Error(message),{error_code:'VEK_TURN_CHECKPOINT_ERROR'});
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
function createTurnCheckpoints({dataDir,workspace,projects,isRunning=()=>false,onChange=()=>{}}){
  const directory=path.join(path.resolve(dataDir),'turn-checkpoints');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(fs.lstatSync(directory).isSymbolicLink())throw fail('Turn checkpoint directory cannot be a symlink');fs.chmodSync(directory,0o700);
  const file=path.join(directory,'state.json');let records=[],closed=false;const restores=new Set();
  if(fs.existsSync(file)){if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>16*1024*1024)throw fail('Invalid turn checkpoint state file');const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.version!==1||!Array.isArray(saved.records)||saved.records.length>10000)throw fail('Unsupported turn checkpoint state');records=saved.records;for(const row of records)if(!uuid(row.threadId)||!uuid(row.runId)||!uuid(row.projectId)||typeof row.projectPath!=='string'||!path.isAbsolute(row.projectPath)||!['capturing-before','awaiting-run','capturing-after','complete','partial','failed','interrupted','cancelled'].includes(row.status)||[row.before,row.after].some(meta=>meta&&(!uuid(meta.id)||typeof meta.head!=='string')))throw fail('Invalid turn checkpoint association');}
  function persist(){const temporary=path.join(directory,`.${randomUUID()}.tmp`);let fd;try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({version:1,records}));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch{}}try{onChange();}catch{}}
  for(const row of records)if(['capturing-before','awaiting-run','capturing-after'].includes(row.status)){row.status='interrupted';row.error='Browser stopped before the turn snapshots were finalized. No after snapshot was inferred.';row.updatedAt=new Date().toISOString();}
  persist();
  function project(id){if(closed)throw fail('Turn checkpoint service is closed');const found=projects().find(p=>p.id===id);if(!found)throw fail('Project no longer exists');return found;}
  function identity(p){const git=path.join(p.path,'.git'),stat=fs.lstatSync(git);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('Automatic checkpoints require a regular repository .git directory');return `${stat.dev}:${stat.ino}`;}
  function owned(thread,runId){const p=project(thread.projectId),row=records.find(r=>r.threadId===thread.id&&r.runId===runId&&r.projectId===p.id);if(!row)throw fail('No local checkpoint association for this turn; imported transcripts do not restore files');if(row.projectPath!==p.path||row.repositoryIdentity!==identity(p))throw fail('Repository identity changed; use the workspace checkpoint manager to review it');return{p,row};}
  const view=row=>clone(Object.fromEntries(Object.entries(row).filter(([key])=>!['projectPath','repositoryIdentity'].includes(key))));
  async function before({thread,project:p,run}){
    if(closed)throw fail('Turn checkpoint service is closed');
    if(records.length>=10000)throw fail('Turn checkpoint association limit reached');
    if(records.some(row=>row.threadId===thread.id&&row.runId===run.id))throw fail('This turn already has a snapshot reservation');
    const row={threadId:thread.id,runId:run.id,projectId:p.id,projectPath:p.path,repositoryIdentity:identity(p),status:'capturing-before',createdAt:new Date().toISOString(),before:null,after:null};records.push(row);persist();
    try{row.before=(await workspace.dispatch('workspace:git:checkpoint:create',{projectId:p.id,name:`Turn ${run.id.slice(0,8)} · before`})).checkpoint;row.status='awaiting-run';row.updatedAt=new Date().toISOString();persist();return view(row);}
    catch(error){row.status='failed';row.error=String(error.message).slice(0,2000);persist();throw error;}
  }
  async function after({thread,run}){
    const found=records.find(row=>row.threadId===thread.id&&row.runId===run.id);if(!found)return{status:'failed',error:'The before snapshot was not captured; no provider changes were attributed.'};
    const {p,row}=owned(thread,run.id);if(row.status==='complete'&&row.after)return view(row);row.providerOutcome=run.status;row.nativeTurnId=run.nativeTurnId||null;
    if(!row.before){row.status='failed';persist();return view(row);}
    if(!run.executedAt){row.status='cancelled';row.error='Stopped before a provider process was started.';persist();return view(row);}
    row.status='capturing-after';persist();
    try{row.after=(await workspace.dispatch('workspace:git:checkpoint:create',{projectId:p.id,name:`Turn ${run.id.slice(0,8)} · after`})).checkpoint;row.status='complete';delete row.error;}
    catch(error){row.status='partial';row.error=String(error.message).slice(0,2000);}
    row.updatedAt=new Date().toISOString();persist();return view(row);
  }
  function locked(projectId){const p=project(projectId);return restores.has(p.path);}
  async function withRestoreLease(projectId,fn){const p=project(projectId);if(restores.has(p.path)||isRunning(p))throw fail('Wait for all Agent turns in this project to finish before restoring files');restores.add(p.path);try{return await fn();}finally{restores.delete(p.path);}}
  async function dispatch(action,payload,thread){
    project(thread.projectId);
    if(action==='agents:changes:list')return{records:records.filter(row=>row.threadId===thread.id&&row.projectId===thread.projectId).map(view)};
    if(action==='agents:changes:diff'){
      let from,to;
      if(payload.scope==='thread'){const rows=records.filter(row=>row.threadId===thread.id&&row.projectId===thread.projectId);const first=rows.find(row=>row.before),last=[...rows].reverse().find(row=>row.after);if(!first||!last)throw fail('This conversation has no complete snapshot span');owned(thread,first.runId);owned(thread,last.runId);from=first.before;to=last.after;}
      else{const {row}=owned(thread,payload.runId);from=row.before;to=row.after;}
      if(!from||!to)throw fail('Both before and after snapshots are required to show a turn diff');
      const result=await workspace.dispatch('workspace:git:checkpoint:compare',{projectId:thread.projectId,fromId:from.id,toId:to.id});return{...result,scope:payload.scope==='thread'?'thread-span':'turn',notice:'Snapshots contain project state, including concurrent external edits. A conversation span may also include intervening work.'};
    }
    const {row}=owned(thread,payload.runId),target=payload.target||'before';if(!['before','after'].includes(target)||!row[target])throw fail('Requested snapshot is unavailable');
    if(action==='agents:changes:preview'){
      if(isRunning(project(thread.projectId)))throw fail('Finish project Agent turns before previewing file restore');
      const result=await workspace.dispatch('workspace:git:checkpoint:preview',{projectId:thread.projectId,id:row[target].id});return{...result,runId:row.runId,target};
    }
    if(action==='agents:changes:restore')return withRestoreLease(thread.projectId,async()=>{
      if(payload.confirm!==true)throw fail('Preview and explicitly confirm file restore');
      const result=await workspace.dispatch('workspace:git:checkpoint:restore',{projectId:thread.projectId,id:row[target].id,expectedState:payload.expectedState,confirm:true});
      row.lastRestore={at:new Date().toISOString(),target,backupId:result.backupCheckpoint.id};persist();return result;
    });
    throw fail('Unknown turn checkpoint action');
  }
  return{before,after,dispatch,locked,withRestoreLease,records:()=>records.map(view),close(){closed=true;}};
}
module.exports={createTurnCheckpoints};

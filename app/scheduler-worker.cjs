'use strict';
// One explicit tick. No OS installation, polling daemon, browser/profile reads,
// model discovery, shell or native provider approval automation. A bounded,
// token-protected loopback endpoint accepts only graceful stop requests.
const path=require('node:path'),fs=require('node:fs');
const control=require('./scheduler-control.cjs');
function readInstructions(dataDir){
  const directory=path.join(path.resolve(dataDir),'preferences'),file=path.join(directory,'state.json');
  if(!fs.existsSync(directory))return '';if(fs.lstatSync(directory).isSymbolicLink()||!fs.lstatSync(directory).isDirectory())throw new Error('Invalid preferences directory for scheduler');
  if(!fs.existsSync(file))return '';const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>65536)throw new Error('Invalid scheduler preferences file');const raw=fs.readFileSync(fd);if(raw.length!==stat.size)throw new Error('Scheduler preferences changed while reading');const value=JSON.parse(raw.toString('utf8'));if(value.version!==1||typeof value.instructions!=='string'||value.instructions.includes('\0')||Buffer.byteLength(value.instructions)>8192)throw new Error('Invalid scheduler user instructions');return value.instructions;}finally{fs.closeSync(fd);}
}
const {createAgentService}=require('./agent-service.cjs');
const {createWorkspaceService}=require('./workspace-service.cjs');
const {createTurnCheckpoints}=require('./turn-checkpoints.cjs');
async function runSchedulerTick({dataDir,timeoutMs=60000,signal,guard=()=>true}={}){
  if(!dataDir||!Number.isSafeInteger(timeoutMs)||timeoutMs<25||timeoutMs>3600000)throw new Error('Scheduler tick needs a data directory and timeout from 25 to 3600000 ms');
  if(signal?.aborted)return {status:'cancelled',attempted:[],skipped:[]};
  if(control.foregroundPresent(dataDir))return {status:'skipped-locked',attempted:[],skipped:[],reason:'Foreground browser is starting or running'};
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();let stopReason;
  let service,workspace,checkpoints,endpoint,instructions='';
  const started=Date.now(),cutoff=started;let timedOut=false,cancelled=false,selection;
  try{
    try{service=createAgentService({dataDir,autoSchedule:false,discoverProviders:false,recoverLock:false,lockRole:'scheduler',
      turnCheckpoints:{before:args=>checkpoints.before(args),after:args=>checkpoints.after(args),locked:id=>checkpoints?.locked(id)||false},
      runContext:({thread})=>({env:{VEK_DATA_DIR:path.resolve(dataDir),VEK_THREAD_ID:thread.id,VEK_PROJECT_ID:thread.projectId,VEK_BROWSER_AUTOSTART:'0'},promptPrefix:'This is an explicitly enabled Vek closed-app automation tick. The browser UI, browser SDK, MCP gateway, voice and approval UI are unavailable. Do not assume access to a browser session. No conversation or attachment is inherited for a new automation thread.'+(instructions?'\nUser instructions:\n'+instructions:'')})
    });}catch(error){if(error.error_code==='VEK_AGENT_DATA_LOCKED')return {status:'skipped-locked',attempted:[],skipped:[],reason:'Agent directory is locked. A browser/worker may be active; open the browser to recover a stale lock.'};throw error;}
    endpoint=await control.startControl(dataDir,reason=>{if(!controller.signal.aborted){stopReason=reason;controller.abort();}});
    if(control.foregroundPresent(dataDir)||!guard())return {status:'skipped-locked',attempted:[],skipped:[],reason:'Foreground or disabled-job gate is active'};
    instructions=readInstructions(dataDir);
    workspace=createWorkspaceService({projects:()=>service.snapshot().projects});
    checkpoints=createTurnCheckpoints({dataDir,workspace,projects:()=>service.snapshot().projects,isRunning:project=>service.snapshot().threads.some(t=>t.projectId===project.id&&['running','discovering'].includes(t.status))});
    service.recoverFileChanges(checkpoints.records());
    selection=service.runDueOnce({through:cutoff,accept:(automation,thread)=>{
      if(controller.signal.aborted||control.foregroundPresent(dataDir)||!guard())return 'foreground or disabled-job gate is active';
      if(!automation.closedAppAllowed)return 'closed-app execution is disabled';
      const provider=service.snapshot().providers.find(p=>p.id===thread.providerId);
      if(provider?.protocol && provider.protocol!=='cli')return 'native provider requires the browser approval UI';
      return true;
    }});
    while(service.snapshot().runningCount){
      if(controller.signal.aborted){cancelled=true;break;}
      if(Date.now()-started>=timeoutMs){timedOut=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    // close waits for actual provider exit and checkpoint finalization.
    await service.close();
    const state=service.snapshot();
    return {status:cancelled?(stopReason==='foreground'?'yielded-foreground':stopReason==='disabled'?'disabled':'cancelled'):timedOut?'timed-out':'completed',...selection,attempted:selection.attempted.map(item=>{const a=state.automations.find(a=>a.id===item.automationId);return {...item,outcome:a?.lastOutcome||item.outcome};}),elapsedMs:Date.now()-started};
  }finally{await service?.close();checkpoints?.close();await workspace?.close();await endpoint?.close();signal?.removeEventListener('abort',abort);}
}
module.exports={runSchedulerTick};

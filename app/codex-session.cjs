'use strict';
const {randomUUID}=require('node:crypto');
const {codexClient,readCodexCatalogue,validateCodexModel,validId}=require('./codex-protocol.cjs');
const {createCodexEvents}=require('./codex-events.cjs');
function connectCodexSession({child,active,run,thread,project,text,attachments,consume,publish,killTree,onSession}){
 let phase='loading',finished=false,deferred=[],deferredBytes=0;const timers=new Set(),approvals=new Map(),streamed=new Set(),events=createCodexEvents(run);
 const timer=(fn,ms)=>{const h=setTimeout(()=>{timers.delete(h);fn()},ms);h.unref?.();timers.add(h);return h};
 const terminate=()=>{killTree(child,'SIGTERM');timer(()=>killTree(child,'SIGKILL'),1000)};
 const failure=e=>{if(finished||active.finalizing||active.stopReason)return;finished=true;run.error=String(e.message||e).slice(0,8192);terminate()};
 const expire=entry=>{if(entry.record.status==='pending')entry.record.status='expired';approvals.delete(entry.record.id);active.native.approvalIds.delete(entry.record.id)};
 const closeInput=()=>{for(const entry of [...approvals.values()])expire(entry);child.stdin.end();timer(terminate,1000)};
 const client=codexClient(child,{onNotification:receive,onServerRequest:receive,onFailure:failure});
 active.native={...client,threadId:null,turnId:null,completed:false,approvalIds:new Map()};
 active.finishNativeActivity=outcome=>events.finish(outcome);
 active.native.approve=(id,decision)=>{
  const a=approvals.get(id);if(!a||a.record.status!=='pending'||finished||active.stopReason)throw Error('Codex permission request is unavailable');
  if(a.childThreadId&&!events.childTurnMatches(a.childThreadId,a.turnId)){expire(a);throw Error('Codex child permission no longer belongs to an active turn')}
  if(decision==='accept'&&a.record.canAccept===false)throw Error('Codex request has no single-use accept decision');
  client.write({id:a.requestId,result:{decision}});a.record.status=decision==='accept'?'accepted':decision==='decline'?'declined':'cancelled';a.record.decidedAt=new Date().toISOString();approvals.delete(id);active.native.approvalIds.delete(id);
 };
 function receive(event){
  if(finished)return;
  if(phase==='starting'){
   deferredBytes+=Buffer.byteLength(JSON.stringify(event));if(deferred.length>=512||deferredBytes>4*1024*1024)throw Error('Codex start event buffer exceeds its limit');deferred.push(event);return;
  }
  const p=event.params||{};
  if(active.stopReason && phase==='turn' && event.id===undefined && event.method==='turn/completed' && (!p.threadId||p.threadId===active.native.threadId) && (!p.turn?.id||p.turn.id===active.native.turnId)){active.native.completed=true;finished=true;closeInput();return;}
  if(phase!=='turn'||active.stopReason){if(event.id!==undefined)client.write({id:event.id,error:{code:-32601,message:'No native turn is active'}});return}
  const childId=p.threadId&&p.threadId!==active.native.threadId?p.threadId:null;
  if(childId&&!events.ownsChild(childId))throw Error('Native provider event belongs to a different thread');
  if(!childId&&p.turnId!==undefined&&p.turnId!==active.native.turnId)throw Error('Native provider event belongs to a different turn');
  if(event.id!==undefined){
   if(!((typeof event.id==='number'&&Number.isSafeInteger(event.id))||validId(event.id))||serverIds.has(event.id)||serverIds.size>=10000)throw Error('Native provider repeated or exceeded server request identities');serverIds.add(event.id);
   if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(event.method)){client.write({id:event.id,error:{code:-32601,message:'Unsupported native client request'}});return}
   if(childId&&!events.childTurnMatches(childId,p.turnId)){client.write({id:event.id,error:{code:-32601,message:'No owned child turn is active for this permission'}});return}
   if((run.approvals?.length||0)>=64)throw Error('Native provider exceeded permission request limit');
   const id=randomUUID(),record={id,kind:event.method.includes('commandExecution')?'command':'file-change',title:`${childId?'Child '+childId+' · ':''}${String(p.reason||event.method)}`.slice(0,2048),command:(typeof p.command==='string'?p.command:Array.isArray(p.command)?p.command.join(' '):'').slice(0,8192),cwd:String(p.cwd||project.path).slice(0,4096),status:'pending',createdAt:new Date().toISOString(),canAccept:!Array.isArray(p.availableDecisions)||p.availableDecisions.includes('accept')};
   run.approvals||=[];run.approvals.push(record);approvals.set(id,{record,requestId:event.id,childThreadId:childId,turnId:p.turnId});active.native.approvalIds.set(id,event.id);publish();return;
  }
  if(event.method==='serverRequest/resolved'){for(const a of [...approvals.values()])if(a.requestId===p.requestId)expire(a);publish();return}
  if(childId){events.accept(event,active.native.threadId);publish();return}
  if(event.method==='turn/started'&&p.turn?.id&&p.turn.id!==active.native.turnId)throw Error('Native provider started a different turn');
  events.accept(event,active.native.threadId);
  if(event.method==='item/agentMessage/delta'&&typeof p.delta==='string'){streamed.add(p.itemId);consume('stdout',Buffer.from(p.delta))}
  if(event.method==='item/completed'&&p.item?.type==='agentMessage'&&!streamed.has(p.item.id)&&typeof p.item.text==='string'){streamed.add(p.item.id);consume('stdout',Buffer.from(p.item.text))}
  if(event.method==='thread/tokenUsage/updated'){
   const usage=p.tokenUsage?.last;if(usage&&['inputTokens','outputTokens'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0))run.usage={inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,...(Number.isSafeInteger(usage.cachedInputTokens)&&usage.cachedInputTokens>=0?{cachedInputTokens:usage.cachedInputTokens}:{}),source:'native-provider-event'};
  }
  if(event.method==='turn/completed'){
   if(p.turn?.id&&p.turn.id!==active.native.turnId)throw Error('Native provider completed a different turn');
   const status=p.turn?.status;if(!['completed','failed','interrupted'].includes(status))throw Error('Native provider turn ended without a recognized status');
   if(status==='failed')run.error=String(p.turn?.error?.message||'Native provider turn failed').slice(0,8192);if(status==='interrupted')active.stopReason||='stopped';
   active.native.completed=true;finished=true;closeInput();
  }
  publish();
 }
 const serverIds=new Set();
 active.native.ready=(async()=>{
  await client.initialize();if(active.stopReason)return;let selected;
  if(thread.nativeCatalog?.source==='codex-model-list'||thread.reasoningEffort){thread.nativeCatalog=await readCodexCatalogue(client.request);selected=validateCodexModel(thread,thread.nativeCatalog,attachments);publish()}
  if(active.stopReason)return;const resumed=!!thread.nativeThreadId,model=thread.model||selected?.id;
  const response=await client.request(resumed?'thread/resume':'thread/start',resumed?{threadId:thread.nativeThreadId}:{cwd:project.path,sandbox:'read-only',approvalPolicy:'on-request',...(model?{model}:{})});if(active.stopReason)return;
  const id=response?.thread?.id;if(!validId(id))throw Error('Native provider did not return a thread id');if(resumed&&id!==thread.nativeThreadId)throw Error('Native provider resumed a different thread');
  thread.nativeThreadId=id;run.nativeThreadId=id;active.native.threadId=id;onSession();
  const input=[{type:'text',text:resumed?text.current:text.full},...attachments.filter(a=>a.mimeType.startsWith('image/')).map(a=>({type:'localImage',path:a.storedPath}))];
  phase='starting';const result=await client.request('turn/start',{threadId:id,input,...(model?{model}:{}),...(thread.reasoningEffort?{effort:thread.reasoningEffort}:{})});if(active.stopReason)return;
  if(!validId(result?.turn?.id))throw Error('Native provider did not return a turn id');active.native.turnId=result.turn.id;run.nativeTurnId=result.turn.id;phase='turn';
  const buffered=deferred;deferred=[];deferredBytes=0;for(const event of buffered)receive(event);publish();
 })();active.native.ready.catch(failure);
 child.once('close',()=>{for(const t of timers)clearTimeout(t);for(const a of [...approvals.values()])expire(a);deferred=[]});
}
module.exports={connectCodexSession};

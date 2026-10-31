'use strict';
// Display-only app-server evidence. IDs/paths never authorize another action.
const {validId}=require('./codex-protocol.cjs');
const {createHash}=require('node:crypto');
const terminal=new Set(['completed','failed','declined']);
function createCodexEvents(run){
 const tools=new Map(),children=new Map(),childTurns=new Map(),seenChildTurns=new Map(),childMessages=new Map(),finishedMessages=new WeakSet(),finishedTools=new WeakMap(),omittedChildren=new Set(),closedChildTurns=new Set();let bytes=0,messageCount=0,rootIdentity;
 const raw=value=>typeof value==='string'?value:JSON.stringify(value??{});
 function setText(target,key,value,limit){const text=raw(value),old=target[key]||'';bytes-=Buffer.byteLength(old);const available=Math.max(0,256*1024-bytes),buffer=Buffer.from(text.slice(0,limit));if(text.length>limit||buffer.length>available)run.nativeEventsTruncated=true;let saved=buffer.subarray(0,available).toString('utf8');while(Buffer.byteLength(saved)>available)saved=saved.slice(0,-1);target[key]=saved;bytes+=Buffer.byteLength(saved)}
 function child(id){if(!validId(id)||id===rootIdentity)throw Error('Codex child identity is invalid');if(children.has(id))return children.get(id);if(children.size>=100){run.nativeEventsTruncated=true;if(omittedChildren.size>=1000)throw Error('Codex child identity limit exceeded');omittedChildren.add(id);return null}const r={id,status:'observed',messages:[]};children.set(id,r);run.subagents||=[];run.subagents.push(r);return r}
 function tool(item,childId){if(!validId(item?.id))throw Error('Codex activity identity is invalid');const key=JSON.stringify([childId||null,item.id]);if(tools.has(key))return tools.get(key);if(tools.size>=200){run.toolEventsTruncated=true;return null}const r={id:item.id,name:String(item.type).slice(0,256),status:'observed',...(childId?{parentToolUseId:childId}:{})};tools.set(key,r);run.toolEvents||=[];run.toolEvents.push(r);return r}
 function recordChildState(id,state){const r=child(id);if(!r)return;if(state?.message!=null)setText(r,'summary',state.message,4096);const mapped={pendingInit:'running',running:'running',interrupted:'interrupted',completed:'completed',errored:'failed',shutdown:'stopped',notFound:'unresolved'}[state?.status];if(mapped)r.status=mapped}
 function content(value){if(!Array.isArray(value))return raw(value);return value.map(v=>v?.type==='text'?String(v.text||''):`[${String(v?.type||'unsupported').slice(0,64)} content omitted]`).join('\n')}
 function accept(event,rootThreadId){
  rootIdentity=rootThreadId;
  const p=event.params||{},childId=p.threadId&&p.threadId!==rootThreadId?p.threadId:null;
  if(childId&&omittedChildren.has(childId))return true;
  if(childId&&!children.has(childId))return false;
  if(childId){
   if(event.method==='turn/started'){
    const id=p.turn?.id;if(!validId(id))throw Error('Codex child turn identity is invalid');const seen=seenChildTurns.get(childId)||new Set();if(seen.has(id))return true;if(seen.size>=1000){run.nativeEventsTruncated=true;return true}seen.add(id);seenChildTurns.set(childId,seen);childTurns.set(childId,id);closedChildTurns.delete(childId);children.get(childId).status='running';return true;
   }
   if(p.turnId&&childTurns.get(childId)&&p.turnId!==childTurns.get(childId))return true;
   if(event.method==='turn/completed'){
    if(p.turn?.id&&childTurns.get(childId)&&p.turn.id!==childTurns.get(childId))return true;
    // A completed child turn is not a completed child agent lifecycle.
    closedChildTurns.add(childId);const r=children.get(childId);if(p.turn?.status==='failed')r.status='failed';else if(p.turn?.status==='interrupted')r.status='interrupted';return true;
   }
   if(event.method==='item/agentMessage/delta'&&typeof p.delta==='string'){
    const r=children.get(childId);if(!validId(p.itemId))throw Error('Codex child message identity is invalid');if(!childMessages.has(childId))childMessages.set(childId,new Map());const messages=childMessages.get(childId);let m=messages.get(p.itemId);if(!m){if(messageCount>=200){run.nativeEventsTruncated=true;return true}m={role:'assistant',content:''};messages.set(p.itemId,m);r.messages.push(m);messageCount++}if(!finishedMessages.has(m))setText(m,'content',m.content+p.delta,16384);return true;
   }
  }
  if(event.method==='item/commandExecution/outputDelta'||event.method==='item/fileChange/outputDelta'){
   if(typeof p.delta!=='string')return !!childId;const r=tool({id:p.itemId,type:event.method.includes('commandExecution')?'commandExecution':'fileChange'},childId);if(r&&!finishedTools.has(r))setText(r,'result',(r.result||'')+p.delta,16384);return !!childId;
  }
  if(!['item/started','item/completed'].includes(event.method))return !!childId;
  const item=p.item;if(!item||typeof item.type!=='string')throw Error('Codex activity item is invalid');
  if(item.type==='agentMessage'&&childId){const r=children.get(childId);if(!childMessages.has(childId))childMessages.set(childId,new Map());const messages=childMessages.get(childId);if(!validId(item.id))throw Error('Codex child message identity is invalid');let m=messages.get(item.id);if(!m){if(messageCount>=200){run.nativeEventsTruncated=true;return true}m={role:'assistant',content:''};messages.set(item.id,m);r.messages.push(m);messageCount++}if(event.method==='item/completed'&&typeof item.text==='string'){setText(m,'content',item.text,16384);finishedMessages.add(m);}return true}
  if(['reasoning','userMessage','agentMessage'].includes(item.type))return !!childId;
  const prior=tools.get(JSON.stringify([childId||null,item.id]));
  if(event.method==='item/completed'&&prior&&finishedTools.has(prior)){const signature=createHash('sha256').update(JSON.stringify(item)).digest('hex');if(finishedTools.get(prior)!==signature)throw Error('Codex activity has conflicting completion events');return !!childId;}
  const collaboration=['collabAgentToolCall','collabToolCall'].includes(item.type);
  if(collaboration){const ids=Array.isArray(item.receiverThreadIds)?item.receiverThreadIds:[item.receiverThreadId,item.newThreadId].filter(Boolean);for(const id of ids.slice(0,100)){const c=child(id);if(c&&item.prompt!=null&&!c.description)setText(c,'description',item.prompt,2048)}if(item.agentsStates&&typeof item.agentsStates==='object'&&!Array.isArray(item.agentsStates))for(const [id,state]of Object.entries(item.agentsStates).slice(0,100))recordChildState(id,state);if(item.agentStatus&&ids.length===1)recordChildState(ids[0],typeof item.agentStatus==='string'?{status:item.agentStatus}:item.agentStatus);}
  if(item.type==='subAgentActivity'){const c=child(item.agentThreadId);if(c){if(item.kind==='started'||item.kind==='interacted')c.status='running';if(item.kind==='interrupted')c.status='interrupted';if(item.agentPath)setText(c,'description',item.agentPath,2048)}}
  const r=tool(item,childId);if(!r)return !!childId;
  if(event.method==='item/started'&&finishedTools.has(r))return !!childId;
  const completed=event.method==='item/completed';if(completed){const signature=createHash('sha256').update(JSON.stringify(item)).digest('hex');if(finishedTools.has(r)){if(finishedTools.get(r)!==signature)throw Error('Codex activity has conflicting completion events');return !!childId;}finishedTools.set(r,signature);}
  r.status=terminal.has(item.status)?(item.status==='declined'?'failed':item.status):completed?'unresolved':'running';
  if(item.type==='commandExecution'){
   setText(r,'name','Command',256);if(item.command!==undefined)setText(r,'input',item.command,4096);
   if(item.aggregatedOutput!=null)setText(r,'result',item.aggregatedOutput,16384);
   if(Number.isInteger(item.exitCode)&&completed){setText(r,'result',`${r.result||''}\n[exit ${item.exitCode}]`,16384);if(item.exitCode!==0)r.status='failed'}
  }else if(item.type==='fileChange'){
   setText(r,'name','File changes',256);if(Array.isArray(item.changes))setText(r,'result',item.changes.slice(0,100).map(c=>`${String(c.path||'').slice(0,1024)}\n${String(c.diff||'').slice(0,16384)}`).join('\n'),16384);
  }else if(item.type==='mcpToolCall'||item.type==='dynamicToolCall'){
   setText(r,'name',`${item.type==='mcpToolCall'?'MCP '+String(item.server||''):'Tool'} · ${String(item.tool||'')}`,256);if(item.arguments!==undefined)setText(r,'input',item.arguments,4096);
   if(item.result!=null)setText(r,'result',item.result?.content?content(item.result.content):item.result,16384);
   if(item.contentItems!=null)setText(r,'result',content(item.contentItems),16384);
   if(item.error!=null){setText(r,'result',item.error,16384);r.status='failed'}if(item.success===false)r.status='failed';
  }else if(['collabAgentToolCall','collabToolCall'].includes(item.type)){
   setText(r,'name',`Subagent · ${String(item.tool||'activity')}`,256);if(item.prompt!=null)setText(r,'input',item.prompt,4096);
  }else if(item.type==='subAgentActivity'){
   setText(r,'name',`Subagent ${String(item.kind||'activity')}`,256);
  }else if(item.type==='contextCompaction'){setText(r,'name','Context compaction',256);r.status=completed?'completed':'running'}
  else if(item.type==='webSearch'){setText(r,'name','Web search',256);setText(r,'input',item.query||item.action||'',4096);r.status=completed?'completed':'running'}
  else {setText(r,'name',item.type,256);if(completed)r.status='unresolved'}
  if(Number.isFinite(item.durationMs)&&item.durationMs>=0)r.elapsedSeconds=Math.min(item.durationMs/1000,1e9);
  return !!childId;
 }
 function finish(outcome){for(const r of [...tools.values(),...children.values()]){if(['observed','running'].includes(r.status)){r.status=outcome==='completed'?'unresolved':'interrupted';setText(r,'endReason',`Turn ${outcome}; no terminal activity event observed`,4096)}}}
 return {accept,finish,childTurnMatches:(id,turn)=>children.has(id)&&validId(turn)&&childTurns.get(id)===turn&&!closedChildTurns.has(id),ownsChild:id=>children.has(id)||omittedChildren.has(id)};
}
module.exports={createCodexEvents};

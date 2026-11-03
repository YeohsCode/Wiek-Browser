'use strict';
// Independently rebuild selected rollout's effective visible context. No provider
// invocation, hidden reasoning decryption, source resume or filesystem effects.
const {createClaudeEvents}=require('./claude-events.cjs');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const contextual=p=>p?.type==='message'&&p.role==='user'&&Array.isArray(p.content)&&p.content.some(b=>['input_text','output_text'].includes(b?.type)&&/^\s*(?:# AGENTS\.md instructions\b|<environment_context>|<skills_instructions>|<collaboration_mode>|<permissions instructions>|<user_shell_command>|<turn_aborted>|<subagent_notification>|<codex_internal_context\b|<goal_context>|<recommended_plugins>|<additional_context>|<skill>|<hook_prompt\b)/i.test(b.text||''));
const boundary=p=>(p?.type==='message'&&p.role==='user'&&!contextual(p))||p?.type==='agent_message'||p?.type==='inter_agent_communication';
function parseCodexHistory(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>32*1024*1024)throw Error('Codex history exceeds 32 MiB');let text;
 try{text=new TextDecoder('utf8',{fatal:true}).decode(bytes)}catch{throw Error('Codex history must be valid UTF-8')}
 const lines=text.split(/\r?\n/);if(lines.length>20000+(text.endsWith('\n')?1:0))throw Error('Codex history exceeds 20000 lines');
 let sessionId,sourceSessionId,skipped=0,compactions=0,legacyCompactions=0,rollbackEvents=0,rolledBackItems=0;
 let effective=[],ids=new Map();const replayNotes=[];
 function append(payload,timestamp,summary=false){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.type!=='string')throw Error('Codex response item is malformed');
  if(payload.id!==undefined){if(typeof payload.id!=='string'||!payload.id||payload.id.length>256)throw Error('Codex response identity is invalid');if(ids.has(payload.id)){if(ids.get(payload.id)!==JSON.stringify(payload))throw Error('Codex history has conflicting duplicate response identities');skipped++;return}ids.set(payload.id,JSON.stringify(payload))}
  effective.push({payload,timestamp,summary:summary||(payload.type==='message'&&payload.role==='user'&&payload.content?.some(b=>typeof b.text==='string'&&b.text.startsWith('Another language model started to solve this problem and produced a summary of its thinking process.')))});
 }
 const resetIds=()=>{ids=new Map(effective.filter(e=>e.payload.id).map(e=>[e.payload.id,JSON.stringify(e.payload)]))};
 for(const [index,line]of lines.entries()){
  if(!line.trim())continue;if(Buffer.byteLength(line)>4*1024*1024)throw Error(`Codex history line ${index+1} exceeds 4 MiB`);let e;
  try{e=JSON.parse(line)}catch{throw Error(`Codex history line ${index+1} is invalid JSON (including incomplete tails)`)}
  if(!e||typeof e!=='object'||Array.isArray(e)||!e.payload||typeof e.payload!=='object'||Array.isArray(e.payload))throw Error(`Codex history line ${index+1} is malformed`);
  const p=e.payload;
  if(e.type==='session_meta'){
   if(sessionId)throw Error('Codex history must contain one leading session_meta');
   if(!uuid(p.id)||(p.session_id!==undefined&&!uuid(p.session_id)))throw Error('Codex history session identity is invalid');sessionId=p.id;sourceSessionId=p.session_id||p.id;continue;
  }
  if(!sessionId)throw Error('Choose a Codex rollout with a leading session_meta');
  if(e.type==='event_msg'&&p.type==='thread_rolled_back'){
   if(!Number.isSafeInteger(p.num_turns)||p.num_turns<0||p.num_turns>0xffffffff)throw Error('Codex rollback count is invalid');
   rollbackEvents++;if(!p.num_turns)continue;const positions=effective.map((e,i)=>boundary(e.payload)?i:-1).filter(i=>i>=0);
   if(positions.length){const cut=positions[Math.max(0,positions.length-p.num_turns)];rolledBackItems+=effective.length-cut;effective=effective.slice(0,cut);resetIds()}continue;
  }
  if(e.type==='compacted'){
   if(typeof p.message!=='string'||Buffer.byteLength(p.message)>1024*1024)throw Error('Codex compaction message is invalid or too large');
   compactions++;
   if(p.replacement_history!=null){
    if(!Array.isArray(p.replacement_history)||p.replacement_history.length>20000)throw Error('Codex replacement history is invalid');
    effective=[];ids=new Map();for(const replacement of p.replacement_history)append(replacement,e.timestamp);
   }else{
    legacyCompactions++;
    // The native legacy replay retains a bounded tail of non-contextual user
    // prompts plus a user-role summary. Reject oversized legacy tails rather
    // than guessing native token-truncation across unsupported old formats.
    const users=effective.filter(e=>e.payload.type==='message'&&e.payload.role==='user'&&!contextual(e.payload)&&!e.summary);
    if(users.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e.payload.content)),0)>80000)throw Error("Legacy Codex compaction user tail exceeds Wiek's conservative 80 KiB replay limit; use replacement_history");
    effective=users;resetIds();append({type:'message',role:'user',content:[{type:'input_text',text:p.message||'(no summary available)'}]},e.timestamp,true);
   }
   continue;
  }
  if(e.type==='turn_context'||e.type==='event_msg'){
   if(/rollback|rolled_back|revert|compact/i.test(String(p.type)))throw Error('Unsupported Codex history-edit event');skipped++;continue;
  }
  if(e.type==='inter_agent_communication'){append({...p,type:'inter_agent_communication'},e.timestamp);continue}
  if(e.type!=='response_item')throw Error(`Unsupported Codex rollout record: ${String(e.type).slice(0,100)}`);
  append(p,e.timestamp);
 }
 const messages=[],activity={},collector=createClaudeEvents(activity);let attachmentsOmitted=0,total=0,contextEntries=0,omittedInterAgent=0;
 for(const e of effective){const p=e.payload;
  if(['compaction','context_compaction','compaction_trigger'].includes(p.type))throw Error('Encrypted Codex compaction without a plaintext replacement checkpoint cannot be imported');
  if(p.type==='message'&&['user','assistant'].includes(p.role)){
   if(!Array.isArray(p.content))throw Error('Codex history message content is malformed');if(contextual(p)){contextEntries++;continue}const parts=[];
   for(const b of p.content){
    if(['input_text','output_text'].includes(b?.type)){if(typeof b.text!=='string')throw Error('Codex history text content is malformed');parts.push(b.text)}
    else if(['input_image','image','input_file'].includes(b?.type)){attachmentsOmitted++;parts.push(`[${b.type} attachment not imported]`)}
    else throw Error('Unsupported Codex message content block');
   }
   const body=parts.join('\n');total+=Buffer.byteLength(body);if(Buffer.byteLength(body)>1024*1024||total>8*1024*1024)throw Error('Codex transcript exceeds limits (1 MiB per message, 8 MiB total)');
   if(body)messages.push({role:p.role,content:body,...(Number.isFinite(Date.parse(e.timestamp))?{createdAt:new Date(e.timestamp).toISOString()}:{} )});
  }else if(['function_call','custom_tool_call'].includes(p.type)){
   if(typeof p.call_id!=='string'||!p.call_id||p.call_id.length>256||typeof p.name!=='string')throw Error('Codex tool call identity is invalid');
   collector.accept({type:'assistant',message:{content:[{type:'tool_use',id:p.call_id,name:p.name,input:String(p.arguments??p.input??'').slice(0,4096)}]}});
  }else if(['function_call_output','custom_tool_call_output'].includes(p.type)){
   if(typeof p.call_id!=='string'||!p.call_id||p.call_id.length>256)throw Error('Codex tool output identity is invalid');
   collector.accept({type:'user',message:{content:[{type:'tool_result',tool_use_id:p.call_id,content:typeof p.output==='string'?p.output.slice(0,16384):'[Non-text tool output omitted]'}]}});
  }else{if(['agent_message','inter_agent_communication'].includes(p.type))omittedInterAgent++;skipped++}
 }
 if(!sessionId||!messages.length)throw Error('Codex rollout has no supported visible conversation');collector.finish('completed');
 if(compactions)replayNotes.push('Imported the effective visible context after compaction; earlier replaced messages are not copied.');
 if(rollbackEvents)replayNotes.push('Rolled-back messages and tool evidence are excluded; no files are restored.');
 if(omittedInterAgent)replayNotes.push('Inter-agent instruction payloads are omitted from visible copied text but count as rollback boundaries.');
 return {sessionId,sourceSessionId,messages,activity,skipped,contextEntries,attachmentsOmitted,replay:{compactions,legacyCompactions,rollbackEvents,rolledBackItems,omittedInterAgent,notes:replayNotes}};
}
function copyCodexReplay(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Codex replay provenance is invalid');const out={};
 for(const key of ['compactions','legacyCompactions','rollbackEvents','rolledBackItems','omittedInterAgent']){const n=value[key]??0;if(!Number.isSafeInteger(n)||n<0||n>(key==='rolledBackItems'?0xffffffff:20000))throw Error('Codex replay provenance count is invalid');out[key]=n;}
 if(out.legacyCompactions>out.compactions)throw Error('Codex replay compaction provenance is inconsistent');return out;
}
module.exports={parseCodexHistory,copyCodexReplay};

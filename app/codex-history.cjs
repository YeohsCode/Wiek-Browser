'use strict';
// Selected single-file rollout transcript only; no native resume or path reads.
const {createClaudeEvents}=require('./claude-events.cjs');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
function parseCodexHistory(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>32*1024*1024)throw Error('Codex history exceeds 32 MiB');let text;
 try{text=new TextDecoder('utf8',{fatal:true}).decode(bytes)}catch{throw Error('Codex history must be valid UTF-8')}
 const lines=text.split(/\r?\n/);if(lines.length>20000+(text.endsWith('\n')?1:0))throw Error('Codex history exceeds 20000 lines');
 let sessionId,sourceSessionId,skipped=0,attachmentsOmitted=0,total=0,contextEntries=0;const messages=[],activity={},collector=createClaudeEvents(activity),ids=new Map();
 for(const [index,line]of lines.entries()){
  if(!line.trim())continue;if(Buffer.byteLength(line)>4*1024*1024)throw Error(`Codex history line ${index+1} exceeds 4 MiB`);let e;
  try{e=JSON.parse(line)}catch{throw Error(`Codex history line ${index+1} is invalid JSON (including incomplete tails)`)}
  if(!e||typeof e!=='object'||Array.isArray(e)||!e.payload||typeof e.payload!=='object'||Array.isArray(e.payload))throw Error(`Codex history line ${index+1} is malformed`);
  const p=e.payload;
  if(e.type==='session_meta'){
   if(sessionId||index!==lines.findIndex(x=>x.trim()))throw Error('Codex history must contain one leading session_meta');
   if(!uuid(p.id)||(p.session_id!==undefined&&!uuid(p.session_id)))throw Error('Codex history session identity is invalid');sessionId=p.id;sourceSessionId=p.session_id||p.id;continue;
  }
  if(!sessionId)throw Error('Choose a Codex rollout with a leading session_meta');
  if(e.type==='compacted'||(e.type==='event_msg'&&/rollback|rolled_back|revert|compact/i.test(String(p.type))))throw Error('Compacted or rolled-back Codex history is not supported; choose an unmodified transcript');
  if(e.type==='turn_context'||e.type==='event_msg'){skipped++;continue}
  if(e.type!=='response_item')throw Error(`Unsupported Codex rollout record: ${String(e.type).slice(0,100)}`);
  if(p.id!==undefined){if(typeof p.id!=='string'||p.id.length>256)throw Error('Codex response identity is invalid');if(ids.has(p.id)){if(ids.get(p.id)!==JSON.stringify(p))throw Error('Codex history has conflicting duplicate response identities');skipped++;continue}ids.set(p.id,JSON.stringify(p))}
  if(p.type==='message'&&['user','assistant'].includes(p.role)){
   if(!Array.isArray(p.content))throw Error('Codex history message content is malformed');const parts=[];
   for(const b of p.content){
    if(['input_text','output_text'].includes(b?.type)){if(typeof b.text!=='string')throw Error('Codex history text content is malformed');parts.push(b.text)}
    else if(['input_image','image','input_file'].includes(b?.type)){attachmentsOmitted++;parts.push(`[${b.type} attachment not imported]`)}
    else throw Error('Unsupported Codex message content block');
   }
   // Codex persists generated user-role environment/AGENTS context separately.
   // Keep it excluded from the copied conversation and disclose the count.
   if(p.role==='user'&&parts.length&&parts.every(s=>/^# AGENTS\.md instructions\b|^<environment_context>/.test(s))){contextEntries++;continue}
   const body=parts.join('\n');total+=Buffer.byteLength(body);if(Buffer.byteLength(body)>1024*1024||total>8*1024*1024)throw Error('Codex transcript exceeds limits (1 MiB per message, 8 MiB total)');
   if(body)messages.push({role:p.role,content:body,...(Number.isFinite(Date.parse(e.timestamp))?{createdAt:new Date(e.timestamp).toISOString()}:{} )});
  }else if(p.type==='function_call'){
   if(typeof p.call_id!=='string'||!p.call_id||p.call_id.length>256||typeof p.name!=='string')throw Error('Codex tool call identity is invalid');
   collector.accept({type:'assistant',message:{content:[{type:'tool_use',id:p.call_id,name:p.name,input:typeof p.arguments==='string'?p.arguments.slice(0,4096):{}}]}});
  }else if(p.type==='function_call_output'){
   if(typeof p.call_id!=='string'||!p.call_id||p.call_id.length>256)throw Error('Codex tool output identity is invalid');
   collector.accept({type:'user',message:{content:[{type:'tool_result',tool_use_id:p.call_id,content:typeof p.output==='string'?p.output.slice(0,16384):'[Non-text tool output omitted]'}]}});
  }else skipped++;
 }
 if(!sessionId||!messages.length)throw Error('Codex rollout has no supported visible conversation');collector.finish('completed');
 return {sessionId,sourceSessionId,messages,activity,skipped,contextEntries,attachmentsOmitted};
}
module.exports={parseCodexHistory};

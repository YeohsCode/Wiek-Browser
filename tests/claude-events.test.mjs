import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const {createClaudeEvents,copyClaudeActivity}=createRequire(import.meta.url)('../app/claude-events.cjs');
test('Claude tool progress/result evidence handles out-of-order results, failure and nested tool ownership',()=>{
 const record={},events=createClaudeEvents(record);
 events.accept({type:'user',message:{content:[{type:'tool_result',tool_use_id:'one',content:'Actual output',is_error:true}]}});
 events.accept({type:'assistant',message:{content:[{type:'tool_use',id:'one',name:'Bash',input:{command:'never execute'}}]}});
 events.accept({type:'tool_progress',tool_use_id:'one',tool_name:'Bash',elapsed_time_seconds:5});
 events.accept({type:'assistant',parent_tool_use_id:'agent',message:{id:'child',content:[{type:'text',text:'Nested literal <img onerror=x>'},{type:'tool_use',id:'one',name:'Read',input:{path:'/never-read'}}]}});
 events.accept({type:'user',parent_tool_use_id:'agent',message:{content:[{type:'tool_result',tool_use_id:'one',content:[{type:'text',text:'Nested result'},{type:'image',source:{path:'/never-read'}}]}]}});
 events.finish('completed');assert.equal(record.toolEvents.length,2);assert.equal(record.toolEvents[0].status,'failed');assert.equal(record.toolEvents[0].result,'Actual output');assert.match(record.toolEvents[1].result,/Nested result\n\[image content omitted\]/);assert.equal(record.toolEvents[1].parentToolUseId,'agent');assert.match(record.subagents[0].messages[0].content,/<img/);
});
test('Claude task lifecycle ignores stale run notifications and preserves terminal state on later progress',()=>{
 const r={},e=createClaudeEvents(r);const base={type:'system',task_id:'t',tool_use_id:'agent'};
 e.accept({...base,subtype:'task_started',run_id:'02',description:'Review'});e.accept({...base,subtype:'task_notification',run_id:'02',status:'completed',summary:'Reviewed'});e.accept({...base,subtype:'task_notification',run_id:'01',status:'failed'});e.accept({...base,subtype:'task_progress',run_id:'02',usage:{total_tokens:15,tool_uses:2,duration_ms:120}});
 assert.equal(r.subagents[0].status,'completed');assert.equal(r.subagents[0].usage.total_tokens,15);
 e.accept({...base,subtype:'task_started',run_id:'03'});assert.equal(r.subagents[0].status,'running');e.finish('stopped');assert.equal(r.subagents[0].status,'interrupted');
});
test('Claude activity truncation is bounded and unresolved activity is never called completed',()=>{
 const r={},e=createClaudeEvents(r,256);for(let i=0;i<220;i++)e.accept({type:'assistant',message:{content:[{type:'tool_use',id:String(i),name:'Read',input:{text:'x'.repeat(5000)}}]}});e.finish('completed');assert.equal(r.toolEvents.length,200);assert.equal(r.toolEventsTruncated,true);assert.equal(r.nativeEventsTruncated,true);assert.ok(r.toolEvents.every(x=>x.status==='unresolved'));assert.ok(r.toolEvents.reduce((n,x)=>n+Buffer.byteLength(x.input||'')+Buffer.byteLength(x.name),0)<=256);
});
test('Claude child messages deduplicate and archive evidence is sanitized without granting capabilities',()=>{
 const r={},e=createClaudeEvents(r),v={type:'assistant',parent_tool_use_id:'agent',message:{id:'child',content:[{type:'text',text:'Child answer'}]}};e.accept(v);e.accept(v);e.finish('completed');assert.equal(r.subagents[0].messages.length,1);
 r.subagents[0].messages[0].storedPath='/never-read';r.subagents[0].nativeThreadId='untrusted';const copy=copyClaudeActivity(r);assert.equal(copy.subagents[0].messages[0].storedPath,undefined);assert.equal(copy.subagents[0].nativeThreadId,undefined);assert.equal(copy.subagents[0].status,'unresolved');
 assert.throws(()=>copyClaudeActivity({toolEvents:Array(201).fill({id:'x'})}),/count/);
 assert.equal(copyClaudeActivity({toolEvents:[{id:'long',name:'Read',input:'x'.repeat(5000)}]}).nativeEventsTruncated,true);
});

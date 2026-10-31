
const fs=require('node:fs'),rl=require('node:readline');
const argv=process.argv.slice(2),session=argv.find(v=>/^--(?:resume|session-id)=/.test(v))?.split('=')[1];
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const audit=v=>fs.appendFileSync((process.env.VEK_CLAUDE_AUDIT||argv.find(v=>v.startsWith('--vek-audit=')).slice(12)),JSON.stringify(v)+'\n');
audit({argv}); let prompt='',timeout;
const result=(extra={})=>send({type:'result',subtype:'success',is_error:false,session_id:session,uuid:'result-id',result:'fallback only',usage:{input_tokens:20,output_tokens:6,cache_read_input_tokens:3,cache_creation_input_tokens:2},total_cost_usd:0.004,...extra});
const activity=complete=>{
 const message=content=>send({type:'assistant',session_id:session,message:{id:'api-multi-block',content}});
 message([{type:'tool_use',id:'parallel-one',name:'Read',input:{file_path:'fixture-one'}}]);
 message([{type:'tool_use',id:'parallel-two',name:'Read',input:{file_path:'fixture-two'}}]);
 send({type:'user',session_id:session,message:{content:[{type:'tool_result',tool_use_id:'parallel-one',content:'Actual tool output'},{type:'tool_result',tool_use_id:'parallel-two',is_error:true,content:'Actual tool error'}]}});
 send({type:'tool_progress',session_id:session,tool_use_id:'parallel-one',tool_name:'Read',parent_tool_use_id:null,elapsed_time_seconds:2});
 send({type:'system',subtype:'task_started',session_id:session,task_id:'task-peer',tool_use_id:'agent-peer',run_id:'02',description:'Local child review'});
 const child={type:'assistant',session_id:session,parent_tool_use_id:'agent-peer',message:{id:'child-peer',content:[{type:'text',text:'Child-only <literal> answer'},{type:'tool_use',id:'nested',name:'Read',input:{file_path:'never-read-by-ui'}}]}};
 send(child);send(child);
 send({type:'user',session_id:session,parent_tool_use_id:'agent-peer',message:{content:[{type:'tool_result',tool_use_id:'nested',content:'Nested tool output'}]}});
 if(complete){send({type:'system',subtype:'task_notification',session_id:session,task_id:'task-peer',tool_use_id:'agent-peer',run_id:'02',status:'completed',summary:'Child reviewed',output_file:'/never-read-task-output'});send({type:'system',subtype:'task_notification',session_id:session,task_id:'task-peer',tool_use_id:'agent-peer',run_id:'01',status:'failed',summary:'Stale event ignored'});}
};
const finish=text=>{
 send({type:'stream_event',session_id:session,event:{type:'message_start',message:{id:'msg-answer'}}});
 const wire=Buffer.from(JSON.stringify({type:'stream_event',session_id:session,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}})+'\n');
 const boundary=wire.indexOf(Buffer.from('世'))+1;
 if(boundary>0){process.stdout.write(wire.subarray(0,boundary));process.stdout.write(wire.subarray(boundary));}else process.stdout.write(wire);
 const message={type:'assistant',session_id:session,message:{id:'msg-answer',content:[{type:'text',text},{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'test-only.txt'}}]}};
 send(message);send(message);
 send({type:'assistant',session_id:session,parent_tool_use_id:'subagent-1',message:{id:'msg-sub',content:[{type:'text',text:'hidden subagent answer'}]}});
 result();
};
rl.createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);audit(v);
 if(v.type==='control_request'){
   send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{models:[{value:'fixture-only'}]}}});
   if(v.request.subtype==='interrupt'){clearTimeout(timeout);result({subtype:'error_during_execution',is_error:true,errors:['Interrupted']});}
 }else if(v.type==='user'){
   prompt=v.message.content[0].text;
   send({type:'system',subtype:'init',session_id:prompt.includes('[wrong-session]')?'00000000-0000-0000-0000-000000000000':session});
   if(prompt.includes('[wrong-session]'))return;
   if(prompt.includes('[disconnect]'))return process.exit(0);
   if(prompt.includes('[malformed]'))return process.stdout.write('not json\n');
   if(prompt.includes('[oversize]'))return process.stdout.write('x'.repeat(4*1024*1024+1));
   if(prompt.includes('[failure]'))return result({subtype:'error_max_turns',is_error:true,errors:['Fixture failed after tool work']});
   if(prompt.includes('[approval]')||prompt.includes('[cancelled-approval]')||prompt.includes('[duplicate-request]')){
     const req={type:'control_request',request_id:'permission-one',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'printf fixture-only',other:'<literal>'},title:'Fixture permission'}};send(req);
     if(prompt.includes('[cancelled-approval]')){send({type:'control_cancel_request',request_id:req.request_id});timeout=setTimeout(()=>finish('Expired permission, no action'),400);}
     if(prompt.includes('[duplicate-request]'))send(req);
   }else if(prompt.includes('[activity-slow]')){activity(false);timeout=setTimeout(()=>finish('Activity done'),5000);}
   else if(prompt.includes('[slow]'))timeout=setTimeout(()=>finish('Slow answer'),5000);
   else { if(prompt.includes('[activity]'))activity(true);if(prompt.includes('[edit-file]'))fs.writeFileSync('note.txt','Claude protocol fixture edit\n');finish('Hello 世界: '+prompt); }
 }else if(v.type==='control_response')finish('Decision: '+v.response.response.behavior);
}).on('close',()=>{clearTimeout(timeout);process.exit(0);});

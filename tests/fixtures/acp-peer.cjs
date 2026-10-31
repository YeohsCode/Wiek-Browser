// Independent ACP v1 wire peer. No model, credentials or external services.
const fs=require('node:fs'),rl=require('node:readline');
const argv=process.argv.slice(2),auditPath=process.env.VEK_ACP_AUDIT||argv.find(x=>x.startsWith('--vek-audit='))?.slice(12);
const audit=v=>{if(auditPath)fs.appendFileSync(auditPath,JSON.stringify(v)+'\n')};
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
const reply=(id,result)=>send({id,result});let session='fixture-owned-session',promptId,timeout,model='fixture/a';
const options=()=>[{id:'model',name:'Model',category:'model',type:'select',currentValue:model,options:[{group:'fixture',name:'Fixture',options:[{value:'fixture/a',name:'Fixture A'},{value:'fixture/b',name:'Fixture B'}]}]}];
const config=()=>argv.includes('--legacy')?{models:{currentModelId:model,availableModels:[{modelId:'fixture/a',name:'Fixture A'},{modelId:'fixture/b',name:'Fixture B'}]}}:{configOptions:options()};
const update=(value,id=session)=>send({method:'session/update',params:{sessionId:id,update:value}});
const finish=(stopReason='end_turn')=>reply(promptId,{stopReason,usage:{inputTokens:12,outputTokens:5}});
const answer=text=>{
 const wire=Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}})+'\n');
 const split=wire.indexOf(Buffer.from('世'))+1;process.stdout.write(wire.subarray(0,split));process.stdout.write(wire.subarray(split));
 update({sessionUpdate:'tool_call',toolCallId:'read-one',title:'Read',status:'in_progress',rawInput:{path:'fixture.txt'}});
 update({sessionUpdate:'tool_call_update',toolCallId:'read-one',status:'completed',content:[{type:'content',content:{type:'text',text:'Actual tool output'}},{type:'diff',path:'note.txt',oldText:'old',newText:'new'}]});
 const child={_meta:{'opencode/child-session':{id:'child-one',parentID:session,depth:1,title:'Local child'}}};
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Child-only answer'},...child});
 update({sessionUpdate:'tool_call',toolCallId:'child-tool',title:'Child Read',status:'in_progress',...child});
 update({sessionUpdate:'usage_update',used:32,size:4096,cost:{amount:0.005,currency:'USD'}});finish();
};
audit({argv});
rl.createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);audit(v);const p=v.params||{};
 if(v.method==='initialize'){
  if(argv.includes('--slow-init'))return;
  return reply(v.id,{protocolVersion:argv.includes('--bad-version')?9:1,agentCapabilities:{loadSession:!argv.includes('--no-load'),promptCapabilities:argv.includes('--no-attachments')?{}:{image:true,embeddedContext:true}}});
 }
 if(v.method==='session/new'||v.method==='session/load'){
  if(v.method==='session/load'){
   session=p.sessionId;update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'REPLAY must be ignored'}});
   update({sessionUpdate:'tool_call',toolCallId:'replayed',title:'Old tool',status:'completed'});
  }
  return reply(v.id,{...(v.method==='session/new'?{sessionId:session}:{}),...config()});
 }
 if(v.method==='session/set_config_option'){model=argv.includes('--reject-model')?'fixture/a':p.value;return reply(v.id,{configOptions:options()});}
 if(v.method==='session/set_model'){model=p.modelId;return reply(v.id,{});}
 if(v.method==='session/cancel'){clearTimeout(timeout);return finish('cancelled');}
 if(v.method==='session/prompt'){
  promptId=v.id;const text=p.prompt[0].text;
  if(text.includes('[disconnect]'))return process.exit(0);
  if(text.includes('[malformed]'))return process.stdout.write('not JSON\n');
  if(text.includes('[oversize]'))return process.stdout.write('x'.repeat(4*1024*1024+1));
  if(text.includes('[wrong-session]'))return update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'foreign'}},'foreign');
  if(text.includes('[unknown-stop]'))return finish('invented');
  if(text.includes('[client-method]')){send({id:'fs-one',method:'fs/write_text_file',params:{sessionId:session,path:'/never-create',content:'forbidden'}});return;}
  if(text.includes('[approval]')||text.includes('[always-only]')){
   const options=[{kind:'allow_always',optionId:'always',name:'Always'},{kind:'reject_once',optionId:'reject',name:'Reject once'}];
   if(!text.includes('[always-only]'))options.push({kind:'allow_once',optionId:'once',name:'Allow once'});
   send({id:'permission-one',method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'permission-tool',title:'Fixture permission'},options}});return;
  }
  if(text.includes('[slow]')){timeout=setTimeout(()=>answer('Late answer'),10000);return;}
  if(text.includes('[edit-file]'))fs.writeFileSync('note.txt','ACP protocol fixture edit\n');
  return answer('Hello 世界: '+text);
 }
 if(v.id==='permission-one')return answer('Decision: '+JSON.stringify(v.result.outcome));
 if(v.id==='fs-one')return answer('Client method result: '+v.error.code);
}).on('close',()=>{clearTimeout(timeout);process.exit(0)});

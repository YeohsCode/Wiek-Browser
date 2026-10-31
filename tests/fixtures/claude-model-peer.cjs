// Independent, model-free Claude initialize/catalogue/control peer.
const fs=require('node:fs'),rl=require('node:readline');
const argv=process.argv.slice(2),session=argv.find(v=>/^--(?:resume|session-id)=/.test(v))?.split('=')[1];
const auditPath=process.env.VEK_CLAUDE_AUDIT||argv.find(v=>v.startsWith('--vek-audit='))?.slice(12);
const audit=value=>{if(auditPath)fs.appendFileSync(auditPath,JSON.stringify(value)+'\n')};
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const models=[{value:'default',displayName:'Default fixture',resolvedModel:'fixture/canonical',supportsEffort:true,supportedEffortLevels:['low','high'],supportsAdaptiveThinking:true},{value:'fixture/old',displayName:'Older CLI fixture'}];
audit({argv});let prompted=false;
rl.createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);audit(v);
 if(v.type==='control_request'){
  if(v.request.subtype==='initialize'&&argv.includes('--slow-init'))return;
  if(v.request.subtype==='initialize'&&argv.includes('--disconnect-init'))return process.exit(0);
  if(v.request.subtype==='initialize'&&argv.includes('--malformed-init'))return process.stdout.write('broken-json\n');
  if(v.request.subtype==='apply_flag_settings'&&argv.includes('--reject-effort'))return send({type:'control_response',response:{subtype:'error',request_id:v.request_id,error:'Unsupported effort overlay'}});
  send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:v.request.subtype==='initialize'?{models:argv.includes('--stale')?[]:models}:{}}});
 }else if(v.type==='user'){
  prompted=true;send({type:'system',subtype:'init',session_id:session});
  const text='Hello 世界: '+v.message.content[0].text;
  send({type:'assistant',session_id:session,message:{id:'fixture-answer',content:[{type:'text',text}]}});
  send({type:'result',subtype:'success',is_error:false,session_id:session,uuid:'fixture-result',user_message_uuid:v.uuid,usage:{input_tokens:10,output_tokens:2},result:text});
 }
}).on('close',()=>process.exit(0));

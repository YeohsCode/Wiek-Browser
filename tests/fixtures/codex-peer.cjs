// Independent model-free app-server peer, with a paginated capability catalogue.
const fs=require('node:fs'),rl=require('node:readline');const args=process.argv.slice(2),auditPath=process.env.VEK_CODEX_AUDIT||args.find(x=>x.startsWith('--vek-audit='))?.slice(12);const audit=v=>{if(auditPath)fs.appendFileSync(auditPath,JSON.stringify(v)+'\n')};
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');const reply=(id,result)=>send({id,result});let thread='owned-codex-session',turn='turn-fixture';
const models=[{id:'id-a',model:'fixture/a',displayName:'Model A',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'low',inputModalities:['text','image'],isDefault:true},{id:'id-b',model:'fixture/b',displayName:'Model B',supportedReasoningEfforts:[{reasoningEffort:'medium'}],defaultReasoningEffort:'medium',inputModalities:['text'],isDefault:false}];
const finish=text=>{const v={method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,itemId:'answer',delta:text}},wire=Buffer.from(JSON.stringify(v)+'\n'),at=wire.indexOf(Buffer.from('世'))+1;process.stdout.write(wire.subarray(0,at));process.stdout.write(wire.subarray(at));send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}})};
audit({args});rl.createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);audit(v);const p=v.params||{};
 if(v.method==='initialize'){if(args.includes('--slow-init'))return;return reply(v.id,{userAgent:'Fixture-only'})}
 if(v.method==='model/list'){
  if(args.includes('--disconnect'))return process.exit(0);
  if(args.includes('--malformed'))return process.stdout.write('not JSON\n');
  if(args.includes('--stale'))return reply(v.id,{data:[],nextCursor:null});
  if(args.includes('--repeated-cursor'))return reply(v.id,{data:models,nextCursor:'loop'});
  return reply(v.id,{data:[p.cursor?models[1]:models[0]],nextCursor:p.cursor?null:'second'});
 }
 if(v.method==='thread/start'||v.method==='thread/resume'){
  if(v.method==='thread/resume')send({method:'item/agentMessage/delta',params:{threadId:thread,itemId:'old',delta:'REPLAY'}});
  return reply(v.id,{thread:{id:thread}});
 }
 if(v.method==='turn/start'){
  reply(v.id,{turn:{id:turn,status:'inProgress'}});const text=p.input[0].text;
  if(text.includes('[wrong-thread]'))return send({method:'item/agentMessage/delta',params:{threadId:'foreign',turnId:turn,itemId:'foreign',delta:'Must reject'}});
  if(text.includes('[unknown-status]'))return send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'unknown'}}});
  if(text.includes('[edit-file]'))fs.writeFileSync('note.txt','Codex protocol fixture edit\n');return finish('Hello 世界: '+text);
 }
 if(v.method==='turn/interrupt'){reply(v.id,{});send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'interrupted'}}})}
}).on('close',()=>process.exit(0));

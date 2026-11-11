'use strict';
const readline=require('node:readline'),META='io.modelcontextprotocol/subscriptionId',modes=new Set(process.argv.slice(2)),streams=new Map(),calls=[];let serial=0;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const result=(id,value)=>send({id,result:{resultType:'complete',...value}});
const notification=(id,method,params={})=>send({method,params:{...params,_meta:{[META]:id}}});
function emit(method,params={}){if(modes.has('--legacy'))send({method,params});for(const[id,filter]of streams){const key=method==='notifications/tools/list_changed'?'toolsListChanged':method==='notifications/prompts/list_changed'?'promptsListChanged':method==='notifications/resources/list_changed'?'resourcesListChanged':'resourceSubscriptions';if(filter[key]===true||Array.isArray(filter[key])&&filter[key].includes(params.uri))notification(id,method,params);}}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);calls.push(m);if(m.method==='notifications/cancelled'){streams.delete(m.params.requestId);return;}if(!Object.hasOwn(m,'id'))return;
 if(m.method==='initialize'&&modes.has('--legacy'))return send({id:m.id,result:{protocolVersion:'2025-11-25',serverInfo:{name:'Legacy prompt fixture'},capabilities:{tools:{listChanged:true},prompts:{listChanged:true}}}});
 if(!modes.has('--legacy')&&m.params?._meta?.['io.modelcontextprotocol/protocolVersion']!=='2026-07-28')return send({id:m.id,error:{code:-32022,message:'Expected per-request metadata'}});
 const p=m.params;
 if(m.method==='server/discover'){if(modes.has('--bad-discovery'))return result(m.id,{supportedVersions:['future'],capabilities:{}});return result(m.id,{supportedVersions:['2026-07-28'],capabilities:{tools:{listChanged:true},resources:{subscribe:true,listChanged:true},prompts:{listChanged:true}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'Modern stdio fixture'}}});}
 if(m.method==='subscriptions/listen'){
  streams.set(m.id,p.notifications);if(modes.has('--silent-ack'))return;
  if(modes.has('--before-ack'))return notification(m.id,'notifications/tools/list_changed');
  const accepted=modes.has('--extra-filter')?{...p.notifications,resourceSubscriptions:['fixture:///unrequested']}:modes.has('--partial-filter')?{promptsListChanged:p.notifications.promptsListChanged===true}:p.notifications;
  notification(m.id,'notifications/subscriptions/acknowledged',{notifications:accepted});return;
 }
 if(m.method==='tools/list'){if(modes.has('--list-race'))emit('notifications/tools/list_changed');return result(m.id,{tools:[{name:'control',inputSchema:{type:'object'}}]});}
 if(m.method==='prompts/list'){
  if(modes.has('--prompt-race'))emit('notifications/prompts/list_changed');
  if(modes.has('--duplicate-prompts'))return result(m.id,{prompts:[{name:'same'},{name:'same'}]});
  if(modes.has('--repeat-cursor'))return result(m.id,{prompts:[],nextCursor:'same'});
  if(modes.has('--bad-arguments'))return result(m.id,{prompts:[{name:'broken',arguments:[{name:'subject',required:'yes'}]}]});
  return result(m.id,{prompts:[{name:p.cursor?'second':'summary',title:'Prompt <script id="untrusted">',description:'Inert prompt fixture',arguments:[{name:'subject',required:true}]}],...(p.cursor?{}:{nextCursor:'second'})});
 }
 if(m.method==='prompts/get'){if(modes.has('--change-on-get'))emit('notifications/prompts/list_changed');return result(m.id,{messages:[{role:modes.has('--bad-role')?'system':'user',content:{type:'text',text:'PRIVATE_PROMPT <script>window.promptExecuted=true</script> '+p.arguments.subject}}]});}
 if(m.method==='resources/list')return result(m.id,{resources:[{uri:'fixture:///notes',name:'Notes'}]});
 if(m.method==='resources/read')return result(m.id,{contents:[{uri:p.uri,text:'fixture resource'}]});
 if(m.method==='tools/call'){
  const action=p.arguments?.action;
  if(action==='invalid-utf8'){process.stdout.write(Buffer.from([0xff]));return;}
  if(action==='input'){if(p.inputResponses)return result(m.id,{content:[{type:'text',text:'Reviewed form accepted'}]});send({id:m.id,result:{resultType:'input_required',requestState:'PRIVATE_CONTINUATION',inputRequests:{ask:{method:'elicitation/create',params:{mode:'form',message:'Fixture input',requestedSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}}}}});return;}
  if(action==='emit'){emit(p.arguments.method,p.arguments.params||{});return result(m.id,{content:[]});}
  if(action==='unsolicited'){send({method:'notifications/prompts/list_changed'});send({method:'notifications/tools/list_changed'});return result(m.id,{content:[]});}
  if(action==='wrong-stream'){const [id]=streams.keys();notification(id,'notifications/resources/updated',{uri:'fixture:///unrequested'});return result(m.id,{content:[]});}
  if(action==='close-streams'){for(const id of [...streams.keys()]){result(id,{_meta:{[META]:id}});streams.delete(id);}return result(m.id,{content:[]});}
  if(action==='server-request'){send({id:'illegal',method:'roots/list'});return;}
  if(action==='slow'){setTimeout(()=>result(m.id,{content:[]}),500);return;}
  if(action==='inspect')return result(m.id,{content:[{type:'text',text:JSON.stringify({calls,streams:streams.size,pid:process.pid})}]});
  return result(m.id,{content:[{type:'text',text:String(++serial)}]});
 }
 send({id:m.id,error:{code:-32601,message:'Unknown fixture method'}});
});

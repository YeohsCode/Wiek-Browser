'use strict';
// Offline protocol peer shared by transport, IPC, packaged-host and native QA.
const http=require('node:http'),fs=require('node:fs');
async function createFixture(settings={}){
 const calls=[],streams=new Set(),held=new Set();let revision=0;
 const json=(res,id,result)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id,result:{resultType:'complete',...result}}));};
 const event=(stream,message)=>stream.res.write('data: '+JSON.stringify({jsonrpc:'2.0',...message})+'\r\n\r\n');
 const notification=(stream,method,params={})=>event(stream,{method,params:{...params,_meta:{'io.modelcontextprotocol/subscriptionId':stream.message.id}}});
 const emit=(method,params={})=>{for(const stream of streams){const f=stream.accepted;if(method==='notifications/tools/list_changed'&&f.toolsListChanged||method==='notifications/prompts/list_changed'&&f.promptsListChanged||method==='notifications/resources/list_changed'&&f.resourcesListChanged||method==='notifications/resources/updated'&&f.resourceSubscriptions?.includes(params.uri))notification(stream,method,params);}};
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const b of req)body+=b;let m;try{m=JSON.parse(body);}catch{res.writeHead(400).end();return;}calls.push({message:m,method:req.method,headers:req.headers});
  if(m.method==='server/discover')return json(res,m.id,{supportedVersions:['2026-07-28'],capabilities:settings.capabilities||{tools:{listChanged:true},resources:{subscribe:true,listChanged:true}},_meta:{'io.modelcontextprotocol/serverInfo':{name:'Offline modern resource fixture',version:'1'}}});
  if(m.method==='subscriptions/listen'){
   if(settings.listenHttpStatus){res.writeHead(settings.listenHttpStatus,{'content-type':'application/json'}).end('{}');return;}
   res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();const accepted=settings.ackFilter||(settings.listenMode==='subset'?{}:m.params.notifications),stream={res,message:m,accepted};streams.add(stream);res.on('close',()=>streams.delete(stream));
   if(settings.listenMode==='noack')return;
   if(settings.listenMode==='early')return notification(stream,'notifications/resources/updated',{uri:'fixture:///notes'});
   if(settings.listenMode==='wrongid')return event(stream,{method:'notifications/subscriptions/acknowledged',params:{_meta:{'io.modelcontextprotocol/subscriptionId':m.id+1},notifications:accepted}});
   if(settings.listenMode==='wrongfilter')return notification(stream,'notifications/subscriptions/acknowledged',{notifications:{resourceSubscriptions:['fixture:///unrequested']}});
   notification(stream,'notifications/subscriptions/acknowledged',{notifications:accepted});
   if(settings.listenMode==='early-update'&&accepted.resourceSubscriptions)notification(stream,'notifications/resources/updated',{uri:accepted.resourceSubscriptions[0]});
   return;
  }
  if(m.method==='prompts/list')return json(res,m.id,{prompts:[{name:'inert',arguments:[{name:'subject',required:true}]}]});
  if(m.method==='prompts/get')return json(res,m.id,{messages:[{role:'user',content:{type:'text',text:'Inert prompt '+m.params.arguments.subject}}]});
  if(m.method==='resources/list'){
   const rows=[{uri:'fixture:///notes',name:'Notes <script id="untrusted">x</script>'},{uri:'fixture:///binary',name:'Binary'}];
   return json(res,m.id,{resources:settings.listMode==='paged'?[rows[m.params.cursor?1:0]]:rows,...(settings.listMode==='paged'&&!m.params.cursor?{nextCursor:'page-2'}:{}),ttlMs:0,cacheScope:'private'});
  }
  if(m.method==='resources/templates/list')return json(res,m.id,{resourceTemplates:[{uriTemplate:'fixture:///entry/{id}',name:'Entry'}]});
  if(m.method==='resources/read'){
   if(settings.readMode==='input')return json(res,m.id,{resultType:'input_required',inputRequests:{ask:{method:'elicitation/create',params:{message:'Offline form'}}},requestState:'opaque-not-authority'});
   if(settings.readMode==='missing-type'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{contents:[]}}));return;}
   const finish=()=>json(res,m.id,{contents:[m.params.uri==='fixture:///binary'?{uri:m.params.uri,blob:'AAEC'}:{uri:m.params.uri,text:'离线内容 '+revision+' <script>inert</script>'}]});
   if(settings.readMode==='hold'){held.add(finish);res.on('close',()=>held.delete(finish));return;}
   return finish();
  }
  if(m.method==='tools/list'&&settings.holdTools){const finish=()=>json(res,m.id,{tools:[]});held.add(finish);res.on('close',()=>held.delete(finish));return;}
  if(m.method==='tools/list'&&settings.unsolicited){res.writeHead(200,{'content-type':'text/event-stream'});event({res},{method:'notifications/tools/list_changed',params:{}});event({res},{id:m.id,result:{resultType:'complete',tools:[]}});res.end();return;}
  if(m.method==='tools/list')return json(res,m.id,{tools:['echo','mutate','inspect',...(settings.inputTool?['interactive']:[])].map(name=>({name,inputSchema:{type:'object'}}))});
  if(m.method==='tools/call'){
   if(settings.inputTool&&m.params.name==='interactive'){
    if(m.params.inputResponses)return json(res,m.id,{content:[{type:'text',text:'Reviewed input: '+JSON.stringify(m.params.inputResponses)}]});
    return json(res,m.id,{resultType:'input_required',requestState:'opaque-local-state',inputRequests:{profile:{method:'elicitation/create',params:{mode:'form',message:'Local fixture: choose a display name and count. <script>inert</script>',requestedSchema:{type:'object',properties:{name:{type:'string',title:'Display name',minLength:2},count:{type:'integer',title:'Count',minimum:1,maximum:3,default:2},confirm:{type:'boolean',title:'Confirm',default:false}},required:['name','count','confirm']}}}}});
   }
   if(m.params.name==='mutate'){revision++;emit('notifications/resources/updated',{uri:'fixture:///notes'});emit('notifications/resources/list_changed');emit('notifications/tools/list_changed');}
   return json(res,m.id,{content:[{type:'text',text:m.params.name==='inspect'?JSON.stringify({calls:calls.map(c=>c.message.method),activeStreams:streams.size}):'offline fixture result'}]});
  }
  res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported fixture method'}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {settings,calls,streams,held,event,notification,emit,url:'http://127.0.0.1:'+server.address().port+'/mcp',close:async()=>{for(const s of streams)s.res.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
module.exports={createFixture};
if(require.main===module)createFixture({inputTool:process.argv.includes('--input')}).then(f=>{if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify({url:f.url,pid:process.pid}));console.log(f.url);process.once('SIGTERM',async()=>{await f.close();process.exit(0);});});

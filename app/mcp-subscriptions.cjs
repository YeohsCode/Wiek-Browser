'use strict';
// Explicit 2026 notification streams. No replay, reconnect or resource fetch.
const {uri,capability,resourceNotification}=require('./mcp-resources.cjs');
const {promptNotification}=require('./mcp-prompts.cjs');
const fail=(message,code='VEK_MCP_PROTOCOL_ERROR')=>Object.assign(new Error(message),{error_code:code});
const META='io.modelcontextprotocol/subscriptionId';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function validateFilter(value,requested){
 if(!object(value))throw fail('Invalid subscription acknowledgment filter');
 const accepted={};
 for(const [key,entry]of Object.entries(value)){
  if(key==='resourceSubscriptions'){
   if(!Array.isArray(entry)||entry.length>128||new Set(entry).size!==entry.length||entry.some(v=>typeof v!=='string'||!requested.resourceSubscriptions?.includes(v)))throw fail('Subscription acknowledged an unrequested resource');
   accepted[key]=entry;
  }else if(['toolsListChanged','resourcesListChanged','promptsListChanged'].includes(key)){
   if(typeof entry!=='boolean'||entry===true&&requested[key]!==true)throw fail('Subscription acknowledged an unrequested notification');
   if(entry)accepted[key]=true;
  }else throw fail('Subscription acknowledged an unsupported notification');
 }
 return accepted;
}
function createSubscriptionMethods(SseDecoder){return {
 subscriptionSnapshot(){return {lists:this.listStream?{status:this.listStream.status,notifications:this.listStream.accepted||{},error:this.listStream.error||''}:null,activeStreams:this.notificationStreams?.size||0};},
 cancelModernStreams(){for(const stream of this.notificationStreams?.values()||[])stream.cancel();},
 async watchLists(enabled,{signal}={}){
  if(!this.modern)throw fail('List streams require the 2026 MCP protocol','VEK_MCP_UNSUPPORTED_CAPABILITY');
  if(this.state!=='connected'||this.stopped)throw fail('MCP connection is disconnected','VEK_MCP_DISCONNECTED');
  if(this.listOperation)throw fail('List subscription is already changing','VEK_MCP_BUSY');
  this.listOperation=true;
  try{
   if(this.listStream?.status==='subscribed'&&enabled)return this.subscriptionSnapshot();
   if(this.listStream){this.listStream.cancel();await this.listStream.done;this.listStream=null;}
   if(enabled){
    const notifications={};if(this.info?.capabilities?.tools?.listChanged===true)notifications.toolsListChanged=true;if(this.info?.capabilities?.resources?.listChanged===true)notifications.resourcesListChanged=true;if(this.info?.capabilities?.prompts?.listChanged===true)notifications.promptsListChanged=true;
    if(!Object.keys(notifications).length)throw fail('Server does not advertise list changes','VEK_MCP_UNSUPPORTED_CAPABILITY');
    const stream=this.openSubscription(notifications,{signal,onEvent:message=>{
     if(message.method==='notifications/tools/list_changed'){this.toolListRevision=(this.toolListRevision||0)+1;this.tools=null;this.toolHeaders.clear();this.notifyChange();}
     else if(!promptNotification(this,message,true))resourceNotification(this,message,true);
    },onEnd:()=>{this.toolListRevision=(this.toolListRevision||0)+1;this.tools=null;this.toolHeaders.clear();this.resourceListRevision++;this.resources=null;this.resourceTemplates=null;this.promptListRevision++;this.prompts=null;}});
    this.listStream=stream;await stream.ready;
   }
   this.notifyChange();return this.subscriptionSnapshot();
  }finally{this.listOperation=false;}
 },
 async changeModernResourceSubscription(value,enabled,{signal}={}){
  capability(this,true);uri(value);
  if(this.resourceOperations.has(value))throw fail('This resource subscription is already changing','VEK_MCP_BUSY');
  const previous=this.resourceSubscriptions.get(value),generation=this.resourceSubscriptions;
  if(enabled&&previous?.status==='subscribed')return {...previous};
  if(!enabled&&!previous)return {uri:value,status:'unsubscribed'};
  if(enabled&&!previous&&generation.size>=128)throw fail('MCP resource subscription limit reached','VEK_MCP_CAPACITY');
  this.resourceOperations.add(value);
  try{
   const old=[...this.notificationStreams.values()].find(s=>s.uri===value);if(old){old.cancel();await old.done;}
   if(!enabled){generation.delete(value);this.notifyChange();return {uri:value,status:'unsubscribed'};}
   const item=previous||{uri:value,revision:0,readRevision:0};if(previous)item.revision=Math.min(Number.MAX_SAFE_INTEGER,item.revision+1);item.status='subscribing';delete item.error;generation.set(value,item);
   const stream=this.openSubscription({resourceSubscriptions:[value]},{signal,uri:value,onEvent:message=>resourceNotification(this,message,true),onStatus:(status,error)=>{if(this.resourceSubscriptions===generation&&generation.get(value)===item){item.status=status;if(error)item.error=error;}},onEnd:()=>{if(this.resourceSubscriptions===generation&&generation.get(value)===item)item.revision=Math.min(Number.MAX_SAFE_INTEGER,item.revision+1);}});
   await stream.ready;return {...item};
  }catch(error){if(this.resourceSubscriptions===generation&&generation.has(value)&&generation.get(value).status==='subscribing')generation.get(value).status='unknown';throw error;}
  finally{if(this.resourceSubscriptions===generation)this.resourceOperations.delete(value);this.notifyChange();}
 },
 openSubscription(notifications,{signal,uri:resourceUri,onEvent,onEnd=()=>{},onStatus=()=>{}}={}){
  if(signal?.aborted)throw fail('MCP subscription cancelled','VEK_MCP_CANCELLED');
  if(this.notificationStreams.size>=16||this.controllers.size>=64)throw fail('MCP notification stream limit reached','VEK_MCP_CAPACITY');
  const id=this.nextId++,controller=new AbortController();let resolve,reject,acknowledged=false,completed=false,cancelled=false;
  const ready=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const stream={uri:resourceUri,status:'subscribing',ready,cancel:()=>{cancelled=true;controller.abort();}};
  const status=(state,error='')=>{stream.status=state;stream.error=error;onStatus(state,error);this.notifyChange();};
  const abort=()=>stream.cancel();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  this.controllers.add(controller);this.notificationStreams.set(id,stream);
  const operation=(async()=>{
   try{
    const response=await this.open('POST',{jsonrpc:'2.0',id,method:'subscriptions/listen',params:this.modernParams({notifications})},controller.signal);
    if(response.statusCode!==200||(response.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='text/event-stream'){
     response.destroy();if([401,403].includes(response.statusCode))this.onAuthorizationFailure?.(response.statusCode);
     throw fail('MCP subscription requires an HTTP 200 SSE response', [401,403].includes(response.statusCode)?'VEK_MCP_HTTP_AUTH':'VEK_MCP_PROTOCOL_ERROR');
    }
    const decoder=new TextDecoder('utf-8',{fatal:true});
    const handle=message=>{
     if(completed)throw fail('MCP subscription delivered a message after completion');
     if(!object(message)||message.jsonrpc!=='2.0')throw fail('Malformed subscription message');
     const isResponse=Object.hasOwn(message,'id'),meta=isResponse?message.result?._meta:message.params?._meta;
     if(meta?.[META]!==id)throw fail('MCP subscription ID mismatch');
     if(!acknowledged){
      if(isResponse||message.method!=='notifications/subscriptions/acknowledged')throw fail('MCP subscription notification arrived before acknowledgment');
      stream.accepted=validateFilter(message.params.notifications,notifications);acknowledged=true;clearTimeout(timer);
      const honored=Object.values(stream.accepted).some(v=>v===true||Array.isArray(v)&&v.length);
      status(honored?'subscribed':'unsupported');resolve();if(!honored)stream.cancel();return;
     }
     if(isResponse){
      if(message.id!==id||Object.hasOwn(message,'method')||Object.hasOwn(message,'error')||message.result?.resultType!=='complete')throw fail('Invalid subscription completion');
      completed=true;return;
     }
     const method=message.method,filter=stream.accepted;
     if(method==='notifications/tools/list_changed'&&filter.toolsListChanged||method==='notifications/prompts/list_changed'&&filter.promptsListChanged||method==='notifications/resources/list_changed'&&filter.resourcesListChanged||method==='notifications/resources/updated'&&filter.resourceSubscriptions?.includes(message.params?.uri))onEvent(message);
     else throw fail('MCP subscription delivered an unrequested notification');
    };
    const parser=new SseDecoder({maxBytes:this.maxMessageBytes,maxEvents:Infinity,onMessage:handle,onCursor:()=>{}});
    try{for await(const chunk of response){parser.feed(decoder.decode(chunk,{stream:true}));if(completed){response.destroy();break;}}if(!completed)parser.feed(decoder.decode(),true);}
    finally{response.destroy();}
    if(!acknowledged)throw fail('MCP subscription ended before acknowledgment');
    if(!completed&&!cancelled)throw fail('MCP subscription connection was lost');
    if(completed)status('closed');
   }catch(error){
    const failure=controller.signal.aborted?fail(cancelled?'MCP subscription cancelled':'MCP subscription acknowledgment timed out',cancelled?'VEK_MCP_CANCELLED':'VEK_MCP_TIMEOUT'):fail(error.error_code?error.message:'MCP subscription connection was lost',error.error_code||'VEK_MCP_DISCONNECTED');
    if(!acknowledged)reject(failure);
    if(!(cancelled&&stream.status==='unsupported'))status(cancelled?'cancelled':'lost',cancelled?'':failure.message);
   }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',abort);this.controllers.delete(controller);this.notificationStreams.delete(id);onEnd();this.notifyChange();
   }
  })();stream.done=operation;this.operations.add(operation);void operation.finally(()=>this.operations.delete(operation));this.notifyChange();return stream;
 }
};}
module.exports={createSubscriptionMethods,validateFilter};

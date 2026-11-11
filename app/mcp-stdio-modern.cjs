'use strict';
// Modern stdio shares one channel; subscriptions are demultiplexed by metadata.
const {validateFilter}=require('./mcp-subscriptions.cjs');
const META='io.modelcontextprotocol/subscriptionId';
const fail=(message,code='VEK_MCP_PROTOCOL_ERROR')=>Object.assign(new Error(message),{error_code:code});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const methods={
 modernParams(params,allowInput=false){return {...params,_meta:{...(params._meta||{}),'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'wiek-browser',version:'0.1.0'},'io.modelcontextprotocol/clientCapabilities':allowInput?{elicitation:{form:{}}}:{}}};},
 consumeModernSubscription(message){
  const response=Object.hasOwn(message,'id')&&!Object.hasOwn(message,'method'),id=response?message.id:message.params?._meta?.[META];
  const stream=this.notificationStreams.get(id);
  if(!stream)return !response&&Object.hasOwn(message.params?._meta||{},META);
  try{stream.accept(message);}catch(error){stream.fail(error);}return true;
 },
 openSubscription(notifications,{signal,uri,onEvent,onEnd=()=>{},onStatus=()=>{}}={}){
  if(signal?.aborted)throw fail('MCP subscription cancelled','VEK_MCP_CANCELLED');
  if(this.notificationStreams.size>=16)throw fail('MCP notification stream limit reached','VEK_MCP_CAPACITY');
  const id=this.nextId++;let acknowledge=false,ended=false,resolve,reject,finishDone;
  const ready=new Promise((yes,no)=>{resolve=yes;reject=no;}),done=new Promise(yes=>finishDone=yes);
  const stream={id,uri,status:'subscribing',ready,done};
  const status=(value,error='')=>{stream.status=value;stream.error=error;onStatus(value,error);this.notifyChange();};
  const finish=(value,error,sendCancel=false)=>{
   if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.notificationStreams.delete(id);
   if(sendCancel&&!this.stopped){try{this.notify('notifications/cancelled',{requestId:id,reason:error?.message||'Subscription cancelled'});}catch{}}
   if(!acknowledge)reject(error||fail('Subscription ended before acknowledgment'));
   status(value,error?.message||'');onEnd();finishDone();
  };
  stream.cancel=()=>finish(stream.status==='unsupported'?'unsupported':'cancelled',fail('MCP subscription cancelled','VEK_MCP_CANCELLED'),true);
  stream.fail=error=>finish('lost',error,true);
  const abort=()=>stream.cancel(),timer=setTimeout(()=>stream.fail(fail('MCP subscription acknowledgment timed out','VEK_MCP_TIMEOUT')),this.timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  stream.accept=message=>{
   if(ended)return;const response=Object.hasOwn(message,'id');
   if(!object(message)||message.jsonrpc!=='2.0'||(response?message.result?._meta:message.params?._meta)?.[META]!==id)throw fail('MCP subscription ID mismatch');
   if(!acknowledge){if(response||message.method!=='notifications/subscriptions/acknowledged')throw fail('MCP subscription notification arrived before acknowledgment');stream.accepted=validateFilter(message.params.notifications,notifications);acknowledge=true;clearTimeout(timer);const honored=Object.values(stream.accepted).some(value=>value===true||Array.isArray(value)&&value.length);status(honored?'subscribed':'unsupported');resolve();if(!honored)stream.cancel();return;}
   if(response){if(message.id!==id||Object.hasOwn(message,'method')||Object.hasOwn(message,'error')||message.result?.resultType!=='complete')throw fail('Invalid subscription completion');finish('closed');return;}
   const filter=stream.accepted,method=message.method;
   if(method==='notifications/tools/list_changed'&&filter.toolsListChanged||method==='notifications/prompts/list_changed'&&filter.promptsListChanged||method==='notifications/resources/list_changed'&&filter.resourcesListChanged||method==='notifications/resources/updated'&&filter.resourceSubscriptions?.includes(message.params?.uri))onEvent(message);
   else throw fail('MCP subscription delivered an unrequested notification');
  };
  this.notificationStreams.set(id,stream);try{this.write({jsonrpc:'2.0',id,method:'subscriptions/listen',params:this.modernParams({notifications})});}catch(error){stream.fail(error);}
  return stream;
 }
};
module.exports={methods};

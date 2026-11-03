'use strict';
// Independent local app-server client. Discovery never starts a thread/turn.
const {StringDecoder}=require('node:string_decoder');
const validId=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v);
function codexClient(child,{onNotification=()=>{},onServerRequest,onFailure=()=>{}}={}){
 let sequence=0,buffer='',closed=false;const decoder=new StringDecoder('utf8'),pending=new Map();
 const write=value=>{if(closed||child.stdin.destroyed||child.stdin.writableEnded)throw Error('Codex input is closed');child.stdin.write(JSON.stringify(value)+'\n')};
 const request=(method,params={},timeoutMs=15000)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`Codex request timed out: ${method}`))},timeoutMs);timer.unref?.();pending.set(id,{resolve,reject,timer});try{write({id,method,params})}catch(e){clearTimeout(timer);pending.delete(id);reject(e)}});
 child.stdout.on('data',chunk=>{buffer+=decoder.write(chunk);try{let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(Buffer.byteLength(line)>4*1024*1024)throw Error('Codex frame exceeds 4 MiB');if(!line.trim())continue;const v=JSON.parse(line);if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Codex emitted invalid JSON object');
  if(v.id!==undefined&&!v.method){const p=pending.get(v.id);if(!p)continue;clearTimeout(p.timer);pending.delete(v.id);if(v.error)p.reject(Error(String(v.error.message||'Codex request failed').slice(0,8192)));else if(!v.result||typeof v.result!=='object'||Array.isArray(v.result))p.reject(Error('Codex response result is invalid'));else p.resolve(v.result)}
  else if(typeof v.method!=='string')throw Error('Codex frame is missing its method');
  else if(v.id!==undefined){if(onServerRequest)onServerRequest(v);else write({id:v.id,error:{code:-32601,message:'Unsupported client request'}})}
  else onNotification(v);
 }if(Buffer.byteLength(buffer)>4*1024*1024)throw Error('Codex frame exceeds 4 MiB')}catch(e){onFailure(e)}});
 child.once('close',()=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Codex provider disconnected'))}pending.clear()});
 return {write,request,initialize:async()=>{await request('initialize',{clientInfo:{name:'vek_browser',title:'Wiek Browser',version:require('../package.json').version},capabilities:{experimentalApi:false}});write({method:'initialized',params:{}})}};
}
async function readCodexCatalogue(request){
 const models=[],seen=new Set(),ids=new Set();let cursor=null,truncated=false;
 for(let page=0;page<16;page++){
  const r=await request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
  if(!Array.isArray(r.data)||r.data.length>1000)throw Error('Codex model catalogue response is invalid');
  for(const m of r.data){
   if(!validId(m?.id)||!validId(m?.model))throw Error('Codex model identity is invalid');if(m.hidden===true)continue;
   if(ids.has(m.model))continue;if(models.length>=256){truncated=true;break}ids.add(m.model);
   const efforts=[...new Set((Array.isArray(m.supportedReasoningEfforts)?m.supportedReasoningEfforts:[]).map(e=>e?.reasoningEffort).filter(validId))].slice(0,16);
   models.push({id:m.model,catalogueId:m.id,name:String(m.displayName||m.model).slice(0,256),reasoningEfforts:efforts,...(efforts.includes(m.defaultReasoningEffort)?{defaultReasoningEffort:m.defaultReasoningEffort}:{}),inputModalities:Array.isArray(m.inputModalities)?[...new Set(m.inputModalities.filter(x=>['text','image'].includes(x)))]:['text','image'],isDefault:m.isDefault===true});
  }
  if(r.nextCursor==null||r.nextCursor==='')return {source:'codex-model-list',observedAt:new Date().toISOString(),models,truncated};
  if(typeof r.nextCursor!=='string'||r.nextCursor.length>4096||seen.has(r.nextCursor))throw Error('Codex model catalogue has an invalid or repeated cursor');seen.add(r.nextCursor);cursor=r.nextCursor;
  if(truncated||page===15){truncated=true;break}
 }
 return {source:'codex-model-list',observedAt:new Date().toISOString(),models,truncated};
}
function validateCodexModel(thread,catalogue,attachments=[]){
 const chosen=thread.model?catalogue.models.find(m=>m.id===thread.model):catalogue.models.find(m=>m.isDefault);
 if(thread.model&&!chosen)throw Error('Selected model is absent from the Codex catalogue');
 if(thread.reasoningEffort&&(!chosen||!chosen.reasoningEfforts.includes(thread.reasoningEffort)))throw Error('Selected reasoning effort is absent from the Codex model capabilities');
 if(chosen&&attachments.some(a=>a.mimeType.startsWith('image/'))&&!chosen.inputModalities.includes('image'))throw Error('Selected Codex model does not advertise image input');
 return chosen;
}
function connectCodexDiscovery({child,active,run,thread,publish,killTree,onSession}){
 let finishing=false;active.native={completed:false};const failure=e=>{if(finishing||active.stopReason)return;finishing=true;run.error=String(e.message||e).slice(0,8192);killTree(child,'SIGTERM')};
 const client=codexClient(child,{onFailure:failure});active.native.ready=(async()=>{await client.initialize();if(active.stopReason)return;const catalogue=await readCodexCatalogue(client.request);if(active.stopReason)return;thread.nativeCatalog=catalogue;onSession();active.native.completed=true;finishing=true;publish();child.stdin.end();const timer=setTimeout(()=>killTree(child,'SIGTERM'),1000);timer.unref?.();child.once('close',()=>clearTimeout(timer))})();active.native.ready.catch(failure);
}
module.exports={codexClient,readCodexCatalogue,validateCodexModel,connectCodexDiscovery,validId};

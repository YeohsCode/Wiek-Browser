'use strict';
// Prompts are untrusted display data. Nothing here executes or injects them.
const {uri}=require('./mcp-resources.cjs');
const fail=(message,code='VEK_MCP_PROTOCOL_ERROR')=>Object.assign(new Error(message),{error_code:code});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const MAX_BYTES=2*1024*1024;
function text(value,label,max=16384){if(typeof value!=='string'||!value||Buffer.byteLength(value)>max||/[\x00-\x1f\x7f]/.test(value))throw fail('Invalid MCP prompt '+label);return value;}
function resetPrompts(client){client.promptListRevision=(client.promptListRevision||0)+1;client.promptGeneration={};client.prompts=null;}
function capability(client){if(client.state!=='connected'||client.stopped)throw fail('MCP connection is disconnected','VEK_MCP_DISCONNECTED');if(!object(client.info?.capabilities?.prompts))throw fail('MCP server does not advertise prompts','VEK_MCP_UNSUPPORTED_CAPABILITY');}
function promptNotification(client,message,authorized=false){
 if(message.method!=='notifications/prompts/list_changed')return false;
 if((!client.modern||authorized)&&client.info?.capabilities?.prompts?.listChanged===true){client.promptListRevision++;client.prompts=null;client.notifyChange();}
 return true;
}
function descriptor(value){
 if(!object(value))throw fail('Invalid MCP prompt descriptor');const out={name:text(value.name,'name',4096)};
 for(const key of ['title','description'])if(value[key]!==undefined){if(typeof value[key]!=='string'||Buffer.byteLength(value[key])>16384)throw fail('Invalid MCP prompt metadata');out[key]=value[key];}
 if(value.arguments!==undefined){if(!Array.isArray(value.arguments)||value.arguments.length>100)throw fail('Invalid MCP prompt arguments');const seen=new Set();out.arguments=value.arguments.map(arg=>{if(!object(arg))throw fail('Invalid MCP prompt argument');const entry={name:text(arg.name,'argument name',4096)};if(seen.has(entry.name))throw fail('Duplicate MCP prompt argument');seen.add(entry.name);if(arg.description!==undefined){if(typeof arg.description!=='string'||Buffer.byteLength(arg.description)>16384)throw fail('Invalid MCP prompt argument description');entry.description=arg.description;}if(arg.required!==undefined){if(typeof arg.required!=='boolean')throw fail('Invalid MCP prompt required flag');entry.required=arg.required;}return entry;});}
 return out;
}
function content(value){
 if(!object(value))throw fail('Invalid MCP prompt content');
 if(value.type==='text'&&typeof value.text==='string')return {type:'text',text:value.text};
 if(['image','audio'].includes(value.type)&&typeof value.mimeType==='string'&&typeof value.data==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)&&Buffer.from(value.data,'base64').toString('base64')===value.data)return {type:value.type,mimeType:text(value.mimeType,'MIME type'),data:value.data};
 if(value.type==='resource_link'&&typeof value.uri==='string')return {type:'resource_link',uri:uri(value.uri),name:text(value.name,'resource name')};
 if(value.type==='resource'&&object(value.resource)&&typeof value.resource.uri==='string'){
  const resource={uri:uri(value.resource.uri)};if(value.resource.mimeType!==undefined)resource.mimeType=text(value.resource.mimeType,'MIME type');
  if(Number(Object.hasOwn(value.resource,'text'))+Number(Object.hasOwn(value.resource,'blob'))!==1)throw fail('Invalid MCP prompt embedded resource');
  if(typeof value.resource.text==='string')resource.text=value.resource.text;
  else if(typeof value.resource.blob==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.resource.blob)&&Buffer.from(value.resource.blob,'base64').toString('base64')===value.resource.blob)resource.blob=value.resource.blob;
  else throw fail('Invalid MCP prompt embedded resource');
  return {type:'resource',resource};
 }
 throw fail('Unsupported MCP prompt content');
}
const methods={
 async listPrompts({signal}={}){
  capability(this);this.prompts=null;this.notifyChange();
  const rows=[],names=new Set(),cursors=new Set(),revision=this.promptListRevision,generation=this.promptGeneration;let cursor;
  for(let page=0;page<50;page++){
   const result=await this.request('prompts/list',cursor===undefined?{}:{cursor},{signal});if(!object(result)||!Array.isArray(result.prompts))throw fail('Invalid MCP prompt list');
   for(const item of result.prompts){const row=descriptor(item);if(names.has(row.name))throw fail('Duplicate MCP prompt name');names.add(row.name);rows.push(row);}
   if(rows.length>2000||Buffer.byteLength(JSON.stringify(rows))>MAX_BYTES)throw fail('MCP prompt list exceeds limits');
   if(result.nextCursor===undefined){if(this.state!=='connected'||generation!==this.promptGeneration||revision!==this.promptListRevision)throw fail('MCP prompt list changed during listing; refresh again');this.prompts=rows;this.notifyChange();return rows;}
   cursor=text(result.nextCursor,'cursor',4096);if(cursors.has(cursor))throw fail('Repeated MCP prompt cursor');cursors.add(cursor);
  }
  throw fail('MCP prompts pagination exceeded the limit');
 },
 async getPrompt(name,args={}, {signal}={}){
  capability(this);text(name,'name',4096);if(!object(args)||Object.keys(args).length>100||Buffer.byteLength(JSON.stringify(args))>65536||Object.values(args).some(value=>typeof value!=='string'))throw fail('Prompt arguments must be bounded strings');
  const prompts=this.prompts||await this.listPrompts({signal}),selected=prompts.find(row=>row.name===name);if(!selected)throw fail('Choose a listed MCP prompt');
  const definitions=selected.arguments||[];if(Object.keys(args).some(key=>!definitions.some(row=>row.name===key))||definitions.some(row=>row.required===true&&!Object.hasOwn(args,row.name)))throw fail('MCP prompt arguments do not match its definition');
  const generation=this.promptGeneration,revision=this.promptListRevision,result=await this.request('prompts/get',{name,arguments:args},{signal});
  if(this.state!=='connected'||generation!==this.promptGeneration)throw fail('MCP connection changed during prompt read');
  if(!object(result)||!Array.isArray(result.messages)||result.messages.length>100||Buffer.byteLength(JSON.stringify(result))>MAX_BYTES)throw fail('Invalid or oversized MCP prompt messages');
  const messages=result.messages.map(message=>{if(!object(message)||!['user','assistant'].includes(message.role))throw fail('Invalid MCP prompt role');return {role:message.role,content:content(message.content)};});
  const out={messages,revision,stale:revision!==this.promptListRevision};if(result.description!==undefined){if(typeof result.description!=='string'||Buffer.byteLength(result.description)>16384)throw fail('Invalid MCP prompt description');out.description=result.description;}return out;
 }
};
module.exports={methods,resetPrompts,promptNotification};

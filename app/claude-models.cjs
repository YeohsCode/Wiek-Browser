'use strict';
// Public initialize response metadata only. Absence is unknown, never capability proof.
const valid=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v);
const levels=new Set(['low','medium','high','xhigh','max']);
function readClaudeCatalogue(result){
 if(!Array.isArray(result?.models)||result.models.length>4096)throw Error('Claude initialize model catalogue is invalid');
 const models=[],seen=new Map();let truncated=false;
 for(const value of result.models){
  if(!value||!valid(value.value))throw Error('Claude model identity is invalid');
  const model={id:value.value,name:String(value.displayName||value.value).slice(0,256),description:String(value.description||'').slice(0,2048)};
  if(value.resolvedModel!==undefined){if(!valid(value.resolvedModel))throw Error('Claude resolved model identity is invalid');model.resolvedModel=value.resolvedModel;}
  for(const key of ['supportsEffort','supportsAdaptiveThinking'])if(value[key]!==undefined){if(typeof value[key]!=='boolean')throw Error('Claude model capability is invalid');model[key]=value[key];}
  if(value.supportedEffortLevels!==undefined&&(!Array.isArray(value.supportedEffortLevels)||value.supportedEffortLevels.length>32||value.supportedEffortLevels.some(e=>!levels.has(e))))throw Error('Claude effort capabilities are invalid');
  model.reasoningEfforts=value.supportsEffort===true?[...new Set(value.supportedEffortLevels||[])]:[];
  const serialized=JSON.stringify(model);if(seen.has(model.id)){if(seen.get(model.id)!==serialized)throw Error('Claude model catalogue has conflicting duplicate identities');continue;}seen.set(model.id,serialized);
  if(models.length>=256){truncated=true;continue;}models.push(model);
 }
 return {source:'claude-initialize',models,observedAt:new Date().toISOString(),truncated};
}
function validateClaudeModel(thread,catalogue){
 const selected=thread.model?catalogue.models.find(m=>m.id===thread.model||m.resolvedModel===thread.model):catalogue.models.find(m=>m.id==='default');
 if(thread.model&&!selected)throw Error('Selected model is absent from the Claude catalogue');
 if(thread.reasoningEffort&&(!selected||selected.supportsEffort!==true||!selected.reasoningEfforts.includes(thread.reasoningEffort)))throw Error('Selected reasoning effort is absent from the Claude model capabilities');
 return selected;
}
module.exports={readClaudeCatalogue,validateClaudeModel};

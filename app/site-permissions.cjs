'use strict';
// Permission decisions are scoped to profile, top-level origin, requesting origin
// and capability. Electron/Chromium still applies secure-context and OS checks.
const CAPABILITIES = Object.freeze({ notifications:'Notifications', geolocation:'Location', microphone:'Microphone', camera:'Camera', 'clipboard-read':'Read clipboard', 'clipboard-sanitized-write':'Write clipboard', fullscreen:'Fullscreen', pointerLock:'Pointer lock', keyboardLock:'Keyboard lock', 'idle-detection':'Idle detection', midi:'MIDI', midiSysex:'MIDI system exclusive', mediaKeySystem:'Protected media', 'speaker-selection':'Audio output selection', 'window-management':'Window management' });
const clone = value => JSON.parse(JSON.stringify(value));
const failure = message => Object.assign(new Error(message), {code:'VEK_PERMISSION_INVALID'});
function originOf(value) { try { if(typeof value!=='string'||value.length>16384)return null; const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password && url.origin.length<=2048 ? url.origin : null; } catch { return null; } }
function capabilities(permission, details = {}) {
  if (permission === 'media') {
    const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
    if (!Array.isArray(types) || !types.length || types.some(t => !['audio','video'].includes(t))) return [];
    return [...new Set(types.map(type => type === 'audio' ? 'microphone' : 'camera'))].sort();
  }
  if (permission === 'deprecated-sync-clipboard-read') permission = 'clipboard-read';
  return Object.hasOwn(CAPABILITIES,permission) ? [permission] : [];
}
function createSitePermissions({initial = [], legacy = {}, onChange = () => {}, prompt = async () => 'block-once', onPrompt = () => {}, timeoutMs = 60000} = {}) {
  let rules = [], closed = false; const generations = new Map(), once = new Map(), pending = new Map();
  function validated(value) {
    const origin = originOf(value?.origin), requestingOrigin = originOf(value?.requestingOrigin || value?.origin);
    if (!origin || !requestingOrigin || !Object.hasOwn(CAPABILITIES,value?.permission) || !['allow','block'].includes(value?.decision) || typeof value.profileId !== 'string' || !value.profileId || value.profileId.length>256) throw failure('Invalid site permission rule');
    return {profileId:value.profileId, origin, requestingOrigin, permission:value.permission, decision:value.decision};
  }
  function key(rule) { return JSON.stringify([rule.profileId,rule.origin,rule.requestingOrigin,rule.permission]); }
  for (const value of initial) { const rule=validated(value); rules=rules.filter(row=>key(row)!==key(rule)); rules.push(rule); }
  // Older broad media grants cannot safely be inferred to cover both devices.
  for (const [profileId, origins] of Object.entries(legacy)) for (const [origin, grants] of Object.entries(origins||{})) for (const [permission,allowed] of Object.entries(grants||{})) {
    if (!Object.hasOwn(CAPABILITIES,permission) || typeof allowed!=='boolean' || !originOf(origin)) continue;
    const rule=validated({profileId,origin,permission,decision:allowed?'allow':'block'}); if (!rules.some(row=>key(row)===key(rule))) rules.push(rule);
  }
  if (rules.length>10000) throw failure('Too many site permission rules');
  const snapshot = profileId => ({rules:clone(rules.filter(rule=>!profileId||rule.profileId===profileId)),capabilities:clone(CAPABILITIES)});
  const changed = () => onChange(clone(rules));
  function decision(rule) { return rules.find(row=>key(row)===key(rule))?.decision || 'ask'; }
  function set(value,exceptEntry) {
    if (closed) throw failure('Site permissions service is closed');
    const rule = validated({...value,decision:value.decision==='ask'?'block':value.decision});
    if (!['ask','allow','block'].includes(value.decision)) throw failure('Unknown site permission decision');
    if (rules.length>=10000 && !rules.some(row=>key(row)===key(rule)) && value.decision!=='ask') throw failure('Too many site permission rules');
    rules=rules.filter(row=>key(row)!==key(rule)); if (value.decision!=='ask') rules.push(rule);
    // Revoke in-memory allow-once decisions for the same capability as well.
    for (const [id,grants] of once) { grants.delete(key(rule)); if(!grants.size)once.delete(id); }
    for(const entry of [...pending.values()])if(entry!==exceptEntry&&entry.ctx.profileId===rule.profileId&&entry.ctx.origin===rule.origin&&entry.ctx.requestingOrigin===rule.requestingOrigin&&entry.ctx.names.includes(rule.permission))entry.finish(false);
    changed(); return snapshot(value.profileId);
  }
  function reset(profileId, origin) {
    if (closed) throw failure('Site permissions service is closed');
    const normalized=originOf(origin); if(!normalized)throw failure('Invalid site origin');
    rules=rules.filter(row=>row.profileId!==profileId || row.origin!==normalized);
    for (const [id,grants] of once) { for(const ruleKey of grants){const parts=JSON.parse(ruleKey);if(parts[0]===profileId&&parts[1]===normalized)grants.delete(ruleKey);}if(!grants.size)once.delete(id); }
    for(const entry of [...pending.values()])if(entry.ctx.profileId===profileId&&entry.ctx.origin===normalized)entry.finish(false);
    changed(); return snapshot(profileId);
  }
  function context({profileId,contents,permission,details={},requestingOrigin}) {
    if (closed || !contents || contents.isDestroyed()) return null;
    const origin=originOf(contents.getURL());
    // Never fall back to the top origin when Electron explicitly supplies an
    // opaque or unsupported frame origin. Requests without a frame are denied.
    const candidate=details.securityOrigin ?? requestingOrigin ?? details.requestingUrl;
    const requested=originOf(candidate);
    const names=capabilities(permission,details);
    if(!origin||!requested||!names.length||typeof profileId!=='string')return null;
    return {profileId,contents,origin,requestingOrigin:requested,names,generation:generations.get(contents.id)||0};
  }
  const valid = ctx => !closed && !ctx.contents.isDestroyed() && (generations.get(ctx.contents.id)||0)===ctx.generation && originOf(ctx.contents.getURL())===ctx.origin;
  const ruleFor = (ctx,permission) => ({profileId:ctx.profileId,origin:ctx.origin,requestingOrigin:ctx.requestingOrigin,permission});
  function check(value) {
    const ctx=context(value);return Boolean(ctx&&ctx.names.every(name=>{const rule=ruleFor(ctx,name),saved=decision(rule);return saved==='allow'||saved!=='block'&&once.get(ctx.contents.id)?.has(key(rule));}));
  }
  function invalidate(contents) {
    if(!contents)return;
    generations.set(contents.id,(generations.get(contents.id)||0)+1); once.delete(contents.id);
    for(const entry of pending.values())if(entry.ctx.contents===contents)entry.finish(false);
    if(contents.isDestroyed())generations.delete(contents.id);
  }
  function request(value,callback) {
    let finished=false;
    const done=allowed=>{if(!finished){finished=true;try{callback(Boolean(allowed));}catch{}}};
    const ctx=context(value); if(!ctx){done(false);return;}
    const values=ctx.names.map(name=>decision(ruleFor(ctx,name)));
    if(values.includes('block')){done(false);return;}
    if(check(value)){done(true);return;}
    const requestKey=JSON.stringify([ctx.contents.id,ctx.generation,ctx.profileId,ctx.origin,ctx.requestingOrigin,ctx.names]);
    const existing=pending.get(requestKey);if(existing){existing.callbacks.push(done);return;}
    if(pending.size>=16){done(false);return;}
    const entry={ctx,controller:new AbortController(),callbacks:[done],finish(allowed){if(pending.get(requestKey)!==entry)return;pending.delete(requestKey);clearTimeout(entry.timer);entry.controller.abort();for(const fn of entry.callbacks)fn(allowed);}};
    pending.set(requestKey,entry);entry.timer=setTimeout(()=>entry.finish(false),timeoutMs);entry.timer.unref?.();
    try{onPrompt({contents:ctx.contents,permission:value.permission});}catch{}
    Promise.resolve().then(()=>pending.get(requestKey)===entry&&valid(ctx)?prompt({contents:ctx.contents,origin:ctx.origin,requestingOrigin:ctx.requestingOrigin,signal:entry.controller.signal,permissions:ctx.names.map(name=>({id:name,label:CAPABILITIES[name]}))}):'block-once').then(answer=>{
      if(pending.get(requestKey)!==entry||!valid(ctx)){entry.finish(false);return;}
      // A rule changed while the dialog was open always wins over a stale prompt.
      if(ctx.names.some(name=>decision(ruleFor(ctx,name))==='block')){entry.finish(false);return;}
      const allowed=['allow-once','allow'].includes(answer);
      if(answer==='allow'||answer==='block')for(const permission of ctx.names)set({...ruleFor(ctx,permission),decision:answer},entry);
      if(answer==='allow-once'){if(!once.has(ctx.contents.id))once.set(ctx.contents.id,new Set());for(const name of ctx.names)once.get(ctx.contents.id).add(key(ruleFor(ctx,name)));}
      entry.finish(allowed);
    }).catch(()=>entry.finish(false));
  }
  function close(){closed=true;for(const entry of [...pending.values()])entry.finish(false);once.clear();generations.clear();}
  return {snapshot,set,reset,check,request,invalidate,close};
}
module.exports={createSitePermissions,originOf,capabilities,CAPABILITIES};

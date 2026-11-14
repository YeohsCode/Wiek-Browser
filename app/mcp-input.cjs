'use strict';
// Bounded, flat form elicitation. Server state is an opaque wire value only.
const fail = (message, code = 'VEK_MCP_INVALID_REQUEST') => Object.assign(new Error(message), { error_code: code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => typeof key === 'string' && key.length > 0 && key.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(key) && !key.includes('\0');
const text = (value, max = 4096) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const allowed = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
function choices(schema, multiple = false) {
  const value = multiple ? schema.items : schema;
  if (!object(value)) return null;
  if (Array.isArray(value.enum) && value.enum.length && value.enum.length <= 64 && value.enum.every(v => text(v)) && new Set(value.enum).size === value.enum.length) return value.enum.map(v => ({ value: v, label: v }));
  const rows = multiple ? value.anyOf : value.oneOf;
  if (Array.isArray(rows) && rows.length && rows.length <= 64 && rows.every(v => allowed(v, ['const', 'title']) && text(v.const) && text(v.title)) && new Set(rows.map(v => v.const)).size === rows.length) return rows.map(v => ({ value: v.const, label: v.title }));
  return null;
}
function validateValue(schema, value) {
  if (schema.type === 'string') {
    if (!text(value, 16384)) return false;
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) return false;
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
    if (schema.format === 'uri') { try { new URL(value); } catch { return false; } }
    if (schema.format === 'date' || schema.format === 'date-time') {
      const date = value.slice(0, 10), time = Date.parse(date + 'T00:00:00Z');
      if (!/^\d{4}-\d\d-\d\d$/.test(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) return false;
      if (schema.format === 'date' ? value !== date : !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(value) || !Number.isFinite(Date.parse(value))) return false;
    }
    const options = choices(schema); return !options || options.some(o => o.value === value);
  }
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value)) && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') { const options = choices(schema, true); return Array.isArray(value) && value.length <= 64 && new Set(value).size === value.length && (schema.minItems === undefined || value.length >= schema.minItems) && (schema.maxItems === undefined || value.length <= schema.maxItems) && value.every(v => options.some(o => o.value === v)); }
  return false;
}
function validateSchema(schema) {
  const unsupported = () => { throw fail('This elicitation form schema is unsupported or exceeds limits', 'VEK_MCP_UNSUPPORTED_CAPABILITY'); };
  if (!allowed(schema, ['type', 'properties', 'required', 'title', 'description', '$schema', 'additionalProperties']) || schema.type !== 'object' || !object(schema.properties) || Object.keys(schema.properties).length > 32 || schema.additionalProperties !== undefined && schema.additionalProperties !== false || schema.required !== undefined && (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length || schema.required.some(key => !Object.hasOwn(schema.properties, key)))) unsupported();
  for (const key of ['title', 'description', '$schema']) if (schema[key] !== undefined && !text(schema[key])) unsupported();
  for (const [key, s] of Object.entries(schema.properties)) {
    if (!safeKey(key) || !object(s) || !['string', 'number', 'integer', 'boolean', 'array'].includes(s.type)) unsupported();
    const extras = s.type === 'string' ? ['minLength', 'maxLength', 'format', 'enum', 'oneOf'] : s.type === 'array' ? ['items', 'minItems', 'maxItems'] : ['number', 'integer'].includes(s.type) ? ['minimum', 'maximum'] : [];
    if (!allowed(s, ['type', 'title', 'description', 'default', ...extras]) || ['title', 'description'].some(k => s[k] !== undefined && !text(s[k]))) unsupported();
    for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (s[k] !== undefined && (!Number.isInteger(s[k]) || s[k] < 0 || s[k] > (s.type === 'array' ? 64 : 16384))) unsupported();
    if (s.minLength > s.maxLength || s.minItems > s.maxItems || s.minimum > s.maximum) unsupported();
    for (const k of ['minimum', 'maximum']) if (s[k] !== undefined && (typeof s[k] !== 'number' || !Number.isFinite(s[k]))) unsupported();
    if (s.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(s.format)) unsupported();
    if (s.enum !== undefined && s.oneOf !== undefined || (s.enum !== undefined || s.oneOf !== undefined) && !choices(s)) unsupported();
    if (s.type === 'array' && (!allowed(s.items, ['type', 'enum', 'anyOf']) || s.items.type !== undefined && s.items.type !== 'string' || s.items.enum !== undefined && s.items.anyOf !== undefined || !choices(s, true))) unsupported();
    if (Object.hasOwn(s, 'default') && !validateValue(s, s.default)) unsupported();
  }
  return schema;
}
function prepareInput(result,{allowUrl=false}={}) {
  if (!object(result) || result.resultType !== 'input_required' || Buffer.byteLength(JSON.stringify(result)) > 131072 || result.requestState !== undefined && !text(result.requestState, 65536) || !Object.hasOwn(result, 'inputRequests') && !Object.hasOwn(result, 'requestState')) throw fail('Malformed MCP input-required result');
  const requests = result.inputRequests === undefined ? {} : result.inputRequests;
  if (!object(requests) || Object.keys(requests).length > 8) throw fail('Invalid MCP input request map');
  const forms = Object.entries(requests).map(([id, request]) => {
    const params=request?.params;
    const unsupported=()=>fail('Unsupported MCP input request','VEK_MCP_UNSUPPORTED_CAPABILITY');
    if (!safeKey(id) || !allowed(request,['method','params']) || request.method!=='elicitation/create') throw unsupported();
    if (params?.mode==='url'){
      if(!allowUrl||!allowed(params,['mode','message','url','_meta']))throw unsupported();
      if(!text(params.message)||!params.message.trim()||!text(params.url,8192)||/[\s\\]/u.test(params.url))throw fail('Invalid MCP URL input');
      let url;
      try{url=new URL(params.url);}catch{throw fail('Invalid MCP input URL');}
      if(url.protocol!=='https:'||url.username||url.password)throw fail('MCP input URLs must use HTTPS without embedded credentials');
      return {id,mode:'url',message:params.message,origin:url.origin,url:url.href};
    }
    if (!allowed(params,['mode','message','requestedSchema','_meta'])||params.mode!==undefined&&params.mode!=='form')throw unsupported();
    if (!text(params.message) || !params.message.trim()) throw fail('Invalid MCP input message');
    return { id, message: request.params.message, schema: validateSchema(request.params.requestedSchema) };
  });
  return { forms, ...(Object.hasOwn(result, 'requestState') ? { requestState: result.requestState } : {}) };
}
function prepareLegacyUrls(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 8) throw fail('Invalid MCP URL authorization requests');
  const seen = new Set();
  return entries.map(entry => {
    if (!allowed(entry, ['mode', 'message', 'url', 'elicitationId', '_meta']) ||
        entry.mode !== 'url' || !safeKey(entry.elicitationId) || seen.has(entry.elicitationId)) throw fail('Invalid MCP URL authorization request');
    seen.add(entry.elicitationId);
    const { elicitationId, ...params } = entry;
    return prepareInput({resultType:'input_required',inputRequests:{[elicitationId]:{method:'elicitation/create',params}}},{allowUrl:true}).forms[0];
  });
}
function validateResponses(forms, responses) {
  if (!object(responses) || Buffer.byteLength(JSON.stringify(responses)) > 131072 || Object.keys(responses).length !== forms.length || Object.keys(responses).some(id => !forms.some(f => f.id === id))) throw fail('Supply one response for every requested input');
  return Object.fromEntries(forms.map(form => {
    const response = responses[form.id];
    if (!allowed(response, ['action', 'content']) || !['accept', 'decline', 'cancel'].includes(response.action)) throw fail('Invalid input response action');
    if (response.action !== 'accept'||form.mode==='url') { if (Object.hasOwn(response, 'content')) throw fail('This input response must omit form content'); return [form.id, { action: response.action }]; }
    const content = response.content, schema = form.schema;
    if (!object(content) || Object.keys(content).some(key => !Object.hasOwn(schema.properties, key)) || (schema.required || []).some(key => !Object.hasOwn(content, key)) || Object.entries(content).some(([key, value]) => !validateValue(schema.properties[key], value))) throw fail('Input does not match the requested form schema');
    return [form.id, { action: 'accept', content: JSON.parse(JSON.stringify(content)) }];
  }));
}
module.exports = { prepareInput, prepareLegacyUrls, validateResponses, validateSchema, choices };

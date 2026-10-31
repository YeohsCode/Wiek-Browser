'use strict';
// Electron's base::Value conversion sorts dictionary keys. Deep serialization
// carries ordinary object properties as ordered pairs, preserving renderer order
// without reexecuting the original Runtime expression.
function decodeDeep(node, references = new Map()) {
  if (!node) return undefined;
  const ref = node.weakLocalObjectReference;
  if (!Object.hasOwn(node, 'value') && ref !== undefined && references.has(ref)) return references.get(ref);
  switch (node.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return node.value;
    case 'number': return typeof node.value === 'string' ? ({ NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 })[node.value] : node.value;
    case 'bigint': return BigInt(String(node.value).replace(/n$/, ''));
    case 'array': { const result = []; if (ref !== undefined) references.set(ref, result); for (const value of node.value || []) result.push(decodeDeep(value, references)); return result; }
    case 'object': { const result = {}; if (ref !== undefined) references.set(ref, result); for (const [key, value] of node.value || []) Object.defineProperty(result, typeof key === 'string' ? key : decodeDeep(key, references), { value: decodeDeep(value, references), enumerable: true, writable: true, configurable: true }); return result; }
    default: return {};
  }
}
const completeTypes = new Set(['undefined', 'null', 'string', 'boolean', 'number', 'bigint', 'array', 'object']);
function needsNativeValue(node) {
  if (!node || !completeTypes.has(node.type)) return true;
  if (node.type === 'array') return (node.value || []).some(needsNativeValue);
  if (node.type === 'object') return (node.value || []).some(([, value]) => needsNativeValue(value));
  return false;
}
function preserveOrder(value, node, references = new Map()) {
  if (value === null || typeof value !== 'object' || !node) return value;
  if (!node.value && node.weakLocalObjectReference !== undefined) {
    const previous = references.get(node.weakLocalObjectReference);
    if (previous) node = previous;
  }
  if (node.weakLocalObjectReference !== undefined && node.value) references.set(node.weakLocalObjectReference, node);
  if (node.type === 'array' && Array.isArray(value)) return value.map((item, index) => preserveOrder(item, node.value?.[index], references));
  if (node.type !== 'object') return value; // Native serialization retains special objects' own data.
  const result = {};
  for (const [key, child] of node.value || []) if (typeof key === 'string' && Object.hasOwn(value, key)) Object.defineProperty(result, key, { value: preserveOrder(value[key], child, references), enumerable: true, writable: true, configurable: true });
  return result;
}
async function sendOrdered(debuggerApi, method, params, sessionId) {
  const ordered = (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') && params.returnByValue === true && !params.serializationOptions;
  const result = await debuggerApi.sendCommand(method, ordered ? { ...params, serializationOptions: { serialization: 'deep' } } : params, sessionId);
  if (!ordered || !result?.result?.deepSerializedValue) return result;
  const remote = result.result, deep = remote.deepSerializedValue, objectId = remote.objectId;
  try {
    delete remote.deepSerializedValue; delete remote.objectId;
    if (deep.type === 'undefined') { remote.type = 'undefined'; return result; }
    if (deep.type === 'number' && typeof deep.value === 'string') { remote.unserializableValue = deep.value; return result; }
    if (deep.type === 'bigint') { remote.unserializableValue = `${String(deep.value).replace(/n$/, '')}n`; return result; }
    let value;
    if (objectId && needsNativeValue(deep)) {
      // Deep CDP omits typedarray elements and own data on Date/Map/etc. Serialize
      // the already returned object through Chromium's standard serializer. This
      // identity call does not rerun the source expression or page action.
      const native = await debuggerApi.sendCommand('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){return this}', returnByValue: true }, sessionId);
      if (native.exceptionDetails) return native;
      value = preserveOrder(native.result?.value, deep);
    } else value = decodeDeep(deep);
    // Standard returnByValue rejects circular graphs rather than emitting JSON
    // transport errors later. Match Chromium's stable protocol failure text.
    try { JSON.stringify(value); } catch (e) { if (/circular/i.test(e.message)) throw new Error('Object reference chain is too long'); if (/BigInt/i.test(e.message)) throw new Error("Object couldn't be returned by value"); throw e; }
    remote.value = value;
    if (remote.type === 'object' && value !== null) { delete remote.className; delete remote.description; delete remote.subtype; delete remote.preview; }
    return result;
  } finally {
    if (objectId && objectId !== params.objectId) await debuggerApi.sendCommand('Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
  }
}
module.exports = { sendOrdered, decodeDeep, preserveOrder };

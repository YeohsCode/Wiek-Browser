'use strict';
// Web Storage is UTF-16, including lone surrogates and NUL. Encode code units,
// rather than silently replacing them with U+FFFD during JSON/UTF-8 transport.
const ENCODING = 'utf16le-base64';
const LIMITS = Object.freeze({ origins:128, entries:1024, areaBytes:2*1024*1024, totalBytes:8*1024*1024, keyBytes:64*1024, valueBytes:1024*1024 });
function fail(message) { throw new Error(`Invalid profile web storage: ${message}`); }
function exactOrigin(value) {
  if(typeof value!=='string'||value.length>16384||/[\u0000-\u0020\u007f\\]/.test(value))fail('origin');
  let u;try{u=new URL(value)}catch{fail('origin')}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.origin!==value)fail('exact HTTP(S) origin required');return value;
}
function bytes(value,max) {
  if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||value.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('encoded entry');
  const b=Buffer.from(value,'base64');if(b.length%2||b.length>max||b.toString('base64')!==value)fail('UTF-16 entry');return b;
}
function validateArea(area, budget={bytes:0}) {
  if(!area||Array.isArray(area)||typeof area!=='object'||Object.keys(area).some(k=>!['origin','entries'].includes(k)))fail('area fields');
  exactOrigin(area.origin);if(!Array.isArray(area.entries)||area.entries.length>LIMITS.entries)fail('entry count');
  let size=0;const keys=new Set();const entries=area.entries.map(pair=>{
    if(!Array.isArray(pair)||pair.length!==2)fail('entry pair');
    const key=bytes(pair[0],LIMITS.keyBytes),value=bytes(pair[1],LIMITS.valueBytes);size+=key.length+value.length;
    if(keys.has(pair[0]))fail('duplicate key');keys.add(pair[0]);return [...pair];
  });
  budget.bytes+=size;if(size>LIMITS.areaBytes||budget.bytes>LIMITS.totalBytes)fail('byte limit');return {origin:area.origin,entries};
}
function encodeArea(origin, entries) { return validateArea({origin,entries:entries.map(pair=>{if(!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string'))fail('CDP entry');return pair.map(v=>Buffer.from(v,'utf16le').toString('base64'));})}); }
function decodeEntries(area) { return validateArea(area).entries.map(pair=>pair.map(v=>Buffer.from(v,'base64').toString('utf16le'))); }
module.exports={ENCODING,LIMITS,exactOrigin,validateArea,encodeArea,decodeEntries};

'use strict';
const {exactOrigin}=require('./profile-storage-data.cjs');
const ENCODING='wiek-idb-portable-v1';
const LIMITS=Object.freeze({origins:32,databases:32,stores:64,indexes:64,records:2048,databaseBytes:2*1024*1024,totalBytes:8*1024*1024,valueBytes:512*1024});
// Fixed code shared by host validation and an isolated renderer world. Values
// are inert tagged JSON strings; property names and UTF-16 strings are base64.
function portableCodec() {
  const fail=()=>{throw new Error('Unsupported or oversized IndexedDB value');};
  const binary=bytes=>{if(bytes.byteLength>384*1024)fail();let out='';for(let i=0;i<bytes.length;i+=8192)out+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(out);};
  const unbinary=value=>{if(typeof value!=='string'||value.length>700000||value.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail();const raw=atob(value),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));if(binary(bytes)!==value)fail();return bytes;};
  const text=value=>{if(typeof value!=='string'||value.length>262144)fail();const bytes=new Uint8Array(value.length*2);for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);bytes[2*i]=n&255;bytes[2*i+1]=n>>>8;}return binary(bytes);};
  const untext=value=>{const bytes=unbinary(value);if(bytes.length%2)fail();let out='';for(let i=0;i<bytes.length;i+=2)out+=String.fromCharCode(bytes[i]|bytes[i+1]<<8);return out;};
  const views={Int8Array,Uint8Array,Uint8ClampedArray,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array,DataView};
  const isArrayIndex=key=>/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<2**32-1;
  const dataProperty=(target,key,value)=>Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});
  function encode(value) {
    const seen=new Map();let nodes=0,encodedBytes=0;
    const bounded=value=>{encodedBytes+=value.length;if(encodedBytes>524288)fail();return value;};
    const encodeText=value=>bounded(text(value));
    const properties=(object,keys,walk,depth)=>{
      if(keys.length>4096)fail();
      return keys.map(key=>{
        const descriptor=Object.getOwnPropertyDescriptor(object,key);
        if(typeof key!=='string'||!descriptor.enumerable||!('value'in descriptor))fail();
        return [encodeText(key),walk(descriptor.value,depth+1)];
      });
    };
    const walk=(v,depth)=>{
      if(++nodes>4096||depth>16)fail();
      if(v===null)return ['null'];if(v===undefined)return ['undefined'];if(typeof v==='boolean')return ['boolean',v];
      if(typeof v==='number')return ['number',Number.isNaN(v)?'nan':v===Infinity?'infinity':v===-Infinity?'-infinity':Object.is(v,-0)?'-0':v];
      if(typeof v==='bigint'){if(v>=10n**1024n||v<=-(10n**1024n))fail();const value=v.toString();if(value.length>1024)fail();return ['bigint',value];}if(typeof v==='string')return ['string',encodeText(v)];
      if(!v||typeof v!=='object')fail();
      if(seen.has(v))return ['ref',seen.get(v)];
      seen.set(v,seen.size);
      if(v instanceof Date)return ['date',Number.isNaN(v.getTime())?null:v.getTime()];
      if(v instanceof Map){
        if(v.size>2048)fail();
        return ['map',Array.from(v,([key,value])=>[walk(key,depth+1),walk(value,depth+1)])];
      }
      if(v instanceof Set){
        if(v.size>4096)fail();
        return ['set',Array.from(v,value=>walk(value,depth+1))];
      }
      if(v instanceof RegExp)return ['regexp',encodeText(v.source),v.flags];
      if(v instanceof ArrayBuffer){
        if(v.resizable)fail();
        return ['binary','ArrayBuffer',bounded(binary(new Uint8Array(v)))];
      }
      if(ArrayBuffer.isView(v)){
        const name=Object.keys(views).find(name=>v instanceof views[name]);
        if(!name||!(v.buffer instanceof ArrayBuffer))fail();
        return ['view',name,v.byteOffset,v.byteLength,walk(v.buffer,depth+1)];
      }
      if(Array.isArray(v)){
        if(v.length>4096)fail();
        const keys=Reflect.ownKeys(v).filter(key=>key!=='length');
        if(keys.length===v.length&&keys.every(key=>typeof key==='string'&&isArrayIndex(key))){
          return ['array',keys.map(key=>{
            const descriptor=Object.getOwnPropertyDescriptor(v,key);
            if(!descriptor.enumerable||!('value'in descriptor))fail();
            return walk(descriptor.value,depth+1);
          })];
        }
        return ['sparse-array',v.length,properties(v,keys,walk,depth)];
      }
      if(![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail();
      return ['object',properties(v,Reflect.ownKeys(v),walk,depth)];
    };
    const out=JSON.stringify(walk(value,0));if(out.length>524288)fail();return out;
  }
  function decode(source) {
    if(typeof source!=='string'||source.length>524288)fail();let nodes=0,root;try{root=JSON.parse(source);}catch{fail();}
    // Object slots follow their first appearance. Register containers before reading children.
    const objects=[];
    const remember=value=>{objects.push(value);return value;};
    const readProperties=(target,entries,depth)=>{
      const keys=new Set();
      for(const pair of entries){
        if(!Array.isArray(pair)||pair.length!==2)fail();
        const key=untext(pair[0]);
        if(keys.has(key)||Array.isArray(target)&&(key==='length'||isArrayIndex(key)&&Number(key)>=target.length))fail();
        keys.add(key);
        dataProperty(target,key,walk(pair[1],depth+1));
      }
      return target;
    };
    const walk=(v,depth)=>{
      if(++nodes>4096||depth>16||!Array.isArray(v)||typeof v[0]!=='string')fail();
      const [kind,value]=v;
      if(kind==='null'&&v.length===1)return null;if(kind==='undefined'&&v.length===1)return undefined;
      if(kind==='boolean'&&v.length===2&&typeof value==='boolean')return value;
      if(kind==='number'&&v.length===2){if(typeof value==='number'&&Number.isFinite(value))return value;if(value==='nan')return NaN;if(value==='infinity')return Infinity;if(value==='-infinity')return -Infinity;if(value==='-0')return -0;fail();}
      if(kind==='bigint'&&v.length===2&&typeof value==='string'&&value.length<=1024&&/^-?(?:0|[1-9][0-9]*)$/.test(value))return BigInt(value);
      if(kind==='string'&&v.length===2)return untext(value);
      if(kind==='ref'&&v.length===2){
        if(!Number.isInteger(value)||value<0||value>=objects.length||objects[value]===undefined)fail();
        return objects[value];
      }
      if(kind==='date'&&v.length===2&&(value===null||typeof value==='number'&&!Number.isNaN(value)&&Math.abs(value)<=8640000000000000))return remember(new Date(value===null?NaN:value));
      if(kind==='map'&&v.length===2&&Array.isArray(value)&&value.length<=2048){
        const map=remember(new Map());
        for(const pair of value){
          if(!Array.isArray(pair)||pair.length!==2)fail();
          const key=walk(pair[0],depth+1);
          if(map.has(key))fail();
          map.set(key,walk(pair[1],depth+1));
        }
        return map;
      }
      if(kind==='set'&&v.length===2&&Array.isArray(value)&&value.length<=4096){
        const set=remember(new Set());
        for(const item of value){
          const decoded=walk(item,depth+1);
          if(set.has(decoded))fail();
          set.add(decoded);
        }
        return set;
      }
      if(kind==='regexp'&&v.length===3&&typeof v[2]==='string'&&v[2].length<=8){
        const source=untext(value);
        let regexp;
        try{regexp=new RegExp(source,v[2]);}catch{fail();}
        if(regexp.source!==source||regexp.flags!==v[2])fail();
        return remember(regexp);
      }
      if(kind==='binary'&&v.length===3){
        const buffer=unbinary(v[2]).buffer;
        if(value==='ArrayBuffer')return remember(buffer);
        if(!Object.hasOwn(views,value))fail();
        try{return remember(new views[value](buffer));}catch{fail();}
      }
      if(kind==='view'&&v.length===5&&Object.hasOwn(views,value)){
        const [,name,offset,length,backing]=v;
        if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0)fail();
        if(!Array.isArray(backing)||!(backing[0]==='ref'||backing[0]==='binary'&&backing[1]==='ArrayBuffer'))fail();
        const slot=objects.length;
        objects.push(undefined);
        const buffer=walk(backing,depth+1),Type=views[name];
        if(!(buffer instanceof ArrayBuffer)||offset+length>buffer.byteLength)fail();
        try{
          if(Type===DataView)objects[slot]=new DataView(buffer,offset,length);
          else{
            if(length%Type.BYTES_PER_ELEMENT)fail();
            objects[slot]=new Type(buffer,offset,length/Type.BYTES_PER_ELEMENT);
          }
        }catch{fail();}
        return objects[slot];
      }
      if(kind==='array'&&v.length===2&&Array.isArray(value)&&value.length<=4096){
        const array=remember([]);
        for(const item of value)array.push(walk(item,depth+1));
        return array;
      }
      if(kind==='sparse-array'&&v.length===3&&Number.isInteger(value)&&value>=0&&value<=4096&&Array.isArray(v[2])&&v[2].length<=4096){
        return readProperties(remember(new Array(value)),v[2],depth);
      }
      if(kind==='object'&&v.length===2&&Array.isArray(value)&&value.length<=4096){
        return readProperties(remember({}),value,depth);
      }
      fail();
    };
    return walk(root,0);
  }
  function key(value,seen=new Set(),depth=0) {
    if(depth>16)return false;
    if(typeof value==='string'||typeof value==='number'&&!Number.isNaN(value)||value instanceof Date&&Number.isFinite(value.getTime())||value instanceof ArrayBuffer||ArrayBuffer.isView(value))return true;
    if(!Array.isArray(value)||seen.has(value))return false;
    seen.add(value);
    for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,i)||!key(value[i],seen,depth+1))return false;
    return true;
  }
  return {encode,decode,text,untext,key};
}
const codec=portableCodec();
// Represent exhaustion as null because 2^53 + 1 cannot be expressed as a Number.
function generatorAfterKey(current,key) {
  if(current===null||typeof key!=='number'||key<current)return current;
  return key>=2**53?null:Math.floor(key)+1;
}
function validateIndexedDb(input) {
  const invalid=()=>{throw new Error('Invalid portable IndexedDB archive');};
  const object=(value,fields)=>{if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(value,k)))invalid();};
  const list=(value,max)=>{if(!Array.isArray(value)||value.length>max)invalid();return value;};
  const name=value=>{if(typeof value!=='string'||value.length>22000)invalid();codec.untext(value);return value;};
  const path=value=>value===null?null:Array.isArray(value)?list(value,64).map(name):name(value);
  object(input,['encoding','origins']);if(input.encoding!==ENCODING)invalid();let total=0;const origins=new Set();
  const out={encoding:ENCODING,origins:list(input.origins,LIMITS.origins).map(area=>{
    object(area,['origin','databases']);exactOrigin(area.origin);if(origins.has(area.origin))invalid();origins.add(area.origin);const dbs=new Set();
    return {origin:area.origin,databases:list(area.databases,LIMITS.databases).map(db=>{
      object(db,['name','version','stores']);name(db.name);if(dbs.has(db.name)||!Number.isSafeInteger(db.version)||db.version<1)invalid();dbs.add(db.name);let records=0;const stores=new Set();
      const result={name:db.name,version:db.version,stores:list(db.stores,LIMITS.stores).map(store=>{
        const fields=['name','keyPath','autoIncrement','indexes','records'];
        if(store?.autoIncrement===true)fields.push('nextKey');
        object(store,fields);name(store.name);if(stores.has(store.name)||typeof store.autoIncrement!=='boolean')invalid();stores.add(store.name);const indexes=new Set();
        const keyPath=path(store.keyPath);
        let minimum=1;
        const result={name:store.name,keyPath,autoIncrement:store.autoIncrement,indexes:list(store.indexes,LIMITS.indexes).map(index=>{object(index,['name','keyPath','unique','multiEntry']);name(index.name);if(indexes.has(index.name)||typeof index.unique!=='boolean'||typeof index.multiEntry!=='boolean'||index.keyPath===null)invalid();indexes.add(index.name);return {name:index.name,keyPath:path(index.keyPath),unique:index.unique,multiEntry:index.multiEntry};}),records:list(store.records,LIMITS.records).map(record=>{
          object(record,['key','value']);
          const key=codec.decode(record.key);
          if(++records>LIMITS.records||!codec.key(key))invalid();
          minimum=generatorAfterKey(minimum,key);
          codec.decode(record.value);return {key:record.key,value:record.value};
        })};
        if(store.autoIncrement){
          const next=store.nextKey;
          if(Array.isArray(keyPath)||keyPath===''||(next!==null&&(!Number.isInteger(next)||next<1||next>2**53||minimum===null||next<minimum)))invalid();
          result.nextKey=next;
        }
        return result;
      })};
      const bytes=Buffer.byteLength(JSON.stringify(result));total+=bytes;if(bytes>LIMITS.databaseBytes||total>LIMITS.totalBytes)invalid();return result;
    })};
  })};
  return out;
}
module.exports={ENCODING,LIMITS,portableCodec,validateIndexedDb,generatorAfterKey};

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{portableCodec,ENCODING,validateIndexedDb}=require('../app/profile-indexeddb-data.cjs'),{createProfileArchive}=require('../app/profile-archive.cjs'),codec=portableCodec(),{captureProfileIndexedDB}=require('../app/profile-indexeddb.cjs');
const input=()=>({encoding:ENCODING,origins:[{origin:'https://fixture.test',databases:[{name:codec.text('fixture'),version:3,stores:[{name:codec.text('rows'),keyPath:null,autoIncrement:false,indexes:[],records:[{key:codec.encode(['one',1]),value:codec.encode({id:'one',value:'private fixture'})}]}]}]}]});
test('portable IndexedDB codec preserves UTF-16, dates, binary, special numbers and inert property names',()=>{
 const value={odd:'\0\ud800你好',array:[null,undefined,true,NaN,Infinity,-Infinity,-0,42n],date:new Date('2024-01-01'),map:new Map([['one',new Set([2,/你好/gi])],[{id:3},'four']]),binary:new Uint16Array([1,65535]),raw:new Uint8Array([3,4]).buffer};Object.defineProperty(value,'__proto__',{value:{inert:true},enumerable:true});const decoded=codec.decode(codec.encode(value));assert.deepEqual(decoded,value);assert.equal(Object.hasOwn(decoded,'__proto__'),true);assert.equal({}.inert,undefined);
 for(const v of [new Blob(['x']),new Set(Array.from({length:4097},(_,i)=>i)),new Uint8Array(384*1024+1),Array(4097),Array.from({length:20},()=>new Uint8Array(50000))])assert.throws(()=>codec.encode(v),/Unsupported/);
 for(const v of ['["binary","Function","AAAA"]','["object",[["YQA=",["null"]],["YQA=",["null"]]]]','["unknown"]','["set",[["number",0],["number","-0"]]]','["map",[[["null"],["null"]],[["null"],["boolean",true]]]]','["regexp","eAA=","gg"]'])assert.throws(()=>codec.decode(v),/Unsupported/);
});
test('portable IndexedDB preserves aliases, cycles, array holes and shared view ranges',()=>{
 const buffer=new Uint8Array([1,2,3,4,5,6,7,8]).buffer;
 const view=new Uint16Array(buffer,2,2),data=new DataView(buffer,1,3);
 const value={view,data,buffer,alias:view,list:Array(4)};
 value.list[2]=undefined;
 value.list.label=value;
 value.map=new Map([[value,value.list]]);
 value.set=new Set([value.map,value]);
 const decoded=codec.decode(codec.encode(value));
 assert.deepEqual(decoded,value);
 assert.equal(decoded.view,decoded.alias);
 assert.equal(decoded.view.buffer,decoded.data.buffer);
 assert.equal(decoded.data.buffer,decoded.buffer);
 assert.equal(decoded.view.byteOffset,2);
 assert.equal(decoded.data.byteLength,3);
 assert.equal(0 in decoded.list,false);
 assert.equal(2 in decoded.list,true);
 assert.equal(decoded.list.label,decoded);
 assert.equal(decoded.map.get(decoded),decoded.list);
 assert.ok(decoded.set.has(decoded.map));
 assert.deepEqual(codec.decode('["binary","Uint16Array","AQD//w=="]'),new Uint16Array([1,65535]));
 for(const value of [
   ['ref',0],['array',[['ref',1]]],['array',[['ref',-1]]],
   ['view','Uint16Array',1,2,['binary','ArrayBuffer','AAAAAA==']],
   ['view','Uint16Array',0,1,['binary','ArrayBuffer','AAAAAA==']],
   ['view','DataView',0,5,['binary','ArrayBuffer','AAAAAA==']],
   ['view','DataView',0,0,['ref',0]],
   ['sparse-array',1,[[codec.text('1'),['null']]]],
   ['sparse-array',1,[[codec.text('length'),['null']]]],
   ['sparse-array',1,[[codec.text('0'),['null']],[codec.text('0'),['null']]]]
 ])assert.throws(()=>codec.decode(JSON.stringify(value)),/Unsupported/);
 for(const value of [['sparse-array',2,[]],['array',[['ref',0]]]]){
   const archive=input();
   archive.origins[0].databases[0].stores[0].records[0].key=JSON.stringify(value);
   assert.throws(()=>validateIndexedDb(archive),/Invalid portable/);
 }
});
test('IndexedDB attachment codec preserves bytes, metadata and aliases within the size budget',async()=>{
 const blob=new Blob([new Uint8Array([0,255,7])],{type:'image/png'});
 const file=new File([new Uint8Array([42])],'草稿.png',{type:'image/png',lastModified:0});
 const value={blob,file,map:new Map([[file,blob]])};
 const staged=codec.stage(value);
 const encoded=await codec.materialize(staged,()=>{});
 assert.equal(encoded.length,staged.size);
 const restored=codec.decode(encoded);
 assert.ok(restored.blob instanceof Blob);
 assert.ok(restored.file instanceof File);
 assert.equal(restored.map.get(restored.file),restored.blob);
 assert.deepEqual([...new Uint8Array(await restored.blob.arrayBuffer())],[0,255,7]);
 assert.deepEqual([...new Uint8Array(await restored.file.arrayBuffer())],[42]);
 assert.deepEqual([restored.file.name,restored.file.type,restored.file.lastModified],['草稿.png','image/png',0]);
 assert.throws(()=>codec.stage(new Blob([new Uint8Array(384*1024+1)])),/Unsupported/);
 assert.throws(()=>codec.stage(Array.from({length:5},()=>new Blob([new Uint8Array(100*1024)]))),/Unsupported/);
 await assert.rejects(codec.materialize(codec.stage(blob),()=>{throw new Error('cancelled');}),/cancelled/);
 for(const tag of [
   ['blob',codec.text('IMAGE/PNG'),'AA=='],
   ['blob',codec.text('image/png\n'),'AA=='],
   ['blob',codec.text('image/png'),'invalid'],
   ['file','','',codec.text('x'),1.5],
   ['file','','',codec.text('x'),2**53],
   ['file','','',codec.text('\ud800'),0]
 ])assert.throws(()=>codec.decode(JSON.stringify(tag)),/Unsupported/);
});
test('IndexedDB schema rejects origin widening, incomplete generators, duplicates and invalid primary keys',()=>{
 assert.deepEqual(validateIndexedDb(input()),input());for(const change of [x=>x.origins[0].origin+='/',x=>x.origins.push(x.origins[0]),x=>x.origins[0].databases.push(x.origins[0].databases[0]),x=>x.origins[0].databases[0].stores[0].autoIncrement=true,x=>x.origins[0].databases[0].stores[0].records[0].key=codec.encode(NaN),x=>x.origins[0].databases[0].stores[0].indexes=[{name:codec.text('idx'),keyPath:null,unique:false,multiEntry:false}]]){const x=input();change(x);assert.throws(()=>validateIndexedDb(x));}
});
test('IndexedDB schema validates the archived generator against numeric keys, including exhaustion',()=>{
 const archive=input(),store=archive.origins[0].databases[0].stores[0];
 store.autoIncrement=true;
 store.records[0].key=codec.encode(20.5);
 for(const next of [21,25,2**53,null]){
   store.nextKey=next;
   assert.deepEqual(validateIndexedDb(archive),archive);
 }
 for(const next of [undefined,0,20,21.5,2**53+2,'21']){
   store.nextKey=next;
   assert.throws(()=>validateIndexedDb(archive),/Invalid portable/);
 }
 store.records[0].key=codec.encode(Infinity);
 store.nextKey=2**53;
 assert.throws(()=>validateIndexedDb(archive),/Invalid portable/);
 store.nextKey=null;
 assert.deepEqual(validateIndexedDb(archive),archive);
 for(const path of [codec.text(''),[codec.text('id')]]){
   store.keyPath=path;
   assert.throws(()=>validateIndexedDb(archive),/Invalid portable/);
 }
});
test('encrypted archive carries validated IndexedDB values without plaintext data',async()=>{
 const a=createProfileArchive(),data={profile:{name:'IndexedDB fixture'},indexedDB:input()},encoded=await a.encode(data,'public indexed fixture passphrase');assert.equal(encoded.includes('private fixture'),false);const decoded=await a.decode(encoded,'public indexed fixture passphrase');assert.equal(decoded.metadata.version,4);assert.deepEqual(decoded.payload.indexedDB,input());
});
test('IndexedDB capture refuses navigated and partitioned origins before reading any records',async()=>{
 for(const partitioned of [false,true]){let reads=0;const frameOrigin=partitioned?'https://old.fixture.test':'https://new.fixture.test',wc={getURL:()=> 'https://old.fixture.test/current',executeJavaScriptInIsolatedWorld:()=>{reads++;throw new Error('must not read');},debugger:{sendCommand:async method=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'f',loaderId:'l',url:frameOrigin+'/current',securityOrigin:frameOrigin}}}:{storageKey:frameOrigin+'/'+(partitioned?'^0partition':'')}}};const result=await captureProfileIndexedDB([{tabs:[{webContents:wc}]}]);assert.equal(reads,0);assert.deepEqual(result.indexedDB.origins,[]);assert.equal(result.counts.indexedDBSkippedOrigins,1);assert.equal(result.warnings.length,1);}
 const controller=new AbortController();controller.abort();await assert.rejects(captureProfileIndexedDB([{tabs:[{}]}],{signal:controller.signal}),/cancelled/);
});
test('actual Electron transfers explicit selected-origin IndexedDB offline, excludes unsupported data and rolls back failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wiek-indexeddb-')),env={...process.env,WIEK_INDEXEDDB_TEST_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
 try{const child=spawn(require('electron'),[join(import.meta.dirname,'fixtures/profile-indexeddb-electron.cjs')],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),30000),code=await new Promise(r=>child.once('close',r));clearTimeout(timer);assert.equal(code,0,output);assert.match(output,/"bootstrapNetworkRequests":0/);process.stdout.write(output.split('\n').filter(v=>v.startsWith('{')).join('\n')+'\n');}finally{await rm(dir,{recursive:true,force:true});}
});

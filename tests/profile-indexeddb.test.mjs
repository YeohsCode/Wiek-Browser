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
 const alias={};for(const v of [new Blob(['x']),new Set(Array.from({length:4097},(_,i)=>i)),new Uint8Array(384*1024+1),new Uint8Array(8).subarray(1),new DataView(new ArrayBuffer(8),2),{a:alias,b:alias},Array(2)])assert.throws(()=>codec.encode(v),/Unsupported/);const cycle={};cycle.self=cycle;assert.throws(()=>codec.encode(cycle),/Unsupported/);
 for(const v of ['["binary","Function","AAAA"]','["object",[["YQA=",["null"]],["YQA=",["null"]]]]','["unknown"]','["set",[["number",0],["number","-0"]]]','["map",[[["null"],["null"]],[["null"],["boolean",true]]]]','["regexp","eAA=","gg"]'])assert.throws(()=>codec.decode(v),/Unsupported/);
});
test('IndexedDB schema rejects origin widening, auto generators, duplicates and invalid primary keys',()=>{
 assert.deepEqual(validateIndexedDb(input()),input());for(const change of [x=>x.origins[0].origin+='/',x=>x.origins.push(x.origins[0]),x=>x.origins[0].databases.push(x.origins[0].databases[0]),x=>x.origins[0].databases[0].stores[0].autoIncrement=true,x=>x.origins[0].databases[0].stores[0].records[0].key=codec.encode(NaN),x=>x.origins[0].databases[0].stores[0].indexes=[{name:codec.text('idx'),keyPath:null,unique:false,multiEntry:false}]]){const x=input();change(x);assert.throws(()=>validateIndexedDb(x));}
});
test('v3 encrypted archive carries validated IndexedDB values without plaintext data',async()=>{
 const a=createProfileArchive(),data={profile:{name:'IndexedDB fixture'},indexedDB:input()},encoded=await a.encode(data,'public indexed fixture passphrase');assert.equal(encoded.includes('private fixture'),false);const decoded=await a.decode(encoded,'public indexed fixture passphrase');assert.equal(decoded.metadata.version,3);assert.deepEqual(decoded.payload.indexedDB,input());
});
test('IndexedDB capture refuses navigated and partitioned origins before reading any records',async()=>{
 for(const partitioned of [false,true]){let reads=0;const frameOrigin=partitioned?'https://old.fixture.test':'https://new.fixture.test',wc={getURL:()=> 'https://old.fixture.test/current',executeJavaScriptInIsolatedWorld:()=>{reads++;throw new Error('must not read');},debugger:{sendCommand:async method=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'f',loaderId:'l',url:frameOrigin+'/current',securityOrigin:frameOrigin}}}:{storageKey:frameOrigin+'/'+(partitioned?'^0partition':'')}}};const result=await captureProfileIndexedDB([{tabs:[{webContents:wc}]}]);assert.equal(reads,0);assert.deepEqual(result.indexedDB.origins,[]);assert.equal(result.counts.indexedDBSkippedOrigins,1);assert.equal(result.warnings.length,1);}
 const controller=new AbortController();controller.abort();await assert.rejects(captureProfileIndexedDB([{tabs:[{}]}],{signal:controller.signal}),/cancelled/);
});
test('actual Electron transfers explicit selected-origin IndexedDB offline, excludes unsupported data and rolls back failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wiek-indexeddb-')),env={...process.env,WIEK_INDEXEDDB_TEST_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;
 try{const child=spawn(require('electron'),[join(import.meta.dirname,'fixtures/profile-indexeddb-electron.cjs')],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),30000),code=await new Promise(r=>child.once('close',r));clearTimeout(timer);assert.equal(code,0,output);assert.match(output,/"bootstrapNetworkRequests":0/);process.stdout.write(output.split('\n').filter(v=>v.startsWith('{')).join('\n')+'\n');}finally{await rm(dir,{recursive:true,force:true});}
});

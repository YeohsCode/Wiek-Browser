import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createProfileArchive}=require('../app/profile-archive.cjs'),{ENCODING,LIMITS,encodeArea,decodeEntries}=require('../app/profile-storage-data.cjs');
const origin='https://storage.fixture.test',area=()=>encodeArea(origin,[['constructor','<script>never executed</script>'],['__proto__','你好\0\ud800'],['','']]);
test('v3 ciphertext roundtrip preserves exact UTF-16 storage keys and independent tab sessions',async()=>{
 const a=createProfileArchive(),local=area(),one=encodeArea(origin,[['tab','one']]),two=encodeArea(origin,[['tab','two']]);const payload={profile:{name:'Storage fixture'},webStorage:{encoding:ENCODING,localStorage:[local]},spaces:[{name:'Tabs',tabs:[{url:origin+'/first',sessionStorage:one},{url:origin+'/second',sessionStorage:two}],activeTabIndex:1}]};
 const json=await a.encode(payload,'public storage fixture passphrase');assert.equal(json.includes('storage.fixture'),false);assert.equal(json.includes(local.entries[0][0]),false);const result=await a.decode(json,'public storage fixture passphrase');assert.equal(result.metadata.version,3);assert.deepEqual(result.payload,a.validate(payload));assert.deepEqual(decodeEntries(result.payload.webStorage.localStorage[0]),[['constructor','<script>never executed</script>'],['__proto__','你好\0\ud800'],['','']]);assert.notDeepEqual(result.payload.spaces[0].tabs[0].sessionStorage,result.payload.spaces[0].tabs[1].sessionStorage);
 const envelope=JSON.parse(json);envelope.version=1;await assert.rejects(a.decode(JSON.stringify(envelope),'public storage fixture passphrase'),/authentication/);
});
test('v1 archived fixture from 0.12 decodes without inventing web storage',async()=>{
 const {payload,metadata}=await createProfileArchive().decode(await fs.readFile(new URL('fixtures/profile-v1.json',import.meta.url)),'public v1 fixture passphrase');assert.equal(metadata.version,1);assert.equal(payload.profile.name,'V1 compatibility fixture');assert.equal(payload.spaces[0].tabs[0].url,'https://legacy.fixture.test/');assert.equal(Object.hasOwn(payload,'webStorage'),false);
});
test('storage schema refuses origin widening, ambiguous duplicate keys/origins and unbounded code units',()=>{
 const a=createProfileArchive(),wrap=localStorage=>({profile:{name:'x'},webStorage:{encoding:ENCODING,localStorage}});
 for(const bad of ['file:///tmp','https://u:p@storage.fixture.test','https://storage.fixture.test/','https://storage.fixture.test?q=x','https://storage.fixture.test\n'])assert.throws(()=>a.validate(wrap([{...area(),origin:bad}])));
 for(const entries of [[['YQ==','']], [['YQA=','YQA=','extra']], [['!!!','']], [['YQA=',''],['YQA=','']], Array.from({length:LIMITS.entries+1},(_,i)=>[Buffer.from(String(i),'utf16le').toString('base64'),''])])assert.throws(()=>a.validate(wrap([{origin,entries}])));
 assert.throws(()=>encodeArea(origin,[['k','x'.repeat(LIMITS.valueBytes/2+1)]]),/entry/);assert.throws(()=>a.validate(wrap([area(),area()])),/Duplicate/);
 assert.throws(()=>a.validate({profile:{name:'x'},spaces:[{name:'x',tabs:[{url:'https://other.fixture.test/',sessionStorage:area()}]}]}),/must match/);
 assert.throws(()=>a.validate({profile:{name:'x'},webStorage:{encoding:'utf-8',localStorage:[]}}),/encoding/);
 assert.throws(()=>a.validate(wrap(Array.from({length:129},(_,i)=>({...area(),origin:`https://origin${i}.fixture.test` })))),/count/);
});
test('aggregate storage budget covers both local origins and per-tab sessions',()=>{
 const a=createProfileArchive(),big=encodeArea(origin,[['a','x'.repeat(400000)],['b','y'.repeat(400000)]]);assert.throws(()=>a.validate({profile:{name:'x'},webStorage:{encoding:ENCODING,localStorage:[big]},spaces:[{name:'x',tabs:Array.from({length:5},()=>({url:origin,sessionStorage:big}))}]}),/byte limit/);
});

test('v2 archived fixture remains readable with exact storage data and no invented IndexedDB',async()=>{
 const {payload,metadata}=await createProfileArchive().decode(await fs.readFile(new URL('fixtures/profile-v2.json',import.meta.url)),'public v2 fixture passphrase');assert.equal(metadata.version,2);assert.equal(payload.profile.name,'V2 compatibility fixture');assert.deepEqual(decodeEntries(payload.webStorage.localStorage[0]),[['odd','\0\ud800你好']]);assert.equal(Object.hasOwn(payload,'indexedDB'),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const {createProfileArchive,MIME_TYPE}=createRequire(import.meta.url)('../app/profile-archive.cjs');
const passphrase='temporary fixture passphrase 你好';
const payload=()=>({
 profile:{id:'old-profile-id',name:'Portable fixture 资料'},
 spaces:[{name:'Research',pinned:true,activeTabIndex:1,tabs:[{url:'https://fixture.test/path?a=1#part',title:'Fixture'},{url:'about:blank'}]}],
 bookmarks:[{url:'https://fixture.test/bookmark',title:'Bookmarked fixture',folder:'Research'}],
 history:[{url:'https://fixture.test/history',title:'Visited fixture',at:'2026-10-30T02:00:00.000Z'}],
 cookies:[{domain:'.fixture.test',path:'/',name:'session',value:'cookie-only-secret',secure:true,httpOnly:true,hostOnly:false,session:true,sameSite:'lax'},{url:'http://localhost/',name:'local',value:'local-cookie',hostOnly:true,secure:false,session:false,expirationDate:Date.now()/1000+86400}],
 passwords:[{origin:'https://fixture.test',username:'fixture-user',password:'password-only-secret'}],
 extensionsMetadata:[{id:'a'.repeat(32),name:'Fixture extension',version:'1.2.3',enabled:false}],
});
const hasCode=expected=>failure=>{assert.equal(failure.error_code,expected);return true};
test('profile archive writes only ciphertext to a temporary file and restores all supported categories',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vek-archive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const archive=createProfileArchive(),data=payload(),json=await archive.encode(data,passphrase),file=path.join(root,'fixture.vek-profile.json');await fs.writeFile(file,json,{mode:0o600});
 for(const secret of ['Portable fixture','fixture.test','cookie-only-secret','password-only-secret','fixture-user',passphrase])assert.equal(json.includes(secret),false);
 const envelope=JSON.parse(json);assert.equal(envelope.mimeType,MIME_TYPE);assert.equal(envelope.kdf,'scrypt-131072-8-1');assert.equal(envelope.cipher,'aes-256-gcm');assert.equal(Buffer.from(envelope.tag,'base64').length,16);
 const result=await archive.decode(await fs.readFile(file),passphrase);assert.deepEqual(result.payload,archive.validate(data));assert.equal(result.metadata.version,3);assert.equal(result.metadata.expiresAt,null);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 const other=await archive.encode(data,passphrase);assert.notEqual(JSON.parse(other).salt,envelope.salt);assert.notEqual(JSON.parse(other).iv,envelope.iv);assert.notEqual(JSON.parse(other).data,envelope.data);
});
test('wrong passphrase and every authenticated header/cipher component fail without returning data',async()=>{
 const archive=createProfileArchive(),json=await archive.encode(payload(),passphrase);await assert.rejects(archive.decode(json,'incorrect fixture password'),hasCode('VEK_PROFILE_ARCHIVE_AUTH'));
 for(const field of ['salt','iv','tag','data']){const changed=JSON.parse(json),bytes=Buffer.from(changed[field],'base64');bytes[0]^=1;changed[field]=bytes.toString('base64');await assert.rejects(archive.decode(JSON.stringify(changed),passphrase),hasCode('VEK_PROFILE_ARCHIVE_AUTH'));}
 for(const [field,value]of[['createdAt','2026-01-01T00:00:00.000Z'],['expiresAt','2099-01-01T00:00:00.000Z']]){const changed=JSON.parse(json);changed[field]=value;await assert.rejects(archive.decode(JSON.stringify(changed),passphrase),hasCode('VEK_PROFILE_ARCHIVE_AUTH'));}
});
test('expired archives and unknown versions, algorithms and MIME types are explicit failures',async()=>{
 const archive=createProfileArchive(),expiry=new Date(Date.now()+30000).toISOString(),json=await archive.encode(payload(),passphrase,{expiresAt:expiry}),now=Date.now;Date.now=()=>now()+60000;try{await assert.rejects(archive.decode(json,passphrase),hasCode('VEK_PROFILE_ARCHIVE_EXPIRED'));}finally{Date.now=now}
 for(const [field,value]of[['version',4],['kdf',{N:2**30,r:128,p:99}],['cipher','aes-256-cbc'],['mimeType','text/html']]){const changed=JSON.parse(json);changed[field]=value;await assert.rejects(archive.decode(JSON.stringify(changed),passphrase),/Unsupported|Unrecognized/);}
 await assert.rejects(archive.encode(payload(),passphrase,{expiresAt:'2020-01-01T00:00:00.000Z'}),hasCode('VEK_PROFILE_ARCHIVE_EXPIRED'));
});
test('validation rejects pollution keys, nonplain JSON, accessors and unsupported data fields before encryption',async()=>{
 const archive=createProfileArchive();for(const input of [JSON.parse('{"profile":{"name":"x"},"__proto__":{"polluted":true}}'),{profile:{name:'x'},constructor:{}},{profile:{name:'x'},spaces:null},{profile:{name:'x'},bookmarks:false},{profile:{name:'x'},history:{}},{profile:{name:'x'},permissions:{}},{profile:new Date()}])assert.throws(()=>archive.validate(input),/Unsafe|Invalid|plain/);
 let ran=false;const getter={profile:{name:'x'}};Object.defineProperty(getter,'cookies',{enumerable:true,get(){ran=true;return[]}});assert.throws(()=>archive.validate(getter),/accessors/);assert.equal(ran,false);
 const custom={profile:{name:'x'},cookies:[]};custom.cookies.extra='unsafe';assert.throws(()=>archive.validate(custom),/array/);const sparse={profile:{name:'x'},cookies:Array(2)};assert.throws(()=>archive.validate(sparse),/sparse/);assert.equal({}.polluted,undefined);
 for(const password of ['short','1234567','x'.repeat(1025)])await assert.rejects(archive.encode(payload(),password),/passphrase/);
});
test('portable URLs, cookie metadata, exact password origins and primitive types are validated',()=>{
 const archive=createProfileArchive();const invalid=[];
 for(const value of ['javascript:alert(1)','data:text/html,test','file:///etc/passwd','chrome://settings','https://user:secret@fixture.test/','https://fixture.test/\ntrick','https:\\fixture.test'])invalid.push({profile:{name:'x'},spaces:[{name:'x',tabs:[{url:value}]}]});
 for(const cookie of [{domain:'fixture.test@evil.test'},{domain:'fixture.test/path'},{domain:'..fixture.test'},{url:'https://evil.test/',domain:'.fixture.test'},{url:'http://fixture.test/',secure:true},{hostOnly:true},{sameSite:'unknown'},{sameSite:false},{secure:'true'},{expirationDate:0,session:false},{session:false},{name:'invalid;name'},{value:'header\r\ninjection'},{path:'bad'}])invalid.push({profile:{name:'x'},cookies:[{domain:'.fixture.test',name:'session',value:'secret',...cookie}]});
 for(const value of ['file:///tmp/a','https://fixture.test/','https://fixture.test/login','https://user:secret@fixture.test','https://fixture.test?q=1','https://fixture.test#x'])invalid.push({profile:{name:'x'},passwords:[{origin:value,username:'fixture',password:'secret'}]});
 invalid.push({profile:{name:'x'},spaces:[{name:'x',tabs:[],activeTabIndex:0}]},{profile:{name:'x'},history:[{url:'https://fixture.test',at:'bad'}]},{profile:{name:'x'},extensionsMetadata:[{id:'a',name:'x',version:'1',enabled:1}]});for(const input of invalid)assert.throws(()=>archive.validate(input),/Invalid|HTTP|Host-only|Cookie|Persistent/);
 const valid=archive.validate(payload());assert.equal(valid.cookies[0].url,'https://fixture.test/');assert.equal(valid.cookies[0].domain,'.fixture.test');assert.equal(valid.cookies[1].domain,'localhost');
});
test('limits reject oversized files, payloads, category counts and structural depth',async()=>{
 const small=createProfileArchive({maxBytes:1024});await assert.rejects(small.encode({profile:{name:'x'},passwords:[{origin:'https://fixture.test',username:'u',password:'a'.repeat(1000)}]},passphrase),hasCode('VEK_PROFILE_ARCHIVE_LIMIT'));await assert.rejects(small.decode(' '.repeat(1025),passphrase),hasCode('VEK_PROFILE_ARCHIVE_LIMIT'));
 const archive=createProfileArchive();assert.throws(()=>archive.validate({profile:{name:'x'},cookies:Array.from({length:20001},()=>({name:'a',value:'b',domain:'fixture.test'}))}),/array|count|structural/);
 let nested={};for(let i=0;i<30;i++)nested={child:nested};assert.throws(()=>archive.validate(nested),/structural/);assert.throws(()=>createProfileArchive({maxBytes:Infinity}),/size limit/);await assert.rejects(archive.decode(Buffer.from([0xff]),passphrase),/UTF-8 JSON/);
 const json=JSON.parse(await archive.encode({profile:{name:'x'}},passphrase));json.data+='!';await assert.rejects(archive.decode(JSON.stringify(json),passphrase),/ciphertext/);json.data='AA==';json.iv='bad';await assert.rejects(archive.decode(JSON.stringify(json),passphrase),/IV/);
});
test('independent operations are reusable and decoded objects never alias input or one another',async()=>{
 const archive=createProfileArchive(),source={profile:{name:'Fixture'}},copy=archive.validate(source);copy.profile.name='changed';assert.equal(source.profile.name,'Fixture');const json=await archive.encode(source,passphrase),results=await Promise.all([archive.decode(json,passphrase),archive.decode(json,passphrase)]);results[0].payload.profile.name='changed';assert.equal(results[1].payload.profile.name,'Fixture');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import library from '../app/library-service.cjs';
const pngBase64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function fixture(t,options={}){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'vek-library-test-'));const services=[];const start=(extra={})=>{const instance=library.createLibraryService({dataDir,...options,...extra});services.push(instance);return instance;};t.after(async()=>{for(const instance of services)await instance.close();await fs.rm(dataDir,{recursive:true,force:true});});return{dataDir,start,service:start()};}
const dispatch=(service,name,payload={})=>service.dispatch('library:'+name,payload);

test('private storage preserves metadata and real image bytes through restart',async t=>{
 const f=await fixture(t);await dispatch(f.service,'items:create',{kind:'image',title:'One pixel',pngBase64});const item=f.service.snapshot().items[0];assert.equal(item.image.width,1);assert.equal(item.image.bytes,Buffer.from(pngBase64,'base64').length);assert.equal(item.image.sha256,crypto.createHash('sha256').update(Buffer.from(pngBase64,'base64')).digest('hex'));
 assert.equal(f.service.snapshot().items[0].dataUrl,undefined);const read=await dispatch(f.service,'items:read',{id:item.id});assert.equal(read.dataUrl,'data:image/png;base64,'+pngBase64);
 const dir=path.join(f.dataDir,'library');assert.equal((await fs.stat(dir)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(dir,'library.json'))).mode&0o777,0o600);assert.equal((await fs.stat(path.join(dir,'assets',item.image.fileName))).mode&0o777,0o600);
 await f.service.close();const next=f.start();assert.equal((await dispatch(next,'items:read',{id:item.id})).dataUrl,read.dataUrl);
});

test('collection/group/tag CRUD and combined item filters use actual metadata',async t=>{
 const f=await fixture(t),s=f.service;await dispatch(s,'collections:create',{name:'Work'});const collection=s.snapshot().collections[0];await dispatch(s,'groups:create',{name:'Research',collectionId:collection.id});const group=s.snapshot().groups[0];await dispatch(s,'tags:create',{name:'Useful',color:'#4488cc'});const tag=s.snapshot().tags[0];
 await dispatch(s,'items:create',{kind:'text',title:'Note',text:'Some searchable words',groupId:group.id,tags:[tag.id]});await dispatch(s,'items:create',{kind:'url',title:'Other',url:'https://example.test/'});
 const filtered=await dispatch(s,'items:list',{collectionId:collection.id,groupId:group.id,tagId:tag.id,query:'searchable'});assert.equal(filtered.items.length,1);assert.equal(filtered.items[0].collectionId,collection.id);
 await dispatch(s,'collections:update',{id:collection.id,name:'Renamed'});await dispatch(s,'groups:update',{id:group.id,name:'Reading'});await dispatch(s,'tags:update',{id:tag.id,name:'Keep',color:'#cc8844'});assert.equal(s.snapshot().collections[0].name,'Renamed');assert.equal(s.snapshot().groups[0].name,'Reading');assert.equal(s.snapshot().tags[0].name,'Keep');
 await dispatch(s,'tags:delete',{id:tag.id});assert.ok(s.snapshot().tags[0].deletedAt);await dispatch(s,'tags:restore',{id:tag.id});assert.equal(s.snapshot().tags[0].deletedAt,null);
});

test('soft delete and restore retain full text and image assets',async t=>{
 const f=await fixture(t);await dispatch(f.service,'items:create',{kind:'text',title:'Keep',text:'Never erase on soft delete'});const item=f.service.snapshot().items[0];await dispatch(f.service,'items:delete',{id:item.id});assert.equal((await dispatch(f.service,'items:list')).items.length,0);assert.equal((await dispatch(f.service,'items:list',{deletedOnly:true})).items[0].id,item.id);
 await f.service.close();const restarted=f.start();await dispatch(restarted,'items:restore',{id:item.id});assert.equal((await dispatch(restarted,'items:read',{id:item.id})).text,'Never erase on soft delete');assert.equal(restarted.snapshot().counts.deleted,0);
});

test('capture returns a real unsaved draft and save-active uses the host page callback',async t=>{
 let captures=0;const f=await fixture(t,{capture:async()=>{captures++;return{pngBase64,url:'https://example.test/page',title:'Captured page'};},activePage:async()=>({url:'https://example.test/page',title:'Page bookmark'})});
 const draft=await dispatch(f.service,'capture');assert.equal(draft.width,1);assert.equal(captures,1);assert.equal(draft.dataUrl,'data:image/png;base64,'+pngBase64);assert.equal(f.service.snapshot().counts.active,0);
 await dispatch(f.service,'save-active');assert.equal(f.service.snapshot().items[0].kind,'page');assert.equal(f.service.snapshot().items[0].url,'https://example.test/page');
});

test('PNG export validates bytes and delegates path selection to the trusted host',async t=>{
 let received;const f=await fixture(t,{exportImage:async value=>{received=value;return{saved:true,path:'chosen-by-host.png'};}});
 const result=await dispatch(f.service,'export-image',{pngBase64,suggestedName:'../../unsafe:name'});assert.equal(result.saved,true);assert.equal(received.pngBase64,pngBase64);assert.equal(received.suggestedName.includes('/'),false);assert.match(received.suggestedName,/\.png$/);
 await assert.rejects(dispatch(f.service,'export-image',{pngBase64:Buffer.from('not png').toString('base64')}),/PNG/);
});

test('invalid images, unsafe URLs and mismatched folders roll back without phantom items',async t=>{
 const f=await fixture(t);await assert.rejects(dispatch(f.service,'items:create',{kind:'image',pngBase64:'AAAA'}),/PNG/);const broken=Buffer.from(pngBase64,'base64');broken[broken.length-1]^=1;await assert.rejects(dispatch(f.service,'items:create',{kind:'image',pngBase64:broken.toString('base64')}),/checksum/);
 await assert.rejects(dispatch(f.service,'items:create',{kind:'url',url:'javascript:alert(1)'}),/scheme/);await assert.rejects(dispatch(f.service,'items:create',{kind:'text',text:'note',groupId:'../../etc'}),/not found/);assert.equal(f.service.snapshot().counts.active,0);assert.equal((await fs.readdir(path.join(f.dataDir,'library/assets'))).length,0);
});

test('moving a group maintains item collection consistency and deleted metadata can restore',async t=>{
 const f=await fixture(t),s=f.service;await dispatch(s,'collections:create',{name:'A'});await dispatch(s,'collections:create',{name:'B'});const [a,b]=s.snapshot().collections;await dispatch(s,'groups:create',{name:'Group',collectionId:a.id});const group=s.snapshot().groups[0];await dispatch(s,'items:create',{kind:'text',text:'Data',groupId:group.id});await dispatch(s,'groups:update',{id:group.id,collectionId:b.id});assert.equal(s.snapshot().items[0].collectionId,b.id);
 await dispatch(s,'collections:delete',{id:b.id});assert.ok(s.snapshot().collections[1].deletedAt);assert.equal(s.snapshot().counts.active,1);await dispatch(s,'collections:restore',{id:b.id});await dispatch(s,'groups:delete',{id:group.id});await dispatch(s,'groups:restore',{id:group.id});assert.equal(s.snapshot().groups[0].deletedAt,null);
});

test('item updates persist real content and snapshot only sends bounded snippets',async t=>{
 const f=await fixture(t);await dispatch(f.service,'items:create',{kind:'text',title:'Old',text:'x'.repeat(1000)});const item=f.service.snapshot().items[0];assert.equal(item.text,undefined);assert.equal(item.snippet.length,200);
 await dispatch(f.service,'items:update',{id:item.id,title:'New',text:'updated'});assert.equal((await dispatch(f.service,'items:read',{id:item.id})).text,'updated');assert.equal(f.service.snapshot().items[0].title,'New');await assert.rejects(dispatch(f.service,'items:update',{id:item.id,text:''}),/empty/);assert.equal((await dispatch(f.service,'items:read',{id:item.id})).text,'updated');
});

test('duplicate hosts and metadata-directory aliases are rejected',async t=>{
 const f=await fixture(t);assert.throws(()=>f.start(),/already open/);await f.service.close();await fs.rename(path.join(f.dataDir,'library'),path.join(f.dataDir,'saved-library'));await fs.symlink(path.join(f.dataDir,'saved-library'),path.join(f.dataDir,'library'));assert.throws(()=>f.start(),/real private directories/);
});

test('asset tampering is detected and service close prevents later writes',async t=>{
 const f=await fixture(t);await dispatch(f.service,'items:create',{kind:'image',pngBase64});const item=f.service.snapshot().items[0];await fs.writeFile(path.join(f.dataDir,'library/assets',item.image.fileName),'tampered');await assert.rejects(dispatch(f.service,'items:read',{id:item.id}),/changed on disk/);await f.service.close();await assert.rejects(dispatch(f.service,'items:create',{kind:'text',text:'after close'}),/closed/);
});

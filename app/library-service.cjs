'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024, MAX_TEXT_BYTES = 1024 * 1024, MAX_STATE_BYTES = 50 * 1024 * 1024;
const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);
const fail = (message, code = 'VEK_LIBRARY_ERROR') => Object.assign(new Error(message), { error_code: code });
const copy = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const crcTable = Array.from({length:256}, (_, value) => { let c = value; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function inspectPng(bytes) {
  if (!bytes.subarray(0, 8).equals(pngSignature)) throw fail('Image is not a PNG');
  let offset = 8, dimensions, hasData = false, ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw fail('PNG is truncated');
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (end > bytes.length) throw fail('PNG chunk is truncated');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) throw fail('PNG checksum is invalid');
    if (!dimensions && type !== 'IHDR') throw fail('PNG header is missing');
    if (type === 'IHDR') {
      if (size !== 13 || dimensions) throw fail('PNG header is invalid');
      const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 32768 || height > 32768 || width * height > 80000000) throw fail('Image dimensions exceed the supported limit');
      dimensions = { width, height };
    }
    if (type === 'IDAT') hasData = true;
    if (type === 'IEND') { if (size !== 0 || end !== bytes.length) throw fail('PNG end is invalid'); ended = true; break; }
    offset = end;
  }
  if (!ended || !hasData) throw fail('PNG image data is missing');
  return dimensions;
}
function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw fail('Image must be bounded standard base64');
  const bytes = Buffer.from(value, 'base64'); if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw fail('Images must not exceed 20 MiB'); return bytes;
}
function inspectImage(bytes, pngOnly = false) {
  if (bytes.subarray(0,8).equals(pngSignature)) return { mime:'image/png',extension:'png',...inspectPng(bytes) };
  if (pngOnly) throw fail('Capture and export require a PNG image');
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return {mime:'image/jpeg',extension:'jpg'};
  if (['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)) && bytes.length >= 13) return {mime:'image/gif',extension:'gif',width:bytes.readUInt16LE(6),height:bytes.readUInt16LE(8)};
  if (bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return {mime:'image/webp',extension:'webp'};
  throw fail('Supported images: PNG, JPEG, GIF, WebP. SVG and executable documents are not accepted as images.');
}

function createLibraryService({dataDir,onChange=()=>{},capture,activePage,exportImage,openUrl}={}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  const directory = path.join(path.resolve(dataDir),'library'), assets = path.join(directory,'assets'), statePath = path.join(directory,'library.json'), lockPath = path.join(directory,'host.lock');
  fs.mkdirSync(path.resolve(dataDir),{recursive:true,mode:0o700});
  for(const target of [directory,assets]) {if(fs.existsSync(target)){const info=fs.lstatSync(target);if(info.isSymbolicLink()||!info.isDirectory())throw fail('Library directories must be real private directories');}else fs.mkdirSync(target,{mode:0o700});fs.chmodSync(target,0o700);}
  for(const target of [statePath,lockPath])if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw fail('Library metadata must not be a symbolic link');
  let state = {version:1,collections:[],groups:[],tags:[],items:[]},closed=false,queue=Promise.resolve();
  const lockToken=crypto.randomUUID();
  try { const old=JSON.parse(fs.readFileSync(lockPath,'utf8')); try {process.kill(old.pid,0);throw fail('Library is already open in another host','VEK_LIBRARY_LOCKED');} catch(error) {if(error.code!=='ESRCH')throw error;}fs.unlinkSync(lockPath); } catch(error) {if(error.code!=='ENOENT')throw error;}
  fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,token:lockToken}),{flag:'wx',mode:0o600});
  try {
    try { const raw=fs.readFileSync(statePath);if(raw.length>MAX_STATE_BYTES)throw fail('Library metadata exceeds its limit');state=JSON.parse(raw.toString('utf8'));if(state.version!==1||!['collections','groups','tags','items'].every(key=>Array.isArray(state[key])))throw fail('Library metadata format is invalid');fs.chmodSync(statePath,0o600); }
    catch(error) {if(error.code!=='ENOENT')throw error;}
  } catch(error) {fs.unlinkSync(lockPath);throw error;}
  function persist() { const value=JSON.stringify(state,null,2);if(Buffer.byteLength(value)>MAX_STATE_BYTES)throw fail('Library metadata exceeds 50 MiB');const temporary=statePath+'.'+crypto.randomUUID()+'.tmp';try {fs.writeFileSync(temporary,value,{mode:0o600,flag:'wx'});fs.renameSync(temporary,statePath);} finally {try{fs.unlinkSync(temporary);}catch{}} }
  function entity(type,id,live=false) {const item=state[type].find(item=>item.id===id);if(!item||(live&&item.deletedAt))throw fail(`${type.slice(0,-1)} was not found`,'VEK_LIBRARY_NOT_FOUND');return item;}
  function title(value,fallback='Untitled') {if(value===undefined||value==='')return fallback;if(typeof value!=='string'||!value.trim()||value.length>300)throw fail('Name/title must contain 1–300 characters');return value.trim();}
  function url(value) {if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||value.length>10000)throw fail('URL is invalid');let parsed;try{parsed=new URL(value);}catch{throw fail('URL is invalid');}if(!['https:','http:','file:','about:'].includes(parsed.protocol))throw fail('This URL scheme cannot be saved');return parsed.href;}
  function text(value) {if(value===undefined||value===null)return '';if(typeof value!=='string'||Buffer.byteLength(value)>MAX_TEXT_BYTES)throw fail('Text must not exceed 1 MiB');return value;}
  function location(payload,previous={}) {
    let collectionId=Object.hasOwn(payload,'collectionId')?(payload.collectionId||null):(previous.collectionId||null);
    let groupId=Object.hasOwn(payload,'groupId')?(payload.groupId||null):(previous.groupId||null);
    if(Object.hasOwn(payload,'collectionId')&&collectionId)entity('collections',collectionId,true);
    if(Object.hasOwn(payload,'groupId')&&groupId){const group=entity('groups',groupId,true);if(collectionId&&group.collectionId&&collectionId!==group.collectionId)throw fail('Group belongs to another collection');collectionId=group.collectionId||collectionId;}
    if(Object.hasOwn(payload,'collectionId')&&!Object.hasOwn(payload,'groupId')&&groupId&&entity('groups',groupId).collectionId!==collectionId)groupId=null;
    const tags=Object.hasOwn(payload,'tags')?payload.tags:(previous.tags||[]);
    if(!Array.isArray(tags)||tags.length>50||tags.some(tag=>typeof tag!=='string'))throw fail('Choose at most 50 tag IDs');
    if(Object.hasOwn(payload,'tags'))for(const id of tags)entity('tags',id,true);
    return {collectionId,groupId,tags:[...new Set(tags)]};
  }
  function metadata(item) {const value=copy(item);delete value.text;value.snippet=(item.text||'').slice(0,200);value.hasText=Boolean(item.text);return value;}
  function snapshot(filters={includeDeleted:true}) {
    let items=state.items;
    if(filters.deletedOnly)items=items.filter(item=>item.deletedAt);else if(!filters.includeDeleted)items=items.filter(item=>!item.deletedAt);
    if(filters.collectionId)items=items.filter(item=>item.collectionId===filters.collectionId);
    if(filters.groupId)items=items.filter(item=>item.groupId===filters.groupId);
    if(filters.tagId)items=items.filter(item=>item.tags.includes(filters.tagId));
    if(filters.kind)items=items.filter(item=>item.kind===filters.kind);
    if(filters.query){const q=String(filters.query).toLowerCase();items=items.filter(item=>`${item.title}\n${item.text||''}\n${item.url||''}`.toLowerCase().includes(q));}
    return {version:1,collections:copy(state.collections),groups:copy(state.groups),tags:copy(state.tags),items:items.map(metadata).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),counts:{active:state.items.filter(item=>!item.deletedAt).length,deleted:state.items.filter(item=>item.deletedAt).length},capabilities:{capture:typeof capture==='function',saveActive:typeof activePage==='function',exportImage:typeof exportImage==='function',openUrl:typeof openUrl==='function',imageMaxBytes:MAX_IMAGE_BYTES}};
  }
  async function mutate(fn) {const previous=copy(state),newAssets=[];try{const result=await fn(newAssets);persist();try{onChange(snapshot());}catch{}return result===undefined?snapshot():result;}catch(error){state=previous;for(const file of newAssets)await fsp.rm(file,{force:true}).catch(()=>{});throw error;}}
  function serialized(fn){if(closed)return Promise.reject(fail('Library service is closed'));const current=queue.catch(()=>{}).then(()=>mutate(fn));queue=current;return current;}
  async function saveImage(payload,newAssets){const bytes=decodeBase64(payload.pngBase64||payload.imageBase64);const info=inspectImage(bytes,Boolean(payload.pngBase64));const fileName=crypto.randomUUID()+'.'+info.extension;const target=path.join(assets,fileName);await fsp.writeFile(target,bytes,{flag:'wx',mode:0o600});newAssets.push(target);return {fileName,mime:info.mime,bytes:bytes.length,sha256:sha(bytes),...(info.width?{width:info.width,height:info.height}:{})};}
  async function createItem(payload,newAssets){if(state.items.length>=5000)throw fail('Library currently supports at most 5000 items including trash');if(!['text','page','url','image'].includes(payload.kind))throw fail('Choose text, page, url, or image');const item={id:crypto.randomUUID(),kind:payload.kind,title:title(payload.title),text:text(payload.text),url:url(payload.url),...location(payload),createdAt:now(),updatedAt:now(),deletedAt:null};if(['page','url'].includes(item.kind)&&!item.url)throw fail('Page and URL items need a URL');if(item.kind==='text'&&!item.text.trim())throw fail('Text item is empty');if(item.kind==='image')item.image=await saveImage(payload,newAssets);state.items.push(item);}
  async function readItem(id){const item=copy(entity('items',id));if(item.image){if(!/^[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(item.image.fileName))throw fail('Image asset path is invalid');const file=path.join(assets,item.image.fileName);const info=await fsp.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_IMAGE_BYTES)throw fail('Image asset is invalid');const bytes=await fsp.readFile(file);if(sha(bytes)!==item.image.sha256)throw fail('Image bytes changed on disk','VEK_LIBRARY_ASSET_CHANGED');item.dataUrl=`data:${item.image.mime};base64,${bytes.toString('base64')}`;}return item;}
  async function dispatch(action,payload={}) {
    if(closed)throw fail('Library service is closed');
    if(action==='library:snapshot')return snapshot();
    if(action==='library:items:list')return snapshot({...payload,includeDeleted:payload.includeDeleted===true});
    if(action==='library:items:read')return readItem(payload.id);
    if(action==='library:capture'){if(!capture)throw fail('Screenshot capture is not connected');const result=await capture();const base64=result?.pngBase64;if(!base64)throw fail('Host returned no screenshot');const bytes=decodeBase64(base64),info=inspectImage(bytes,true);return {kind:'image-draft',base64,dataUrl:`data:image/png;base64,${base64}`,mime:info.mime,width:info.width,height:info.height,title:title(result.title,'Screenshot'),url:url(result.url)};}
    if(action==='library:export-image'){if(!exportImage)throw fail('PNG export is not connected');const bytes=decodeBase64(payload.pngBase64);inspectImage(bytes,true);const suggestedName=String(payload.suggestedName||'vek-screenshot.png').replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(0,150);return exportImage({pngBase64:bytes.toString('base64'),suggestedName:suggestedName.toLowerCase().endsWith('.png')?suggestedName:suggestedName+'.png'});}
    if(action==='library:open-url'){if(!openUrl)throw fail('Opening saved URLs is not connected');const item=entity('items',payload.id);if(!item.url)throw fail('This item has no URL');return openUrl(url(item.url));}
    if(action==='library:save-active'){if(!activePage)throw fail('Saving the active page is not connected');const page=await activePage();return serialized(assets=>createItem({kind:'page',title:page?.title,url:page?.url,text:page?.text},assets));}
    return serialized(async newAssets=>{
      const match=action.match(/^library:(collections|groups|tags):(create|update|delete|restore)$/);
      if(match){const [,type,operation]=match;if(operation==='create'){if(state[type].length>=1000)throw fail('Too many library folders/tags');const record={id:crypto.randomUUID(),name:title(payload.name),createdAt:now(),updatedAt:now(),deletedAt:null};if(type==='groups'){record.collectionId=payload.collectionId||null;if(record.collectionId)entity('collections',record.collectionId,true);}if(type==='tags'&&payload.color){if(!/^#[\da-f]{6}$/i.test(payload.color))throw fail('Tag color must be a hex color');record.color=payload.color;}state[type].push(record);}else{const record=entity(type,payload.id);if(operation==='delete')record.deletedAt=now();else if(operation==='restore')record.deletedAt=null;else{if(Object.hasOwn(payload,'name'))record.name=title(payload.name);if(type==='groups'&&Object.hasOwn(payload,'collectionId')){record.collectionId=payload.collectionId||null;if(record.collectionId)entity('collections',record.collectionId,true);for(const item of state.items)if(item.groupId===record.id){item.collectionId=record.collectionId;item.updatedAt=now();}}if(type==='tags'&&Object.hasOwn(payload,'color')){if(!/^#[\da-f]{6}$/i.test(payload.color))throw fail('Tag color must be a hex color');record.color=payload.color;}}record.updatedAt=now();}return;}
      if(action==='library:items:create')return createItem(payload,newAssets);
      const item=entity('items',payload.id);
      if(action==='library:items:delete')item.deletedAt=now();
      else if(action==='library:items:restore')item.deletedAt=null;
      else if(action==='library:items:update'){if(Object.hasOwn(payload,'title'))item.title=title(payload.title);if(Object.hasOwn(payload,'text'))item.text=text(payload.text);if(Object.hasOwn(payload,'url'))item.url=url(payload.url);Object.assign(item,location(payload,item));if(item.kind==='image'&&(payload.pngBase64||payload.imageBase64))item.image=await saveImage(payload,newAssets);if(['page','url'].includes(item.kind)&&!item.url)throw fail('Page and URL items need a URL');if(item.kind==='text'&&!item.text.trim())throw fail('Text item is empty');}
      else throw fail('Unknown Library action');item.updatedAt=now();
    });
  }
  async function close(){if(closed)return;closed=true;await queue.catch(()=>{});try{if(JSON.parse(fs.readFileSync(lockPath,'utf8')).token===lockToken)fs.unlinkSync(lockPath);}catch{}}
  try {persist();}catch(error){try{fs.unlinkSync(lockPath);}catch{}throw error;}
  return {dispatch,snapshot,close};
}
module.exports={createLibraryService,inspectPng};

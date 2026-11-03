'use strict';
// Portable Wiek profile data only. This module performs no filesystem/network I/O.
const { randomBytes, scrypt, createCipheriv, createDecipheriv } = require('node:crypto');
const { promisify } = require('node:util');
const { TextDecoder } = require('node:util');
const derive = promisify(scrypt);
const { ENCODING, LIMITS: STORAGE_LIMITS, validateArea } = require('./profile-storage-data.cjs');
// The on-disk identifier is retained so existing encrypted archives still decode.
const FORMAT = 'vek-browser-profile', MIME_TYPE = 'application/vnd.vek.profile+json', VERSION = 2;
const KDF = 'scrypt-131072-8-1', CIPHER = 'aes-256-gcm';
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const SCRYPT = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const ROW_LIMIT = 20000, SPACE_LIMIT = 512, TAB_LIMIT = 10000;
const error = (message, code = 'VEK_PROFILE_ARCHIVE_INVALID') => Object.assign(new Error(message), { error_code: code, code });
const prohibited = new Set(['__proto__', 'prototype', 'constructor']);
let activeKdfs = 0;
function string(value, field, max = 4096, empty = true) {
  if (typeof value !== 'string' || (!empty && !value) || value.includes('\0') || !value.isWellFormed() || Buffer.byteLength(value) > max) throw error(`Invalid ${field}`);
  return value;
}
function object(value, fields, field, required = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw error(`Invalid ${field} fields`);
  return value;
}
function bool(value, field) { if (typeof value !== 'boolean') throw error(`Invalid ${field}`); return value; }
function date(value, field) { string(value, field, 32, false); if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw error(`Invalid ${field}`); return value; }
function url(value, field, blank = false) {
  string(value, field, 16384, false);
  if (blank && value === 'about:blank') return value;
  if (/[\u0000-\u0020\u007f\\]/.test(value)) throw error(`Invalid ${field} URL`);
  let parsed; try { parsed = new URL(value); } catch { throw error(`Invalid ${field} URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw error(`Invalid ${field} URL`);
  return parsed.href;
}
function origin(value, field) { const parsed = new URL(url(value, field)); if (parsed.origin !== value) throw error(`Invalid ${field}: use an exact HTTP(S) origin`); return parsed.origin; }
function array(value, field, max = ROW_LIMIT) { if (!Array.isArray(value) || value.length > max) throw error(`Invalid ${field} count`); return value; }
function optionalText(out, source, key, max = 4096) { if (Object.hasOwn(source, key)) out[key] = string(source[key], key, max); }
// Inspect before JSON serialization: getters, toJSON, class instances, sparse
// arrays and pollution keys must never be evaluated or silently normalized.
function plainClone(value, maxBytes) {
  let nodes = 0, budget = 0;
  function walk(current, depth = 0) {
    if (++nodes > 180000 || depth > 24) throw error('Archive data exceeds structural limits', 'VEK_PROFILE_ARCHIVE_LIMIT');
    const consume = bytes => { budget += bytes; if (budget > maxBytes) throw error('Archive data exceeds the size limit', 'VEK_PROFILE_ARCHIVE_LIMIT'); };
    if (current === null || typeof current === 'boolean') { consume(5); return current; }
    if (typeof current === 'number') { if (!Number.isFinite(current)) throw error('Archive numbers must be finite'); consume(24); return current; }
    if (typeof current === 'string') { string(current, 'text', maxBytes); consume(Buffer.byteLength(current) + 2); return current; }
    if (!current || typeof current !== 'object') throw error('Archive data must contain only JSON values');
    const isArray = Array.isArray(current), proto = Object.getPrototypeOf(current);
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw error('Archive data must contain only plain JSON objects');
    const descriptors = Object.getOwnPropertyDescriptors(current), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || prohibited.has(key))) throw error('Unsafe archive property');
    const out = isArray ? [] : {};
    consume(2);
    if (isArray) {
      if (current.length > ROW_LIMIT || keys.some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length))) throw error('Invalid archive array');
      for (let i = 0; i < current.length; i++) { const descriptor = descriptors[i]; if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw error('Archive arrays must not be sparse or contain accessors'); out.push(walk(descriptor.value, depth + 1)); consume(1); }
    } else for (const key of keys) {
      const descriptor = descriptors[key]; if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw error('Archive objects must not contain accessors or hidden properties');
      consume(Buffer.byteLength(key) + 4); out[key] = walk(descriptor.value, depth + 1);
    }
    return out;
  }
  return walk(value);
}
function normalizePayload(input, maxBytes, version = VERSION) {
  const source = plainClone(input, maxBytes);
  object(source, ['profile','spaces','bookmarks','history','cookies','passwords','extensionsMetadata',...(version>=2?['webStorage']:[])], 'profile payload', ['profile']);
  const profile = object(source.profile, ['id','name'], 'profile', ['name']);
  const out = { profile: { name: string(profile.name, 'profile name', 1024, false) }, spaces: [], bookmarks: [], history: [], cookies: [], passwords: [], extensionsMetadata: [] };
  optionalText(out.profile, profile, 'id', 128);
  let totalTabs = 0; const storageBudget={bytes:0};
  out.spaces = array(source.spaces === undefined ? [] : source.spaces, 'spaces', SPACE_LIMIT).map(space => {
    object(space, ['name','pinned','activeTabIndex','tabs'], 'space', ['name','tabs']);
    const tabs = array(space.tabs, 'tabs', 1024); totalTabs += tabs.length;
    if (totalTabs > TAB_LIMIT) throw error('Archive has too many tabs', 'VEK_PROFILE_ARCHIVE_LIMIT');
    const normalized = { name: string(space.name, 'space name', 1024, false), tabs: tabs.map(tab => { object(tab, ['url','title',...(version>=2?['sessionStorage']:[])], 'tab', ['url']); const result = { url: url(tab.url, 'tab', true) }; optionalText(result,tab,'title'); if(Object.hasOwn(tab,'sessionStorage')) { result.sessionStorage=validateArea(tab.sessionStorage,storageBudget);if(result.url==='about:blank'||new URL(result.url).origin!==result.sessionStorage.origin)throw error('Session storage origin must match its tab'); }return result; }) };
    if (Object.hasOwn(space,'pinned')) normalized.pinned = bool(space.pinned,'space pinned');
    if (Object.hasOwn(space,'activeTabIndex')) { if (!Number.isInteger(space.activeTabIndex) || space.activeTabIndex < 0 || space.activeTabIndex >= tabs.length) throw error('Invalid active tab index'); normalized.activeTabIndex = space.activeTabIndex; }
    return normalized;
  });
  out.bookmarks = array(source.bookmarks === undefined ? [] : source.bookmarks, 'bookmarks').map(row => { object(row,['url','title','folder'],'bookmark',['url']); const result={url:url(row.url,'bookmark')}; optionalText(result,row,'title');optionalText(result,row,'folder');return result; });
  out.history = array(source.history === undefined ? [] : source.history, 'history').map(row => { object(row,['url','title','at'],'history',['url','at']); const result={url:url(row.url,'history'),at:date(row.at,'history date')}; optionalText(result,row,'title');return result; });
  out.cookies = array(source.cookies === undefined ? [] : source.cookies, 'cookies').map(row => {
    object(row,['url','domain','name','value','path','secure','httpOnly','hostOnly','session','sameSite','expirationDate'],'cookie',['name','value']);
    const secure = Object.hasOwn(row,'secure') ? bool(row.secure,'cookie secure') : false;
    let cookieURL = Object.hasOwn(row,'url') ? new URL(url(row.url,'cookie')) : null;
    if (!Object.hasOwn(row,'domain') && !cookieURL) throw error('Cookie requires a domain or URL');
    const domain = Object.hasOwn(row,'domain') ? string(row.domain,'cookie domain',1024,false).toLowerCase() : cookieURL.hostname;
    const hostname = domain.replace(/^\./,'');
    let parsed; try { parsed = new URL(`${secure ? 'https' : 'http'}://${hostname}/`); } catch {}
    if (!parsed || !hostname || hostname.startsWith('.') || parsed.hostname !== hostname || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) throw error('Invalid cookie domain');
    const hostOnly = Object.hasOwn(row,'hostOnly') ? bool(row.hostOnly,'cookie hostOnly') : !domain.startsWith('.');
    if (hostOnly && domain.startsWith('.')) throw error('Host-only cookie cannot use a domain prefix');
    if (cookieURL && (cookieURL.hostname !== hostname || cookieURL.port || cookieURL.search || cookieURL.hash || secure && cookieURL.protocol !== 'https:')) throw error('Cookie URL does not match its domain or secure flag');
    const cookiePath = Object.hasOwn(row,'path') ? string(row.path,'cookie path',4096,false) : '/';
    if (!cookiePath.startsWith('/') || /[\r\n]/.test(cookiePath)) throw error('Invalid cookie path');
    const name = string(row.name,'cookie name',4096), value=string(row.value,'cookie value',65536);
    if (/[\u0000-\u0020\u007f()<>@,;:\\"/\[\]?={}]/.test(name) || /[\r\n\u0000]/.test(value)) throw error('Invalid cookie name or value');
    const session = Object.hasOwn(row,'session') ? bool(row.session,'cookie session') : !Object.hasOwn(row,'expirationDate');
    const result={url:cookieURL ? cookieURL.origin+'/' : parsed.href,domain:hostOnly?hostname:'.'+hostname,name,value,path:cookiePath,secure,httpOnly:Object.hasOwn(row,'httpOnly')?bool(row.httpOnly,'cookie httpOnly'):false,hostOnly,session,sameSite:Object.hasOwn(row,'sameSite')?row.sameSite:'unspecified'};
    if (!['unspecified','no_restriction','lax','strict'].includes(result.sameSite)) throw error('Invalid cookie sameSite');
    if (Object.hasOwn(row,'expirationDate')) { if (session || typeof row.expirationDate !== 'number' || !Number.isFinite(row.expirationDate) || row.expirationDate <= 0 || row.expirationDate > 253402300799) throw error('Invalid cookie expirationDate'); result.expirationDate=row.expirationDate; }
    else if (!session) throw error('Persistent cookie requires an expirationDate');
    return result;
  });
  out.passwords = array(source.passwords === undefined ? [] : source.passwords, 'passwords').map(row => { object(row,['origin','username','password'],'password',['origin','username','password']); return {origin:origin(row.origin,'password origin'),username:string(row.username,'username',16384),password:string(row.password,'password',65536)}; });
  out.extensionsMetadata = array(source.extensionsMetadata === undefined ? [] : source.extensionsMetadata, 'extension metadata',512).map(row=>{object(row,['id','name','version','enabled'],'extension metadata',['id','name','version']);const result={id:string(row.id,'extension id',128,false),name:string(row.name,'extension name',1024,false),version:string(row.version,'extension version',128,false)};if(Object.hasOwn(row,'enabled'))result.enabled=bool(row.enabled,'extension enabled');return result;});
  if(Object.hasOwn(source,'webStorage')) {
    object(source.webStorage,['encoding','localStorage'],'web storage',['encoding','localStorage']);
    if(source.webStorage.encoding!==ENCODING)throw error('Unsupported web storage encoding');const seen=new Set();
    out.webStorage={encoding:ENCODING,localStorage:array(source.webStorage.localStorage,'local storage origins',STORAGE_LIMITS.origins).map(row=>{const area=validateArea(row,storageBudget);if(seen.has(area.origin))throw error('Duplicate local storage origin');seen.add(area.origin);return area;})};
  }
  if (Buffer.byteLength(JSON.stringify(out)) > maxBytes) throw error('Archive data exceeds the size limit','VEK_PROFILE_ARCHIVE_LIMIT');
  return out;
}
function passphraseBytes(value) { string(value,'passphrase',1024,false); if ([...value].length < 8) throw error('Archive passphrase must contain at least eight characters','VEK_PROFILE_ARCHIVE_PASSPHRASE'); return Buffer.from(value,'utf8'); }
async function keyFor(passphrase,salt) {
  if (activeKdfs >= 2) throw error('Two archive operations are already deriving keys; retry after one finishes','VEK_PROFILE_ARCHIVE_BUSY');
  const secret=passphraseBytes(passphrase); activeKdfs++;
  try { return await derive(secret,salt,32,SCRYPT); }
  catch (failure) { if (failure.error_code) throw failure; throw error('Archive key derivation failed','VEK_PROFILE_ARCHIVE_CRYPTO'); }
  finally { secret.fill(0);activeKdfs--; }
}
const headerFields=['format','mimeType','version','createdAt','expiresAt','kdf','cipher','salt','iv'];
function headerOf(envelope) { return Object.fromEntries(headerFields.map(field=>[field,envelope[field]])); }
function base64(value,field,length,maxBytes) {
  if (typeof value!=='string' || !value || value.length>Math.ceil(maxBytes/3)*4 || value.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw error(`Invalid archive ${field}`);
  const result=Buffer.from(value,'base64'); if(result.toString('base64')!==value || length && result.length!==length || result.length>maxBytes)throw error(`Invalid archive ${field}`); return result;
}
function createProfileArchive({maxBytes=DEFAULT_MAX_BYTES}={}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes<512 || maxBytes>128*1024*1024) throw error('Archive size limit must be between 512 bytes and 128 MiB');
  function validate(payload) { return normalizePayload(payload,maxBytes); }
  return {
    limits:Object.freeze({maxBytes,maxRowsPerCategory:ROW_LIMIT,maxSpaces:SPACE_LIMIT,maxTabs:TAB_LIMIT,mimeType:MIME_TYPE,format:FORMAT,version:VERSION}),
    validate,
    async encode(payload,passphrase,{expiresAt=null}={}) {
      const normalized=validate(payload),createdAt=new Date().toISOString();
      if(expiresAt!==null){date(expiresAt,'archive expiry');if(Date.parse(expiresAt)<=Date.parse(createdAt))throw error('Archive expiry must be in the future','VEK_PROFILE_ARCHIVE_EXPIRED');}
      const salt=randomBytes(16),iv=randomBytes(12);
      const header={format:FORMAT,mimeType:MIME_TYPE,version:VERSION,createdAt,expiresAt,kdf:KDF,cipher:CIPHER,salt:salt.toString('base64'),iv:iv.toString('base64')};
      const plain=Buffer.from(JSON.stringify(normalized),'utf8');let key;
      try {
        // Avoid an expensive KDF for a payload whose base64 envelope cannot fit.
        if(Math.ceil(plain.length/3)*4+Buffer.byteLength(JSON.stringify(header))+100>maxBytes)throw error('Encrypted archive exceeds the size limit','VEK_PROFILE_ARCHIVE_LIMIT');
        key=await keyFor(passphrase,salt);const cipher=createCipheriv(CIPHER,key,iv,{authTagLength:16});cipher.setAAD(Buffer.from(JSON.stringify(header),'utf8'));
        const data=Buffer.concat([cipher.update(plain),cipher.final()]);const encoded=JSON.stringify({...header,tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
        if(Buffer.byteLength(encoded)>maxBytes)throw error('Encrypted archive exceeds the size limit','VEK_PROFILE_ARCHIVE_LIMIT');return encoded;
      } finally {key?.fill(0);plain.fill(0);}
    },
    async decode(input,passphrase) {
      if(!(typeof input==='string'||Buffer.isBuffer(input)||input instanceof Uint8Array))throw error('Archive input must be UTF-8 JSON text or bytes');
      const length=typeof input==='string'?Buffer.byteLength(input):input.byteLength;if(length>maxBytes)throw error('Archive file exceeds the size limit','VEK_PROFILE_ARCHIVE_LIMIT');
      let envelope;
      try {const text=typeof input==='string'?input:new TextDecoder('utf-8',{fatal:true}).decode(input);envelope=JSON.parse(text);}catch{throw error('Archive is not valid UTF-8 JSON');}
      envelope=plainClone(envelope,maxBytes);
      object(envelope,[...headerFields,'tag','data'],'archive envelope',[...headerFields,'tag','data']);
      if(envelope.format!==FORMAT||envelope.mimeType!==MIME_TYPE)throw error('Unrecognized Wiek profile archive format or MIME type');
      if(![1,VERSION].includes(envelope.version))throw error('Unsupported Wiek profile archive version','VEK_PROFILE_ARCHIVE_VERSION');
      if(envelope.kdf!==KDF||envelope.cipher!==CIPHER)throw error('Unsupported archive encryption parameters');
      date(envelope.createdAt,'archive creation date');if(envelope.expiresAt!==null)date(envelope.expiresAt,'archive expiry');
      const salt=base64(envelope.salt,'salt',16,16),iv=base64(envelope.iv,'IV',12,12),tag=base64(envelope.tag,'tag',16,16),data=base64(envelope.data,'ciphertext',null,maxBytes);
      let key,plain,part;
      try {
        key=await keyFor(passphrase,salt);
        try {const decipher=createDecipheriv(CIPHER,key,iv,{authTagLength:16});decipher.setAAD(Buffer.from(JSON.stringify(headerOf(envelope)),'utf8'));decipher.setAuthTag(tag);part=decipher.update(data);const tail=decipher.final();plain=Buffer.concat([part,tail]);tail.fill(0);}
        catch{throw error('Incorrect passphrase or archive authentication failed','VEK_PROFILE_ARCHIVE_AUTH');}
        if(Date.parse(envelope.createdAt)>Date.now()+5*60*1000)throw error('Archive creation date is in the future');
        if(envelope.expiresAt!==null&&(Date.parse(envelope.expiresAt)<=Date.now()||Date.parse(envelope.expiresAt)<=Date.parse(envelope.createdAt)))throw error('Profile archive has expired','VEK_PROFILE_ARCHIVE_EXPIRED');
        if(plain.length>maxBytes)throw error('Archive data exceeds the size limit','VEK_PROFILE_ARCHIVE_LIMIT');
        let payload;try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}catch{throw error('Decrypted archive payload is not valid UTF-8 JSON');}
        return {payload:normalizePayload(payload,maxBytes,envelope.version),metadata:{format:FORMAT,mimeType:MIME_TYPE,version:envelope.version,createdAt:envelope.createdAt,expiresAt:envelope.expiresAt}};
      } finally {key?.fill(0);plain?.fill(0);part?.fill(0);data.fill(0);}
    },
  };
}
module.exports={createProfileArchive,FORMAT,MIME_TYPE,VERSION};

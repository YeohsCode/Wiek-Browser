#!/usr/bin/env node
// Read-only Chromium DataPack v4/v5 extractor. Targets are inert byte strings.
// Format: chromium ui/base/resource/data_pack.cc and resource_bundle.cc.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
const root = path.resolve(import.meta.dirname, '..');
const resourceRoot = path.join(root, 'downloads/ego/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/0.6.1.13/Resources');
const output = path.join(root, 'analysis/extracted-ego-resources');
if (fs.existsSync(path.join(output,'manifest.json'))) throw new Error('Extraction already exists; review the retained manifest instead of overwriting evidence');
fs.mkdirSync(output,{recursive:true});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8',{fatal:true});
function kind(bytes) {
 if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['png',null];
 if (bytes.subarray(0,4).toString()==='RIFF') return ['webp',null];
 if (bytes.subarray(0,4).toString()==='wOF2') return ['woff2',null];
 let text; try {text=decoder.decode(bytes);if(text.includes('\0'))return ['bin',null]}catch{return ['bin',null]}
 const clean=text.trim();if(!clean)return ['txt',text];
 if(/^<svg\b|^<\?xml/.test(clean))return ['svg',text];
 if(/^<!doctype\s+html|^<html\b|^<body\b|^<head\b/i.test(clean))return ['html',text];
 try{JSON.parse(clean);return ['json',text]}catch{}
 if(/\b(?:import\s|export\s|function\s|const\s|let\s|var\s)|=>/.test(text))return ['js',text];
 if(/\{[^}]*\b(?:color|display|background|padding|margin)\s*:/.test(text))return ['css',text];
 return ['txt',text];
}
const manifest={version:1,method:'Chromium DataPack v4/v5 little-endian validated offsets, aliases, gzip/Brotli decoding',sources:['https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/resource/data_pack.cc','https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/resource/resource_bundle.cc'],packs:[],limitations:['Numeric resource IDs do not establish original path names.','Text file type detection is heuristic; manifest retains payload offsets and hashes.','Vendor marker matches are candidates, not proof that all matching assets are Ego-specific.','No resource JavaScript or application bootstrap code was executed.']};
for(const relative of ['resources.pak','chrome_100_percent.pak','chrome_200_percent.pak','en.lproj/locale.pak']){
 const source=path.join(resourceRoot,relative),bytes=fs.readFileSync(source);let b=bytes,outerCompression='none';if(b[0]===31&&b[1]===139){b=gunzipSync(b);outerCompression='gzip'}
 const version=b.readUInt32LE(0);let count,aliasCount,encoding,header;if(version===5){header=12;encoding=b[4];count=b.readUInt16LE(8);aliasCount=b.readUInt16LE(10)}else if(version===4){header=9;count=b.readUInt32LE(4);aliasCount=0;encoding=b[8]}else throw new Error('Unsupported DataPack version '+version);
 const tableEnd=header+(count+1)*6+aliasCount*4;if(tableEnd>b.length)throw new Error('Truncated table');
 const entries=Array.from({length:count+1},(_,i)=>({id:b.readUInt16LE(header+i*6),offset:b.readUInt32LE(header+i*6+2)}));
 for(let i=0;i<entries.length;i++){if(entries[i].offset> b.length||entries[i].offset<tableEnd||i&&entries[i].offset<entries[i-1].offset)throw new Error('Invalid resource offsets')}
 const aliases=Array.from({length:aliasCount},(_,i)=>{const start=header+(count+1)*6+i*4,id=b.readUInt16LE(start),index=b.readUInt16LE(start+2);if(index>=count)throw new Error('Invalid alias index');return {id,resourceId:entries[index].id}});
 const packName=relative.replaceAll('/','__').replace(/\.pak$/,''),directory=path.join(output,packName);fs.mkdirSync(directory,{recursive:true});
 const pack={source:path.relative(root,source),sha256:digest(bytes),bytes:bytes.length,version,encoding,resourceCount:count,aliasCount,outerCompression,aliases,resources:[]};
 for(let i=0;i<count;i++){
  const {id,offset}=entries[i],raw=b.subarray(offset,entries[i+1].offset);let data=raw,compression='none';
  if(raw[0]===31&&raw[1]===139){data=gunzipSync(raw);compression='gzip'}else if(raw[0]===30&&raw[1]===155){data=brotliDecompressSync(raw.subarray(8));const expected=raw.readUIntLE(2,6);if(data.length!==expected)throw new Error('Brotli size mismatch');compression='brotli'}
  const [type,text]=kind(data),filename=`${id}.${type}`;fs.writeFileSync(path.join(directory,filename),data);
  const candidate=!!text&&/\bego\b|citro(?:labs)?|ego[-_:/.]|task.?space|local.?ego.?daemon/i.test(text);
  const markerLines=candidate?text.split('\n').flatMap((line,index)=>/\bego\b|citro(?:labs)?|ego[-_:/.]|task.?space|local.?ego.?daemon/i.test(line)?[{line:index+1,snippet:line.slice(0,240)}]:[]).slice(0,20):[];
  pack.resources.push({id,offset,rawBytes:raw.length,rawSha256:digest(raw),compression,decodedBytes:data.length,decodedSha256:digest(data),type,path:path.relative(root,path.join(directory,filename)),vendorCandidate:candidate,...(markerLines.length?{markerLines}:{})});
 }
 manifest.packs.push(pack);console.log(JSON.stringify({pack:relative,resources:count,aliases:aliasCount,types:pack.resources.reduce((sum,r)=>(sum[r.type]=(sum[r.type]||0)+1,sum),{}),vendorCandidates:pack.resources.filter(r=>r.vendorCandidate).length}));
}
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));

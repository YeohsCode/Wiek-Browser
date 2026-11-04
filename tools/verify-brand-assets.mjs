#!/usr/bin/env node
// Hash audit of active product inputs; analysis/reference evidence stays separate.
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
const packaged=process.argv[2]?resolve(process.argv[2]):null;
const original=new Set(['2822b28752520f2a5506cb0693c8db2fd1ec0345806454b5f92d999b84b5bc1f','cec732e29ea3b03d8920b28d912306f43651186dc2f4a488800da9db0a50f993']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function walk(base,relative){let result=[];for(const item of await readdir(join(base,relative),{withFileTypes:true})){const next=join(relative,item.name);if(item.isDirectory())result.push(...await walk(base,next));else if(item.isFile())result.push(next);}return result;}
const hits=[];let checked=0;
for(const base of [root,...(packaged?[packaged]:[])])for(const dir of ['app','skills','packages/sdk/dist'])for(const file of await walk(base,dir)){
  checked++;if(original.has(sha(await readFile(join(base,file)))))hits.push({base,file});
}
const appIcon=sha(await readFile(join(root,'app/assets/wiek.png')));
const mappings=[];
for(const base of [root,...(packaged?[packaged]:[])])for(const skill of ['wiek-browser','ego-browser']){
  const actual=sha(await readFile(join(base,'skills',skill,'assets/logo.png')));
  mappings.push({base,skill,matches:actual===appIcon});
}
let packagedIconMatches=null;
if(packaged)packagedIconMatches=sha(await readFile(join(packaged,'../icon.icns')))===sha(await readFile(join(root,'app/assets/wiek.icns')));
const report={generatedAt:new Date().toISOString(),version:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,checked,originalEgoLogoHits:hits,skillMappings:mappings,packagedIconMatches,scope:'Exact SHA-256 check of two original Ego PNGs; independently authored Wiek SVG is the brand source.'};
await writeFile(join(root,'reports/wiek-brand-audit.json'),JSON.stringify(report,null,2)+'\n');
if(hits.length||mappings.some(row=>!row.matches)||packagedIconMatches===false)throw new Error('Brand audit failed');
console.log(JSON.stringify(report,null,2));

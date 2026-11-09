#!/usr/bin/env node
import {cp,mkdir,readFile,writeFile,rm,symlink,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {migrateNamespace} from './sdk-test-namespace.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
export const regressionRoot=join(root,'data/sdk-regression/workspace');
export const regressionSdk=join(regressionRoot,'packages/sdk');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function prepareRegression(){
 const manifest=JSON.parse(await readFile(join(root,'reports/upstream-test-integrity.json'),'utf8'));
 const records=[];
 for(const entry of manifest.records){
  const bytes=await readFile(join(root,'tests/fixtures/sdk-original',entry.file));
  if(sha(bytes)!==entry.sha256)throw Error('Original SDK test input changed: '+entry.file);
  records.push({file:entry.file,sha256:entry.sha256,unchanged:true});
 }
 await rm(regressionRoot,{recursive:true,force:true});await mkdir(regressionSdk,{recursive:true});
 await cp(join(root,'packages/sdk'),regressionSdk,{recursive:true,filter:p=>!p.split('/').some(s=>['node_modules','.build.lock','artifacts'].includes(s)||s==='.env'||s.startsWith('.env.')||s.endsWith('.log'))});
 await symlink(join(root,'packages/sdk/node_modules'),join(regressionSdk,'node_modules'),'dir');
 await cp(join(root,'tests/fixtures/sdk-original'),regressionSdk,{recursive:true});
 await cp(join(root,'skills/wiek-browser'),join(regressionRoot,'skills/wiek-browser'),{recursive:true});
 for(const directory of ['.agents','.codex','.claude']){await mkdir(join(regressionRoot,directory,'skills'),{recursive:true});await symlink('../../skills/wiek-browser',join(regressionRoot,directory,'skills/wiek-browser'),'dir');}
 async function normalize(directory){for(const item of await readdir(directory,{withFileTypes:true})){
  if(item.name==='node_modules')continue;const file=join(directory,item.name);
  if(item.isDirectory())await normalize(file);
  else if(item.isFile()&&/\.(?:mjs|js|ts|json|md|sh|ya?ml)$/.test(item.name)){
   const bytes=await readFile(file),text=bytes.toString('utf8');if(!bytes.includes(0))await writeFile(file,migrateNamespace(text));
  }
  const renamed=migrateNamespace(item.name);if(renamed!==item.name){const{rename}=await import('node:fs/promises');await rename(file,join(directory,renamed));}
 }}
 await normalize(regressionSdk);
 const fixtures=join(root,'tests/fixtures/upstream-workflows');
 const workflowManifest=JSON.parse(await readFile(join(fixtures,'manifest.json'),'utf8'));
 await mkdir(join(regressionRoot,'.github/workflows'),{recursive:true});
 for(const item of workflowManifest.files){const bytes=await readFile(join(fixtures,item.name+'.fixture'));if(sha(bytes)!==item.sha256)throw Error('Original workflow input changed');await writeFile(join(regressionRoot,'.github/workflows',item.name),migrateNamespace(bytes.toString('utf8')));}
 const receipt={schemaVersion:1,generatedAt:new Date().toISOString(),originalInputs:records.length,allOriginalInputsUnchanged:true,namespaceMappingOnly:true,assertionsRemoved:0,casesRemoved:0,thresholdsChanged:0,transformSha256:sha(await readFile(new URL('./sdk-test-namespace.mjs',import.meta.url))),records};
 await writeFile(join(root,'reports/sdk-test-lineage.json'),JSON.stringify(receipt,null,2)+'\n');
 return regressionSdk;
}
async function tests(directory){const out=[];for(const entry of await readdir(directory,{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isDirectory())out.push(...await tests(file));else if(entry.name.endsWith('.test.mjs'))out.push(file);}return out.sort();}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 await prepareRegression();
 if(!process.argv.includes('--prepare-only')){
  const browser=process.argv.includes('--browser');
  const args=browser?[join(regressionSdk,'scripts/run-real-browser-e2e.mjs')]:['--test','--test-concurrency=1',...await tests(join(regressionSdk,'src'))];
  const child=spawn(process.execPath,args,{cwd:regressionSdk,env:process.env,stdio:'inherit'});
  process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
 }
}

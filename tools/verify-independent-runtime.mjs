#!/usr/bin/env node
import {readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const sourceRoot=fileURLToPath(new URL('..',import.meta.url));
const original=/\bego\b|Ego(?=[A-Z])|(?<![A-Za-z0-9])EGO_|ego\.app|citrolabs\//g;
export async function verifyIndependentRuntime(root=sourceRoot){
 const files=[],violations=[];
 async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
  const file=join(directory,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())files.push(file);
 }}
 const scannedDirectories=['app','cli','skills','packages/sdk/dist','packages/sdk/skill-body'];
 for(const directory of ['packages/sdk/src','packages/sdk/scripts']){
  try{await lstat(join(root,directory));scannedDirectories.push(directory);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 for(const directory of scannedDirectories)await walk(join(root,directory));
 for(const file of ['packages/sdk/package.json','packages/sdk/package-lock.json']){
  try{await lstat(join(root,file));files.push(join(root,file));}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 files.push(join(root,'package.json'));let textFiles=0;
 for(const file of files){
  const relativePath=relative(root,file);original.lastIndex=0;
  if(original.test(relativePath))violations.push({file:relativePath,kind:'path'});
  const bytes=await readFile(file);if(bytes.includes(0))continue;
  let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{continue;}
  textFiles++;original.lastIndex=0;const match=original.exec(content);
  if(match)violations.push({file:relativePath,kind:'content',line:content.slice(0,match.index).split('\n').length});
 }
 const metadata=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 const result={passed:violations.length===0,version:metadata.version,filesChecked:files.length,textFilesChecked:textFiles,scannedDirectories,violations,scope:'All owned runtime, SDK build output, available SDK sources, product Skills and package configuration. Original test inputs and legal notices are outside runtime scope.'};
 if(!result.passed)throw Object.assign(Error('Independent runtime check failed'),{result});
 return result;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const result=await verifyIndependentRuntime(process.argv[2]?resolve(process.argv[2]):sourceRoot);await writeFile(join(sourceRoot,'reports/independent-runtime-audit.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));}
 catch(error){console.error(JSON.stringify(error.result||{error:error.message},null,2));process.exitCode=1;}
}

#!/usr/bin/env node
// Explicit offline handshake probe. Never sends a user message or inherits auth.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
const {claudeLaunch}=createRequire(import.meta.url)('../app/claude-session.cjs');
const file=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]||'reports/v100-claude-model-readiness.json');
const directory=await fs.mkdtemp(path.resolve('data/claude-readiness-'));
await fs.mkdir(path.join(directory,'home'));await fs.mkdir(path.join(directory,'config'));
const env={PATH:process.env.PATH,HOME:path.join(directory,'home'),TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',CLAUDE_CONFIG_DIR:path.join(directory,'config'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
const command=file.endsWith('.js')?process.execPath:file,prefix=file.endsWith('.js')?[file]:[];
const version=spawnSync(command,[...prefix,'--version'],{env,cwd:directory,encoding:'utf8',timeout:15000,maxBuffer:65536});
const report={generatedAt:new Date().toISOString(),cli:file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),version:version.stdout?.trim(),versionExit:version.status,isolatedHome:true,inheritedAuthentication:false,userMessagesSent:0,modelCalls:0,initialize:false,notes:'Initialize model metadata only: no prompt, authentication or inference tested. Names/descriptions may be bundled or cached for this exact CLI version; no entitlement or current pricing verification.'};
if(version.status===0){
 const launch=claudeLaunch({args:prefix,attachments:[]});
 const child=spawn(command,launch.args,{env,cwd:directory,detached:true,stdio:['pipe','pipe','pipe']});
 const requestId=randomUUID();let buffer='',stderr='',stopping=false;
 const kill=signal=>{try{process.kill(-child.pid,signal)}catch{}};
 const timer=setTimeout(()=>{report.error='Initialize timed out';kill('SIGKILL')},20000);
 child.stdout.on('data',chunk=>{
  buffer+=chunk.toString('utf8');if(buffer.length>4*1024*1024){report.error='Frame limit exceeded';kill('SIGKILL');return;}
  let newline;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);try{
   const value=JSON.parse(line);if(value.type==='control_response'&&value.response?.request_id===requestId){
    report.initialize=value.response.subtype==='success';report.responseKeys=Object.keys(value.response.response||{});report.models=(value.response.response?.models||[]).slice(0,256).map(m=>Object.fromEntries(['value','resolvedModel','displayName','description','supportsEffort','supportedEffortLevels','supportsAdaptiveThinking'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]])));if(!report.initialize)report.error=String(value.response.error||'Control error').slice(0,2048);
    stopping=true;child.stdin.end();setTimeout(()=>kill('SIGTERM'),500).unref();setTimeout(()=>kill('SIGKILL'),1500).unref();
   }
  }catch{report.error='Invalid JSON'} }
 });
 child.stderr.on('data',chunk=>{if(stderr.length<4096)stderr+=chunk.toString('utf8').slice(0,4096-stderr.length)});
 child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify({type:'control_request',request_id:requestId,request:{subtype:'initialize',hooks:null,forwardSubagentText:true}})+'\n');
 await new Promise(resolve=>{child.once('error',e=>{report.error=e.message;resolve()});child.once('close',(code,signal)=>{report.exitCode=code;report.signal=signal;resolve()})});clearTimeout(timer);
 if(!report.initialize&&!report.error)report.error=stderr||'Exited without initialize response';report.stoppedAfterHandshake=stopping;
}
await fs.writeFile(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
if(!report.initialize)process.exitCode=1;

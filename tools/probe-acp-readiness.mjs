#!/usr/bin/env node
// Official binary readiness only. A clean environment, no prompt or auth.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const {connectAcp}=createRequire(import.meta.url)('../app/acp-session.cjs');
const file=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]||'reports/opencode-readiness.json');
const directory=await fs.mkdtemp(path.resolve('data/acp-readiness-'));
for(const name of ['home','config','data','cache','state','project'])await fs.mkdir(path.join(directory,name));
const env={PATH:process.env.PATH,HOME:path.join(directory,'home'),TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',XDG_CONFIG_HOME:path.join(directory,'config'),XDG_DATA_HOME:path.join(directory,'data'),XDG_CACHE_HOME:path.join(directory,'cache'),XDG_STATE_HOME:path.join(directory,'state'),OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_DEFAULT_PLUGINS:'1',OPENCODE_PURE:'1',OPENCODE_DISABLE_EXTERNAL_SKILLS:'1',OPENCODE_DISABLE_CLAUDE_CODE_SKILLS:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_CONFIG_CONTENT:JSON.stringify({plugin:[],mcp:{},autoupdate:false})};
const version=spawnSync(file,['--version'],{env,cwd:path.join(directory,'project'),encoding:'utf8',timeout:15000,maxBuffer:65536});
const report={generatedAt:new Date().toISOString(),cli:file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),version:version.stdout?.trim(),versionExit:version.status,isolatedHome:true,inheritedAuthentication:false,userMessagesSent:0,modelCalls:0,sessionNew:false,notes:'No prompt, authentication or inference tested. Discovered models do not prove authentication or availability.'};
if(version.status===0){
 const child=spawn(file,['acp'],{env,cwd:path.join(directory,'project'),detached:true,stdio:['pipe','pipe','pipe']}),active={},run={},thread={};let stderr='';
 const killTree=(proc,signal)=>{try{process.kill(-proc.pid,signal)}catch{}};
 connectAcp({child,active,run,thread,project:{path:path.join(directory,'project')},discoverOnly:true,consume:()=>{},publish:()=>{},killTree,onSession:()=>{report.sessionNew=true}});
 child.stdin.on('error',()=>{});child.stderr.on('data',chunk=>{if(stderr.length<4096)stderr+=chunk.toString('utf8').slice(0,4096-stderr.length)});
 const timer=setTimeout(()=>{run.error='Overall readiness deadline exceeded';killTree(child,'SIGKILL')},50000);
 await new Promise(resolve=>{child.once('error',e=>{run.error=e.message;resolve()});child.once('close',(code,signal)=>{report.exitCode=code;report.signal=signal;resolve()})});clearTimeout(timer);
 report.discoveryCompleted=active.native?.completed===true;report.modelCount=thread.nativeCatalog?.models.length||0;report.modelSelector=thread.nativeCatalog?.modelConfigId||null;
 if(!report.discoveryCompleted)report.error=run.error||stderr||'Exited without completing discovery';
}
await fs.writeFile(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(!report.discoveryCompleted)process.exitCode=1;

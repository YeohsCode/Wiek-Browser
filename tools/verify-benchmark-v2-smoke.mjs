#!/usr/bin/env node
// Local fixtures only: no model, judge, real website or account actions.
import {createBenchmarkV2} from './benchmark-sdk-v2-contract.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const sdk=join(root,'packages/sdk/dist/out/index.js');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=await readFile(new URL('./benchmark-sdk-v2-contract.mjs',import.meta.url),'utf8');
const factory=`const control=(${createBenchmarkV2.toString()})({listTaskSpaces,taskSpace});\n`;
const fixture='<!doctype html><meta charset="utf-8"><title>Shared SDK V2 fixture</title><h1>Canonical benchmark fixture</h1><button>Local fixture button</button>';
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fixture);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const option=process.argv.slice(2);if(option.length!==2||option[0]!=='--browser'||!['wiek','ego','both'].includes(option[1])){server.close();throw new Error('Use --browser wiek|ego|both');}
const wiekData=join(root,'data/benchmark-v2-smoke',randomUUID());
const targets=option[1]==='both'?['ego','wiek']:[option[1]];
const report={generatedAt:new Date().toISOString(),onlineBenchmark:false,modelCalls:0,accountActions:0,sdkSha256:sha(await readFile(sdk)),controlSha256:sha(source),fixtureSha256:sha(fixture),runs:[]};
function execute(browser,code){return new Promise((resolve,reject)=>{
  const marker=randomUUID();
  const program=`const __benchmarkRun=async()=>{${code}\n};const result=await __benchmarkRun();console.log(JSON.stringify({benchmarkSmoke:${JSON.stringify(marker)},result}));`;
  const cli=browser==='ego'?[process.env.WIEK_BENCH_EGO_CLI||join(root,'tools/ego-reference-cli'),...(process.env.WIEK_BENCH_EGO_CLI?['--ego-server-name=vek-reference']:[])]:[process.execPath,join(root,'cli/wiek-browser.mjs')];
  const env={...process.env};if(browser==='wiek'){env.WIEK_DATA_DIR=wiekData;env.VEK_DATA_DIR=env.WIEK_DATA_DIR;}
  const child=spawn(cli[0],[...cli.slice(1),'nodejs','--sdk-path',sdk,'-e',program],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',overflow=false,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},45000);
  for(const [stream,kind] of [[child.stdout,'out'],[child.stderr,'err']])stream.on('data',chunk=>{if(kind==='out')stdout+=chunk;else stderr+=chunk;if(stdout.length+stderr.length>2*1024*1024){overflow=true;child.kill('SIGKILL');}});
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);let payload;for(const line of [...stdout.split(/\r?\n/),...stderr.split(/\r?\n/)]){try{const parsed=JSON.parse(line);if(parsed.benchmarkSmoke===marker)payload=parsed.result;}catch{}}
    if(timedOut||overflow||code!==0||payload===undefined)reject(new Error(`SDK smoke failed (exit=${code}, timeout=${timedOut}, overflow=${overflow}): ${stderr.slice(-1500)}`));else resolve(payload);
  });
});}
try{
  for(const browser of targets){
    const name=`benchmark-v2-local-${randomUUID()}`;let createdId,cleanupNeeded=false;
    const cliPath=browser==='ego'?(process.env.WIEK_BENCH_EGO_CLI||join(root,'tools/ego-reference-cli')):join(root,'cli/wiek-browser.mjs');
    const run={browser,cli:cliPath,taskName:name,passed:false,checks:[]};report.runs.push(run);
    try{
      run.cliSha256=sha(await readFile(cliPath));
      const probe=await execute(browser,`const fs=await import('node:fs');const crypto=await import('node:crypto');return {canonical:typeof taskSpace==='function'&&typeof listTaskSpaces==='function',globalCanonical:typeof globalThis.taskSpace==='function',runtimeSdkSha256:crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(sdk)})).digest('hex'),hostVersion:await globalThis.ego.getBrowserVersion()};`);
      if(probe.runtimeSdkSha256!==report.sdkSha256)throw new Error('Runtime SDK identity mismatch');
      if(!probe.canonical)throw new Error('Canonical lexical SDK helpers unavailable');run.checks.push({probe});
      cleanupNeeded=true;const created=await execute(browser,`const task=await taskSpace(${JSON.stringify(name)});await task.page('p1').goto(${JSON.stringify(url)});return {spaceId:task.id};`);
      createdId=created.spaceId;if(!Number.isSafeInteger(createdId))throw new Error('Missing created task id');run.checks.push({created});
      const capture=await execute(browser,factory+`return await control.capture([${JSON.stringify(name)}],{format:'png'});`);
      const png=Buffer.from(capture.data,'base64');if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid PNG');
      if(!Array.isArray(capture.ax?.nodes)||!capture.ax.nodes.some(node=>node.name?.value==='Canonical benchmark fixture'))throw new Error('Fixture AX content missing');
      await mkdir(join(root,'reports/benchmark-v2'),{recursive:true});await writeFile(join(root,'reports/benchmark-v2',`${browser}.png`),png);
      run.checks.push({capture:{spaceId:capture.spaceId,pngBytes:png.length,pngSha256:sha(png),axNodes:capture.ax.nodes.length}});
      const closed=await execute(browser,factory+`return await control.close([${createdId}]);`);run.checks.push({closed});if(!closed[0]?.ok)throw new Error('Canonical task cleanup incomplete');
      createdId=undefined;cleanupNeeded=false;
      const missing=await execute(browser,factory+`const before=(await listTaskSpaces()).length;const rows=await control.close([${JSON.stringify(name)}]);const after=(await listTaskSpaces()).length;return {rows,before,after};`);
      if(!missing.rows[0]?.notFound||missing.before!==missing.after)throw new Error('Missing-space cleanup created or mutated a task');run.checks.push({missing});run.passed=true;
    }catch(error){run.error=String(error.message||error);}
    finally{if(cleanupNeeded){try{run.cleanup=await execute(browser,factory+`return await control.close([${JSON.stringify(createdId??name)}]);`);}catch(error){run.cleanupError=String(error.message||error);}}}
  }
}finally{
  if(targets.includes('wiek'))await new Promise(resolve=>{const child=spawn(process.execPath,[join(root,'cli/wiek-browser.mjs'),'stop'],{cwd:root,env:{...process.env,WIEK_DATA_DIR:wiekData,VEK_DATA_DIR:wiekData},stdio:'ignore'});child.once('error',resolve);child.once('close',resolve);});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  report.passed=report.runs.length===targets.length&&report.runs.every(run=>run.passed);
  await writeFile(join(root,'reports/p4-sdk-v2-local-smoke.json'),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;

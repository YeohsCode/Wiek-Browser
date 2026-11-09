#!/usr/bin/env node
import {readFile,writeFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url)),framework=join(root,'benchmark/framework');
const bytes=await readFile(join(framework,'data/real_world_bench.json')),tasks=JSON.parse(bytes),expected=JSON.parse(await readFile(join(root,'analysis/real-world-bench-task-manifest.json'),'utf8'));
const same=JSON.stringify(tasks.map(x=>x.task_id))===JSON.stringify(expected.map(x=>x.task_id));
if(!same)throw Error('Ordered task identities changed');
const result={generatedAt:new Date().toISOString(),repositoryOwned:true,benchmarkRun:false,modelCalls:0,accountActions:0,tasks:{count:tasks.length,sameOrderedIds:true,datasetSha256:createHash('sha256').update(bytes).digest('hex')},sdkSha256:createHash('sha256').update(await readFile(join(root,'packages/sdk/dist/out/index.js'))).digest('hex'),requirements:['Dedicated Stage A and Judge models with explicit limits','Dedicated account/login state','Explicit evaluation launch'],runtimeDependency:'Wiek Browser only'};
await writeFile(join(root,'reports/p4-benchmark-readiness.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));

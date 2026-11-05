#!/usr/bin/env node
// Static readiness audit only: never starts a browser, model, judge, or account task.
import{readFile,writeFile,access}from'node:fs/promises';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';import{resolve,join}from'node:path';import{fileURLToPath}from'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),reference=resolve(process.env.WIEK_BENCHMARK_ROOT||join(root,'references/ego-browser-benchmark-framework')),manifest=JSON.parse(await readFile(join(root,'analysis/real-world-bench-task-manifest.json'),'utf8'));
const exists=file=>access(file).then(()=>true,()=>false),sha=value=>createHash('sha256').update(value).digest('hex');
const datasetPath=join(reference,'data/real_world_bench.json'),present=await exists(datasetPath);let dataset=null,commit=null,adapter=null;
if(present){dataset=JSON.parse(await readFile(datasetPath,'utf8'));try{commit=execFileSync('git',['-C',reference,'rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{}adapter=await readFile(join(reference,'ego_bench/browser_tools/ego_browser.py'),'utf8').catch(()=>null);}
const taskIds=manifest.map(row=>row.task_id),actual=dataset?.map(row=>row.task_id),sameTasks=actual?JSON.stringify(taskIds)===JSON.stringify(actual):false;
const attachments=[...new Set(manifest.flatMap(row=>row.attachments))],attachmentStatus=[];for(const name of attachments)attachmentStatus.push({name,present:await exists(join(reference,'data/attachments',name))});
const report={generatedAt:new Date().toISOString(),benchmarkRun:false,modelCalls:0,accountActions:0,reference:{present,commit,datasetSha256:present?sha(await readFile(datasetPath)):null,adapterSha256:adapter?sha(adapter):null},tasks:{count:manifest.length,unique:new Set(taskIds).size,sameOrderedIds:sameTasks,requiresLogin:manifest.filter(row=>row.requires_login).length,loginPlatforms:[...new Set(manifest.flatMap(row=>row.login_platforms))].sort(),attachments:attachmentStatus},adapter:{canonicalSdkV2Present:adapter?adapter.includes('typeof globalThis.taskSpace ==='):false,legacyOrFacadeProbePresent:adapter?adapter.includes('LEGACY_FLAT_V1')&&adapter.includes('TASKSPACES_FACADE_V1'):false},blockers:[]};
const controlPath=join(root,'tools/benchmark-sdk-v2-contract.mjs');
report.adapter.sharedCanonicalControlPresent=await exists(controlPath);
const overlay=join(root,'benchmark/sdk-v2'),overlayManifest=JSON.parse(await readFile(join(overlay,'manifest.json'),'utf8'));
report.adapter.canonicalSdkV2Present=adapter?/typeof\s+taskSpace\s*===/.test(adapter)&&adapter.includes('CANONICAL_V2'):false;
const installed=[];
for(const [name,identity] of Object.entries(overlayManifest.files))installed.push({file:name,matches:await exists(join(reference,name))&&sha(await readFile(join(reference,name)))===identity.patchedSha256});
for(const [name,source] of [['canonical_v2.py',join(overlay,'canonical_v2.py')],['_canonical_guard.mjs',join(overlay,'canonical_guard.mjs')],['_canonical_control.mjs',controlPath]])installed.push({file:name,matches:await exists(join(reference,'ego_bench/browser_tools',name))&&sha(await readFile(join(reference,'ego_bench/browser_tools',name)))===sha(await readFile(source))});
report.adapter.installedIdentities=installed;
report.adapter.stageAIntegrated=commit===overlayManifest.referenceCommit&&report.adapter.canonicalSdkV2Present&&installed.every(row=>row.matches);
const frameworkSmokePath=join(root,'reports/p4-sdk-v2-framework-smoke.json');
if(await exists(frameworkSmokePath)){
 const smoke=JSON.parse(await readFile(frameworkSmokePath,'utf8'));
 const identities=smoke.adapter?.overlayFiles||{};
 const sdkMatches=smoke.sdkSha256===sha(await readFile(join(root,'packages/sdk/dist/out/index.js')));
 const sourceMatches=smoke.adapter?.patchSha256===sha(await readFile(join(overlay,'adapter.patch')))&&identities['canonical_v2.py']===sha(await readFile(join(overlay,'canonical_v2.py')))&&identities['_canonical_guard.mjs']===sha(await readFile(join(overlay,'canonical_guard.mjs')))&&identities['_canonical_control.mjs']===sha(await readFile(controlPath));
 report.adapter.frameworkSmoke={passed:smoke.passed===true&&sdkMatches&&sourceMatches,sdkMatches,sourceMatches,onlineBenchmark:false,runs:smoke.runs.map(row=>({browser:row.browser,passed:row.passed,hostVersion:row.hostVersion?.currentVersion||null})),report:'p4-sdk-v2-framework-smoke.json'};
}
const smokePath=join(root,'reports/p4-sdk-v2-local-smoke.json');
if(await exists(smokePath)){
 const smoke=JSON.parse(await readFile(smokePath,'utf8'));
 const currentHash=report.adapter.sharedCanonicalControlPresent?sha(await readFile(controlPath)):null;
 const sdkPath=join(root,'packages/sdk/dist/out/index.js');const sdkMatches=await exists(sdkPath)&&smoke.sdkSha256===sha(await readFile(sdkPath));
 report.adapter.localCanonicalSmoke={passed:smoke.passed===true&&smoke.controlSha256===currentHash&&sdkMatches,sdkMatches,controlMatches:smoke.controlSha256===currentHash,onlineBenchmark:false,runs:smoke.runs.map(row=>({browser:row.browser,passed:row.passed,hostVersion:row.checks.find(check=>check.probe)?.probe.hostVersion?.currentVersion||null})),report:'p4-sdk-v2-local-smoke.json'};
}
if(!present)report.blockers.push('Pinned benchmark checkout not present');if(!sameTasks)report.blockers.push('Benchmark task IDs differ from the recorded ordered manifest');if(attachmentStatus.some(row=>!row.present))report.blockers.push('Required attachment missing');if(!report.adapter.stageAIntegrated)report.blockers.push('Canonical SDK V2 framework overlay is absent or its identities differ');if(!report.adapter.frameworkSmoke?.passed)report.blockers.push('Current full framework local smoke has not passed with matching source/SDK identities');report.blockers.push('No dedicated Stage A/Judge model and thinking/limits configuration has been approved for a paid run','Dedicated test-account/login readiness is not recorded; personal browsing sessions are not benchmark fixtures','Equivalent pinned SDK, task, model, limits, account state and adapter behavior must be recorded for both browsers');
await writeFile(join(root,'reports/p4-benchmark-readiness.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));

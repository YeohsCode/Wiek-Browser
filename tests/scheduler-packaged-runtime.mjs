// Explicit packaged runtime QA. All OS job operations are fixture callbacks.
// Executes the reviewed bootstrap against an empty, disposable profile only.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,realpath} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';

if(process.platform!=='darwin'||!process.argv[2]||!process.argv[3]||!isAbsolute(process.argv[2])||!isAbsolute(process.argv[3]))throw Error('Pass absolute packaged application root and executable paths on macOS');
const root=await realpath(process.argv[2]),executable=await realpath(process.argv[3]),require=createRequire(import.meta.url);
const {createSchedulerJob}=require(join(root,'app/scheduler-job.cjs'));
await mkdir(resolve('data'),{recursive:true});
const base=await mkdtemp(resolve('data/wiek-packaged-job-')),dataDir=join(base,'资料 & fixture'),jobs=join(base,'temporary 登录 jobs');
const calls=[];let loaded=false,job;
const launchctl=async args=>{calls.push(args[0]);if(args[0]==='print')return loaded?{code:0}:{code:113,absent:true};if(args[0]==='bootstrap'){loaded=true;return{code:0};}if(args[0]==='bootout'){loaded=false;return{code:0};}throw Error('Unexpected fixture OS call');};
try{
  job=createSchedulerJob({dataDir,root,executable,launchAgentsDir:jobs,launchctl});
  const review=await job.dispatch('scheduler:job:prepare',{}, {interactive:true});
  const state=await job.dispatch('scheduler:job:enable',{token:review.plan.token},{interactive:true});
  assert.equal(state.enabled,true);assert.equal(state.loaded,true);
  await promisify(execFile)(executable,[state.bootstrap],{env:{PATH:process.env.PATH||'/usr/bin:/bin',ELECTRON_RUN_AS_NODE:'1'},timeout:20000,maxBuffer:65536});
  const last=JSON.parse(await readFile(join(dataDir,'scheduler/last-job.json'),'utf8'));
  assert.equal(last.status,'completed');assert.equal(last.attempted,0);assert.equal(last.skipped,0);
  await job.dispatch('scheduler:job:remove',{}, {interactive:true});
  assert.equal(job.snapshot().enabled,false);assert.equal(job.snapshot().installed,false);assert.equal(job.snapshot().configured,false);
  const result={passed:true,version:review.plan.version,nodeVersion:review.plan.nodeVersion,exactReviewedArgvExecuted:true,emptyFixtureTickCompleted:true,attempted:0,jobCleanupConfirmed:true,osJobOperations:'fixture-only',realOSRegistration:false,physicalSleepWakeTested:false,modelCalls:0,accountActions:0};
  console.log(JSON.stringify(result,null,2));
}finally{
  if(job){try{await job.dispatch('scheduler:job:remove',{}, {interactive:true});}finally{await job.close();}}
  await rm(base,{recursive:true,force:true});
}

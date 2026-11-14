import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,symlink,rename,rm,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),sourceRoot=resolve(import.meta.dirname,'..');
const {createSchedulerJob}=require('../app/scheduler-job.cjs'),{launch}=require('../app/scheduler-launch.cjs');
const trusted={interactive:true};

async function fixture(t,{aliases=false,worker}={}){
  const temporary=await mkdtemp(join(tmpdir(),'wiek-job-layout-')),base=await realpath(temporary);
  const root=join(base,'应用 & <review>.app','Contents','Resources','app'),data=join(base,'资料 & <profile>'),jobs=join(base,'登录 & <jobs>');
  await mkdir(join(root,'app'),{recursive:true});await mkdir(data);
  await writeFile(join(root,'package.json'),JSON.stringify({version:'layout-fixture'}));
  await copyFile(join(sourceRoot,'app/scheduler-launch.cjs'),join(root,'app/scheduler-launch.cjs'));
  await writeFile(join(root,'app/scheduler-worker.cjs'),worker||"exports.runSchedulerTick=async()=>({status:'completed',attempted:[],skipped:[]});");
  let runtime=root,directory=data,executable=process.execPath,loaded=false;const calls=[];
  if(aliases){runtime=join(base,'应用入口');directory=join(base,'资料入口');executable=join(base,'node 入口');await symlink(root,runtime,'dir');await symlink(data,directory,'dir');await symlink(process.execPath,executable);}
  const launchctl=async args=>{calls.push(args);if(args[0]==='print')return loaded?{code:0}:{code:113,absent:true};if(args[0]==='bootstrap'){loaded=true;return{code:0};}if(args[0]==='bootout'){loaded=false;return{code:0};}throw Error('Unexpected fixture OS command');};
  const options={dataDir:directory,root:runtime,executable,launchAgentsDir:jobs,uid:501,platform:'darwin',launchctl};
  const job=createSchedulerJob(options),act=(name,payload={})=>job.dispatch('scheduler:job:'+name,payload,trusted);
  t.after(async()=>{await job.close();await rm(base,{recursive:true,force:true});});
  return {base,root,data,jobs,runtime,executable,job,act,options,calls,async enable(){const state=await act('prepare');return act('enable',{token:state.plan.token});}};
}

test('packaged layouts with Unicode, spaces and XML characters preserve literal reviewed paths',async t=>{
  const f=await fixture(t,{aliases:true}),state=await f.enable();
  assert.equal(state.runtime.root,f.root);assert.equal(state.runtime.executable,await realpath(process.execPath));
  assert.equal(state.bootstrap,join(f.data,'scheduler/launch.cjs'));
  const body=await readFile(state.plist,'utf8');assert.match(body,/&amp;/);assert.match(body,/&lt;/);
  if(process.platform==='darwin'){
    const plist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',state.plist],{encoding:'utf8'}));
    assert.deepEqual(plist.ProgramArguments,[await realpath(process.execPath),state.bootstrap]);
  }
  assert.deepEqual(f.calls.find(args=>args[0]==='bootstrap'),['bootstrap','gui/501',state.plist]);
  assert.equal((await launch(join(f.data,'scheduler'))).status,'completed');
});
test('canonical data aliases share one job identity and never install a second job on reopen',async t=>{
  const f=await fixture(t,{aliases:true}),state=await f.enable(),calls=f.calls.length;
  const reopened=createSchedulerJob({...f.options,dataDir:f.data,root:f.root,executable:process.execPath});
  try{
    assert.equal(reopened.snapshot().label,state.label);assert.equal(reopened.snapshot().plist,state.plist);
    assert.equal(reopened.snapshot().enabled,true);assert.equal(f.calls.length,calls);
    await assert.rejects(reopened.dispatch('scheduler:job:prepare',{},trusted),/Disable the current/);
    assert.equal(f.calls.length,calls);
  }finally{await reopened.close();}
});
test('retargeting an installation alias never changes the canonical runtime accepted by the review',async t=>{
  const f=await fixture(t,{aliases:true}),review=await f.act('prepare'),other=join(f.base,'other app');await mkdir(other);
  await rm(f.runtime);await symlink(other,f.runtime,'dir');
  const unreviewed=join(f.base,'unreviewed runtime');await writeFile(unreviewed,'must not run');await rm(f.executable);await symlink(unreviewed,f.executable);
  const state=await f.act('enable',{token:review.plan.token});assert.equal(state.runtime.root,f.root);
  assert.equal(state.runtime.executable,await realpath(process.execPath));
  assert.equal((await launch(join(f.data,'scheduler'))).status,'completed');
});
test('a moved profile never inherits installation authority at a new canonical destination',async t=>{
  const f=await fixture(t);await f.enable();const moved=join(f.base,'moved 资料');await rename(f.data,moved);
  const before=f.calls.length,reopened=createSchedulerJob({...f.options,dataDir:moved});
  try{
    const state=reopened.snapshot();assert.equal(state.enabled,false);assert.equal(state.installed,null);
    assert.match(state.error,/identity does not match/);
    await assert.rejects(reopened.dispatch('scheduler:job:prepare',{},trusted),/identity does not match/);
    assert.equal(f.calls.length,before);
  }finally{await reopened.close();}
});
test('moving a reviewed runtime fails closed and requires a fresh explicit review',async t=>{
  const f=await fixture(t);await f.enable();const moved=join(f.base,'moved 应用.app');await rename(f.root,moved);
  const result=await launch(join(f.data,'scheduler'));assert.equal(result.status,'needs-review');
  const calls=f.calls.length,reopened=createSchedulerJob({...f.options,root:moved});
  try{
    assert.equal(f.calls.length,calls);assert.equal(reopened.snapshot().runtime.root,f.root);
    await assert.rejects(reopened.dispatch('scheduler:job:prepare',{},trusted),/Disable the current/);
    await reopened.dispatch('scheduler:job:disable',{},trusted);
    const review=await reopened.dispatch('scheduler:job:prepare',{},trusted);
    assert.equal(review.plan.root,moved);
    await reopened.dispatch('scheduler:job:enable',{token:review.plan.token},trusted);
    assert.equal((await launch(join(f.data,'scheduler'))).status,'completed');
  }finally{await reopened.close();}
});
test('symlinked runtime code cannot be omitted from the reviewed runtime receipt',async t=>{
  const f=await fixture(t),outside=join(f.base,'outside fixture.cjs');await writeFile(outside,"throw Error('must not execute');");
  await symlink(outside,join(f.root,'app/dynamic.cjs'));
  await assert.rejects(f.act('prepare'),/canonical regular file/);
  assert.deepEqual(f.calls,[]);assert.equal(existsSync(f.jobs),false);
});
test('a code symlink added after enable stops the launcher before any unreviewed module can run',async t=>{
  const f=await fixture(t,{worker:"exports.runSchedulerTick=async()=>{if(require('node:fs').existsSync(require('node:path').join(__dirname,'dynamic.cjs')))require('./dynamic.cjs');return {status:'completed',attempted:[],skipped:[]};};"});
  await f.enable();const marker=join(f.base,'must-not-execute'),outside=join(f.base,'outside fixture.cjs');
  await writeFile(outside,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`);
  await symlink(outside,join(f.root,'app/dynamic.cjs'));
  assert.equal((await launch(join(f.data,'scheduler'))).status,'needs-review');assert.equal(existsSync(marker),false);
});
test('symlinked package metadata is rejected during review before login setup is written',async t=>{
  const f=await fixture(t),outside=join(f.base,'metadata.json');await rename(join(f.root,'package.json'),outside);await symlink(outside,join(f.root,'package.json'));
  await assert.rejects(f.act('prepare'),/canonical regular file/);assert.deepEqual(f.calls,[]);
});

test('an atomic app replacement at the original path requires a fresh review', async t => {
  const f = await fixture(t);
  await f.enable();
  const previous = join(f.base, 'previous release');
  await rename(f.root, previous);
  await mkdir(join(f.root, 'app'), { recursive: true });
  await copyFile(join(previous, 'package.json'), join(f.root, 'package.json'));
  await copyFile(join(previous, 'app/scheduler-launch.cjs'), join(f.root, 'app/scheduler-launch.cjs'));
  const marker = join(f.base, 'replacement-ran');
  await writeFile(join(f.root, 'app/scheduler-worker.cjs'), `
    exports.runSchedulerTick = async () => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'reviewed');
      return {status:'completed', attempted:[], skipped:[]};
    };`);
  assert.equal((await launch(join(f.data, 'scheduler'))).status, 'needs-review');
  assert.equal(existsSync(marker), false);
  await f.act('disable');
  await f.enable();
  assert.equal((await launch(join(f.data, 'scheduler'))).status, 'completed');
  assert.equal(await readFile(marker, 'utf8'), 'reviewed');
});

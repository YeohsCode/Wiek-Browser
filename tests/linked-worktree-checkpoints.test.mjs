import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import workspace from '../app/workspace-service.cjs';
import layout from '../app/repository-layout.cjs';
import turns from '../app/turn-checkpoints.cjs';
const exec=promisify(execFile);

async function fixture(t){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'wiek-linked-')),main=path.join(base,'main'),linked=path.join(base,'linked');
  await fs.mkdir(main);
  const git=async(root,...args)=>(await exec('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',root,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}})).stdout;
  await git(main,'init','-q');await git(main,'config','user.name','Fixture');await git(main,'config','user.email','fixture@localhost');await fs.writeFile(path.join(main,'file.txt'),'base\n');await git(main,'add','.');await git(main,'commit','-qm','Base');await git(main,'worktree','add','-b','linked',linked);
  const projects=[{id:randomUUID(),path:main},{id:randomUUID(),path:linked}],service=workspace.createWorkspaceService({projects:()=>projects});
  const action=(root,op,payload={})=>service.dispatch('workspace:git:checkpoint:'+op,{projectId:projects.find(row=>row.path===root).id,...payload});
  t.after(async()=>{await service.close();await fs.rm(base,{recursive:true,force:true});});
  return {base,main,linked,git,projects,service,action,info:layout.repositoryLayout(linked)};
}

test('linked restore preserves staged and working bytes without changing the main worktree index or files',async t=>{
  const f=await fixture(t),file=path.join(f.linked,'file.txt');
  await fs.writeFile(path.join(f.main,'file.txt'),'main pending\n');await f.git(f.main,'add','file.txt');
  const mainIndex=await fs.readFile(path.join(f.main,'.git/index'));
  await fs.writeFile(file,'linked staged\n');await f.git(f.linked,'add','file.txt');await fs.writeFile(file,'linked working\n');
  await fs.writeFile(path.join(f.linked,'untracked.bin'),Buffer.from([0,255,1]));
  const index=await fs.readFile(path.join(f.info.gitDir,'index')),saved=await f.action(f.linked,'create',{name:'Linked state'});
  await fs.writeFile(file,'later\n');await f.git(f.linked,'add','file.txt');await fs.unlink(path.join(f.linked,'untracked.bin'));
  const preview=await f.action(f.linked,'preview',{id:saved.checkpoint.id});
  await f.action(f.linked,'restore',{id:saved.checkpoint.id,expectedState:preview.expectedState,confirm:true});
  assert.equal(await fs.readFile(file,'utf8'),'linked working\n');assert.equal(await f.git(f.linked,'show',':file.txt'),'linked staged\n');assert.deepEqual(await fs.readFile(path.join(f.info.gitDir,'index')),index);
  assert.deepEqual(await fs.readFile(path.join(f.linked,'untracked.bin')),Buffer.from([0,255,1]));
  assert.equal(await fs.readFile(path.join(f.main,'file.txt'),'utf8'),'main pending\n');assert.deepEqual(await fs.readFile(path.join(f.main,'.git/index')),mainIndex);
});

test('main and two linked worktrees cannot list or restore one another’s checkpoints',async t=>{
  const f=await fixture(t),other=path.join(f.base,'other');await f.git(f.main,'worktree','add','-b','other',other);f.projects.push({id:randomUUID(),path:other});
  const saved=[];
  for(const root of [f.main,f.linked,other])saved.push((await f.action(root,'create',{name:path.basename(root)})).checkpoint.id);
  for(const [i,root] of [f.main,f.linked,other].entries()){
    assert.deepEqual((await f.action(root,'list')).checkpoints.map(row=>row.id),[saved[i]]);
    await assert.rejects(f.action(root,'preview',{id:saved[(i+1)%3]}),/Git command failed/);
  }
});

test('each linked index lock is honored independently and existing locks are retained',async t=>{
  const f=await fixture(t),lock=path.join(f.info.gitDir,'index.lock');await fs.writeFile(lock,'another Git owner');
  await assert.rejects(f.action(f.linked,'create',{name:'Busy'}),/busy/);
  assert.equal(await fs.readFile(lock,'utf8'),'another Git owner');
  assert.ok((await f.action(f.main,'create',{name:'Main remains available'})).checkpoint.id);
});

test('mismatched backlink and symlinked metadata refuse checkpoint writes',async t=>{
  const f=await fixture(t),backlink=path.join(f.info.gitDir,'gitdir'),original=await fs.readFile(backlink);
  await fs.writeFile(backlink,path.join(f.base,'unrelated/.git'));
  await assert.rejects(f.action(f.linked,'create',{name:'Wrong owner'}),/backlink/);
  await fs.writeFile(backlink,original);
  const common=path.join(f.info.gitDir,'commondir'),contents=await fs.readFile(common),copy=path.join(f.base,'commondir-copy');
  await fs.writeFile(copy,contents);await fs.unlink(common);await fs.symlink(copy,common);
  await assert.rejects(f.action(f.linked,'create',{name:'Alias'}),/regular file/);
  await fs.unlink(common);await fs.writeFile(common,contents);
  assert.deepEqual((await f.action(f.linked,'list')).checkpoints,[]);
});

test('linked checkpoint refs survive Git gc and detached HEAD while remaining scoped',async t=>{
  const f=await fixture(t);await f.git(f.linked,'checkout','--detach');
  const saved=await f.action(f.linked,'create',{name:'Detached'});await f.git(f.main,'gc','--prune=now');
  assert.equal((await f.action(f.linked,'list')).checkpoints[0].id,saved.checkpoint.id);
  assert.deepEqual((await f.action(f.main,'list')).checkpoints,[]);
});

test('turn associations support linked snapshots and reject replacement of the .git identity',async t=>{
  const f=await fixture(t),project=f.projects[1],thread={id:randomUUID(),projectId:project.id},run={id:randomUUID(),status:'complete',executedAt:new Date().toISOString()};
  const coordinator=turns.createTurnCheckpoints({dataDir:path.join(f.base,'data'),workspace:f.service,projects:()=>f.projects});t.after(()=>coordinator.close());
  await coordinator.before({thread,project,run});await fs.writeFile(path.join(f.linked,'file.txt'),'provider result');
  const after=await coordinator.after({thread,run});assert.equal(after.status,'complete');
  const diff=await coordinator.dispatch('agents:changes:diff',{runId:run.id},thread);assert.match(diff.worktreeDiff,/provider result/);
  const pointer=path.join(f.linked,'.git'),contents=await fs.readFile(pointer);await fs.rename(pointer,pointer+'.old');await fs.writeFile(pointer,contents);
  await assert.rejects(coordinator.dispatch('agents:changes:preview',{runId:run.id},thread),/identity changed/);
});

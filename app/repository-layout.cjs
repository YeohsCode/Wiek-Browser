'use strict';
// Resolve only ordinary repositories or Git's reciprocal linked-worktree
// layout. Arbitrary .git indirection (submodules/separate-git-dir) stays refused.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const fail=message=>Object.assign(new Error(message),{error_code:'VEK_CHECKPOINT_UNSAFE'});
function directory(target){
  const stat=fs.lstatSync(target);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(target)!==target)throw fail('Git storage cannot use directory aliases');
  return stat;
}
function smallFile(target){
  const stat=fs.lstatSync(target);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw fail('Git worktree metadata must be a small regular file');
  return {stat,text:fs.readFileSync(target,'utf8').trim()};
}
function repositoryLayout(projectRoot){
  const root=fs.realpathSync(projectRoot),entry=path.join(root,'.git'),stat=fs.lstatSync(entry);
  if(stat.isDirectory()&&!stat.isSymbolicLink()){
    directory(entry);
    return {root,gitDir:entry,commonDir:entry,linked:false,identity:`${stat.dev}:${stat.ino}`,checkpointPrefix:'refs/vek/checkpoints/'};
  }
  const pointer=smallFile(entry),match=/^gitdir: (.+)$/.exec(pointer.text);
  if(!match||match[1].includes('\n')||match[1].includes('\0'))throw fail('Unsupported repository .git pointer');
  const gitDir=path.resolve(root,match[1]),gitStat=directory(gitDir);
  const common=smallFile(path.join(gitDir,'commondir')),commonDir=path.resolve(gitDir,common.text),commonStat=directory(commonDir);
  directory(path.join(commonDir,'worktrees'));
  if(path.dirname(gitDir)!==path.join(commonDir,'worktrees'))throw fail('Only reciprocal linked worktrees are supported');
  const backlink=smallFile(path.join(gitDir,'gitdir'));
  if(backlink.text.includes('\0')||path.resolve(gitDir,backlink.text)!==entry)throw fail('Linked worktree backlink does not match this project');
  const scope=crypto.createHash('sha256').update(gitDir).digest('hex').slice(0,32);
  return {root,gitDir,commonDir,linked:true,
    identity:`linked:${gitStat.dev}:${gitStat.ino}:${commonStat.dev}:${commonStat.ino}:${pointer.stat.dev}:${pointer.stat.ino}`,
    checkpointPrefix:`refs/vek/checkpoints/worktree-${scope}/`};
}
module.exports={repositoryLayout};

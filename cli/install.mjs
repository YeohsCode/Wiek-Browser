import {mkdir,lstat,symlink,rename,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
export async function installWiek({root,home=homedir(),now=Date.now}={}){
 if(!root)throw Error('Wiek installation root is required');root=await realpath(root);
 const backup=join(home,'.local/share/wiek/installation-backup',String(now()));
 const installed=[];
 async function link(target,file){
  await mkdir(join(file,'..'),{recursive:true});
  try{
   const st=await lstat(file);
   if(st.isSymbolicLink()&&await realpath(file).catch(()=>null)===await realpath(target))return;
   await mkdir(backup,{recursive:true});await rename(file,join(backup,installed.length+'-'+file.split('/').at(-1)));
  }catch(error){if(error.code!=='ENOENT')throw error;}
  await symlink(target,file);installed.push(file);
 }
 await link(join(root,'cli/wiek-browser.mjs'),join(home,'.local/bin/wiek-browser'));
 for(const directory of ['.agents','.codex','.claude'])await link(join(root,'skills/wiek-browser'),join(home,directory,'skills/wiek-browser'));
 return {installed:true,command:join(home,'.local/bin/wiek-browser'),skill:join(home,'.agents/skills/wiek-browser'),root,changedEntries:installed};
}

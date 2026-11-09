#!/usr/bin/env node
// One-time migration utility. Never shipped in the application.
import {mkdir,lstat,rename,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installWiek} from '../cli/install.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),home=homedir();
const registration=await installWiek({root:join(root,'dist/mac-arm64/Wiek Browser.app/Contents/Resources/app')});
const backup=join(home,'.local/share/wiek/migration-backup',String(Date.now()));
const moved=[];
for(const relative of ['.local/bin/ego-browser','.agents/skills/ego-browser','.codex/skills/ego-browser','.claude/skills/ego-browser']){
 const file=join(home,relative);
 try{await lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
 await mkdir(backup,{recursive:true});const destination=join(backup,relative.replaceAll('/','--'));
 await rename(file,destination);moved.push({entry:relative,backup:destination});
}
const result={completed:true,registration,moved,personalBrowserDataChanged:false};
await writeFile(join(root,'reports/system-entrypoint-migration.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));

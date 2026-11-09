import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readlink,mkdir,writeFile,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {installWiek} from '../cli/install.mjs';
import {verifyIndependentRuntime} from '../tools/verify-independent-runtime.mjs';
const root=resolve(import.meta.dirname,'..');
test('owned runtime and all shipped SDK/Skill outputs contain no retired runtime dependency',async()=>{
 assert.equal((await verifyIndependentRuntime()).passed,true);
});
test('SDK initializes and disposes using only the Wiek runtime global',()=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';globalThis.wiek={getBrowserVersion:()=>({currentVersion:'test',updateAvailable:false}),sendCDPMessage(){}};const sdk=await import(${JSON.stringify(new URL('../packages/sdk/dist/out/index.js',import.meta.url).href)});assert.equal(typeof globalThis.taskSpace,'function');assert.equal(Object.hasOwn(globalThis,'ego'),false);assert.equal(typeof sdk.installWiekSdk,'function');await sdk.disposeWiekSdk();console.log('Wiek-only runtime passed');`],{encoding:'utf8',env:{...process.env,EGO_BROWSER_AGENT_WORKSPACE:'/unavailable',EGO_BROWSER_STATE_DIR:'/unavailable'}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Wiek-only runtime passed/);
});
test('system registration creates three Wiek Skills and a usable command, and is idempotent',async()=>{
 const home=await mkdtemp(join(tmpdir(),'wiek-install-'));
 try{
  const first=await installWiek({root,home});assert.equal(first.changedEntries.length,4);
  for(const directory of ['.agents','.codex','.claude'])assert.equal(await realpath(join(home,directory,'skills/wiek-browser')),join(root,'skills/wiek-browser'));
  assert.equal((await installWiek({root,home})).changedEntries.length,0);
  const result=spawnSync(process.execPath,[first.command,'--help'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Wiek Browser/);
  const guide=spawnSync(process.execPath,[first.command,'skill'],{encoding:'utf8'});assert.equal(guide.status,0,guide.stderr);assert.match(guide.stdout,/^\[wiek-browser:skill\]/);assert.match(guide.stdout,/\[wiek-browser:skill\] end of guide/);assert.doesNotMatch(guide.stdout,/\bego\b|Ego|EGO_/);
 }finally{await rm(home,{recursive:true,force:true});}
});
test('system registration preserves an existing user entry in a backup outside Skill discovery',async()=>{
 const home=await mkdtemp(join(tmpdir(),'wiek-install-backup-'));
 try{
  await mkdir(join(home,'.agents/skills/wiek-browser'),{recursive:true});await writeFile(join(home,'.agents/skills/wiek-browser/personal-note'),'keep');
  await installWiek({root,home,now:()=>123});
  const backup=join(home,'.local/share/wiek/installation-backup/123'),names=await readdir(backup);
  assert.equal(names.length,1);assert.equal(await import('node:fs/promises').then(fs=>fs.readFile(join(backup,names[0],'personal-note'),'utf8')),'keep');
 }finally{await rm(home,{recursive:true,force:true});}
});

#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const executable=resolve(root,process.argv[2]||'dist','mac-arm64/Wiek Browser.app/Contents/MacOS/Wiek Browser');
if(process.platform==='darwin'){
 const processes=execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(.+)$/.exec(line);return match&&match[2]===executable?[Number(match[1])]:[];});
 if(processes.length)throw Error('Close the running packaged Wiek instances before rebuilding their application directory. PIDs: '+processes.join(', '));
}
console.log('Package output is not in use by a running host.');

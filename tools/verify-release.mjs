#!/usr/bin/env node
// Read-only identity verification of the app and its public test/reference inputs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const packaged=path.resolve(process.argv[2]||path.join(root,'dist/mac-arm64/Wiek Browser.app/Contents/Resources/app'));
const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const exists=async file=>fs.access(file).then(()=>true,()=>false);
async function files(directory){const output=[];for(const entry of await fs.readdir(path.join(root,directory),{withFileTypes:true})){if(entry.name==='.DS_Store'||entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;const relative=path.join(directory,entry.name);if(entry.isDirectory())output.push(...await files(relative));else if(entry.isFile())output.push(relative);}return output;}
const sources=[...(await files('app')),...(await files('cli')),...(await files('skills')),...(await files('models')),...(await files('packages/sdk/dist')),...(await files('packages/sdk/skill-body')),'packages/sdk/LICENSE','NOTICE.md'];
const records=[];
for(const file of [...new Set(sources)].sort()){const sha256=await digest(path.join(root,file));records.push({file,sha256,matches:await exists(path.join(packaged,file))&&sha256===await digest(path.join(packaged,file))});}
const integrity=JSON.parse(await fs.readFile(path.join(root,'reports/upstream-test-integrity.json'),'utf8'));
integrity.referenceMode='immutable-local-test-inputs';
for(const entry of integrity.records){entry.unchanged=await digest(path.join(root,'tests/fixtures/sdk-original',entry.file))===entry.sha256;}
integrity.allUnchanged=integrity.records.every(entry=>entry.unchanged);integrity.verifiedAt=new Date().toISOString();
const excluded=['downloads','references','analysis','reports','data','tests','tools'];
const audit={excluded,unexpected:[],modelSha256:await digest(path.join(packaged,'models/ggml-tiny.bin')),whisperSha256:await digest(path.join(packaged,'app/bin/whisper-cli'))};
for(const directory of excluded)if(await exists(path.join(packaged,directory)))audit.unexpected.push(directory);
const sdkSha256=await digest(path.join(packaged,'packages/sdk/dist/out/index.js'));
const comparison=JSON.parse(await fs.readFile(path.join(root,'reports/comparison.json'),'utf8'));
const metadata=JSON.parse(await fs.readFile(path.join(packaged,'package.json'),'utf8'));
const current=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const verification={generatedAt:new Date().toISOString(),version:metadata.version,versionMatches:metadata.version===current.version,checkedFiles:records.length,allMatch:records.every(entry=>entry.matches),sdkSha256,sdkMatchesCompared:comparison.runs.every(run=>run.sdkSha256===sdkSha256),files:records};
await fs.writeFile(path.join(root,'reports/package-source-verification.json'),JSON.stringify(verification,null,2)+'\n');
await fs.writeFile(path.join(root,'reports/package-content-audit.json'),JSON.stringify(audit,null,2)+'\n');
await fs.writeFile(path.join(root,'reports/upstream-test-integrity.json'),JSON.stringify(integrity,null,2)+'\n');
if(!verification.versionMatches||!verification.allMatch||!verification.sdkMatchesCompared||!integrity.allUnchanged||audit.unexpected.length)throw new Error('Release identity check failed; inspect saved reports');
console.log(JSON.stringify({version:metadata.version,packageFiles:records.length,sourceMatches:true,sdkMatchesCompared:true,upstreamFiles:integrity.records.length,upstreamUnchanged:true,unexpected:[]},null,2));

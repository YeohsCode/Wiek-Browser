#!/usr/bin/env node
// Read-only inventory. Counts identify source references, not runtime calls.
import {readFile,writeFile,readdir,readlink,realpath,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,relative,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
// Identifier-aware: excludes ordinary words such as category and negotiate.
const expression=String.raw`(?i:\bego\b|ego[-_](?:browser|lite|bench|scoped|gateway))|Ego(?=[A-Z])|(?<![A-Za-z0-9])EGO_|(?<![A-Za-z0-9])ego(?=[A-Z_])`;
// JavaScript has no inline flag groups. Spell out only the case-insensitive part.
const pattern=/\b[eE][gG][oO]\b|[eE][gG][oO][-_](?:[bB][rR][oO][wW][sS][eE][rR]|[lL][iI][tT][eE]|[bB][eE][nN][cC][hH]|[sS][cC][oO][pP][eE][dD]|[gG][aA][tT][eE][wW][aA][yY])|Ego(?=[A-Z])|(?<![A-Za-z0-9])EGO_|(?<![A-Za-z0-9])ego(?=[A-Z_])/g;
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const tracked=git('ls-files','-z').split('\0').filter(Boolean);
const generatedReports=new Set(['reports/reference-residue-audit.md','reports/reference-residue-audit.json']);
function category(file){
 if(file.startsWith('app/'))return 'app-host';
 if(file.startsWith('cli/'))return 'cli';
 if(file.startsWith('packages/sdk/')){
  if(/\.test\.|\/scripts\/real-browser-e2e\/|\/scripts\/run-real-browser-e2e/.test(file))return 'sdk-original-tests';
  if(file.startsWith('packages/sdk/src/'))return 'sdk-runtime-source';
  return 'sdk-build-and-guide';
 }
 if(file.startsWith('skills/ego-browser/'))return 'upstream-compatibility-skill';
 if(file.startsWith('skills/wiek-browser/'))return 'current-product-skill';
 if(file.startsWith('skills/'))return 'other-compatibility-skill';
 if(file.startsWith('benchmark/'))return 'benchmark';
 if(file.startsWith('tests/'))return 'tests-and-fixtures';
 if(file.startsWith('tools/'))return 'development-tools';
 if(file.startsWith('.github/'))return 'tracked-ci';
 if(file.startsWith('reports/'))return 'reports-and-history';
 if(file.startsWith('analysis/'))return 'research-documents';
 return 'root-and-other-documents';
}
async function scan(base,files){
 const rows=[],stats={files:0,textFiles:0,binaryFiles:0,symlinks:0,missingFiles:0};
 for(const file of files){
  if(generatedReports.has(file))continue;
  let bytes;try{const p=join(base,file);if((await lstat(p)).isSymbolicLink()){bytes=Buffer.from(await readlink(p));stats.symlinks++;}else bytes=await readFile(p);}catch{stats.missingFiles++;continue;}
  stats.files++;
  let source;try{if(bytes.includes(0))throw 0;source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{stats.binaryFiles++;continue;}
  stats.textFiles++;
  const hits=[];let occurrences=0;
  for(const [index,line]of source.split(/\r?\n/).entries()){
   pattern.lastIndex=0;const matches=[...line.matchAll(pattern)];
   if(matches.length){occurrences+=matches.length;hits.push(index+1);}
  }
  pattern.lastIndex=0;const pathHit=pattern.test(file);pattern.lastIndex=0;
  if(hits.length||pathHit)rows.push({file,category:category(file),pathHit,matchedLines:hits,matchedLineCount:hits.length,occurrences,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 return {stats,matchingFiles:rows.length,matchedLines:rows.reduce((n,r)=>n+r.matchedLineCount,0),occurrences:rows.reduce((n,r)=>n+r.occurrences,0),rows};
}
function groups(rows){const result={};for(const row of rows){const g=result[row.category]||={files:0,matchedLines:0,occurrences:0};g.files++;g.matchedLines+=row.matchedLineCount;g.occurrences+=row.occurrences;}return result;}
async function exists(p){return lstat(p).then(()=>true,()=>false);}
const source=await scan(root,tracked);
const manifest=JSON.parse(await readFile(join(root,'reports/package-source-verification.json'),'utf8'));
const packagedRoot=join(root,'dist/mac-arm64/Wiek Browser.app/Contents/Resources/app');
const packaged=await scan(packagedRoot,[...manifest.files.map(row=>row.file),'package.json']);
const packagedMetadata=JSON.parse(await readFile(join(packagedRoot,'package.json'),'utf8'));
const system={};
for(const name of ['ego-browser','wiek-browser']){
 const file=join(homedir(),'.local/bin',name);
 system[name]={onPath:!!execFileSync('/bin/zsh',['-c',`command -v ${name} || true`],{encoding:'utf8'}).trim(),localBinExists:await exists(file)};
 if(await exists(file)){system[name].resolved=await realpath(file);if((await lstat(file)).isSymbolicLink())system[name].symlink=await readlink(file);}
}
system.skills={originalPresent:await exists(join(homedir(),'.agents/skills/ego-browser/SKILL.md')),currentPresent:await exists(join(homedir(),'.agents/skills/wiek-browser/SKILL.md'))};
system.repositorySkillLinks=[];
for(const file of tracked.filter(p=>/^\.(?:agents|codex|claude)\/skills\//.test(p))){
 try{if((await lstat(join(root,file))).isSymbolicLink())system.repositorySkillLinks.push({file,target:await readlink(join(root,file))});}catch{}
}
const processLines=execFileSync('/bin/ps',['-axo','pid=,comm='],{encoding:'utf8'}).split('\n');
system.processes=processLines.flatMap(line=>{
 const match=/^\s*(\d+)\s+(.+)$/.exec(line);if(!match)return [];
 const executable=match[2],kind=executable.includes('/downloads/ego/')?'original-reference':executable.includes('/Wiek Browser.app/')?'wiek':null;
 return kind?[{pid:Number(match[1]),kind,executable}]:[];
});
const ignoredWorkflows=[];
for(const name of ['ci.yml','purge-camo-cache.yml','star-history.yml']){
 const file='.github/workflows/'+name;
 ignoredWorkflows.push({file,present:await exists(join(root,file)),tracked:tracked.includes(file)});
}
const runtimeNames=['downloads','references','analysis','reports','data','tests','tools'];
const excludedDirectories=[];for(const name of runtimeNames)excludedDirectories.push({name,present:await exists(join(packagedRoot,name))});
const report={schemaVersion:1,auditDate:'2026-11-09',timeZone:'Asia/Shanghai',generatedAt:new Date().toISOString(),head:git('rev-parse','HEAD'),workingTree:git('status','--short').split('\n').filter(Boolean),scope:'Tracked working-tree text and names, manifest-owned packaged files plus package.json, targeted global command/skill and executable-only process snapshot. No personal browser data read.',matchExpression:expression,countsAreRuntimeCalls:false,source:{...source,groups:groups(source.rows)},packaged:{version:packagedMetadata.version,...packaged,groups:groups(packaged.rows),excludedDirectories},system,ignoredWorkflows,limitations:['Binary strings are not scanned. Logo findings use the separate saved hash audit.','Text matches are not proof of executed branches, network requests, or commercial service dependencies.','Untracked title-reader changes are not in the 0.22.0 package; original SDK build artifacts are counted separately in packaged scope.','The audit does not remove, rename, stop or launch either browser. Audit output files are excluded to prevent self-counting.']};
await writeFile(join(root,'reports/reference-residue-audit.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({head:report.head,source:{...source.stats,matchingFiles:source.matchingFiles,matchedLines:source.matchedLines,occurrences:source.occurrences,groups:report.source.groups},packaged:{version:packagedMetadata.version,...packaged.stats,matchingFiles:packaged.matchingFiles,groups:report.packaged.groups},system:{commands:system['ego-browser'],currentCommand:system['wiek-browser'],skills:system.skills,processCounts:system.processes.reduce((a,p)=>(a[p.kind]=(a[p.kind]||0)+1,a),{})},ignoredWorkflows},null,2));

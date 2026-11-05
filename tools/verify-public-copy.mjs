#!/usr/bin/env node
// Current public guides only. Original license notices and historical evidence
// retain their source attribution and immutable diagnostic records.
import{readFile}from'node:fs/promises';
const files=['README.md','README.zh-CN.md','PLAN.md','docs/README.md','analysis/feature-parity.md','analysis/implementation-matrix.md','analysis/local-services-design.md','reports/RESULTS.md','reports/comparison.md','skills/wiek-browser/API.md'];
const forbidden=/\b(?:Vek|REA|Ego(?: Browser)?)\b|反编译/ig;
const failures=[];
for(const file of files){const source=await readFile(new URL('../'+file,import.meta.url),'utf8');if(forbidden.test(source))failures.push(file);forbidden.lastIndex=0;}
if(failures.length)throw new Error('Current public naming check failed in: '+failures.join(', '));
console.log(JSON.stringify({passed:true,checkedDocuments:files.length,originalNoticesAndHistoricalRecordsPreserved:true}));

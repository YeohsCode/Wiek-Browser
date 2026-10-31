#!/usr/bin/env node
// Explicitly combine complete saved runs only when their immutable suite inputs match.
import {readFile,writeFile} from 'node:fs/promises';
import {comparisonMarkdown} from '../tests/run-comparison.mjs';
import {e2eCases} from '../packages/sdk/scripts/real-browser-e2e/cases/index.mjs';
const selectedNames=e2eCases.map(c=>c.name);
const runs=await Promise.all(['ego','vek'].map(async browser=>JSON.parse(await readFile(new URL(`../reports/${browser}-e2e.json`,import.meta.url),'utf8'))));
const [ego,vek]=runs;
for(const run of runs){
 if(!run.summaryPresent || run.counts.selected!==selectedNames.length || selectedNames.some(name=>run.cases.find(c=>c.name===name)?.source!=='upstream-summary')) throw new Error(`${run.browser}: incomplete suite; results were not merged`);
}
for(const key of ['sdkSha256','fixtureSha256','suiteIndexSha256']) if(!ego[key] || ego[key]!==vek[key]) throw new Error(`Cannot compare runs with different ${key}`);
const report={schemaVersion:1,generatedAt:new Date().toISOString(),suite:'ego-lite real-browser-e2e',selectedNames,comparable:true,aggregation:'explicit complete saved runs with identical SDK/fixture/case hashes',runs};
await writeFile(new URL('../reports/comparison.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
await writeFile(new URL('../reports/comparison.md',import.meta.url),comparisonMarkdown(report)+'\n\n本表通过 tools/compare-saved-runs.mjs 显式合并两次完整记录，哈希校验通过。Ego 基准先执行；Vek 使用最终 macOS 应用包的 CLI 执行，保留各自开始/结束时间及原始日志。\n');
console.log(runs.map(r=>`${r.browser}: ${r.counts.pass}/${r.counts.total}, fail ${r.counts.fail}, not_run ${r.counts.notRun}`).join('\n'));

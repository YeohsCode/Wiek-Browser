#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
export async function verifyFrameworkInputs(root = sourceRoot) {
  const lineage = JSON.parse(await readFile(join(root, 'reports/benchmark-fork-lineage.json'), 'utf8'));
  const tracked = new Set(execFileSync('git', ['ls-files', '-z', '--', 'benchmark/framework'], {cwd: root, encoding: 'utf8'}).split('\0'));
  const missing = [], changed = [];
  for (const entry of lineage.currentOwnedFiles) {
    const file = 'benchmark/framework/' + entry.file;
    if (!tracked.has(file)) { missing.push(file); continue; }
    try {
      const bytes = await readFile(join(root, file));
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) changed.push(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(file);
    }
  }
  const result = {passed: !missing.length && !changed.length, checkedFiles: lineage.currentOwnedFiles.length, missing, changed};
  if (!result.passed) throw Object.assign(Error('Tracked framework inputs are missing or differ from their pinned identities'), {result});
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await verifyFrameworkInputs();
    await writeFile(join(sourceRoot, 'reports/framework-inputs-verification.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify(error.result || {error: error.message}, null, 2));
    process.exitCode = 1;
  }
}

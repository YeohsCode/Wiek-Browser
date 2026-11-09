import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyFrameworkInputs} from '../tools/verify-framework-inputs.mjs';

test('framework input verification rejects ignored, changed and missing task inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiek-framework-inputs-'));
  const git = (...args) => execFileSync('git', args, {cwd: root, stdio: 'pipe'});
  try {
    git('init', '-q');
    await mkdir(join(root, 'benchmark/framework/data'), {recursive: true});
    await mkdir(join(root, 'reports'));
    const file = join(root, 'benchmark/framework/data/tasks.json'), bytes = '[{"task_id":"fixture"}]';
    await writeFile(file, bytes);
    await writeFile(join(root, '.gitignore'), 'data/\n');
    await writeFile(join(root, 'reports/benchmark-fork-lineage.json'), JSON.stringify({currentOwnedFiles: [{file: 'data/tasks.json', sha256: createHash('sha256').update(bytes).digest('hex')}]}));
    await assert.rejects(verifyFrameworkInputs(root), error => error.result.missing.includes('benchmark/framework/data/tasks.json'));
    git('add', '-f', 'benchmark/framework/data/tasks.json');
    assert.equal((await verifyFrameworkInputs(root)).passed, true);
    await writeFile(file, '[]');
    await assert.rejects(verifyFrameworkInputs(root), error => error.result.changed.length === 1);
    await rm(file);
    await assert.rejects(verifyFrameworkInputs(root), error => error.result.missing.length === 1);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

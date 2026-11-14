import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const require = createRequire(import.meta.url);
const electron = require('electron');
const launch = promisify(execFile);
const root = process.env.WIEK_LANGUAGE_APP_ROOT || resolve(import.meta.dirname, '..');

test('the desktop switches languages live, preserves names, and restores the chosen language on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wiek-language-'));
  try {
    const env = { ...process.env, WIEK_DATA_DIR: directory, WIEK_LANGUAGE_APP_ROOT: root };
    delete env.ELECTRON_RUN_AS_NODE;
    const fixture = join(import.meta.dirname, 'fixtures/interface-language.cjs');
    for (const phase of ['switch', 'restart']) {
      const { stdout } = await launch(electron, [fixture, phase], { env, timeout: 30000 });
      assert.match(stdout, /language-checks-passed/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

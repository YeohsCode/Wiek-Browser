'use strict';
const { app, dialog, webContents } = require('electron');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const directories = JSON.parse(process.env.WIEK_MIXED_PROFILES);
const exec = childProcess.execFile;
const realExec = promisify(exec);
const keyRequests = [];
childProcess.execFile = Object.assign((...args) => exec(...args), {
  [promisify.custom]: async (file, args, options) => {
    if (file !== '/usr/bin/security') return realExec(file, args, options);
    const key = { 'Chrome Safe Storage': 'chrome fixture key', 'Microsoft Edge Safe Storage': 'edge fixture key' }[args[2]];
    assert.ok(key);
    assert.deepEqual(args, ['find-generic-password', '-s', args[2], '-w']);
    keyRequests.push(args[2]);
    return { stdout: key + '\n', stderr: '' };
  },
});

let decisions = [];
const dialogs = [];
dialog.showOpenDialog = async () => ({ filePaths: directories });
dialog.showMessageBox = async (_window, options) => {
  dialogs.push(options);
  return { response: decisions.shift() ?? 0 };
};

app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => run(window).then(() => app.quit(), error => {
    console.error(error);
    app.exit(1);
  }));
});

async function run(window) {
  const js = code => window.webContents.executeJavaScript(code);
  const wait = async check => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('Settings did not become ready');
  };
  const state = () => js('vek.state()');
  await wait(async () => (await state()).spaces.length);
  await js('document.querySelector("[data-panel=settings]").click()');
  await js('document.querySelector("[data-settings-section=data]").click()');
  assert.equal(await js('!!document.querySelector("select option[value=mixed]")'), true);
  const migrate = cookies => js('vek.action("profile:import", {sourceBrowser:"mixed",cookies:' + cookies + '})');
  await migrate(false);
  assert.equal(dialogs.length, 0);
  assert.deepEqual(keyRequests, []);
  decisions = [1, 0];
  await migrate(true);
  assert.deepEqual(dialogs.splice(0).map(entry => entry.detail), directories);
  assert.deepEqual(keyRequests, []);
  decisions = [1, 3, 0];
  await migrate(true);
  assert.equal(dialogs.length, 3);
  assert.match(dialogs[2].detail, /Google Chrome\s·/);
  assert.match(dialogs[2].detail, /Microsoft Edge\s·/);
  assert.deepEqual(keyRequests, []);
  dialogs.length = 0;
  decisions = [1, 3, 1];
  const result = await migrate(true);
  assert.equal(result.importResult.counts.cookies, 2);
  assert.deepEqual(keyRequests, ['Chrome Safe Storage', 'Microsoft Edge Safe Storage']);
  const browserPage = webContents.getAllWebContents().find(contents => contents.getURL() === 'about:blank');
  const cookies = await browserPage.session.cookies.get({ url: 'https://fixture.test/' });
  assert.deepEqual(cookies.map(cookie => [cookie.name, cookie.value]).sort(), [['chrome', 'chrome cookie'], ['edge', 'edge cookie']]);
  console.log(JSON.stringify({ mixedSourceImport: true }));
}

require(path.join(process.env.WIEK_PROFILE_IMPORT_APP_ROOT || path.resolve(__dirname, '../..'), 'app/main.cjs'));

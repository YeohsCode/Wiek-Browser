import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:http';

const execute = promisify(execFile);
const cli = resolve(process.env.WIEK_RECOVERY_CLI || 'cli/wiek-browser.mjs');

test('real CLI distinguishes reopening tabs, continuing scripts, completed tasks and user handoff', {skip: process.platform !== 'darwin', timeout: 90000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wiek-recovery-'));
  const env = {...process.env, WIEK_DATA_DIR: directory, VEK_DATA_DIR: directory};
  delete env.WIEK_BROWSER_STATE_DIR;
  delete env.WIEK_BROWSER_AGENT_WORKSPACE;
  const web = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Recovery fixture</title><input id="draft"><h1>Local fixture</h1>');
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${web.address().port}/`;
  let running = false;
  let checks = 0;
  const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
  const command = (...args) => execute(process.execPath, [cli, ...args], {env, timeout: 30000, maxBuffer: 1024 * 1024});
  async function script(source) {
    const result = await command('nodejs', '-e', source);
    const rows = result.stdout.split('\n').flatMap(line => {
      try { const row = JSON.parse(line); return row.recoveryFixture ? [row] : []; } catch { return []; }
    });
    assert.equal(rows.length, 1, result.stdout + result.stderr);
    return rows[0];
  }
  try {
    await command('start'); running = true;
    const created = await script(`const task=await taskSpace('recovery-fixture');const page=task.page('p1');await page.goto(${JSON.stringify(url)});await page.fill('#draft','unsaved input');console.log(JSON.stringify({recoveryFixture:true,id:task.spaceId,label:page.label}));`);
    check(created.label, 'p1');
    const continued = await script(`const task=await taskSpace(${created.id});console.log(JSON.stringify({recoveryFixture:true,value:await task.page('p1').evaluate(()=>document.querySelector('#draft').value)}));`);
    check(continued.value, 'unsaved input');

    // A browser restart gives Chromium new target identities. Old Page labels
    // must never silently acquire authority over the reopened user pages.
    await command('stop'); running = false;
    await command('start'); running = true;
    const reopened = await script(`const task=await taskSpace(${created.id});const tabs=await task.tabs();let missing;try{await task.page('p1').url()}catch(e){missing=e.message}console.log(JSON.stringify({recoveryFixture:true,tabs:tabs.map(t=>({label:t.label||null,url:t.url,openedBy:t.openedBy})),missing}));`);
    check(reopened.tabs.length, 1);
    check(reopened.tabs[0].url, url);
    check(reopened.tabs[0].label, null);
    check(reopened.tabs[0].openedBy, 'unknown');
    assert.match(reopened.missing, /page label not found: p1/); checks++;
    const adopted = await script(`const task=await taskSpace(${created.id});const tab=(await task.tabs())[0];const page=await task.adopt(tab.page);await page.waitForSelector('#draft');const value=await page.evaluate(()=>document.querySelector('#draft').value);await task.finish({keep:[page.label]});console.log(JSON.stringify({recoveryFixture:true,value}));`);
    check(adopted.value, '');

    const collision = await script(`let code;try{await taskSpace('recovery-fixture')}catch(e){code=e.error_code}const fresh=await taskSpace('independent-test-run');await fresh.page('p1').goto(${JSON.stringify(url)});const title=await fresh.page('p1').title();await fresh.finish({keep:[]});console.log(JSON.stringify({recoveryFixture:true,code,title}));`);
    check(collision.code, 'WIEK_TASK_SPACE_NAME_IN_USE');
    check(collision.title, 'Recovery fixture');
    const inactive = await command('nodejs', '-e', `await takeOverTaskSpace(${created.id});`).then(() => null, error => error);
    check(inactive?.code, 1);
    assert.match(inactive.stderr, /no longer assigned to the agent/); checks++;
    const claimed = await script(`const task=await claimTaskSpace(${created.id});const tab=(await task.tabs())[0];const page=await task.adopt(tab.page);console.log(JSON.stringify({recoveryFixture:true,url:await page.url(),ownership:task.ownership}));`);
    check(claimed.url, url);
    check(claimed.ownership, 'agent');

    await script(`const task=await taskSpace(${created.id});await task.handOff();console.log(JSON.stringify({recoveryFixture:true,handedOff:true}));`);
    const paused = await command('nodejs', '-e', `const task=await taskSpace(${created.id});await task.tabs();`).then(() => null, error => error);
    check(paused?.code, 1);
    assert.match(paused.stderr, /Control of this task space is with the user/); checks++;
    const resumed = await script(`const task=await takeOverTaskSpace(${created.id});console.log(JSON.stringify({recoveryFixture:true,url:(await task.tabs())[0].url}));`);
    check(resumed.url, url);
    console.log(JSON.stringify({ok:true,checks,realCLI:true,isolatedData:true,modelCalls:0,accountActions:0}));
  } finally {
    if (running) await command('stop');
    await new Promise(resolve => web.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});

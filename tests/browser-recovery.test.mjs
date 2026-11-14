import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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
    response.end('<title>Recovery fixture</title><script>window.firstViewport = [innerWidth, innerHeight]</script><input id="draft"><h1>Local fixture</h1>');
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
    const created = await script(`const task=await taskSpace('recovery-fixture');const page=task.page('p1');await page.goto(${JSON.stringify(url)});await page.fill('#draft','unsaved input');console.log(JSON.stringify({recoveryFixture:true,id:task.spaceId,label:page.label,viewport:await page.evaluate(()=>window.firstViewport)}));`);
    check(created.label, 'p1');
    assert.ok(created.viewport[0] >= 490 && created.viewport[1] >= 400,
      'the first document in a background tab has a usable browser viewport'); checks++;
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
    const caught = await command('nodejs', '-e', `
      console.log('diagnostic before handoff error');
      try {
        const task = await taskSpace(${created.id});
        await task.tabs();
      } catch (error) {
        console.log('caught', error.error_code);
      }
    `).then(() => null, error => error);
    check(caught?.code, 1);
    check(caught.stdout.trim().split('\n'), [
      'diagnostic before handoff error',
      'caught WIEK_TASK_SPACE_USER_IN_CONTROL',
    ]);
    const diagnostics = caught.stderr.trim().split('\n');
    check(diagnostics.length, 1);
    assert.match(diagnostics[0], /^\[wiek-browser:error\] /); checks++;
    check(JSON.parse(diagnostics[0].slice('[wiek-browser:error] '.length)).code,
      'WIEK_TASK_SPACE_USER_IN_CONTROL');
    const resumed = await script(`const task=await takeOverTaskSpace(${created.id});console.log(JSON.stringify({recoveryFixture:true,url:(await task.tabs())[0].url}));`);
    check(resumed.url, url);
    console.log(JSON.stringify({ok:true,checks,realCLI:true,isolatedData:true,modelCalls:0,accountActions:0}));
  } finally {
    if (running) await command('stop');
    await new Promise(resolve => web.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});

test('skipping startup tabs preserves browser data for a later normal launch', {
  skip: process.platform !== 'darwin', timeout: 90000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wiek-skip-tabs-'));
  const stateFile = join(directory, 'browser.json');
  const env = {...process.env, WIEK_DATA_DIR: directory, VEK_DATA_DIR: directory,
    WIEK_BROWSER_STATE_DIR: join(directory, 'sdk-state'), WIEK_NO_RESTORE: '0'};
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    response.end('<title>Saved tab</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const original = {
    nextSpace: 8,
    selected: 7,
    profiles: [{id: 'saved', name: 'Saved profile', isDefault: true}],
    spaces: [{id: 7, name: 'Previous session', profileId: 'saved', ownership: 'agent',
      tabs: [{url: origin + '/', title: 'Saved tab', active: true}]}],
    bookmarks: [{profileId: 'saved', title: 'Bookmark', url: origin + '/bookmark'}],
    history: [{profileId: 'saved', url: origin + '/history'}],
    homePins: {saved: [{id: 'saved-pin', title: 'Home', url: origin + '/home'}]},
    sitePermissions: [{profileId: 'saved', origin, requestingOrigin: origin,
      permission: 'notifications', decision: 'block'}],
    downloads: [{id: 'saved-download', profileId: 'saved', state: 'completed', url: origin + '/download'}],
    closedSpaces: [{id: 'closed', name: 'Previously closed', profileId: 'saved', tabs: []}],
  };
  const command = (args, overrides = {}) => execute(process.execPath, [cli, ...args], {
    env: {...env, ...overrides}, timeout: 30000, maxBuffer: 1024 * 1024,
  });
  let running = false;
  try {
    await writeFile(stateFile, JSON.stringify(original), {mode: 0o600});
    // Exercise the public flag and the existing environment option on successive launches.
    for (const [args, overrides] of [
      [['start', '--no-restore'], {}],
      [['start'], {WIEK_NO_RESTORE: '1'}],
    ]) {
      await command(args, overrides); running = true;
      const result = await command(['nodejs', '-e', 'console.log(JSON.stringify(await listTaskSpaces()))']);
      const groups = JSON.parse(result.stdout.trim());
      assert.equal(groups.length, 1);
      assert.equal(groups[0].profileId, 'saved');
      assert.ok(groups[0].id > 7);
      assert.equal(requests, 0);
      await command(['stop']); running = false;
      const saved = JSON.parse(await readFile(stateFile, 'utf8'));
      for (const key of ['selected', 'profiles', 'spaces', 'bookmarks', 'history', 'homePins', 'sitePermissions', 'closedSpaces']) {
        assert.deepEqual(saved[key], original[key], key);
      }
      assert.equal(saved.downloads[0].id, 'saved-download');
      assert.ok(saved.nextSpace > groups[0].id);
    }
    await command(['start', '--no-restore']); running = true;
    const reusedName = await command(['nodejs', '-e', `await taskSpace('Previous session')`])
      .then(() => null, error => error);
    assert.equal(reusedName?.code, 1);
    assert.match(reusedName.stderr, /name in use/i);
    const created = await command(['nodejs', '-e', `
      const task = await taskSpace('New session');
      await task.page('p1').goto(${JSON.stringify(origin + '/new')});
      console.log(task.spaceId);
    `]);
    const newGroupId = Number(created.stdout.trim());
    assert.ok(newGroupId > 7);
    await command(['stop']); running = false;
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.deepEqual(saved.spaces[0], original.spaces[0]);
    assert.equal(saved.spaces.length, 2);
    assert.equal(saved.spaces[1].id, newGroupId);
    assert.equal(saved.spaces[1].tabs[0].url, origin + '/new');

    requests = 0;
    await command(['start']); running = true;
    const restored = await command(['nodejs', '-e', `
      const task = await taskSpace(7);
      const [tab] = await task.tabs();
      const page = await task.adopt(tab.page);
      await page.waitForFunction(() => document.title === 'Saved tab');
      console.log(await page.url());
    `]);
    assert.equal(restored.stdout.trim(), origin + '/');
    assert.ok(requests > 0);
  } finally {
    if (running) await command(['stop']);
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});

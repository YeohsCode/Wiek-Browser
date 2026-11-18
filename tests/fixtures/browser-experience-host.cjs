"use strict";
const { app } = require("electron");
const assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs"),
  http = require("node:http"),
  { execFile } = require("node:child_process"),
  { promisify } = require("node:util");
const root =
    process.env.WIEK_EXPERIENCE_APP_ROOT || path.resolve(__dirname, "../.."),
  exec = promisify(execFile);
let server,
  variant = "normal",
  effects = 0;
app.once("browser-window-created", (_, window) =>
  window.webContents.once("did-finish-load", () =>
    run(window).then(
      () => {
        server?.close();
        app.quit();
      },
      (error) => {
        console.error(error.stack);
        server?.close();
        app.exit(1);
      },
    ),
  ),
);
async function run(window) {
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error("Renderer:", event.message);
  });
  const e = async (source) => {
      try {
        return await window.webContents.executeJavaScript(source);
      } catch (error) {
        throw new Error(source + ": " + error.message);
      }
    },
    pause = () => new Promise((r) => setTimeout(r, 25));
  for (let i = 0; i < 300; i++) {
    try {
      const s = await e("vek.state()");
      if (
        s.spaces.length &&
        fs.existsSync(path.join(process.env.WIEK_DATA_DIR, "runtime.json"))
      )
        break;
    } catch {}
    await pause();
  }
  server = http.createServer((req, res) => {
    if (req.url === "/effect") {
      effects++;
      res.end("ok");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    const id = variant === "id" ? "replacement" : "apply",
      label = variant === "text" ? "Delete" : "Apply",
      offset = variant === "moved" ? "margin-top:600px;margin-left:350px;" : "";
    res.end(
      `<h1>Experience fixture</h1><p id="result">Ready</p><button id="${id}" style="${offset}" onclick="fetch('/effect');document.querySelector('#result').textContent='${variant === "wrong" ? "Wrong" : "Done"}'">${label}</button><input type="password" value="NEVER_SAVE_THIS_VALUE">`,
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const cli = async (source) => {
    const { stdout } = await exec(
      process.env.WIEK_TEST_NODE,
      [path.join(root, "cli/wiek-browser.mjs"), "nodejs", "-e", source],
      { env: { ...process.env }, timeout: 25000, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  };
  const setup = `const task=await taskSpace('operation-experience-host');const page=task.page('p1');`;
  const json = async (source) =>
    JSON.parse((await cli(setup + source)).split("\n").at(-1));
  const state = () => e("vek.state()");
  const action = (name, payload) =>
    e(
      `vek.action(${JSON.stringify("experience:" + name)},${JSON.stringify(payload)})`,
    );
  let counted = 0;
  const eq = (a, b) => {
    assert.deepEqual(a, b);
    counted++;
  };
  await cli(setup + `await page.goto(${JSON.stringify(url)});`);
  let s = await state();
  const sid = s.spaces.find(
    (row) => row.name === "operation-experience-host",
  ).id;
  await e(`vek.action('space:select',${sid})`);
  // Default disabled keeps existing operations and snapshots unchanged.
  eq(
    (
      await json(
        "console.log(JSON.stringify(await page.experience('observeBegin',{name:'click'})))",
      )
    ).recorded,
    false,
  );
  const baseline = await json(
    `let failures=0;for(let round=0;round<2;round++){await page.goto(${JSON.stringify(url)});try{await page.click('#obsolete',{timeout:100});}catch{failures++;}await page.click('#apply');}console.log(JSON.stringify({failures,businessOutcome:await page.evaluate(()=>document.querySelector('#result').textContent)}));`,
  );
  eq(effects, 2);
  eq(baseline.failures, 2);
  s = await state();
  await action("settings", {
    enabled: true,
    mode: "hints",
    expectedRevision: s.experience.revision,
  });
  // Round one: a real SDK resolution failure, recovery and independent host business check.
  const checks = [
    { kind: "element", selector: "#result", attribute: "text", equals: "Done" },
  ];
  await cli(
    setup +
      `await page.goto(${JSON.stringify(url)});await page.experience('start',{task:'Apply item'});try{await page.click('#obsolete',{timeout:100});}catch{}await page.click('#apply');console.log(JSON.stringify(await page.experience('verify',{checks:${JSON.stringify(checks)}})));`,
  );
  s = await state();
  eq(s.experience.runs[0].status, "verified");
  assert.ok(
    s.experience.runs[0].events.some((row) => row.status === "uncertain"),
  );
  counted++;
  const auto = s.experience.candidates[0];
  eq(auto.status, "pending");
  await action("review", {
    id: auto.id,
    version: auto.version,
    status: "enabled",
    expectedRevision: s.experience.revision,
  });
  // Round two is a new CLI process: hints arrive through the ordinary SDK snapshot.
  const hinted = await cli(
    setup +
      `await page.goto(${JSON.stringify(url)});await page.experience('start',{task:'Apply item'});console.log(await page.snapshot());`,
  );
  assert.match(hinted, /reviewed-browser-experience/);
  counted++;
  assert.match(hinted, /earlier operation/);
  counted++;
  const hintedOutcome = await json(
    `const recalled=await page.experience('recall',{task:'Apply item'});const operations=recalled.candidates.flatMap(c=>c.operations||[]);if(!operations.some(op=>op.locator==='#obsolete'&&op.status==='uncertain'))throw Error('Failure evidence missing');const recovered=operations.filter(op=>op.status==='executed'&&op.locator).at(-1);if(!recovered)throw Error('Recovery evidence missing');await page.click(recovered.locator);console.log(JSON.stringify({usedLocator:recovered.locator,businessOutcome:await page.evaluate(()=>document.querySelector('#result').textContent)}));`,
  );
  eq(hintedOutcome.businessOutcome, "Done");
  eq(hintedOutcome.usedLocator, "#apply");
  // Record an actual checked click, then approve it through the trusted chrome boundary.
  const recipe = {
    type: "click",
    selector: "#apply",
    tag: "button",
    text: "Apply",
    before: [
      {
        kind: "element",
        selector: "#result",
        attribute: "text",
        equals: "Ready",
      },
    ],
    after: checks,
  };
  const c = await json(
    `await page.goto(${JSON.stringify(url)});await page.experience('start',{task:'Apply item'});await page.experience('perform',{recipe:${JSON.stringify(recipe)}});await page.experience('verify',{checks:${JSON.stringify(checks)}});console.log(JSON.stringify(await page.experience('propose',{note:'Use the Apply button and confirm Done.'})));`,
  );
  eq(c.versions[0].completeWorkflow, true);
  s = await state();
  await action("settings", {
    enabled: true,
    mode: "replay",
    expectedRevision: s.experience.revision,
  });
  s = await state();
  await action("review", {
    id: c.id,
    version: c.version,
    status: "enabled",
    expectedRevision: s.experience.revision,
  });
  const replay = async () =>
    json(
      `await page.experience('start',{task:'Apply item'});console.log(JSON.stringify(await page.experience('replay',{id:${JSON.stringify(c.id)},version:1})));`,
    );
  const reload = () => cli(setup + `await page.goto(${JSON.stringify(url)});`);
  variant = "moved";
  await reload();
  const before = effects;
  const replayed = await replay();
  eq(replayed.status, "verified");
  eq(effects, before + 1);
  const replayedOutcome = await json(
    "console.log(JSON.stringify(await page.evaluate(()=>document.querySelector('#result').textContent)))",
  );
  variant = "text";
  await reload();
  const changed = effects;
  eq((await replay()).status, "suspended");
  eq(effects, changed);
  s = await state();
  await action("review", {
    id: c.id,
    version: 1,
    status: "enabled",
    expectedRevision: s.experience.revision,
  });
  variant = "id";
  await reload();
  eq((await replay()).status, "suspended");
  eq(effects, changed);
  s = await state();
  await action("review", {
    id: c.id,
    version: 1,
    status: "enabled",
    expectedRevision: s.experience.revision,
  });
  variant = "wrong";
  await reload();
  const wrong = await replay();
  eq(wrong.status, "suspended");
  eq(wrong.mayHaveDispatched, true);
  eq(effects, changed + 1);
  eq(
    await json(
      "console.log(JSON.stringify(await page.evaluate(()=>document.querySelector('#result').textContent)));",
    ),
    "Wrong",
  );
  // An integration cannot self-approve, even when it supplies an interactive-looking field.
  const denied = await json(
    "try{await page.experience('review',{id:'fake',version:1,status:'enabled'});console.log('false')}catch{console.log('true')}",
  );
  eq(denied, true);
  // Exercise the real main-process MCP assembly, rather than only its callback schema.
  variant = "normal";
  let agentState = await e(
    `vek.action('agents:projects:create',{name:'Experience MCP fixture',path:${JSON.stringify(process.env.WIEK_DATA_DIR)}})`,
  );
  const projectId = agentState.projects.at(-1).id;
  agentState = await e(
    `vek.action('agents:providers:configure',{name:'Unused fixture provider',command:${JSON.stringify(process.env.WIEK_TEST_NODE)},args:['-e','process.exit(0)'],inputMode:'stdin'})`,
  );
  const providerId = agentState.providers.at(-1).id;
  agentState = await e(
    `vek.action('agents:threads:create',${JSON.stringify({ projectId, providerId, title: "Experience MCP fixture" })})`,
  );
  const scope = { projectId, threadId: agentState.threads.at(-1).id };
  const mcp = async (name, args) => {
    const task = await e(
      `vek.action('mcp:tasks:create',${JSON.stringify({ scope, name: "browser." + name, arguments: args })})`,
    );
    const result = await e(
      `vek.action('mcp:tasks:wait',${JSON.stringify({ scope, id: task.id })})`,
    );
    if (result.status === "failed")
      console.error("MCP fixture result", JSON.stringify(result));
    return result;
  };
  const created = await mcp("createTab", { url });
  eq(created.status, "completed");
  const targetId = created.result.targetId;
  eq((await mcp("navigate", { targetId, url })).status, "completed");
  const exp = (action, payload = {}) =>
    mcp("experience", { action, targetId, payload });
  eq((await exp("start", { task: "MCP apply" })).status, "completed");
  eq((await exp("perform", { recipe })).status, "completed");
  eq((await exp("verify", { checks })).result.passed, true);
  const external = await exp("propose", {
    format: 1,
    source: "MCP fixture",
    note: "Apply and check the browser result.",
    steps: [recipe],
  });
  eq(external.result.status, "pending");
  eq(
    (
      await exp("review", {
        id: external.result.id,
        version: 1,
        status: "enabled",
      })
    ).status,
    "failed",
  );
  await e(`vek.action('space:select',${sid})`);
  // Real bilingual settings panel, literal candidate text and edit/rollback controls.
  const until = async (source) => {
    for (let i = 0; i < 100; i++) {
      if (await e(source)) return;
      await pause();
    }
    throw Error("UI did not become ready: " + source);
  };
  await e("vek.action('preferences:update',{interfaceLanguage:'zh-CN'})");
  await e("document.querySelector('[data-panel=settings]').click();undefined");
  await until("!!document.querySelector('[data-settings-section=experience]')");
  await e(
    "document.querySelector('[data-settings-section=experience]').click();undefined",
  );
  assert.match(await e("document.body.textContent"), /浏览器操作经验/);
  counted++;
  await e(
    "document.querySelector('button[data-settings-section=appearance]').click();undefined",
  );
  await until(
    "!!document.querySelector('button[data-settings-section=experience]')",
  );
  await e(
    "document.querySelector('button[data-settings-section=experience]').click();undefined",
  );
  await e("vek.action('preferences:update',{interfaceLanguage:'en'})");
  assert.match(
    await e("document.body.textContent"),
    /Browser operation experience/,
  );
  counted++;
  const editor = `[data-experience-id="${c.id}"]`;
  await e(
    `document.querySelector(${JSON.stringify(editor + " textarea")}).value='Updated 中文 note';[...document.querySelector(${JSON.stringify(editor)}).querySelectorAll('button')].find(b=>b.textContent==='Save as a new draft').click();undefined`,
  );
  await until(
    `document.querySelector(${JSON.stringify(editor)})?.textContent.includes('Version 2')`,
  );
  eq(
    (await state()).experience.candidates.find((row) => row.id === c.id).status,
    "pending",
  );
  await e(
    `[...document.querySelector(${JSON.stringify(editor)}).querySelectorAll('button')].find(b=>b.textContent==='Restore as a new draft').click();undefined`,
  );
  await until(
    `document.querySelector(${JSON.stringify(editor)})?.textContent.includes('Version 3')`,
  );
  eq(
    (await state()).experience.candidates.find((row) => row.id === c.id)
      .versions[2].note,
    c.versions[0].note,
  );
  const file = fs.readFileSync(
    path.join(process.env.WIEK_DATA_DIR, "browser-experience/state.json"),
    "utf8",
  );
  assert.ok(!file.includes("NEVER_SAVE_THIS_VALUE"));
  counted++;
  console.log(
    JSON.stringify({
      experienceHost: true,
      assertions: counted,
      comparison: {
        noExperience: {
          failedAttempts: baseline.failures,
          repeatedErrors: baseline.failures - 1,
          businessOutcome: baseline.businessOutcome,
        },
        reviewedHints: {
          receivedSuggestions: true,
          failedAttempts: 0,
          businessOutcome: hintedOutcome.businessOutcome,
        },
        checkedReplay: {
          status: replayed.status,
          failedAttempts: 0,
          businessOutcome: replayedOutcome,
        },
        modelCalls: 0,
        consumer: "deterministic fixture, not a language model",
      },
      changedLabelDispatches: 0,
      changedIdDispatches: 0,
      wrongResultDispatches: 1,
    }),
  );
  await cli(setup + "await task.finish({keep:[]});");
}
require(path.join(root, "app/main.cjs"));

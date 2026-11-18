import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const root =
  process.env.WIEK_EXPERIENCE_APP_ROOT ||
  path.resolve(import.meta.dirname, "..");
const { createBrowserExperience } = createRequire(import.meta.url)(
  path.join(root, "app/browser-experience.cjs"),
);
const checks = [
  { kind: "element", selector: "#result", attribute: "text", equals: "Done" },
];
const recipe = {
  type: "click",
  selector: "#apply",
  tag: "button",
  text: "Apply",
  before: [{ kind: "url", path: "/" }],
  after: checks,
};
async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wiek-experience-"));
  let service = createBrowserExperience({ dataDir: dir }),
    effects = 0,
    valid = true,
    control = true;
  const ctx = {
    profileId: "p",
    projectId: "project",
    spaceId: 1,
    targetId: "target",
    url: "https://fixture.test/?private=DO_NOT_SAVE#secret",
    assertControl() {
      if (!control)
        throw Object.assign(Error("User control"), {
          error_code: "WIEK_USER_CONTROL",
        });
    },
    check: async () => valid,
    execute: async () => {
      effects++;
    },
  };
  const h = {
    dir,
    ctx,
    get service() {
      return service;
    },
    get effects() {
      return effects;
    },
    set valid(v) {
      valid = v;
    },
    set control(v) {
      control = v;
    },
    call: (a, p = {}, c = ctx) => service.dispatch(a, p, c),
    review: (a, p = {}) =>
      service.dispatch(
        a,
        { expectedRevision: service.snapshot(ctx).revision, ...p },
        { ...ctx, interactive: true },
      ),
    async enable(mode = "hints") {
      await h.review("settings", { enabled: true, mode });
    },
    async start() {
      return h.call("start", { task: "Apply item" });
    },
    async draft({ failed = false, steps = true } = {}) {
      await h.start();
      if (failed) {
        const e = await h.call("begin", { name: "click" });
        await h.call("end", { ...e, status: "uncertain" });
      }
      if (steps) await h.call("perform", { recipe });
      else {
        const e = await h.call("begin", { name: "click" });
        await h.call("end", { ...e, status: "executed" });
      }
      await h.call("verify", { checks });
      return h.call("propose", {
        note: "Use the uniquely labelled Apply button and check the result.",
      });
    },
    reopen() {
      service.close();
      service = createBrowserExperience({ dataDir: dir });
    },
  };
  t.after(async () => {
    h.service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return h;
}
test("disabled default is non-blocking for automatic observation, and agents cannot enable or approve", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.call("observeBegin", { name: "click" }), {
    recorded: false,
    candidates: [],
  });
  await assert.rejects(h.start(), /Enable/);
  await assert.rejects(
    h.call("settings", { enabled: true, mode: "replay", expectedRevision: 0 }),
    /Settings/,
  );
  await h.enable();
  const c = await h.draft();
  await assert.rejects(
    h.call("review", {
      id: c.id,
      version: 1,
      status: "enabled",
      expectedRevision: h.service.snapshot(h.ctx).revision,
    }),
    /Settings/,
  );
  assert.equal(
    (await h.call("recall", { task: "Apply item" })).candidates.length,
    0,
  );
});
test("execution is separate from business validation; two rounds recall only a reviewed evidence-linked suggestion", async (t) => {
  const h = await harness(t);
  await h.enable();
  await h.start();
  let e = await h.call("begin", { name: "click" });
  await h.call("end", { ...e, status: "failed", code: "WIEK_ELEMENT_MISSING" });
  e = await h.call("begin", { name: "click" });
  await h.call("end", { ...e, status: "executed" });
  await assert.rejects(
    h.call("propose", { note: "Claimed success" }),
    /host-verified/,
  );
  h.valid = false;
  assert.equal((await h.call("verify", { checks })).passed, false);
  await assert.rejects(
    h.call("propose", { note: "False success" }),
    /host-verified/,
  );
  h.valid = true;
  assert.equal((await h.call("verify", { checks })).passed, true);
  const c = await h.call("propose", {
    note: "Do not use the missing button; inspect the label first.",
  });
  assert.equal(c.versions[0].completeWorkflow, false);
  assert.ok(c.versions[0].evidence.includes(e.operationId));
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  await h.start();
  assert.equal(
    (await h.call("recall", { task: "Apply item" })).candidates[0].id,
    c.id,
  );
  assert.equal(h.service.snapshot(h.ctx).runs.length, 2);
});
test("profile, project, page, task, and exact origin isolate records and recalled hints", async (t) => {
  const h = await harness(t);
  await h.enable();
  const c = await h.draft();
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  for (const ctx of [
    { ...h.ctx, profileId: "other" },
    { ...h.ctx, projectId: "other" },
    { ...h.ctx, url: "https://other.test/" },
  ]) {
    if (ctx.profileId === "other")
      assert.equal(h.service.snapshot(ctx).runs.length, 0);
    else
      assert.equal(
        (await h.call("recall", { task: "Apply item" }, ctx)).candidates.length,
        0,
      );
    await assert.rejects(h.call("verify", { runId: c.runId, checks }, ctx));
  }
  assert.equal(
    (await h.call("recall", { task: "Different task" })).candidates.length,
    0,
  );
  await assert.rejects(
    h.call(
      "verify",
      { runId: c.runId, checks },
      { ...h.ctx, targetId: "other" },
    ),
    /scope/,
  );
});
test("operation IDs cannot be reused, mismatched or injected with payloads and secrets", async (t) => {
  const h = await harness(t);
  await h.enable();
  await h.start();
  const e = await h.call("begin", { name: "fill" });
  await assert.rejects(h.call("begin", { name: "click" }), /already open/);
  await assert.rejects(
    h.call("end", { ...e, operationId: "other", status: "executed" }),
    /Unknown/,
  );
  await h.call("end", { ...e, status: "uncertain", code: "password=SECRET" });
  await assert.rejects(h.call("end", { ...e, status: "executed" }), /Unknown/);
  await assert.rejects(
    h.call("begin", { name: "fill", value: "SECRET" }),
    /Unsupported/,
  );
  const stored = await fs.readFile(
    path.join(h.dir, "browser-experience/state.json"),
    "utf8",
  );
  assert.ok(!stored.includes("SECRET"));
  assert.ok(!stored.includes("DO_NOT_SAVE"));
  assert.ok(!stored.includes("#secret"));
  assert.equal(
    (await fs.stat(path.join(h.dir, "browser-experience/state.json"))).mode &
      0o777,
    0o600,
  );
});
test("checked replay requires both profile opt-in and an approved immutable candidate version", async (t) => {
  const h = await harness(t);
  await h.enable();
  const c = await h.draft();
  await h.start();
  await assert.rejects(h.call("replay", { id: c.id, version: 1 }), /Settings/);
  await h.enable("replay");
  await assert.rejects(
    h.call("replay", { id: c.id, version: 1 }),
    /not enabled/,
  );
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  const result = await h.call("replay", { id: c.id, version: 1 });
  assert.deepEqual(result, {
    status: "verified",
    completed: 1,
    completeWorkflow: true,
  });
  assert.equal(h.effects, 2);
  assert.equal(
    h.service
      .snapshot(h.ctx)
      .runs[0].events.filter((e) => e.kind === "verification").length,
    1,
  );
});
test("changed precondition dispatches nothing, demotes stale experience and suspends rather than retries", async (t) => {
  const h = await harness(t);
  await h.enable("replay");
  const c = await h.draft();
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  await h.start();
  h.valid = false;
  const result = await h.call("replay", { id: c.id, version: 1 });
  assert.equal(result.status, "suspended");
  assert.equal(result.completed, 0);
  assert.equal(result.mayHaveDispatched, false);
  assert.equal(h.effects, 1);
  await assert.rejects(h.call("replay", { id: c.id, version: 1 }), /new run/);
  assert.equal(h.service.snapshot(h.ctx).candidates[0].status, "pending");
});
test("wrong business result after one dispatch is uncertain and never automatically repeated", async (t) => {
  const h = await harness(t);
  await h.enable("replay");
  const c = await h.draft();
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  await h.start();
  h.ctx.execute = async () => {
    h.valid = false;
  };
  const result = await h.call("replay", { id: c.id, version: 1 });
  assert.equal(result.mayHaveDispatched, true);
  assert.equal(result.status, "suspended");
  const run = h.service.snapshot(h.ctx).runs[0];
  assert.equal(run.events.filter((e) => e.kind === "operation").length, 1);
  assert.equal(
    run.events.find((e) => e.kind === "operation").status,
    "uncertain",
  );
});
test("partial recovery never becomes a fully replayed workflow", async (t) => {
  const h = await harness(t);
  await h.enable("replay");
  const c = await h.draft({ failed: true });
  assert.equal(c.versions[0].completeWorkflow, false);
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  await h.start();
  assert.equal(
    (await h.call("replay", { id: c.id, version: 1 })).completeWorkflow,
    false,
  );
});
test("a user handoff interrupts replay before any dispatch and preserves the result uncertainty", async (t) => {
  const h = await harness(t);
  await h.enable("replay");
  const c = await h.draft();
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  await h.start();
  h.ctx.check = async () => {
    h.control = false;
    return true;
  };
  const result = await h.call("replay", { id: c.id, version: 1 });
  assert.equal(result.status, "suspended");
  assert.equal(h.effects, 1);
  assert.equal(result.code, "WIEK_USER_CONTROL");
});
test("revisions, edit, rollback and deletion invalidate old approvals and survive a restart", async (t) => {
  const h = await harness(t);
  await h.enable();
  const c = await h.draft(),
    rev = h.service.snapshot(h.ctx).revision;
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  await assert.rejects(
    h.review("edit", {
      id: c.id,
      version: 1,
      note: "Stale",
      expectedRevision: rev,
    }),
    /refresh/,
  );
  await h.review("edit", {
    id: c.id,
    version: 1,
    note: "Inspect current result before deciding.",
  });
  let edited = h.service.snapshot(h.ctx).candidates[0];
  assert.equal(edited.version, 2);
  assert.equal(edited.status, "pending");
  await h.review("rollback", { id: c.id, version: 2, operationId: 1 });
  edited = h.service.snapshot(h.ctx).candidates[0];
  assert.equal(edited.version, 3);
  assert.equal(edited.versions[2].note, c.versions[0].note);
  assert.equal(edited.status, "pending");
  h.reopen();
  assert.equal(h.service.snapshot(h.ctx).candidates[0].version, 3);
  await h.review("delete", { id: c.id, version: 3 });
  assert.equal(h.service.snapshot(h.ctx).candidates.length, 0);
  h.reopen();
  assert.equal(h.service.snapshot(h.ctx).candidates.length, 0);
});
test("restart does not resume unfinished input or accept a prior operation ID", async (t) => {
  const h = await harness(t);
  await h.enable();
  await h.start();
  const e = await h.call("begin", { name: "submit" });
  h.reopen();
  assert.equal(h.service.snapshot(h.ctx).runs[0].status, "interrupted");
  assert.equal(h.service.snapshot(h.ctx).runs[0].events[0].status, "uncertain");
  await assert.rejects(h.call("end", { ...e, status: "executed" }), /scope/);
  assert.deepEqual(await h.call("observeBegin", { name: "click" }), {
    recorded: false,
    candidates: [],
  });
});
test("a live writer lock prevents concurrent hosts and clear permanently removes scoped evidence", async (t) => {
  const h = await harness(t);
  assert.throws(
    () => createBrowserExperience({ dataDir: h.dir }),
    /already open/,
  );
  await h.enable();
  await h.draft();
  await h.review("clear");
  h.reopen();
  assert.equal(h.service.snapshot(h.ctx).runs.length, 0);
  assert.equal(h.service.snapshot(h.ctx).candidates.length, 0);
});
test("concurrent replay and review are rejected while a host result check is pending", async (t) => {
  const h = await harness(t);
  await h.enable();
  await h.start();
  let release, entered;
  const waiting = new Promise((r) => (entered = r));
  h.ctx.check = () => {
    entered();
    return new Promise((r) => (release = r));
  };
  const pending = h.call("verify", { checks });
  await waiting;
  await assert.rejects(h.call("verify", { checks }), /already running/);
  await assert.rejects(h.review("clear"), /Wait/);
  release(true);
  assert.equal((await pending).passed, true);
});
test("external suggestions are versioned drafts and cannot inject code or fabricated steps", async (t) => {
  const h = await harness(t);
  await h.enable();
  await h.draft();
  await assert.rejects(
    h.call("propose", {
      note: "Unverified action",
      format: 1,
      steps: [{ ...recipe, selector: "#different" }],
    }),
    /match/,
  );
  await assert.rejects(
    h.call("propose", { note: "Invalid version", format: 2 }),
    /format/,
  );
  await assert.rejects(
    h.call("perform", { recipe: { ...recipe, script: "steal()" } }),
    /new run|fields/,
  );
  const c = await h.call("propose", {
    note: "External advice is untrusted until reviewed.",
    source: "MCP fixture",
    format: 1,
    steps: [recipe],
  });
  assert.equal(c.status, "pending");
  assert.equal(c.versions[0].source, "MCP fixture");
  assert.equal(
    (await h.call("recall", { task: "Apply item" })).candidates.length,
    0,
  );
});
test("known candidate IDs cannot replay on another site or task", async (t) => {
  const h = await harness(t);
  await h.enable("replay");
  const c = await h.draft();
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  const foreign = { ...h.ctx, url: "https://another.test/" };
  await h.call("start", { task: "Apply item" }, foreign);
  assert.equal((await h.call("list", {}, foreign)).candidates.length, 0);
  await assert.rejects(h.call("replay", { id: c.id, version: 1 }, foreign), {
    error_code: "WIEK_EXPERIENCE_SCOPE",
  });
  await h.call("start", { task: "Another goal" });
  await assert.rejects(h.call("replay", { id: c.id, version: 1 }), {
    error_code: "WIEK_EXPERIENCE_SCOPE",
  });
  assert.equal(h.effects, 1);
});
test("replay preserves standard user-control hard stops", async (t) => {
  const h = await harness(t);
  await h.enable("replay");
  const c = await h.draft();
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  await h.start();
  h.ctx.check = async () => {
    throw Object.assign(Error("manual_takeover"), {
      error_code: "WIEK_TASK_SPACE_USER_IN_CONTROL",
    });
  };
  await assert.rejects(h.call("replay", { id: c.id, version: 1 }), {
    error_code: "WIEK_TASK_SPACE_USER_IN_CONTROL",
  });
  assert.equal(h.effects, 1);
  assert.equal(h.service.snapshot(h.ctx).runs[0].status, "suspended");
});
test("recovery automatically produces a pending hint, never an automatically enabled rule", async (t) => {
  const h = await harness(t);
  await h.enable();
  await h.start();
  const failed = await h.call("begin", { name: "click" });
  await h.call("end", { ...failed, status: "uncertain" });
  const done = await h.call("begin", { name: "click" });
  await h.call("end", { ...done, status: "executed" });
  const verified = await h.call("verify", { checks });
  const c = h.service
    .snapshot(h.ctx)
    .candidates.find((c) => c.id === verified.candidateId);
  assert.equal(c.status, "pending");
  assert.equal(c.versions[0].completeWorkflow, false);
  assert.ok(c.versions[0].evidence.includes(failed.operationId));
  assert.equal(
    (await h.call("recall", { task: "Apply item" })).candidates.length,
    0,
  );
});
test("consecutive partial steps preserve their checked order and never claim whole-task completion", async (t) => {
  const h = await harness(t);
  await h.enable("replay");
  await h.start();
  const one = await h.call("perform", { recipe }),
    two = await h.call("perform", {
      recipe: { ...recipe, selector: "#next", text: "Next" },
    });
  await h.call("verify", { checks });
  await assert.rejects(
    h.call("propose", { note: "Wrong order", eventIds: [two.id, one.id] }),
    /original order/,
  );
  await assert.rejects(
    h.call("propose", { note: "Unknown ID", eventIds: ["foreign"] }),
    /original order/,
  );
  const c = await h.call("propose", {
    note: "Only the first checked step.",
    eventIds: [one.id],
  });
  assert.equal(c.versions[0].completeWorkflow, false);
  assert.equal(c.versions[0].steps.length, 1);
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  await h.start();
  assert.deepEqual(await h.call("replay", { id: c.id, version: 1 }), {
    status: "verified",
    completed: 1,
    completeWorkflow: false,
  });
  assert.equal(
    (await h.call("propose", { note: "Do not promote a partial replay." }))
      .versions[0].completeWorkflow,
    false,
  );
});
test("repeated verified observations are counted as evidence, not as an asserted success rate", async (t) => {
  const h = await harness(t);
  await h.enable();
  await h.draft();
  const c = await h.draft();
  assert.equal(c.versions[0].observations, 2);
  assert.match(c.versions[0].signature, /^[a-f0-9]{64}$/);
});
test("MCP allowlists and resolved scopes apply to experience just like other browser capabilities", async (t) => {
  const h = await harness(t);
  await h.enable();
  const { createBrowserGateway } = createRequire(import.meta.url)(
    path.join(root, "app/mcp-service.cjs"),
  );
  const calls = [];
  const gateway = createBrowserGateway({
    resolveScope: async (s) => (s.projectId === "project" ? s : null),
    callbacks: {
      experience: async (input) => {
        calls.push(input);
        return h.call(input.arguments.action, input.arguments.payload, {
          ...h.ctx,
          projectId: input.scope.projectId,
        });
      },
    },
  });
  const scope = { projectId: "project", threadId: "thread" };
  assert.equal(gateway.tools()[0].name, "browser.experience");
  await gateway.call(
    "browser.experience",
    { action: "start", payload: { task: "Apply item" } },
    { scope },
  );
  assert.equal(calls[0].scope.projectId, "project");
  await assert.rejects(
    gateway.call(
      "browser.experience",
      { action: "list", profileId: "other" },
      { scope },
    ),
    /arguments/,
  );
  await assert.rejects(
    gateway.call(
      "browser.experience",
      { action: "list" },
      { scope, allowedMethods: [] },
    ),
    /allowlist/,
  );
  await assert.rejects(
    gateway.call(
      "browser.experience",
      { action: "list" },
      { scope: { projectId: "other", threadId: "thread" } },
    ),
    /Unknown/,
  );
  await assert.rejects(
    gateway.call(
      "browser.experience",
      {
        action: "review",
        payload: { id: "fake", version: 1, status: "enabled" },
      },
      { scope },
    ),
    /Settings/,
  );
});
test("normal automation does not get blocked by cross-origin navigation or an exhausted optional recorder", async (t) => {
  const h = await harness(t);
  await h.enable();
  await h.start();
  const e = await h.call("begin", { name: "navigate" });
  const foreign = { ...h.ctx, url: "https://another.test/" };
  assert.deepEqual(await h.call("observeRecall", {}, foreign), {
    recorded: false,
    candidates: [],
  });
  assert.equal(h.service.snapshot(h.ctx).runs[0].status, "origin-changed");
  assert.equal(
    h.service
      .snapshot(h.ctx)
      .runs[0].events.find((row) => row.id === e.operationId).status,
    "uncertain",
  );
  await h.start();
  for (let i = 0; i < 250; i++) {
    const op = await h.call("begin", { name: "click" });
    await h.call("end", { ...op, status: "executed" });
  }
  assert.equal(h.service.snapshot(h.ctx).runs[0].events.length, 250);
  // Use the advertised bound without writing a separate mirror of the implementation.
  const remaining = h.service.snapshot(h.ctx).limits.events - 250;
  for (let i = 0; i < remaining; i++) {
    const op = await h.call("observeBegin", { name: "click" });
    await h.call("end", { ...op, status: "executed" });
  }
  assert.deepEqual(await h.call("observeBegin", { name: "click" }), {
    recorded: false,
  });
});
test("a real crash after dispatch withdraws replay approval before the next host starts", async (t) => {
  const h = await harness(t);
  await h.enable("replay");
  const c = await h.draft();
  await h.review("review", { id: c.id, version: 1, status: "enabled" });
  h.service.close();
  const { fork } = await import("node:child_process"),
    { once } = await import("node:events");
  const script = path.join(h.dir, "crash.cjs");
  await fs.writeFile(
    script,
    `const {createBrowserExperience}=require(${JSON.stringify(path.join(root, "app/browser-experience.cjs"))});const service=createBrowserExperience({dataDir:${JSON.stringify(h.dir)}});const ctx=${JSON.stringify({ ...h.ctx, assertControl: undefined, check: undefined, execute: undefined })};ctx.check=async()=>true;ctx.execute=()=>{process.send('dispatched');return new Promise(()=>{});};(async()=>{await service.dispatch('start',{task:'Apply item'},ctx);await service.dispatch('replay',{id:${JSON.stringify(c.id)},version:1},ctx);})().catch(error=>{console.error(error);process.exit(1)});`,
  );
  const child = fork(script, { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  const dispatched = await Promise.race([
    once(child, "message"),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("Crash fixture did not dispatch")),
        5000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(dispatched[0], "dispatched");
  const ended = once(child, "exit");
  child.kill("SIGKILL");
  await ended;
  h.reopen();
  assert.equal(h.service.snapshot(h.ctx).candidates[0].status, "pending");
  assert.equal(h.service.snapshot(h.ctx).runs[0].status, "interrupted");
  await h.start();
  await assert.rejects(
    h.call("replay", { id: c.id, version: 1 }),
    /not enabled/,
  );
});

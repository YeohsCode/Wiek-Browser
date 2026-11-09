#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {prepareRegression,regressionSdk} from "../tools/run-sdk-regression.mjs";
import { e2eCases } from "./fixtures/sdk-original/scripts/real-browser-e2e/cases/index.mjs";
import { parseOnlyCases } from "./fixtures/sdk-original/scripts/real-browser-e2e/runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = join(root, "reports");
const sdkDirectory = join(root, "packages/sdk");
const runner = join(regressionSdk, "scripts/run-real-browser-e2e.mjs");
const sdkBundle = join(sdkDirectory, "dist/out/index.js");
const names = e2eCases.map(({ name }) => name);

export function parseArguments(argv) {
  let browser = "wiek";
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--browser") {
      browser = argv[++i];

      if (browser !== "wiek") throw new Error("--browser requires wiek; this runner uses the standalone runtime only");
    } else if (arg === "--only") {
      const name = argv[++i];
      if (!names.includes(name)) throw new Error(`--only requires an exact case name; got ${JSON.stringify(name)}. Available: ${names.join("; ")}`);
      only.push(name);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const selection = only.length ? JSON.stringify([...new Set(only)]) : process.env.WIEK_BROWSER_REAL_E2E_ONLY || "";
  const selected = parseOnlyCases(selection, names);
  return { browser, selection, selectedNames: selected.size ? [...selected] : [...names] };
}

export function parseSuiteOutput(output, selectedNames = names) {
  const selected = new Set(selectedNames);
  const section = output.slice(output.lastIndexOf("== E2E Summary =="));
  const table = section.includes("  Cases:") ? section.split("  Cases:")[1].split("  Failures:")[0] : "";
  const rows = new Map();
  for (const line of table.split(/\r?\n/)) {
    const match = line.match(/^\s+(.+?)\s+(?:(\d+(?:\.\d+)?)(ms|s)\s+)?(?:([0-9]+) assertions|-)\s+(PASS|FAIL|SKIP)\s*$/);
    if (!match || !names.includes(match[1])) continue;
    rows.set(match[1], {
      name: match[1], status: match[5].toLowerCase(),
      durationMs: match[2] ? Math.round(Number(match[2]) * (match[3] === "s" ? 1000 : 1)) : 0,
      assertionCount: Number(match[4] || 0), source: "upstream-summary",
    });
  }
  const cases = names.map((name) => rows.get(name) || {
    name, status: selected.has(name) ? "not_run" : "skip", durationMs: 0, assertionCount: 0,
    source: selected.has(name) ? "no-upstream-result" : "not-selected",
  });
  const count = (status) => cases.filter((item) => item.status === status).length;
  return { summaryPresent: table.length > 0, cases, counts: {
    total: names.length, selected: selectedNames.length, pass: count("pass"), fail: count("fail"),
    skip: count("skip"), notRun: count("not_run"), assertions: cases.reduce((sum, item) => sum + item.assertionCount, 0),
  } };
}

async function sha256(path) {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function runBrowser(browser, options) {
  const startedAt = new Date().toISOString();
  const logPath = join(reportsDir, `${browser}-e2e.log`);
  const stdoutPath = join(reportsDir, `${browser}-e2e.stdout.log`);
  const stderrPath = join(reportsDir, `${browser}-e2e.stderr.log`);
  const log = createWriteStream(logPath);
  const stdoutLog = createWriteStream(stdoutPath);
  const stderrLog = createWriteStream(stderrPath);
  let output = "";
  const append = (chunk, stream) => {
    const value = String(chunk); output += value; log.write(value);
    if (stream === "stderr") { stderrLog.write(value); process.stderr.write(value); }
    else { stdoutLog.write(value); process.stdout.write(value); }
  };
  // Always use a fresh, owned fixture profile; never attach to a caller's host.
  await mkdir(join(root, "data/browser-regression"), {recursive: true});
  const dataDir = await mkdtemp(join(root, "data/browser-regression/run-"));
  const env = {...process.env, WIEK_DATA_DIR: dataDir, VEK_DATA_DIR: dataDir};
  let cleanup = {status: "not-started"};
  let cli = null;
  let exitCode = null;
  let signal = null;
  let error = null;
  const start = Date.now();
  try {
    cli = resolve(process.env.WIEK_COMPARISON_CLI || process.env.VEK_COMPARISON_VEK_CLI || join(root, "cli/wiek-browser.mjs"));
    const info = await stat(cli);
    if (!info.isFile()) throw new Error(`CLI is not a regular file: ${cli}`);
    await access(cli, constants.X_OK);
    console.log(`\n== ${browser.toUpperCase()} comparison run ==\nCLI: ${cli}\nSelection: ${options.selection || "all cases"}`);
    const completion = await new Promise((resolveCompletion) => {
      const child = spawn(process.execPath, [runner], {
        cwd: regressionSdk,
        env: { ...env, WIEK_BROWSER_REAL_E2E_CLI: cli, WIEK_BROWSER_REAL_E2E_ONLY: options.selection },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => append(chunk, "stdout"));
      child.stderr.on("data", (chunk) => append(chunk, "stderr"));
      child.on("error", (failure) => { error = failure.stack || failure.message; append(`${error}\n`, "stderr"); });
      child.on("close", (code, terminationSignal) => resolveCompletion({ code, terminationSignal }));
    });
    exitCode = completion.code;
    signal = completion.terminationSignal;
  } catch (failure) {
    error = failure.stack || failure.message;
    append(`${error}\n`, "stderr");
  } finally {
    try {
      const runtime = JSON.parse(await readFile(join(dataDir, "runtime.json"), "utf8"));
      try { process.kill(runtime.pid, 0); } catch (failure) {
        if (failure.code !== "ESRCH") throw failure;
        cleanup = {status: "already-exited"};
      }
      if (cleanup.status !== "already-exited") {
        cleanup = {status: "stopping", pid: runtime.pid};
        await new Promise((done, reject) => execFile(process.execPath, [cli, "stop", "--timeout-ms", "30000"], {env, timeout: 35000}, failure => failure ? reject(failure) : done()));
        cleanup = {status: "stopped", pid: runtime.pid};
      }
    } catch (failure) {
      if (failure.code !== "ENOENT" || cleanup.status === "stopping") {
        cleanup = {status: "failed", error: failure.message};
        error ||= "Fixture host cleanup failed: " + failure.message;
        append(error + "\n", "stderr");
      }
    }
    await Promise.all([log, stdoutLog, stderrLog].map((stream) => new Promise((done, reject) => {
      stream.on("error", reject); stream.end(done);
    })));
  }
  const parsed = parseSuiteOutput(output, options.selectedNames);
  const selected = parsed.cases.filter(({ name }) => options.selectedNames.includes(name));
  const passed = exitCode === 0 && !error && parsed.summaryPresent && selected.every(({ status }) => status === "pass");
  const result = { browser, status: passed ? "pass" : "fail", startedAt, endedAt: new Date().toISOString(),
    wallTimeMs: Date.now() - start, cli, cliSha256: cli ? await sha256(cli) : null,
    command: [process.execPath, runner], sdkPath: sdkBundle, sdkSha256: await sha256(sdkBundle),
    fixtureSha256: await sha256(join(root,"tests/fixtures/sdk-original/scripts/real-browser-e2e/fixture.mjs")),
    suiteIndexSha256: await sha256(join(root,"tests/fixtures/sdk-original/scripts/real-browser-e2e/cases/index.mjs")),
    dataDir, cleanup, exitCode, signal, error, logPath, stdoutPath, stderrPath, ...parsed };
  await writeFile(join(reportsDir, `${browser}-e2e.json`), JSON.stringify(result, null, 2) + "\n");
  return result;
}

function cell(value) { return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " "); }

export function comparisonMarkdown(report) {
  const lines=["# Wiek Browser 独立运行测试", "", `生成时间：${report.generatedAt}`, "", "使用原始测试的隔离名称映射版本；断言、用例和超时阈值不变。SKIP 和未运行均不计为通过；不等同31项在线模型评估。", "", "| 浏览器 | PASS | FAIL | SKIP | 未运行 | 断言 |", "|---|---:|---:|---:|---:|---:|"];
  for(const run of report.runs)lines.push(`| Wiek | ${run.counts.pass} | ${run.counts.fail} | ${run.counts.skip} | ${run.counts.notRun} | ${run.counts.assertions} |`);
  lines.push("", "| Case | Wiek |", "|---|---|");
  for(const name of names){const item=report.runs[0]?.cases.find(row=>row.name===name);lines.push(`| ${cell(name)} | ${item?.status||'not_run'} |`);}
  lines.push("", "详细身份和日志见[结构化记录](comparison.json)。原始输入身份见[sdk-test-lineage.json](sdk-test-lineage.json)。线上模型评估未运行（blocked）：仍缺专用模型与账号。", "");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log('Usage: npm run test:e2e -- [--browser wiek] [--only "exact case name"]\nRepeat --only for multiple exact names. CLI override: WIEK_COMPARISON_CLI.');
    return;
  }
  await mkdir(reportsDir, { recursive: true });
  const runs = [];
  await prepareRegression();
  runs.push(await runBrowser("wiek",options));
  const report = {schemaVersion:2,generatedAt:new Date().toISOString(),suite:"Wiek standalone real-browser-e2e",selectedNames:options.selectedNames,comparable:false,namespaceMappedInputs:true,runs};
  await writeFile(join(reportsDir, "comparison.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(reportsDir, "comparison.md"), comparisonMarkdown(report));
  console.log(`\nComparison saved to ${join(reportsDir, "comparison.md")}`);
  if (runs.some((run) => run.status !== "pass")) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

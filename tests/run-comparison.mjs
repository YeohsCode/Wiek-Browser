#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { e2eCases } from "../packages/sdk/scripts/real-browser-e2e/cases/index.mjs";
import { parseOnlyCases } from "../packages/sdk/scripts/real-browser-e2e/runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = join(root, "reports");
const sdkDirectory = join(root, "packages/sdk");
const runner = join(sdkDirectory, "scripts/run-real-browser-e2e.mjs");
const sdkBundle = join(sdkDirectory, "dist/out/index.js");
const names = e2eCases.map(({ name }) => name);

export function parseArguments(argv) {
  let browser = "both";
  const only = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--browser") {
      browser = argv[++i];
      browser=({reference:'ego',wiek:'vek'})[browser]||browser;
      if (!["ego", "vek", "both"].includes(browser)) throw new Error("--browser requires reference, wiek, or both");
    } else if (arg === "--only") {
      const name = argv[++i];
      if (!names.includes(name)) throw new Error(`--only requires an exact case name; got ${JSON.stringify(name)}. Available: ${names.join("; ")}`);
      only.push(name);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const selection = only.length ? JSON.stringify([...new Set(only)]) : process.env.EGO_BROWSER_REAL_E2E_ONLY || "";
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

async function resolveEgoCli() {
  if (process.env.WIEK_REFERENCE_CLI) return resolve(process.env.WIEK_REFERENCE_CLI);
  if (process.env.VEK_COMPARISON_EGO_CLI) return resolve(process.env.VEK_COMPARISON_EGO_CLI);
  const versions = join(root, "downloads/ego/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions");
  const current = join(versions, "Current/Helpers/ego-browser");
  try { await access(current, constants.X_OK); return current; } catch {}
  const candidates = [];
  try {
    for (const name of (await readdir(versions)).sort()) {
      if (name === "Current") continue;
      const candidate = join(versions, name, "Helpers/ego-browser");
      try { await access(candidate, constants.X_OK); candidates.push(candidate); } catch {}
    }
  } catch {}
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error('Multiple reference CLI versions found. Set WIEK_REFERENCE_CLI to the intended executable.');
  throw new Error('Reference CLI is missing or not executable. Set WIEK_REFERENCE_CLI to the intended executable.');
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
  let cli = null;
  let exitCode = null;
  let signal = null;
  let error = null;
  const start = Date.now();
  try {
    cli = browser === "ego" ? await resolveEgoCli() : resolve(process.env.WIEK_COMPARISON_CLI || process.env.VEK_COMPARISON_VEK_CLI || join(root, "cli/wiek-browser.mjs"));
    const info = await stat(cli);
    if (!info.isFile()) throw new Error(`CLI is not a regular file: ${cli}`);
    await access(cli, constants.X_OK);
    console.log(`\n== ${browser.toUpperCase()} comparison run ==\nCLI: ${cli}\nSelection: ${options.selection || "all cases"}`);
    const completion = await new Promise((resolveCompletion) => {
      const child = spawn(process.execPath, [runner], {
        cwd: sdkDirectory,
        env: { ...process.env, EGO_BROWSER_REAL_E2E_CLI: cli, EGO_BROWSER_REAL_E2E_ONLY: options.selection },
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
    fixtureSha256: await sha256(join(sdkDirectory, "scripts/real-browser-e2e/fixture.mjs")),
    suiteIndexSha256: await sha256(join(sdkDirectory, "scripts/real-browser-e2e/cases/index.mjs")),
    exitCode, signal, error, logPath, stdoutPath, stderrPath, ...parsed };
  await writeFile(join(reportsDir, `${browser}-e2e.json`), JSON.stringify(result, null, 2) + "\n");
  return result;
}

function cell(value) { return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " "); }

export function comparisonMarkdown(report) {
  const label=browser=>browser==='vek'?'Wiek':'参考侧';
  const lines = ["# Wiek Browser 同集测试对比", "", `生成时间：${report.generatedAt}`, "",
    "使用未改断言的上游真实浏览器 E2E runner 与本地 fixture，串行执行；两侧使用相同 SDK，本地修复见 ../analysis/sdk-changes.md。SKIP 和未运行均不计为通过；本结果不等同 31 项在线模型 benchmark。", "",
    `选择：${report.selectedNames.length}/${names.length} 个 cases。${report.comparable ? "两侧 SDK、fixture 和 case 索引哈希一致。" : "尚无两侧相同 SDK、fixture、case 索引的完整运行证据。"}`, "",
    "| 浏览器 | 运行状态 | PASS | FAIL | SKIP | 未运行 | 断言 | 退出码 | 总用时 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const run of report.runs) lines.push(`| ${label(run.browser)} | ${run.status} | ${run.counts.pass} | ${run.counts.fail} | ${run.counts.skip} | ${run.counts.notRun} | ${run.counts.assertions} | ${cell(run.exitCode)} | ${(run.wallTimeMs / 1000).toFixed(1)}s |`);
  lines.push("", "| Case | 参考侧 | Wiek |", "|---|---|---|");
  for (const name of names) {
    const status = (browser) => {
      const item = report.runs.find((run) => run.browser === browser)?.cases.find((row) => row.name === name);
      return item ? `${item.status}${item.status === "pass" || item.status === "fail" ? ` (${item.assertionCount} assertions, ${item.durationMs}ms)` : ""}` : "not_run";
    };
    lines.push(`| ${cell(name)} | ${status("ego")} | ${status("vek")} |`);
  }
  lines.push("", "## 可审计产物", "");
  for (const run of report.runs) {
    lines.push(`- **${label(run.browser)}**：SDK SHA-256：\`${run.sdkSha256 || "未生成"}\`。CLI 身份、完整诊断及日志索引见[结构化记录](comparison.json)。`);
    if (run.error) lines.push('  启动失败；完整错误保存在结构化记录中。');
  }
  lines.push("", "## 在线 benchmark", "", "未运行（blocked）：本次没有为 Stage A 与 Judge 提供已确认可用的模型认证，也未确认五类第三方网站登录。未读取个人 API key。框架与 31 项任务已下载；详细前提见 ../analysis/public-api-and-tests.md。", "");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log('Usage: npm run test:e2e -- [--browser reference|wiek|both] [--only "exact case name"]\nRepeat --only for multiple exact names. CLI overrides: WIEK_REFERENCE_CLI, WIEK_COMPARISON_CLI.');
    return;
  }
  await mkdir(reportsDir, { recursive: true });
  const runs = [];
  for (const browser of options.browser === "both" ? ["ego", "vek"] : [options.browser]) runs.push(await runBrowser(browser, options));
  const [ego, vek] = [runs.find((run) => run.browser === "ego"), runs.find((run) => run.browser === "vek")];
  const comparable = Boolean(ego && vek && ego.sdkSha256 && ego.sdkSha256 === vek.sdkSha256 && ego.fixtureSha256 === vek.fixtureSha256 && ego.suiteIndexSha256 === vek.suiteIndexSha256 && ego.summaryPresent && vek.summaryPresent && [ego, vek].every((run) => options.selectedNames.every((name) => run.cases.find((item) => item.name === name)?.source === "upstream-summary")));
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), suite: "ego-lite real-browser-e2e", selectedNames: options.selectedNames, comparable, runs };
  await writeFile(join(reportsDir, "comparison.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(reportsDir, "comparison.md"), comparisonMarkdown(report));
  console.log(`\nComparison saved to ${join(reportsDir, "comparison.md")}`);
  if (runs.some((run) => run.status !== "pass")) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

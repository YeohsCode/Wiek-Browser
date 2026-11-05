import test from "node:test";
import assert from "node:assert/strict";
import { parseArguments, parseSuiteOutput, comparisonMarkdown } from "./run-comparison.mjs";

test("upstream summary parsing preserves pass, fail, skip and absent selected cases", () => {
  const parsed = parseSuiteOutput(`
noise: PASS
== E2E Summary ==
  Passed: 1/69
  Cases:
    environment initialization       2.1s    25 assertions  PASS
    helper surface                    120ms    4 assertions  FAIL
    navigation helpers                           -  SKIP

  Failures:
    - helper surface: failure with misleading PASS text
`, ["environment initialization", "helper surface", "task spaces and control"]);
  assert.equal(parsed.summaryPresent, true);
  assert.equal(parsed.counts.pass, 1);
  assert.equal(parsed.counts.fail, 1);
  assert.equal(parsed.counts.notRun, 1);
  assert.equal(parsed.counts.assertions, 29);
  assert.equal(parsed.cases.find((item) => item.name === "environment initialization").durationMs, 2100);
  assert.equal(parsed.cases.find((item) => item.name === "navigation helpers").status, "skip");
});

test("startup failure creates no invented passing result", () => {
  const parsed = parseSuiteOutput("Error: executable not found\n", ["helper surface"]);
  assert.equal(parsed.summaryPresent, false);
  assert.equal(parsed.counts.pass, 0);
  assert.equal(parsed.counts.notRun, 1);
  assert.equal(parsed.counts.skip, 68);
});

test("exact case names containing commas survive CLI selection", () => {
  const options = parseArguments(["--browser", "vek", "--only", "wait, fetch, cdp, js, help"]);
  assert.deepEqual(options.selectedNames, ["wait, fetch, cdp, js, help"]);
  assert.deepEqual(JSON.parse(options.selection), options.selectedNames);
  assert.throws(() => parseArguments(["--only", "wait"]), /exact case name/);
  assert.throws(() => parseArguments(["--browser", "other"]), /requires reference, wiek, or both/);
});
test('public browser selectors preserve compatibility with saved run identifiers',()=>{
  assert.equal(parseArguments(['--browser','wiek']).browser,'vek');
  assert.equal(parseArguments(['--browser','reference']).browser,'ego');
  assert.equal(parseArguments(['--browser','both']).browser,'both');
});

test("single-browser Markdown leaves the counterpart unrun and documents evidence limitations", () => {
  const parsed = parseSuiteOutput("", ["helper surface"]);
  const report = { generatedAt: "2026-10-30T00:00:00Z", comparable: false,
    selectedNames: ["helper surface"], runs: [{ browser: "vek", status: "fail", ...parsed,
      wallTimeMs: 0, exitCode: null, cli: null, sdkSha256: null, error: "missing executable" }] };
  const markdown = comparisonMarkdown(report);
  assert.match(markdown, /helper surface \| not_run \| not_run/);
  assert.match(markdown, /SKIP 和未运行均不计为通过/);
  assert.match(markdown, /未运行（blocked）/);
});

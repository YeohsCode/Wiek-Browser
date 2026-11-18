import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
test(
  "actual Wiek SDK, trusted settings and Chromium replay validate two rounds and changed-page effects",
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "wiek-experience-host-"));
    try {
      const env = {
        ...process.env,
        WIEK_DATA_DIR: dir,
        VEK_DATA_DIR: dir,
        WIEK_TEST_NODE: process.execPath,
        WIEK_EXPERIENCE_APP_ROOT:
          process.env.WIEK_EXPERIENCE_APP_ROOT ||
          resolve(import.meta.dirname, ".."),
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(
        require("electron"),
        [join(import.meta.dirname, "fixtures/browser-experience-host.cjs")],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 85000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
      } finally {
        clearTimeout(timeout);
      }
      assert.equal(code, 0, output);
      assert.match(output, /"experienceHost":true/);
      const report = JSON.parse(
        output
          .split("\n")
          .find((line) => line.includes('"experienceHost":true')),
      );
      assert.ok(report.assertions >= 22);
      assert.equal(report.wrongResultDispatches, 1);
      assert.equal(report.comparison.modelCalls, 0);
      console.log('EXPERIENCE_COMPARISON ' + JSON.stringify(report));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

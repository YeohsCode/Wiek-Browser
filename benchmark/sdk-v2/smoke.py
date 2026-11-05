#!/usr/bin/env python3
"""Exercise the actual framework adapter/hooks against loopback fixtures only."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = b"<!doctype html><title>Stage A adapter local fixture</title><h1>Full canonical adapter fixture</h1><button>Local only</button>"
sha = lambda data: hashlib.sha256(data).hexdigest()


@contextmanager
def environment(values):
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None: os.environ.pop(key, None)
            else: os.environ[key] = value


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers(); self.wfile.write(FIXTURE)
    def log_message(self, *_args):
        pass


def run(reference: Path, browsers: list[str], ego_binary: Path | None) -> dict:
    from apply import install
    installed = install(reference)
    sys.path.insert(0, str(reference.resolve()))
    from ego_bench.browser_tools import get_browser_tool
    from ego_bench.browser_tools.ego_browser import probe_runtime_contract, validate_skill_runtime_contract
    from ego_bench.hooks import pi_extension_helper as hook
    from ego_bench.browser_tools.canonical_v2 import marker_payload
    sdk = ROOT / "packages/sdk/dist/out/index.js"
    report = {"onlineBenchmark": False, "modelCalls": 0, "accountActions": 0,
              "sdkSha256": sha(sdk.read_bytes()), "adapter": installed,
              "fixtureSha256": sha(FIXTURE), "runs": []}
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    url = f"http://127.0.0.1:{server.server_port}/"
    try:
        for browser in browsers:
            own = ROOT / "data/benchmark-framework-v2" / uuid.uuid4().hex
            own.mkdir(parents=True)
            binary = ROOT / "cli/wiek-browser.mjs" if browser == "wiek" else ROOT / "tools/ego-reference-cli"
            run_report = {"browser": browser, "passed": False, "cliSha256": sha(binary.read_bytes()), "checks": []}
            report["runs"].append(run_report)
            process = None
            task_id = "framework-smoke-" + uuid.uuid4().hex
            values = {"EGO_BROWSER_BIN": str(binary), "EGO_BENCH_TASK_ID": task_id,
                      "EGO_BENCH_BROWSER_TOOL": "ego-browser", "EGO_BENCH_BROWSER_TOOL_MODE": "strict",
                      "EGO_BENCH_EGO_BROWSER_RUNTIME_CONTRACT": "canonical-sdk-v2",
                      "EGO_BENCH_EGO_BROWSER_SDK_PATH": str(sdk), "WIEK_DATA_DIR": str(own / "wiek"), "VEK_DATA_DIR": str(own / "wiek"),
                      "WIEK_REFERENCE_VERSION": "0.6.2.7", "EGO_BENCH_BROWSER_STATE_PATH": str(own / "state.json"),
                      "EGO_BENCH_SCREENSHOT_FRAMES_DIR": str(own / "frames")}
            with environment(values):
                try:
                    if browser == "ego":
                        if not ego_binary or not ego_binary.is_file(): raise RuntimeError("Explicit Ego application binary required")
                        # A private named instance/profile prevents the framework from
                        # ever attaching to the user's default browser session.
                        # This explicit fixture profile was initialized for earlier
                        # reference tests. A brand-new profile stops at onboarding
                        # (rc=0 without executing JS); never bypass that gate.
                        profile = ROOT / "data/ego-reference"
                        if not profile.is_dir(): raise RuntimeError("Initialized dedicated Ego fixture profile required")
                        run_report["referenceProfile"] = "data/ego-reference"
                        arguments = [str(ego_binary), "--user-data-dir=" + str(profile), "--ego-server-name=vek-reference", "--no-first-run"]
                        log = (own / "ego-launch.log").open("w")
                        process = subprocess.Popen(arguments, stdout=log, stderr=subprocess.STDOUT)
                        log.close()
                        for attempt in range(20):
                            if process.poll() is not None: raise RuntimeError("Owned Ego process exited during startup")
                            try:
                                contract = probe_runtime_contract(bin_path=str(binary), sdk_path=sdk, timeout_seconds=5)
                                break
                            except RuntimeError:
                                if attempt == 19: raise
                                time.sleep(.5)
                    else:
                        contract = probe_runtime_contract(bin_path=str(binary), sdk_path=sdk)
                    assert contract.value == "canonical-sdk-v2", contract
                    os.environ["EGO_BENCH_EGO_BROWSER_RUNTIME_CONTRACT"] = contract.value
                    validate_skill_runtime_contract(skill_path=sdk.parent / "ego-browser/SKILL.md", sdk_path=sdk, runtime_contract=contract)
                    tool = get_browser_tool("ego-browser")
                    def execute(source):
                        marker = uuid.uuid4().hex
                        code = "const __run=async()=>{" + source + "\n};const result=await __run();console.log(JSON.stringify({canonicalMarker:" + json.dumps(marker) + ",result}));"
                        return marker_payload(tool._run_nodejs(code), marker)["result"]
                    before = execute("return (await listTaskSpaces()).length;")
                    probe_runtime_contract(bin_path=str(binary), sdk_path=sdk)
                    assert execute("return (await listTaskSpaces()).length;") == before
                    run_report["checks"].append({"probe": contract.value, "zeroMutation": True, "pairedSkill": True})
                    create = f"const task=await taskSpace({json.dumps(task_id)});await task.page('p1').goto({json.dumps(url)});return {{id:task.id,version:await ego.getBrowserVersion(),layout:await task.page('p1').cdp('Page.getLayoutMetrics',{{}})}};"
                    created = execute(create)
                    run_report["hostVersion"] = created["version"]
                    source = f"const task=await taskSpace({json.dumps(task_id)});console.log(await task.page('p1').title());"
                    command = shlex.join([str(binary), "nodejs", "--sdk-path", str(sdk), "-e", source])
                    assert hook.cmd_validate(command) == 0
                    assert hook.cmd_screenshot(command) == 0
                    frames = own / "frames"
                    assert not (frames / "errors.jsonl").exists(), (frames / "errors.jsonl").read_text()
                    manifest = [json.loads(line) for line in (frames / "manifest.jsonl").read_text().splitlines()]
                    assert len(manifest) == 1
                    capture = frames / "001.png"
                    receipt = json.loads((frames / "001.png.receipt.json").read_text())
                    assert receipt["spaceId"] == created["id"]
                    assert receipt["viewport"]["width"] == 1280 and receipt["viewport"]["height"] == 800
                    trees = list((frames / "trees").glob("*.json"))
                    assert trees and "Full canonical adapter fixture" in trees[0].read_text()
                    after = execute(f"const task=await taskSpace({json.dumps(task_id)});return await task.page('p1').cdp('Page.getLayoutMetrics',{{}});")
                    assert after["cssLayoutViewport"] == created["layout"]["cssLayoutViewport"], "Device metrics were not restored"
                    output = ROOT / "reports/benchmark-v2" / f"{browser}-framework.png"
                    output.write_bytes(capture.read_bytes())
                    output.with_suffix(".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
                    run_report["checks"].append({"strictHook": True, "screenshotHook": True, "pngSha256": sha(capture.read_bytes()), "pngBytes": capture.stat().st_size, "ax": True, "viewportRestored": True, "receipt": receipt})
                    assert hook.cmd_validate(tool.cleanup_command(task_id)) == 0
                    close = tool.close_targets(instance_id=task_id)
                    assert close.ok, close
                    assert tool.close_targets(instance_id=task_id).ok
                    assert execute("return (await listTaskSpaces()).length;") == before
                    run_report["checks"].append({"closed": json.loads(close.stdout_tail), "missingCleanupIdempotent": True})
                    run_report["passed"] = True
                except Exception as exc:
                    run_report["error"] = str(exc)
                finally:
                    try:
                        cleanup = get_browser_tool("ego-browser").close_targets(instance_id=task_id)
                        run_report["finalCleanup"] = {"ok": cleanup.ok, "error": cleanup.error}
                    except Exception as exc:
                        run_report["cleanupError"] = str(exc)
                    if browser == "wiek":
                        subprocess.run([str(binary), "stop"], capture_output=True, text=True, timeout=30)
                    if process and process.poll() is None:
                        process.send_signal(signal.SIGTERM)
                        try: process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill(); process.wait(timeout=5)
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)
    report["passed"] = all(row["passed"] for row in report["runs"])
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--browser", choices=["wiek", "ego", "both"], required=True)
    parser.add_argument("--ego-binary", type=Path)
    args = parser.parse_args()
    report = run(args.reference, ["ego", "wiek"] if args.browser == "both" else [args.browser], args.ego_binary)
    (ROOT / "reports/p4-sdk-v2-framework-smoke.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["passed"] else 1)

"""Shared canonical SDK V2 integration for the pinned MIT benchmark framework.

No model calls, website credentials, host-specific fallbacks or ownership changes.
Installed alongside wiek_browser.py by apply.py; legacy contracts stay upstream.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import struct
import subprocess
import tempfile
import uuid

from .base import CloseResult

VIEWPORT = {"width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": False}
DIRECTORY = Path(__file__).parent


def control_source() -> str:
    return (DIRECTORY / "_canonical_control.mjs").read_text().replace(
        "export function createBenchmarkV2", "function createBenchmarkV2", 1
    ) + "\nconst control=createBenchmarkV2({listTaskSpaces,taskSpace});\n"


def parse_script(source: str, task_id: str | None = None) -> dict:
    node = os.environ.get("WIEK_BENCH_V2_NODE") or shutil.which("node")
    if not node:
        return {"ok": False, "error": "Node.js is required for the canonical V2 syntax guard"}
    try:
        proc = subprocess.run(
            [node, str(DIRECTORY / "_canonical_guard.mjs")],
            input=json.dumps({"source": source, "taskId": task_id}),
            text=True, capture_output=True, timeout=5,
        )
        result = json.loads(proc.stdout)
        return result if isinstance(result, dict) else {"ok": False, "error": "Invalid syntax guard result"}
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": f"Canonical syntax guard failed: {exc}"}


def inline_script(command: str, binary: str) -> tuple[list[str], str | None]:
    """Accept the documented, shell-quoted nodejs -e form; no file/redirect guessing."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        return [], None
    indices = [i for i, token in enumerate(tokens) if token == binary or Path(token).name == Path(binary).name]
    if len(indices) != 1:
        return tokens, None
    args = tokens[indices[0] + 1:]
    if not args or args[0] != "nodejs":
        return args, None
    source = None
    i = 1
    while i < len(args):
        if args[i] in ("-e", "--eval") and i + 1 < len(args) and source is None:
            source = args[i + 1]; i += 2
        elif args[i] == "--sdk-path" and i + 1 < len(args):
            i += 2
        else:
            return args, None
    return args, source


def validate_invocation(tool, command: str, task_id: str, mode: str) -> str | None:
    args, source = inline_script(command, tool.bin())
    if source is None:
        return "Canonical V2 requires nodejs --sdk-path <pinned SDK> -e <quoted script>"
    # Exact harness cleanup is generated from the same bounded control factory.
    # It lists existing spaces and resolves only this task, never creates one.
    if shlex.split(command) == shlex.split(tool.cleanup_command(task_id)):
        return None
    from .wiek_browser import _sdk_path_from_env
    if args.count("--sdk-path") != 1 or args[args.index("--sdk-path") + 1] != _sdk_path_from_env():
        return "Canonical V2 command must pin this run's SDK with --sdk-path"
    parsed = parse_script(source, task_id)
    return None if parsed.get("ok") else str(parsed.get("error", "Invalid canonical V2 command"))


def extract_candidates(tool, command: str) -> list:
    _args, source = inline_script(command, tool.bin())
    result = parse_script(source if source is not None else command)
    return result.get("candidates", []) if result.get("ok") else []


def mentions_release(tool, command: str) -> bool:
    _args, source = inline_script(command, tool.bin())
    if source is None:
        source = command
    result = parse_script(source)
    return result.get("release", False) if result.get("ok") else False


def candidates(tool, instance_id: str | None) -> list:
    # A strict run may only capture/close its exact task. In off mode preserve
    # numeric IDs as numbers rather than silently treating them as task names.
    if os.environ.get("WIEK_BENCH_BROWSER_TOOL_MODE", "strict").lower() != "off":
        if not instance_id:
            raise RuntimeError("Canonical V2 requires an exact task name")
        return [instance_id]
    values = []
    state = os.environ.get("WIEK_BENCH_BROWSER_STATE_PATH")
    if state and Path(state).is_file():
        for value in json.loads(Path(state).read_text()).get("taskspaces", []):
            if type(value) not in (str, int) or value in values:
                continue
            values.append(value)
    if instance_id and instance_id not in values:
        values.append(instance_id)
    return values


def close_js(values: list, marker: str = "") -> str:
    return control_source() + (
        f"const results=await control.close({json.dumps(values)});\n"
        f"console.log(JSON.stringify({{wiekBenchClose:results,canonicalMarker:{json.dumps(marker)}}}));\n"
    )


def purge_js() -> str:
    return control_source() + """
const result={total:0,closed:[],kept:[],failed:[],error:null};
try {
  const spaces=await listTaskSpaces();result.total=spaces.length;
  for(const space of spaces){
    const label=space.name||String(space.id);
    if(space.ownership!=='agent'){result.kept.push(label);continue;}
    const [row]=await control.close([space.id]);
    if(row.ok)result.closed.push(label);else result.failed.push({space:label,...row});
  }
}catch(error){result.error=String(error.message||error);}
console.log(JSON.stringify({wiekBenchPurgeSpaces:result}));
"""


def screenshot_js(params: dict, output: str, values: list, tree: str | None, marker: str) -> str:
    return control_source() + f"""
const capture=await control.capture({json.dumps(values)},{json.dumps(params)},{{viewport:{json.dumps(VIEWPORT)}}});
const fs=await import('node:fs');
const crypto=await import('node:crypto');
const bytes=Buffer.from(capture.data,'base64');
if(bytes.length<24)throw new Error('Invalid screenshot bytes');
fs.writeFileSync({json.dumps(output)},bytes);
if({json.dumps(tree)}&&capture.ax&&Array.isArray(capture.ax.nodes))fs.writeFileSync({json.dumps(tree)},JSON.stringify(capture.ax));
console.log(JSON.stringify({{canonicalMarker:{json.dumps(marker)},spaceId:capture.spaceId,targetId:capture.targetId,viewport:capture.viewport,axError:capture.axError,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}}));
"""


def marker_payload(proc, marker: str) -> dict:
    if proc.returncode != 0:
        raise RuntimeError(f"Canonical V2 CLI failed (rc={proc.returncode}): {proc.stderr[-500:]}")
    for line in (proc.stdout + "\n" + proc.stderr).splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("canonicalMarker") == marker:
            return value
    raise RuntimeError(f"Canonical V2 result marker missing: {proc.stderr[-500:]}")


def capture(tool, *, instance_id, output_path, params, tree_output_path=None) -> None:
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    marker = uuid.uuid4().hex
    # Every call owns fresh temporary output; a stale final file is never proof.
    with tempfile.TemporaryDirectory(prefix=".canonical-v2-", dir=destination.parent) as temporary:
        image = Path(temporary) / "capture"
        tree = Path(temporary) / "tree.json" if tree_output_path else None
        proc = tool._run_nodejs(screenshot_js(params.to_cdp(), str(image), candidates(tool, instance_id), str(tree) if tree else None, marker))
        receipt = marker_payload(proc, marker)
        if not image.is_file():
            raise RuntimeError("Canonical V2 produced no fresh screenshot")
        data = image.read_bytes()
        if hashlib.sha256(data).hexdigest() != receipt.get("sha256"):
            raise RuntimeError("Canonical V2 screenshot hash mismatch")
        if receipt.get("viewport") != VIEWPORT or not receipt.get("targetId") or type(receipt.get("spaceId")) is not int:
            raise RuntimeError("Canonical V2 screenshot scope receipt missing")
        if params.format == "png":
            if data[:8] != b"\x89PNG\r\n\x1a\n" or len(data) < 24 or struct.unpack(">II", data[16:24]) != (VIEWPORT["width"], VIEWPORT["height"]):
                raise RuntimeError("Canonical V2 PNG does not match the fixed viewport")
        elif not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
            raise RuntimeError("Canonical V2 invalid JPEG")
        os.replace(image, destination)
        if tree_output_path:
            Path(tree_output_path).unlink(missing_ok=True)
            if tree and tree.is_file():
                Path(tree_output_path).parent.mkdir(parents=True, exist_ok=True)
                os.replace(tree, tree_output_path)
        destination.with_suffix(destination.suffix + ".receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")


def close(tool, *, instance_id) -> CloseResult:
    command = "canonical SDK V2 task.finish({keep:[]})"
    try:
        values = candidates(tool, instance_id)
        marker = uuid.uuid4().hex
        proc = tool._run_nodejs(close_js(values, marker))
        receipt = marker_payload(proc, marker)
        rows = receipt.get("wiekBenchClose")
        if not isinstance(rows, list) or len(rows) != len(values) or any(row.get("candidate") != value for row, value in zip(rows, values, strict=True)):
            raise RuntimeError("Canonical V2 close receipt scope mismatch")
        ok = all(row.get("ok") is True and (row.get("notFound") is True or row.get("receipt", {}).get("closedSpace") is True) for row in rows)
        return CloseResult(ok=ok, close_command=command, raw_returncode=proc.returncode,
                           stdout_tail=json.dumps(receipt), stderr_tail=proc.stderr[-500:],
                           error=None if ok else "Canonical cleanup incomplete; protected pages or control boundary retained")
    except subprocess.TimeoutExpired as exc:
        return CloseResult.timeout(command, exc=exc, timeout_s=25)
    except Exception as exc:
        return CloseResult(ok=False, close_command=command, error=str(exc))

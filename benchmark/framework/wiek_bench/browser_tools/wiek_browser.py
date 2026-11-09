"""wiek-browser (wiek-lite) nodejs helper and task-space model.

Legacy releases expose the global ``useOrCreateTaskSpace``,
``switchTaskSpace``, and ``completeTaskSpace`` functions. Playwright-style
runtimes expose the ``taskSpaces.*`` facade. Stage A runs a side-effect-free
capability probe against the pinned ``index.js`` and selects one run-level
contract. Candidate parsing accepts both input dialects, while screenshot,
close, and cleanup execution use only the selected contract and never fall
back based on an exception.

A task space is process-local runtime state inside ``wiek-browser nodejs``; it
is not a handle that a CLI flag can pass between processes. Two observed
constraints determine the EngineControl transport:

- ``wiek-browser taskspace close <X>`` accepts only numeric ids. A string
  produces ``Invalid task id`` with exit code 0 and closes nothing. The harness
  owns a string ``task_id``, and with the guard disabled the agent may create a
  space under a descriptive name, so native taskspace close is insufficient.
- ``--taskspace=<name>`` does not create a missing space. It leaves the runtime
  unselected and cannot discover an existing space.

Close and screenshot therefore use ``wiek-browser nodejs`` without
``--taskspace`` and with the run-pinned ``--sdk-path``. JavaScript switches
through the selected contract before calling
``cdp(Page.captureScreenshot)`` or completing each candidate. A missing
candidate is an idempotent success. The screenshot hook parses candidates from
both input dialects and stores their union in
``browser_state/<task_id>.json``; ``task_id`` is only a fallback candidate.

Two additional runtime constraints shape the implementation:

- The nodejs process inherits only standard environment variables, so custom
  arguments are serialized directly into the JavaScript source instead of
  read through ``process.env``.
- The runtime wraps ``nodejs -e`` in an AsyncFunction and awaits only top-level
  await. Use top-level ``await`` rather than an unawaited async IIFE. Because
  top-level await conflicts with CommonJS ``require``, file operations use
  ``await import('node:fs')``.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
from enum import Enum
from pathlib import Path

from .base import (
    CdpScreenshotParams,
    CloseResult,
    InvocationContext,
    parse_flag_invocation,
    resolve_bin,
)

_VALUE_FLAGS = {
    "--taskspace",
    "--screenshot-dir",
    "--screenshot-format",
    "--screenshot-quality",
    "--profile",
    "--proxy",
    "--sdk-path",
}
_NODEJS_TIMEOUT = 25.0
RUNTIME_CONTRACT_ENV = "WIEK_BENCH_WIEK_BROWSER_RUNTIME_CONTRACT"
SDK_PATH_ENV = "WIEK_BENCH_WIEK_BROWSER_SDK_PATH"


class WiekBrowserRuntimeContract(str, Enum):
    """Machine-selected helper surface for one complete Stage A run."""

    CANONICAL_V2 = "canonical-sdk-v2"
    LEGACY_FLAT_V1 = "legacy-flat-v1"
    TASKSPACES_FACADE_V1 = "taskspaces-facade-v1"

    @property
    def switch_callee(self) -> str:
        if self is WiekBrowserRuntimeContract.CANONICAL_V2:
            return "taskSpace"
        if self is WiekBrowserRuntimeContract.LEGACY_FLAT_V1:
            return "switchTaskSpace"
        return "taskSpaces.switch"

    @property
    def complete_callee(self) -> str:
        if self is WiekBrowserRuntimeContract.CANONICAL_V2:
            return "task.finish"
        if self is WiekBrowserRuntimeContract.LEGACY_FLAT_V1:
            return "completeTaskSpace"
        return "taskSpaces.complete"

    @property
    def output_callee(self) -> str:
        if self is WiekBrowserRuntimeContract.LEGACY_FLAT_V1:
            return "cliLog"
        return "console.log"


_LITERAL_FIRST_ARG = r"""\s*\(\s*(?:(['"])(?P<str>(?:\\.|(?!\1).)*)\1|(?P<num>\d+))"""

# Input boundary accepts both historical helper surfaces. Execution remains contract-specific.
_FACADE_CANDIDATE_RE = re.compile(
    r"taskSpaces\s*\.\s*(?:useOrCreate|new|switch|claim|takeOver|handOff|complete)" + _LITERAL_FIRST_ARG
)
_LEGACY_CANDIDATE_RE = re.compile(
    r"(?<![\w.])(?:useOrCreateTaskSpace|newTaskSpace|switchTaskSpace|claimTaskSpace|"
    r"takeOverTaskSpace|handOffTaskSpace|completeTaskSpace)" + _LITERAL_FIRST_ARG
)
_FACADE_RELEASE_RE = re.compile(r"taskSpaces\s*\.\s*(?:complete|handOff)\s*\(")
_LEGACY_RELEASE_RE = re.compile(r"(?<![\w.])(?:completeTaskSpace|handOffTaskSpace)\s*\(")
_SKILL_FACADE_CALL_RE = re.compile(r"taskSpaces\s*\.\s*(?:useOrCreate|switch|complete)\s*\(")
_SKILL_LEGACY_CALL_RE = re.compile(
    r"(?<![\w.])(?:useOrCreateTaskSpace|switchTaskSpace|completeTaskSpace)\s*\("
)

_CONTRACT_PROBE_KEY = "wiekBenchRuntimeContractProbe"
_CONTRACT_PROBE_JS = f"""
const __probeRuntimeContract=async()=>{{
  const canonical=typeof taskSpace==='function'&&typeof listTaskSpaces==='function';
  if(canonical)return {{canonical:true,legacy:false,facade:false,screenshot:true}};
  const legacy=typeof globalThis.useOrCreateTaskSpace==='function'&&typeof globalThis.switchTaskSpace==='function'&&typeof globalThis.completeTaskSpace==='function'&&typeof globalThis.cliLog==='function';
  const facade=Boolean(globalThis.taskSpaces&&typeof globalThis.taskSpaces.useOrCreate==='function'&&typeof globalThis.taskSpaces.switch==='function'&&typeof globalThis.taskSpaces.complete==='function');
  const screenshot=typeof cdp==='function'||(typeof wiek!=='undefined'&&wiek&&typeof wiek.cdp==='function')||typeof captureScreenshot==='function';
  return {{canonical:false,legacy,facade,screenshot}};
}};
const __contractResult=await __probeRuntimeContract();
const __contractLine=JSON.stringify({{{_CONTRACT_PROBE_KEY}:__contractResult}});
if(!__contractResult.canonical&&typeof cliLog==='function')cliLog(__contractLine);else console.log(__contractLine);
"""


def _probe_payload(text: str) -> dict[str, object] | None:
    for line in reversed((text or "").strip().splitlines()):
        try:
            payload = json.loads(line.strip())
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict) and isinstance(payload.get(_CONTRACT_PROBE_KEY), dict):
            return payload[_CONTRACT_PROBE_KEY]
    return None


def probe_runtime_contract(
    *, bin_path: str, sdk_path: str | Path, timeout_seconds: float = _NODEJS_TIMEOUT
) -> WiekBrowserRuntimeContract:
    """Resolve exactly one helper surface without creating, selecting, or closing a space."""
    sdk = Path(sdk_path).resolve()
    if not sdk.is_file():
        raise RuntimeError(f"wiek-browser runtime index.js not found: {sdk}")
    try:
        proc = subprocess.run(
            [bin_path, "nodejs", "--sdk-path", str(sdk), "-e", _CONTRACT_PROBE_JS],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"wiek-browser runtime contract probe timed out after {timeout_seconds}s: {sdk}"
        ) from exc
    except OSError as exc:
        raise RuntimeError(f"wiek-browser runtime contract probe failed to start: {exc}") from exc

    payload = _probe_payload(proc.stdout) or _probe_payload(proc.stderr)
    if payload is None:
        stderr_tail = (proc.stderr or proc.stdout or "").strip()[-500:]
        raise RuntimeError(
            "wiek-browser runtime contract probe produced no marker "
            f"(rc={proc.returncode}, sdk={sdk}): {stderr_tail or '<no stderr>'}"
        )
    if proc.returncode != 0:
        raise RuntimeError(f"runtime contract probe failed (rc={proc.returncode})")
    # V2 installs guarded legacy globals. Prefer its lexical public API, without
    # invoking any helper or treating those guards as a second live dialect.
    if payload.get("canonical") is True:
        return WiekBrowserRuntimeContract.CANONICAL_V2
    matches: list[WiekBrowserRuntimeContract] = []
    if payload.get("legacy") is True:
        matches.append(WiekBrowserRuntimeContract.LEGACY_FLAT_V1)
    if payload.get("facade") is True:
        matches.append(WiekBrowserRuntimeContract.TASKSPACES_FACADE_V1)
    if len(matches) != 1:
        raise RuntimeError(
            "wiek-browser runtime contract must match exactly one supported surface "
            f"(sdk={sdk}, probe={payload})"
        )
    if payload.get("screenshot") is not True:
        raise RuntimeError(
            "wiek-browser runtime exposes no supported screenshot transport "
            f"(sdk={sdk}, probe={payload})"
        )
    return matches[0]


def classify_skill_runtime_contract(
    skill_path: str | Path,
) -> WiekBrowserRuntimeContract | None:
    """Classify an unambiguous SKILL call surface; prose-only/dual syntax stays unknown."""
    text = Path(skill_path).read_text(encoding="utf-8")
    if re.search(r"(?<![\w.])taskSpace\s*\(", text):
        if _SKILL_FACADE_CALL_RE.search(text) or _SKILL_LEGACY_CALL_RE.search(text):
            return None
        return WiekBrowserRuntimeContract.CANONICAL_V2
    has_facade = bool(_SKILL_FACADE_CALL_RE.search(text))
    has_legacy = bool(_SKILL_LEGACY_CALL_RE.search(text))
    if has_facade == has_legacy:
        return None
    if has_legacy:
        return WiekBrowserRuntimeContract.LEGACY_FLAT_V1
    return WiekBrowserRuntimeContract.TASKSPACES_FACADE_V1


def validate_skill_runtime_contract(
    *, skill_path: str | Path, sdk_path: str | Path, runtime_contract: WiekBrowserRuntimeContract
) -> WiekBrowserRuntimeContract | None:
    """Require the release-paired SKILL and reject a clearly opposite helper surface."""
    skill = Path(skill_path)
    sdk = Path(sdk_path).resolve()
    expected = sdk.parent / "wiek-browser" / "SKILL.md"
    if not expected.is_file() or skill.resolve() != expected.resolve():
        raise RuntimeError(
            f"wiek-browser SKILL/runtime mismatch: skill={skill.resolve()}, expected={expected} for sdk={sdk}"
        )
    skill_contract = classify_skill_runtime_contract(skill)
    if runtime_contract is WiekBrowserRuntimeContract.CANONICAL_V2 and skill_contract is None:
        raise RuntimeError("Canonical SDK V2 requires an unambiguous release-paired Skill")
    if skill_contract is not None and skill_contract is not runtime_contract:
        raise RuntimeError(
            "wiek-browser SKILL/runtime contract mismatch: "
            f"skill={skill_contract.value}, runtime={runtime_contract.value}"
        )
    return skill_contract


def _runtime_contract_from_env() -> WiekBrowserRuntimeContract:
    value = os.environ.get(RUNTIME_CONTRACT_ENV)
    if not value:
        raise RuntimeError(f"missing required env: {RUNTIME_CONTRACT_ENV}")
    try:
        return WiekBrowserRuntimeContract(value)
    except ValueError as exc:
        raise RuntimeError(f"unsupported wiek-browser runtime contract: {value}") from exc


def _sdk_path_from_env() -> str:
    value = os.environ.get(SDK_PATH_ENV)
    if not value:
        raise RuntimeError(f"missing required env: {SDK_PATH_ENV}")
    path = Path(value).resolve()
    if not path.is_file():
        raise RuntimeError(f"wiek-browser runtime index.js not found: {path}")
    return str(path)


# Fixed viewport used to recover from 0x0 captures. Under high concurrency,
# a non-primary tab in an wiek-lite task space can collapse to 0x0 and make
# Page.captureScreenshot return empty data. Apply device metrics and retry at
# a conventional 1280x800 viewport.
_HARDEN_VIEWPORT = {"width": 1280, "height": 800, "deviceScaleFactor": 1, "mobile": False}

# Screenshot body after the contract-specific space switch. Params/out/candidates/viewport are
# Inlined by _screenshot_js because custom env values are not forwarded.
# Keep top-level await and dynamic import semantics.
_SCREENSHOT_BODY = r"""
const fn = (typeof cdp === 'function') ? cdp
  : (typeof wiek !== 'undefined' && wiek && typeof wiek.cdp === 'function' ? wiek.cdp.bind(wiek) : null);
if (fn) {
  // Give the first capture a soft timeout because a collapsed 0x0 viewport may
  // not produce a frame before wiek-lite's 15-second watchdog. The underlying
  // request still rejects later, so attach a catch to consume that rejection.
  const FIRST_SHOOT_SOFT_TIMEOUT_MS = 6000;
  const shoot = async (softTimeoutMs) => {
    const raw = fn('Page.captureScreenshot', params);
    if (!softTimeoutMs) {
      const r = await raw;
      return r && (r.data || (r.result && r.result.data));
    }
    raw.catch(() => {});  // The losing request rejects later; consume it to avoid an unhandled rejection.
    let timer;
    const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('captureScreenshot soft-timeout ' + softTimeoutMs + 'ms')), softTimeoutMs); });
    try {
      const r = await Promise.race([raw, guard]);
      return r && (r.data || (r.result && r.result.data));
    } finally {
      clearTimeout(timer);  // An uncleared timer keeps the Node event loop alive after a fast capture.
    }
  };
  // A healthy first capture returns in under a second. A collapsed 0x0 viewport
  // either returns empty data on older builds or waits for the CDP timeout.
  // Convert only timeout failures to a null result so the device-metrics retry
  // can recover them; preserve unrelated failures such as target closure.
  let data = null;
  try {
    data = await shoot(FIRST_SHOOT_SOFT_TIMEOUT_MS);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (!/timed out|timeout/i.test(msg)) throw e;
  }
  let overridden = false;
  try {
    if (!data) {
      // Recover a non-primary tab whose viewport collapsed to 0x0 under high
      // concurrency by setting renderer-level dimensions before retrying.
      await fn('Emulation.setDeviceMetricsOverride', viewport);
      overridden = true;
      data = await shoot();
    }
    if (!data) throw new Error('no screenshot data from cdp');
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
  } finally {
    // The override persists on the page across processes, so always clear it.
    // Cleanup is best effort, but keep failures visible on stderr.
    if (overridden) {
      try { await fn('Emulation.clearDeviceMetricsOverride'); }
      catch (e) { console.error('clearDeviceMetricsOverride failed, viewport may be polluted: ' + (e && e.message ? e.message : e)); }
    }
  }
} else if (typeof captureScreenshot === 'function') {
  const r = await captureScreenshot();
  const data = (typeof r === 'string') ? r : (r && (r.data || r.base64));
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
} else {
  throw new Error('no cdp() or captureScreenshot() in wiek runtime');
}
// After a successful screenshot, capture an accessibility tree through the
// same CDP channel as secondary evidence. AX failure never changes screenshot
// success. getFullAXTree is a one-shot, viewport-independent snapshot and does
// not require Accessibility.enable. Skip it when the fallback has no CDP call.
if (typeof tree_out === 'string' && tree_out && fn) {
  try {
    const ax = await fn('Accessibility.getFullAXTree', {});
    const nodes = ax && (ax.nodes || (ax.result && ax.result.nodes));
    if (nodes) fs.writeFileSync(tree_out, JSON.stringify({ nodes }));  // Raw candidate slimmed by commit_capture.
  } catch (e) { /* AX capture is best effort. */ }
}
"""


def _screenshot_js(
    cdp_params: dict,
    output_path: str,
    candidates: list[str],
    runtime_contract: WiekBrowserRuntimeContract,
    tree_output_path: str | None = None,
) -> str:
    if runtime_contract is WiekBrowserRuntimeContract.CANONICAL_V2:
        from .canonical_v2 import screenshot_js
        return screenshot_js(cdp_params, output_path, candidates, tree_output_path, "")
    return (
        "const fs = await import('node:fs');\n"
        f"const params = {json.dumps(cdp_params)};\n"
        f"const out = {json.dumps(output_path)};\n"
        f"const candidates = {json.dumps(candidates)};\n"
        f"const viewport = {json.dumps(_HARDEN_VIEWPORT)};\n"
    # Inline the AX tree output path because custom env values are not forwarded.
    # ``None`` becomes ``tree_out=null`` and skips tree capture.
        f"const tree_out = {json.dumps(tree_output_path)};\n"
        f"for (const c of candidates) {{ try {{ await {runtime_contract.switch_callee}(c); "
        "break; } catch (e) { /* try next */ } }\n" + _SCREENSHOT_BODY
    )


# Purge script for the queue's pre-launch taskspace check (see webui runner).
#
# Unlike every other script in this module, this one probes the helper surface at
# runtime instead of resolving a pinned WiekBrowserRuntimeContract. That contract exists
# to guarantee the *tested* agent sees one consistent API; this purge is a harness
# housekeeping action that runs in the console process, outside any run's runtime lease,
# and must keep working across wiek-lite releases without a probe round-trip. Spaces the
# user owns are never touched — only `ownership: 'agent'` leftovers are closed.
_PURGE_SPACES_JS = r"""
const helpers = (globalThis.wiek && globalThis.wiek.helpers) || {};
const top = globalThis.wiek || {};
const ns = helpers.taskSpaces || globalThis.taskSpaces || null;
const listFn =
  (ns && ns.list) ? ns.list.bind(ns)
  : (typeof globalThis.listTaskSpaces === 'function') ? globalThis.listTaskSpaces
  : (typeof top.listTaskSpaces === 'function') ? top.listTaskSpaces.bind(top)
  : null;
const completeFn =
  (ns && ns.complete) ? ns.complete.bind(ns)
  : (typeof globalThis.completeTaskSpace === 'function') ? globalThis.completeTaskSpace
  : (typeof top.completeTaskSpace === 'function') ? top.completeTaskSpace.bind(top)
  : null;
const emit = (typeof globalThis.cliLog === 'function') ? globalThis.cliLog : console.log;
const result = { total: 0, closed: [], kept: [], failed: [], error: null };
if (!listFn || !completeFn) {
  result.error = 'taskspace helpers unavailable in this wiek-browser runtime';
} else {
  const spaces = await listFn();
  const all = Array.isArray(spaces) ? spaces : [];
  result.total = all.length;
  for (const s of all) {
    const label = (s && (s.name || s.taskId)) || String(s && s.id);
    if (!s || (s.ownership || s.createdBy) !== 'agent') { result.kept.push(label); continue; }
    try {
      await completeFn(s.id, { keep: false });
      result.closed.push(label);
    } catch (e) {
      result.failed.push({ space: label, error: (e && e.message) ? e.message : String(e) });
    }
  }
}
emit(JSON.stringify({ wiekBenchPurgeSpaces: result }));
"""


from .canonical_v2 import purge_js as _canonical_purge_js
_PURGE_SPACES_JS = ("if(typeof taskSpace==='function'&&typeof listTaskSpaces==='function'){" + _canonical_purge_js() + "}else{" + _PURGE_SPACES_JS + "}")

def purge_agent_task_spaces(
    *,
    bin_path: str | None = None,
    sdk_path: str | None = None,
    timeout_seconds: float = _NODEJS_TIMEOUT,
) -> dict[str, object]:
    """Close every agent-owned wiek-browser taskspace; leave user-owned ones alone.

    Used as the queue's pre-launch check: a crashed or stopped run can leave spaces
    behind, and starting the next run on top of them risks carrying over login state
    and stray tabs. Returns an audit dict (``ok``/``total``/``closed``/``kept``/
    ``failed``/``error``) — never raises, because a failed purge must degrade to a
    warning on the queue item, not block the run from starting.
    """
    argv = [bin_path or resolve_bin(WiekBrowserTool.bin_env, WiekBrowserTool.bin_default), "nodejs"]
    if sdk_path:
        argv += ["--sdk-path", sdk_path]
    argv += ["-e", _PURGE_SPACES_JS]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"taskspace purge timed out after {timeout_seconds}s"}
    except OSError as exc:
        return {"ok": False, "error": f"taskspace purge could not start: {exc}"}
    for stream in (proc.stdout or "", proc.stderr or ""):
        for line in stream.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            payload = obj.get("wiekBenchPurgeSpaces") if isinstance(obj, dict) else None
            if isinstance(payload, dict):
                payload["ok"] = not payload.get("error") and not payload.get("failed")
                return payload
    tail = (proc.stderr or proc.stdout or "").strip()[-300:]
    return {"ok": False, "error": f"taskspace purge produced no result marker: {tail or '<silent>'}"}


def _close_js(candidates: list[str], runtime_contract: WiekBrowserRuntimeContract) -> str:
    if runtime_contract is WiekBrowserRuntimeContract.CANONICAL_V2:
        from .canonical_v2 import close_js
        return close_js(candidates)
    return (
        f"const candidates = {json.dumps(candidates)};\n"
        "const results = [];\n"
        "for (const c of candidates) {\n"
        "  try {\n"
        f"    await {runtime_contract.complete_callee}(c, {{ keep: false }});\n"
        "    results.push({ nameOrId: c, ok: true });\n"
        "  } catch (e) {\n"
        "    const msg = (e && e.message) ? e.message : String(e);\n"
        "    if (/task space not found/i.test(msg)) {\n"
        "      results.push({ nameOrId: c, ok: true, notFound: true });\n"
        "    } else {\n"
        "      results.push({ nameOrId: c, ok: false, error: msg });\n"
        "    }\n"
        "  }\n"
        "}\n"
        f"{runtime_contract.output_callee}(JSON.stringify({{ wiekBenchClose: results }}));\n"
    )


class WiekBrowserTool:
    name = "wiek-browser"
    skill_name = "wiek-browser"
    bin_env = "WIEK_BROWSER_BIN"
    bin_default = "wiek-browser"
    guard_applies = True
        # Capture Accessibility.getFullAXTree through the same CDP session as
        # the screenshot. Only wiek-browser exposes the required nodejs cdp()
        # runtime.
    supports_ax_tree = True

    def bin(self) -> str:
        return resolve_bin(self.bin_env, self.bin_default)

    def detect_invocation(self, bash_command: str) -> InvocationContext | None:
        return parse_flag_invocation(
            bash_command=bash_command,
            tool_name=self.name,
            bin_path=self.bin(),
            instance_flag="--taskspace",
            value_flags=_VALUE_FLAGS,
        )

    def validate_instance_command(self, command: str, task_id: str, mode: str) -> tuple[bool, str | None]:
        if os.environ.get(RUNTIME_CONTRACT_ENV) != WiekBrowserRuntimeContract.CANONICAL_V2.value:
            return False, None
        from .canonical_v2 import validate_invocation
        return True, validate_invocation(self, command, task_id, mode)

    # --- space-candidate parsing (single-sourced here, called by screenshot hook) ---

    def extract_space_candidates(self, command: str) -> list[str]:
        """Static literal first-args of space-selection helpers in a command.

        Only literal string/number args are recoverable; variables / templates /
        ``task.id`` are not. This resolution is best effort.
        """
        if os.environ.get(RUNTIME_CONTRACT_ENV) == WiekBrowserRuntimeContract.CANONICAL_V2.value:
            from .canonical_v2 import extract_candidates
            return extract_candidates(self, command)
        matches: list[tuple[int, re.Match[str]]] = []
        for pattern in (_FACADE_CANDIDATE_RE, _LEGACY_CANDIDATE_RE):
            matches.extend((m.start(), m) for m in pattern.finditer(command))
        matches.sort(key=lambda item: item[0])
        out: list[str] = []
        for _position, m in matches:
            val = m.group("str")
            if val is None:
                val = m.group("num")
            else:
                val = re.sub(r"\\(.)", r"\1", val)  # unescape \' \" \\
            if val and val not in out:
                out.append(val)
        return out

    def mentions_space_release(self, command: str) -> bool:
        """True only for the release surface selected for this run."""
        runtime_contract = _runtime_contract_from_env()
        if runtime_contract is WiekBrowserRuntimeContract.CANONICAL_V2:
            from .canonical_v2 import mentions_release
            return mentions_release(self, command)
        if runtime_contract is WiekBrowserRuntimeContract.LEGACY_FLAT_V1:
            return bool(_LEGACY_RELEASE_RE.search(command))
        return bool(_FACADE_RELEASE_RE.search(command))

    def _load_candidates(self, instance_id: str | None) -> list[str]:
        """browser_state candidates ∪ {instance_id fallback}, deduped, order-preserving.

        Reads the harness-injected ``WIEK_BENCH_BROWSER_STATE_PATH`` from this Python
        process's env (not the node bundle's).
        """
        candidates: list[str] = []
        state_path = os.environ.get("WIEK_BENCH_BROWSER_STATE_PATH")
        if state_path and os.path.exists(state_path):
            try:
                data = json.loads(Path(state_path).read_text(encoding="utf-8"))
                for c in data.get("taskspaces", []):
                    s = str(c)
                    if s and s not in candidates:
                        candidates.append(s)
            except Exception:  # noqa: BLE001
                pass
        if instance_id and instance_id not in candidates:
            candidates.append(instance_id)
        return candidates

    def _run_nodejs(self, js: str) -> subprocess.CompletedProcess[str]:
        # No --taskspace: selection happens inside JS. --sdk-path pins this run's exact runtime;
        # params remain inlined because the bundle does not receive custom env.
        return subprocess.run(
            [self.bin(), "nodejs", "--sdk-path", _sdk_path_from_env(), "-e", js],
            capture_output=True,
            text=True,
            timeout=_NODEJS_TIMEOUT,
        )

    def capture_screenshot(
        self,
        *,
        instance_id: str | None,
        output_path: str,
        params: CdpScreenshotParams,
        tree_output_path: str | None = None,
    ) -> None:
        if _runtime_contract_from_env() is WiekBrowserRuntimeContract.CANONICAL_V2:
            from .canonical_v2 import capture
            return capture(self, instance_id=instance_id, output_path=output_path, params=params, tree_output_path=tree_output_path)
        candidates = self._load_candidates(instance_id)
        runtime_contract = _runtime_contract_from_env()
        proc = self._run_nodejs(
            _screenshot_js(
                params.to_cdp(),
                output_path,
                candidates,
                runtime_contract,
                tree_output_path,
            )
        )
        if not os.path.exists(output_path):
        # The wiek runtime can exit with rc=0 even when the script throws. Treat
        # a missing output file as failure and preserve stderr, which carries
        # the real cause such as empty CDP data from a 0x0 viewport.
            stderr_tail = (proc.stderr or "").strip()[-500:]
            raise RuntimeError(
                f"wiek-browser nodejs produced no screenshot file: {stderr_tail or '<no stderr>'}"
            )

    @staticmethod
    def _parse_marker(stdout: str) -> list[dict] | None:
        for line in reversed((stdout or "").strip().splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if isinstance(obj, dict) and isinstance(obj.get("wiekBenchClose"), list):
                return obj["wiekBenchClose"]
        return None

    def close_targets(self, *, instance_id: str | None) -> CloseResult:
        if _runtime_contract_from_env() is WiekBrowserRuntimeContract.CANONICAL_V2:
            from .canonical_v2 import close
            return close(self, instance_id=instance_id)
        # No --taskspace (avoids any use-or-create); the run-selected contract completes each
        # candidate. not-found is idempotent success; audit comes from the marker, never rc.
        candidates = self._load_candidates(instance_id)
        if not candidates:
            return CloseResult(ok=True, close_command="(no candidates; close skipped)")
        runtime_contract = _runtime_contract_from_env()
        sdk_path = _sdk_path_from_env()
        command_prefix = shlex.join([self.bin(), "nodejs", "--sdk-path", sdk_path])
        close_command = f"{command_prefix} ({runtime_contract.complete_callee} candidates={candidates})"
        try:
            proc = self._run_nodejs(_close_js(candidates, runtime_contract))
        except subprocess.TimeoutExpired as exc:
            return CloseResult.timeout(close_command, exc=exc, timeout_s=_NODEJS_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            return CloseResult.spawn_error(close_command, exc=exc)
        # Runtime output channels differ by release; the marker may land on either stream.
        marker = self._parse_marker(proc.stdout) or self._parse_marker(proc.stderr)
        if marker is None:
            return CloseResult(
                ok=False,
                close_command=close_command,
                raw_returncode=proc.returncode,
                stdout_tail=(proc.stdout or "")[-500:],
                stderr_tail=(proc.stderr or "")[-500:],
                error="close marker missing (wiekBenchClose)",
            )
        failed = [r for r in marker if not r.get("ok")]
        ok = not failed
        return CloseResult(
            ok=ok,
            close_command=close_command,
            raw_returncode=proc.returncode,
            stdout_tail=json.dumps({"wiekBenchClose": marker}, ensure_ascii=False)[-500:],
            stderr_tail=(proc.stderr or "")[-500:],
            error=None if ok else f"close failed for {[r.get('nameOrId') for r in failed]}",
        )

    def instance_constraint(self, task_id: str, mode: str) -> str:
        if os.environ.get(RUNTIME_CONTRACT_ENV) == WiekBrowserRuntimeContract.CANONICAL_V2.value:
            sdk = _sdk_path_from_env()
            return (f"BROWSER INSTANCE ISOLATION: use only {shlex.quote(self.bin())} nodejs "
                    f"--sdk-path {shlex.quote(sdk)} -e <shell-quoted JavaScript>. "
                    f"Every script must directly call await taskSpace({json.dumps(task_id)}) with that exact literal name; "
                    "use its Page methods. Do not use --taskspace, other control helpers, dynamic task IDs, imports or file scripts. "
                    "The syntax guard is advisory isolation; browser ownership remains authoritative.")
        return (
            f"BROWSER INSTANCE ISOLATION: EVERY `wiek-browser` command MUST place "
            f"`--taskspace={task_id}` immediately after `wiek-browser` and BEFORE the "
            f"subcommand (e.g. `wiek-browser --taskspace={task_id} open <url>`). "
            f"The task-management subcommands `wiek-browser taskspace list/close/complete` "
            f"take the taskspace name as a positional argument instead."
        )

    def cleanup_command(self, task_id: str) -> str:
        runtime_contract = _runtime_contract_from_env()
        sdk_path = _sdk_path_from_env()
        if runtime_contract is WiekBrowserRuntimeContract.CANONICAL_V2:
            from .canonical_v2 import close_js
            return shlex.join([self.bin(), "nodejs", "--sdk-path", sdk_path, "-e", close_js([task_id])])
        js = f"await {runtime_contract.complete_callee}({json.dumps(task_id)}, {{ keep: false }})"
        return shlex.join([self.bin(), "nodejs", "--sdk-path", sdk_path, "-e", js])

    def inject_fragment(self, task_id: str, mode: str) -> str:
        return (
            f"{self.instance_constraint(task_id, mode)}\n\n"
            f"CLEANUP: Right before your `FINAL ANSWER:`, release the taskspace with:\n"
            f"    {self.cleanup_command(task_id)}"
        )

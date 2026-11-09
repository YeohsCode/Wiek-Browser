"""Core wiek-browser release management.

When ``browser_tool=wiek-browser``, the measured surface is the in-browser
``index.js`` runtime loaded by Wiek Browser. It implements helpers such as
``page.snapshot``, ``cdp``, and ``taskSpaces.useOrCreate``. The
``wiek-browser`` CLI on PATH remains a control variable. Wiek Browser loads the
runtime through this debug override symlink:

    ~/Library/Application Support/Wiek Browser/runtime/index.js  ->  <release>/index.js

The agent skill changes with the runtime through a second symlink that is
atomically relinked with ``index.js``:

    <repo>/agent-home/.pi/agent/skills/wiek-browser  ->  <index.js sibling>/wiek-browser/

This module is the single implementation for GitHub release discovery, the
project-local ``wiek-browser-releases/<tag>/`` cache, atomic runtime and skill
relinking, external-build detection, and restoration. It is shared by the
WebUI, CLI, and ``run_eval`` and depends only on the standard library and
``wiek_bench.config``. Runtime switching is supported only on macOS.

GitHub's ``/releases/latest`` endpoint returns the item marked
``make_latest``, not necessarily one of the newest items by publication time.
The latest release must therefore be fetched separately from the recent list.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import fnmatch
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from wiek_bench.config import WiekBrowserConfig, load_config

_API = "https://api.github.com"
_UA = "wiek-benchmark-harness"
_API_TIMEOUT = 20.0
_DOWNLOAD_TIMEOUT = 120.0
_ASSET_GLOB = "wiek-browser-*.zip"
_ORIGIN_NAME = ".external_origin"
_RUNTIME_LOCK_NAME = ".runtime.lock"
_CACHED_RELEASES_LIMIT = 5
_SEMVER_TAG_RE = re.compile(
    r"^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)

# Serialize activation and downloads within the process so concurrent requests
# do not duplicate downloads or race the staging directory. The reentrant lock
# allows ``activate`` to call ``ensure_downloaded`` while holding it; the file
# lease below coordinates runtime switching across processes.
_LOCK = threading.RLock()


class RuntimeDriftError(RuntimeError):
    """The active wiek-browser artifact no longer matches the run-start snapshot."""


# --- path resolution -------------------------------------------------------


def _expand(p: str) -> Path:
    return Path(os.path.expanduser(os.path.expandvars(p)))


def _cache_root(cfg: WiekBrowserConfig) -> Path:
    """Return the cache root, relative to the repository working directory."""
    return Path(cfg.cache_dir)


def _symlink_path(cfg: WiekBrowserConfig) -> Path:
    return _expand(cfg.debug_symlink)


def _origin_file(cfg: WiekBrowserConfig) -> Path:
    return _cache_root(cfg) / _ORIGIN_NAME


def _runtime_lock_path(cfg: WiekBrowserConfig) -> Path:
    return _cache_root(cfg).resolve() / _RUNTIME_LOCK_NAME


@contextlib.contextmanager
def _runtime_lease(cfg: WiekBrowserConfig, *, exclusive: bool, owner: str) -> Iterator[None]:
    """Acquire the cross-process runtime lease without waiting."""
    path = _runtime_lock_path(cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
    acquired = False
    try:
        try:
            fcntl.flock(handle.fileno(), operation | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError as exc:
            action = "切换" if exclusive else "启动 wiek-browser Stage A"
            raise RuntimeError(
                f"无法{action}：wiek-browser runtime 正被另一个进程占用（requester={owner}）"
            ) from exc
        yield
    finally:
        try:
            if acquired:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def stage_a_runtime_lease(cfg: WiekBrowserConfig) -> contextlib.AbstractContextManager[None]:
    """Shared lease held from runtime preflight through all task teardowns."""
    return _runtime_lease(cfg, exclusive=False, owner="stage-a")


def _runtime_switch_lease(cfg: WiekBrowserConfig) -> contextlib.AbstractContextManager[None]:
    return _runtime_lease(cfg, exclusive=True, owner="activate/restore")


def _safe(tag: str) -> str:
    """Return a filesystem-safe directory name for a release tag."""
    return tag.replace("/", "_")


def _cached_index(cfg: WiekBrowserConfig, tag: str) -> Path:
    return _cache_root(cfg) / _safe(tag) / "index.js"


def _version_sort_key(
    tag: str,
) -> tuple[int, tuple[int, int, int], int, tuple[tuple[int, int | str], ...], str]:
    """Build a descending sort key for release tags, accepting the repo's optional ``v`` prefix."""
    match = _SEMVER_TAG_RE.fullmatch(tag)
    if match is None:
        natural = tuple(
            (0, int(part)) if part.isdigit() else (1, part.casefold())
            for part in re.findall(r"\d+|\D+", tag)
        )
        return (0, (0, 0, 0), 0, natural, tag.casefold())

    major, minor, patch, prerelease = match.groups()
    prerelease_key = tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in (prerelease or "").split(".")
        if part
    )
    return (
        1,
        (int(major), int(minor or 0), int(patch or 0)),
        1 if prerelease is None else 0,
        prerelease_key,
        tag.casefold(),
    )


def status_payload(cfg: WiekBrowserConfig) -> dict[str, Any]:
    """Return the active runtime and up to five local caches without accessing GitHub."""
    active = current_active(cfg)
    cache = _cache_root(cfg)
    tags = (
        [
            path.name
            for path in cache.iterdir()
            if path.is_dir() and (path / "index.js").is_file()
        ]
        if cache.is_dir()
        else []
    )
    tags.sort(key=_version_sort_key, reverse=True)
    cached_releases = [
        {
            "tag": tag,
            "active": active.get("source") == "managed" and active.get("active_tag") == tag,
        }
        for tag in tags[:_CACHED_RELEASES_LIMIT]
    ]
    return {"active": active, "cached_releases": cached_releases}


# --- GitHub HTTP (standard library only) ----------------------------------


def _api_headers() -> dict[str, str]:
    h = {"User-Agent": _UA, "Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:  # Authentication only raises the rate limit; public access works anonymously.
        h["Authorization"] = f"Bearer {token}"
    return h


def _get_json(url: str) -> Any:
    req = urllib.request.Request(url, headers=_api_headers())
    with urllib.request.urlopen(req, timeout=_API_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _download_bytes(url: str) -> bytes:
    # Public release assets can be downloaded anonymously. Do not forward
    # Authorization across the redirect to object storage.
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_DOWNLOAD_TIMEOUT) as resp:
        return resp.read()


def _pick_asset(release: dict) -> dict | None:
    """Return the matching wiek-browser zip asset, or ``None``."""
    for a in release.get("assets") or []:
        if fnmatch.fnmatch(a.get("name") or "", _ASSET_GLOB):
            return a
    return None


# --- Release discovery: latest plus recent, deduplicated ------------------


def _fetch_raw(cfg: WiekBrowserConfig) -> tuple[list[dict], str | None, str | None]:
    """Return ``(raw_releases, latest_tag, error)`` without raising network errors."""
    repo = cfg.repo
    recent_n = max(1, cfg.releases_limit - 1)  # Reserve one slot for Latest.
    error: str | None = None
    latest_tag: str | None = None
    items: list[dict] = []
    seen: set[str] = set()

    try:
        recent = _get_json(f"{_API}/repos/{repo}/releases?per_page={recent_n}")
        if isinstance(recent, list):
            for r in recent:
                tag = r.get("tag_name")
                if tag and tag not in seen:
                    seen.add(tag)
                    items.append(r)
    except Exception as exc:  # noqa: BLE001
        error = f"list releases failed: {exc}"

    try:
        latest = _get_json(f"{_API}/repos/{repo}/releases/latest")
        if isinstance(latest, dict) and latest.get("tag_name"):
            latest_tag = latest["tag_name"]
            if latest_tag not in seen:
                seen.add(latest_tag)
                items.append(latest)
    except urllib.error.HTTPError as exc:
        if exc.code != 404:  # A repository with no stable release legitimately returns 404.
            error = error or f"latest failed: {exc}"
    except Exception as exc:  # noqa: BLE001
        error = error or f"latest failed: {exc}"

    return items, latest_tag, error


def releases_payload(cfg: WiekBrowserConfig) -> dict[str, Any]:
    """Return release, active-runtime, cache, and error data.

    Each call fetches GitHub directly and recomputes the ``latest``,
    ``downloaded``, and ``active`` flags. Only an explicit frontend refresh or
    CLI list operation invokes it.
    """
    raw, latest_tag, error = _fetch_raw(cfg)
    status = status_payload(cfg)
    active = status["active"]
    active_real = active.get("index_js_realpath") if active.get("source") == "managed" else None

    releases: list[dict[str, Any]] = []
    for r in raw:
        tag = r["tag_name"]
        asset = _pick_asset(r)
        cached = _cached_index(cfg, tag)
        releases.append(
            {
                "tag": tag,
                "name": r.get("name") or tag,
                "published_at": r.get("published_at"),
                "prerelease": bool(r.get("prerelease")),
                "latest": tag == latest_tag,
                "downloadable": asset is not None,
                "asset": ({"name": asset["name"], "size": asset.get("size")} if asset else None),
                "downloaded": cached.exists(),
                "active": active_real is not None and active_real == str(cached.resolve()),
            }
        )
    releases.sort(key=lambda x: x["published_at"] or "", reverse=True)
    return {"releases": releases, **status, "error": error}


# --- Download cache: reuse hits and retain downloaded releases ------------


def _locate_index_dir(root: Path) -> Path | None:
    """Locate index.js at the extraction root or one directory below it."""
    if (root / "index.js").exists():
        return root
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        if (d / "index.js").exists():
            return d
    return None


def ensure_downloaded(cfg: WiekBrowserConfig, tag: str) -> Path:
    """Return cached ``<tag>/index.js``, downloading atomically on a miss."""
    if not tag or tag.startswith("."):  # Git ref names cannot start with a dot; also blocks ``..`` paths.
        raise RuntimeError(f"非法 tag：{tag!r}")
    with _LOCK:
        index_js = _cached_index(cfg, tag)
        if index_js.exists():  # Reuse a complete cache hit.
            return index_js

        rel = _get_json(f"{_API}/repos/{cfg.repo}/releases/tags/{urllib.parse.quote(tag, safe='')}")
        asset = _pick_asset(rel) if isinstance(rel, dict) else None
        if not asset or not asset.get("browser_download_url"):
            raise RuntimeError(f"release {tag} 无 wiek-browser-*.zip asset，不可激活")

        cache = _cache_root(cfg)
        cache.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix=f".{_safe(tag)}.dl-", dir=cache))
        try:
            with zipfile.ZipFile(io.BytesIO(_download_bytes(asset["browser_download_url"]))) as zf:
                zf.extractall(tmp)
            located = _locate_index_dir(tmp)
            if located is None:
                raise RuntimeError(f"release {tag} 的 zip 内未找到 index.js")
            staged = cache / f".{_safe(tag)}.ready"
            if staged.exists():
                shutil.rmtree(staged)
            shutil.move(str(located), str(staged))
            dest = cache / _safe(tag)
            if dest.exists():  # Remove an incomplete destination left by an interrupted run.
                shutil.rmtree(dest)
            os.replace(staged, dest)  # Atomic rename on the same filesystem.
            return dest / "index.js"
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# --- Symlink activation, external builds, and restoration -----------------


def _ensure_debug_dir(cfg: WiekBrowserConfig, link: Path) -> None:
    """Ensure the debug directory exists and fail loudly if Wiek Browser is absent."""
    debug_dir = link.parent
    citro = debug_dir.parent
    if not citro.exists():
        raise RuntimeError(
            f"{citro} 不存在 —— Wiek Browser 似乎未安装（本功能不负责安装 Wiek Browser）"
        )
    debug_dir.mkdir(parents=True, exist_ok=True)


def _backup_regular_file(link: Path) -> None:
    """Back up a regular debug/index.js file as ``index.js.bak``.

    Replacing a copied build directly would destroy it. It would also be
    misclassified as an external target pointing to itself, producing an
    unusable ``.external_origin``. After the backup it is treated as no link.
    """
    if link.is_symlink() or not link.exists():
        return
    bak = link.with_name(link.name + ".bak")
    if bak.exists():
        raise RuntimeError(f"{link} 是普通文件且备份 {bak} 已存在，请先手动清理")
    os.replace(link, bak)


def _atomic_symlink(link: Path, target: Path) -> None:
    tmp = link.parent / f".{link.name}.tmp-{os.getpid()}"
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    os.symlink(target, tmp)
    os.replace(tmp, link)  # Atomically replace the existing link or file.


def _skill_relink_paths(cfg: WiekBrowserConfig, index_js: Path) -> tuple[Path, Path]:
    """Return the skill symlink and target that must move with ``index.js``.

    The target is always the sibling ``wiek-browser/`` directory shared by
    release and development layouts. Validation fails loudly when ``SKILL.md``
    is absent or a real file/directory occupies the link path. Callers must
    validate before modifying either symlink to avoid a partial switch.
    """
    src = index_js.resolve().parent / "wiek-browser"
    if not (src / "SKILL.md").is_file():
        raise RuntimeError(f"{src} 缺少 SKILL.md，无法随版本切换 skill")
    link = _expand(cfg.skill_symlink)
    if not link.is_symlink() and link.exists():
        raise RuntimeError(
            f"{link} 是真实文件/目录而非软链（疑似手动复制的 skill），请先移除或备份后重试"
        )
    link.parent.mkdir(parents=True, exist_ok=True)
    return link, src


def _record_external_origin_if_needed(cfg: WiekBrowserConfig) -> None:
    """Record the first external target for restoration without overwriting it."""
    st = current_active(cfg)
    if st.get("source") != "external" or not st.get("external_target"):
        return
    origin = _origin_file(cfg)
    if origin.exists():
        return
    origin.parent.mkdir(parents=True, exist_ok=True)
    origin.write_text(st["external_target"], encoding="utf-8")


def activate(cfg: WiekBrowserConfig, tag: str) -> dict[str, Any]:
    """Download on cache miss, atomically relink runtime and skill, and return status."""
    with _LOCK, _runtime_switch_lease(cfg):
        index_js = ensure_downloaded(cfg, tag)
        link = _symlink_path(cfg)
        _ensure_debug_dir(cfg, link)
        skill_link, skill_src = _skill_relink_paths(cfg, index_js)  # Validate before modifying links.
        _backup_regular_file(link)  # A backed-up file no longer appears as an external link.
        _record_external_origin_if_needed(cfg)
        _atomic_symlink(link, index_js.resolve())
        _atomic_symlink(skill_link, skill_src)
        return current_active(cfg)


def activate_external(
    cfg: WiekBrowserConfig,
    index_js: str | Path,
) -> dict[str, Any]:
    """Atomically relink the runtime and skill to an explicit external build."""
    target = _expand(str(index_js)).resolve()
    with _LOCK, _runtime_switch_lease(cfg):
        if not target.is_file():
            raise RuntimeError(f"external index.js 不存在：{target}")
        link = _symlink_path(cfg)
        _ensure_debug_dir(cfg, link)
        skill_link, skill_src = _skill_relink_paths(cfg, target)  # Validate before modifying links.
        _backup_regular_file(link)
        origin = _origin_file(cfg)
        origin.parent.mkdir(parents=True, exist_ok=True)
        origin.write_text(str(target), encoding="utf-8")
        _atomic_symlink(link, target)
        _atomic_symlink(skill_link, skill_src)
        return current_active(cfg)


def restore_external(cfg: WiekBrowserConfig) -> dict[str, Any]:
    """Relink the runtime and skill to the build recorded in ``.external_origin``.

    Raise when no origin was recorded or the target no longer exists.
    """
    with _LOCK, _runtime_switch_lease(cfg):
        origin = _origin_file(cfg)
        if not origin.exists():
            raise RuntimeError("无 external 记录可恢复（.external_origin 不存在）")
        target = Path(origin.read_text(encoding="utf-8").strip())
        if not target.exists():
            raise RuntimeError(f"记录的 external 目标已不存在：{target}")
        link = _symlink_path(cfg)
        _ensure_debug_dir(cfg, link)
        skill_link, skill_src = _skill_relink_paths(cfg, target)  # Validate before modifying links.
        _atomic_symlink(link, target.resolve())
        _atomic_symlink(skill_link, skill_src)
        return current_active(cfg)


def _sha256(p: Path) -> str | None:
    try:
        h = hashlib.sha256()
        with p.open("rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def assert_runtime_snapshot(cfg: WiekBrowserConfig, expected: dict[str, Any]) -> None:
    """Fail when the active realpath or bytes differ from the run-start snapshot."""
    expected_path_raw = expected.get("index_js_realpath")
    expected_sha = expected.get("index_js_sha256")
    if not expected_path_raw or not expected_sha:
        raise RuntimeDriftError("wiek-browser run snapshot is missing index_js_realpath/sha256")

    link = _symlink_path(cfg)
    if not link.exists() and not link.is_symlink():
        raise RuntimeDriftError(f"wiek-browser runtime link disappeared: {link}")
    current_path = link.resolve()
    expected_path = Path(str(expected_path_raw)).resolve()
    if current_path != expected_path:
        raise RuntimeDriftError(
            f"wiek-browser runtime realpath drifted: expected={expected_path}, current={current_path}"
        )
    current_sha = _sha256(current_path)
    if current_sha != expected_sha:
        raise RuntimeDriftError(
            "wiek-browser runtime sha256 drifted: "
            f"expected={expected_sha}, current={current_sha}, path={current_path}"
        )


def _read_external_origin(cfg: WiekBrowserConfig) -> str | None:
    """Return the recorded restorable development build, if any."""
    origin = _origin_file(cfg)
    if not origin.exists():
        return None
    try:
        val = origin.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return val or None


def current_active(cfg: WiekBrowserConfig) -> dict[str, Any]:
    """Classify the debug symlink target as managed, external, or absent.

    ``external_origin`` is always returned, including for a managed runtime, so
    the frontend can still offer restoration after activating a release.
    """
    link = _symlink_path(cfg)
    external_origin = _read_external_origin(cfg)
    if not link.is_symlink() and not link.exists():
        return {
            "active_tag": None,
            "source": "none",
            "external_target": None,
            "external_origin": external_origin,
            "index_js_realpath": None,
            "index_js_sha256": None,
        }
    real = link.resolve()  # Follow the symlink to the actual file.
    cache = _cache_root(cfg).resolve()

    tag: str | None = None
    try:
        parts = real.relative_to(cache).parts
        if len(parts) >= 2 and parts[-1] == "index.js":
            tag = parts[0]  # <safe-tag>/index.js; current wiek-lite tags contain no slashes.
    except ValueError:
        tag = None

    sha = _sha256(real) if real.exists() else None
    if tag is not None:
        return {
            "active_tag": tag,
            "source": "managed",
            "external_target": None,
            "external_origin": external_origin,
            "index_js_realpath": str(real),
            "index_js_sha256": sha,
        }
    return {
        "active_tag": None,
        "source": "external",
        "external_target": str(real),
        "external_origin": external_origin,
        "index_js_realpath": str(real),
        "index_js_sha256": sha,
    }


_WIEK_LITE_BUNDLE_ID = "app.wiek.browser"


def _native_app_version() -> dict[str, Any]:
    """Return a best-effort, auditable snapshot of the native Wiek Browser app.

    LaunchServices resolves the installed app by bundle id to avoid confusing
    it with an older app at a hard-coded path. Bundle versions come from
    Info.plist, while ``running_version`` is extracted from the active framework
    process and reflects the build actually driven by the run. The installed
    and running builds may differ after an update. Every probe is best effort,
    returns ``None`` on failure, never accesses the network, and never blocks a
    run from starting.
    """
    info: dict[str, Any] = {
        "bundle_id": _WIEK_LITE_BUNDLE_ID,
        "bundle_path": None,
        "bundle_version": None,
        "short_version": None,
        "running_version": None,
    }
    try:
        app = subprocess.run(
            ["osascript", "-e", f'POSIX path of (path to application id "{_WIEK_LITE_BUNDLE_ID}")'],
            capture_output=True, text=True, timeout=8,
        ).stdout.strip()
        if app:
            info["bundle_path"] = app
            plist = f"{app.rstrip('/')}/Contents/Info"
            for key, field in (
                ("CFBundleVersion", "bundle_version"),
                ("CFBundleShortVersionString", "short_version"),
            ):
                r = subprocess.run(
                    ["defaults", "read", plist, key],
                    capture_output=True, text=True, timeout=8,
                )
                if r.returncode == 0 and r.stdout.strip():
                    info[field] = r.stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    try:
        ps = subprocess.run(
            ["pgrep", "-lf", "wiek Framework.framework/Versions"],
            capture_output=True, text=True, timeout=8,
        )
        m = re.search(r"Versions/([0-9][0-9.]*)", ps.stdout or "")
        if m:
            info["running_version"] = m.group(1)
    except Exception:  # noqa: BLE001
        pass
    return info


def run_metadata_entry(cfg: WiekBrowserConfig) -> dict[str, Any]:
    """Return the auditable active-runtime snapshot frozen at run start."""
    st = current_active(cfg)
    return {
        "active_tag": st["active_tag"],
        "source": st["source"],
        "index_js_realpath": st["index_js_realpath"],
        "index_js_sha256": st["index_js_sha256"],
        "external_target": st["external_target"],
        "native_app": _native_app_version(),
    }


# --- CLI: python -m wiek_bench.wiek_release ---------------------------------


def _print(obj: Any) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m wiek_bench.wiek_release", description=__doc__)
    parser.add_argument("--config", default="config.yaml", help="config.yaml 路径")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="列 Latest + 最近 5 个 + 当前 active")
    p_act = sub.add_parser("activate", help="下载（已缓存跳过）+ 重建软链")
    p_act.add_argument("tag")
    p_external = sub.add_parser("activate-external", help="重链到显式 external/dev index.js")
    p_external.add_argument("index_js")
    sub.add_parser("current", help="打印当前 active 状态")
    sub.add_parser("restore", help="恢复 external / dev 构建软链")
    args = parser.parse_args(argv)

    cfg = load_config(args.config).wiek_browser
    try:
        if args.cmd == "list":
            _print(releases_payload(cfg))
        elif args.cmd == "activate":
            _print(activate(cfg, args.tag))
        elif args.cmd == "activate-external":
            _print(activate_external(cfg, args.index_js))
        elif args.cmd == "current":
            _print(current_active(cfg))
        elif args.cmd == "restore":
            _print(restore_external(cfg))
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

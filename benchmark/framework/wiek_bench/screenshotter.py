"""Incremental capture-time dedup → frames/ + manifest (no raw/ staging).

Each browser command's post-state screenshot is captured straight into the task's
``frames/`` dir as the next candidate ``NNN.png``; ``commit_capture`` then byte-hashes
it (sha256) and KEEPS it only if the hash is new — otherwise the candidate is deleted
and the command is still recorded against the already-saved frame. So ``frames/`` holds
only unique frames in capture (time) order, and at most one transient PNG ever exists
on disk per task.

``manifest.jsonl`` records one line PER capture (duplicates included), preserving the
full command↔screenshot mapping the agent-mode judge reads to know which command
produced which frame. Byte-level sha256 (not perceptual) keeps results
comparable with upstream and adds no LLM cost.

At teardown (``compress_frames``, called once after the agent loop), each kept ``NNN.png``
is transcoded to full-resolution ``NNN.webp`` (q90) and the manifest is rewritten — keeping
the capture hot path on raw PNG (timing stays comparable with historical runs) while the
archived ``frames/`` end up ~3.4x smaller.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

MANIFEST_NAME = "manifest.jsonl"
ERRORS_NAME = "_errors.jsonl"
TREES_DIRNAME = "trees"  # CDP getFullAXTree evidence under frames/trees/NNN.json.


@dataclass(frozen=True)
class FramesSelection:
    """Teardown view of a task's frames dir (consumed by run_eval / run_judge)."""

    frame_paths: list[Path]
    manifest_path: Path | None
    errors_path: Path | None
    tree_paths: list[Path] = field(default_factory=list)  # AX trees under frames/trees/NNN.json.


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _numeric_frames(frames_dir: Path) -> list[Path]:
    """Unique frame images sorted in time order. A frame is ``NNN.png`` at capture and
    ``NNN.webp`` after the teardown transcode; old runs stay ``.png``. Excludes
    the in-flight candidate and any non-numeric helper file. When both extensions exist for
    one frame number (transient mid-transcode), the ``.webp`` wins."""
    by_stem: dict[str, Path] = {}
    for p in [*frames_dir.glob("*.png"), *frames_dir.glob("*.webp")]:
        if not p.stem.isdigit():
            continue
        if p.stem not in by_stem or p.suffix == ".webp":
            by_stem[p.stem] = p
    return [by_stem[k] for k in sorted(by_stem, key=int)]


def next_frame_candidate(frames_dir: str | Path) -> Path:
    """Path the next capture should write to: ``frames/<count+1>.png`` (3-digit).

    Numbering tracks the count of *kept* unique frames, so a capture that turns out to
    be a duplicate (candidate deleted in ``commit_capture``) leaves the next number
    unchanged.

    Load-bearing invariant (NOT guarded here): captures for one task are triggered
    serially. Both this count-based numbering and ``commit_capture``'s manifest
    read-modify-write are unsynchronized, so two captures racing on the same
    ``frames_dir`` would pick the same ``NNN.png`` and lose a frame. This holds today
    because pi's snapshot-and-ref browser workflow issues one browser command per
    assistant turn (measured across real runs: 0 turns with ≥2 concurrent browser
    commands) and the TS extension awaits each ``screenshot`` helper. pi runs sibling
    tool calls concurrently by default — if a future model/tool ever emits ≥2
    independent browser bash calls in one turn, serialize this section with a per-task
    file lock (and write to a unique temp name, rename under the lock)."""
    frames_dir = Path(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)
    seq = len(_numeric_frames(frames_dir)) + 1
    return frames_dir / f"{seq:03d}.png"


def _numeric_trees(frames_dir: Path) -> list[Path]:
    """Unique AX-tree snapshots ``trees/NNN.json`` in time order. Excludes the
    in-flight ``.json.tmp`` candidate and any non-numeric file."""
    trees_dir = Path(frames_dir) / TREES_DIRNAME
    if not trees_dir.exists():
        return []
    out = [p for p in trees_dir.glob("*.json") if p.stem.isdigit()]
    return sorted(out, key=lambda p: int(p.stem))


def next_tree_candidate(frames_dir: str | Path) -> Path:
    """Path the next AX-tree capture should write to: ``trees/<kept-unique-trees+1>.json``.

    Numbered INDEPENDENTLY of frames — a duplicate frame with a new tree (or vice versa) is
    the whole point of the separate text-dedup, so this tracks kept unique
    *trees*, not the frame count, and the command↔tree mapping lives in the manifest's
    ``tree`` field (never a same-name ``.json`` derivation). Same serial-capture invariant as
    ``next_frame_candidate``."""
    trees_dir = Path(frames_dir) / TREES_DIRNAME
    trees_dir.mkdir(parents=True, exist_ok=True)
    seq = len(_numeric_trees(Path(frames_dir))) + 1
    return trees_dir / f"{seq:03d}.json"


def _read_manifest(manifest_path: Path) -> list[dict]:
    if not manifest_path.exists():
        return []
    out: list[dict] = []
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _ax_value(v: object) -> object:
    """Flatten a CDP AXValue (`{type, value, ...}`) to its bare value; pass scalars through."""
    return v.get("value") if isinstance(v, dict) else v


def _slim_ax_node(n: dict) -> dict:
    """Keep only role / name / value / properties (all flattened), drop everything else.

    Dropped: nodeId / parentId / childIds (graph pointers — judge greps by role/name, maps
    by manifest), chromeRole (internal numeric role), frameId, ignoredReasons, name.sources
    (name-computation provenance, ~19% of the raw tree). properties become a flat
    ``{name: value}`` dict (url/href, checked, selected, expanded, disabled, focusable…)."""
    out: dict = {}
    role = _ax_value(n.get("role"))
    if role is not None and role != "":
        out["role"] = role
    name = _ax_value(n.get("name"))
    if name is not None and name != "":
        out["name"] = name
    value = _ax_value(n.get("value"))
    if value is not None and value != "":
        out["value"] = value
    props: dict = {}
    for p in n.get("properties") or []:
        if not isinstance(p, dict):
            continue
        pn, pv = p.get("name"), _ax_value(p.get("value"))
        if pn and pv is not None and pv != "":
            props[pn] = pv
    if props:
        out["properties"] = props
    return out


_AxNodeId = str | int


def _ax_node_id(value: object) -> _AxNodeId | None:
    """Return a usable CDP AX node id, or ``None`` for malformed/missing ids."""
    if isinstance(value, str):
        return value or None
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _nearest_retained_parent_index(
    node: dict,
    nodes_by_id: dict[_AxNodeId, dict],
    retained_indices: dict[_AxNodeId, int],
) -> int | None:
    """Find the nearest retained ancestor while validating the raw parent chain."""
    node_id = _ax_node_id(node.get("nodeId"))
    parent_id = _ax_node_id(node.get("parentId"))
    visited = {node_id} if node_id is not None else set()
    nearest: int | None = None

    while parent_id is not None:
        if parent_id in visited:
            return None
        visited.add(parent_id)
        parent = nodes_by_id.get(parent_id)
        if parent is None:
            return None
        if nearest is None:
            nearest = retained_indices.get(parent_id)
        parent_id = _ax_node_id(parent.get("parentId"))

    return nearest


def _slim_ax_tree(raw: object) -> dict:
    """Denoise a raw ``getFullAXTree`` (``{"nodes":[...]}``) for on-disk storage:
    drop ``ignored`` nodes, keep role/name/value/properties per ``_slim_ax_node``, and add
    the nearest retained ancestor's slim-array index. Malformed input produces an empty v2
    tree (best-effort; the caller records tree=null)."""
    nodes = raw.get("nodes") if isinstance(raw, dict) else None
    if not isinstance(nodes, list):
        return {"schema_version": 2, "nodes": []}

    raw_nodes = [node for node in nodes if isinstance(node, dict)]
    nodes_by_id = {
        node_id: node
        for node in raw_nodes
        if (node_id := _ax_node_id(node.get("nodeId"))) is not None
    }
    retained_nodes = [node for node in raw_nodes if not node.get("ignored")]
    retained_indices = {
        node_id: index
        for index, node in enumerate(retained_nodes)
        if (node_id := _ax_node_id(node.get("nodeId"))) is not None
    }
    slim: list[dict] = []
    for node in retained_nodes:
        slim_node = _slim_ax_node(node)
        slim_node["parent_index"] = _nearest_retained_parent_index(
            node, nodes_by_id, retained_indices
        )
        slim.append(slim_node)
    return {"schema_version": 2, "nodes": slim}


def commit_capture(
    frames_dir: str | Path, candidate: Path, command: str, tree_candidate: Path | None = None
) -> None:
    """Dedup a freshly-captured ``candidate`` PNG (and optional AX ``tree_candidate``) and
    append their single manifest line.

    Frame: unique byte-hash → the candidate stays as the frame; duplicate → it is deleted and
    the line points at the already-saved frame (``new=False``). AX tree (wiek-browser only):
    an INDEPENDENT text-hash dedup fills ``tree_sha256`` / ``tree`` / ``tree_new`` on
    the SAME line (all null when absent) — a duplicate frame with a new tree, or vice versa,
    is recorded faithfully. Best-effort: any error is swallowed so the screenshot path never
    disturbs the agent."""
    frames_dir = Path(frames_dir)
    candidate = Path(candidate)
    manifest_path = frames_dir / MANIFEST_NAME
    try:
        sha = _sha256(candidate)
    except OSError:
        return
    entries = _read_manifest(manifest_path)
    seen = {e["sha256"]: e["frame"] for e in entries if e.get("new")}
    if sha in seen:
        frame, is_new = seen[sha], False
        candidate.unlink(missing_ok=True)
    else:
        frame, is_new = candidate.name, True
    # Read the raw JS tree candidate, denoise it, and deduplicate its normalized
    # text hash independently from the frame hash. Atomically persist unique trees,
    # delete duplicates, and leave all tree manifest fields null on capture failure.
    tree_sha, tree_name, tree_new = None, None, None
    if tree_candidate is not None:
        tree_candidate = Path(tree_candidate)
        if tree_candidate.exists():
            slim_text = None
            try:
                raw = json.loads(tree_candidate.read_text(encoding="utf-8"))
                slim_text = json.dumps(_slim_ax_tree(raw), ensure_ascii=False)
                tree_sha = hashlib.sha256(slim_text.encode("utf-8")).hexdigest()
            except (OSError, ValueError):
                tree_candidate.unlink(missing_ok=True)  # Remove invalid or partial candidates.
            if tree_sha is not None and slim_text is not None:
                seen_trees = {e["tree_sha256"]: e["tree"] for e in entries if e.get("tree_new")}
                if tree_sha in seen_trees:
                    tree_name, tree_new = seen_trees[tree_sha], False
                    tree_candidate.unlink(missing_ok=True)
                else:
                    tmp = tree_candidate.with_name(tree_candidate.name + ".tmp")
                    try:
                        tmp.write_text(slim_text, encoding="utf-8")
                        tmp.replace(tree_candidate)  # Atomically replace the raw tree.
                        tree_name, tree_new = f"{TREES_DIRNAME}/{tree_candidate.name}", True
                    except OSError:
                        tmp.unlink(missing_ok=True)
                        tree_candidate.unlink(missing_ok=True)
                        tree_sha = None  # Omit the tree when normalized persistence fails.
    entry = {
        "command": command,
        "sha256": sha,
        "frame": frame,
        "new": is_new,
        "tree_sha256": tree_sha,
        "tree": tree_name,
        "tree_new": tree_new,
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        with manifest_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _rewrite_manifest_frames(manifest_path: Path, renamed: dict[str, str]) -> None:
    """Point each manifest line's ``frame`` at its transcoded ``.webp`` name. Covers both
    ``new=true`` lines (own frame) and ``new=false`` lines (pointing back at an earlier
    frame). Best-effort: any error leaves the manifest as-is."""
    if not manifest_path.exists():
        return
    try:
        entries = _read_manifest(manifest_path)
        for entry in entries:
            entry["frame"] = renamed.get(entry.get("frame"), entry.get("frame"))
        tmp = manifest_path.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            for entry in entries:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        tmp.replace(manifest_path)
    except OSError:
        pass


def compress_frames(frames_dir: str | Path, *, quality: int = 90, method: int = 6) -> None:
    """Teardown: transcode each kept ``NNN.png`` to full-resolution ``NNN.webp`` (q90), delete
    the PNG, and rewrite the manifest's ``frame`` fields ``.png``→``.webp``.

    Runs once after the agent loop (NOT in the capture hook), so the timed run keeps emitting
    raw PNG and stays comparable with historical runs; ``frames/`` ends up ~3.4x smaller while
    the agent-mode judge (pi ``read``, which natively reads webp and caps images at 2000px) is
    unaffected. Best-effort: a frame that fails to transcode is left as PNG (``_numeric_frames``
    reads either extension), never blocking teardown."""
    frames_dir = Path(frames_dir)
    if not frames_dir.exists():
        return
    from PIL import Image

    renamed: dict[str, str] = {}  # NNN.png -> NNN.webp
    for png in sorted(frames_dir.glob("*.png")):
        if not png.stem.isdigit():
            continue
        webp = png.with_suffix(".webp")
        tmp = webp.with_name(webp.name + ".tmp")  # Ignored by _numeric_frames.
        try:
            with Image.open(png) as im:
                im.convert("RGB").save(tmp, format="WEBP", quality=quality, method=method)
            tmp.replace(webp)  # Atomic replacement leaves only an ignored temp file on interruption.
            png.unlink(missing_ok=True)  # Never let a partial WebP hide an intact PNG.
            renamed[png.name] = webp.name
        except Exception:  # noqa: BLE001 - best-effort; leave the PNG in place
            tmp.unlink(missing_ok=True)
            webp.unlink(missing_ok=True)
            continue
    if renamed:
        _rewrite_manifest_frames(frames_dir / MANIFEST_NAME, renamed)


def load_frames(frames_dir: str | Path) -> FramesSelection:
    """Teardown: the unique frame paths (time order) + manifest / errors paths + AX trees."""
    frames_dir = Path(frames_dir)
    if not frames_dir.exists():
        return FramesSelection([], None, None)
    manifest_path = frames_dir / MANIFEST_NAME
    errors_path = frames_dir / ERRORS_NAME
    return FramesSelection(
        frame_paths=_numeric_frames(frames_dir),
        manifest_path=manifest_path if manifest_path.exists() else None,
        errors_path=errors_path if errors_path.exists() else None,
        tree_paths=_numeric_trees(frames_dir),
    )

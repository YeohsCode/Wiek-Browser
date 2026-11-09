"""Per-task trajectory screenshot gallery HTML.

Reads each ``screenshots/<task_id>/frames/manifest.jsonl`` and renders a self-contained,
command-aligned timeline gallery — the third per-task browse page alongside agent /
judge session HTML. Unlike ``session_html.py`` (which replays pi sessions via export_html),
this is pure local IO: read the manifest, string-build HTML. ``<img>`` uses RELATIVE paths
into ``../screenshots/<task_id>/frames/`` (no base64 inlining) so the gallery stays light
and works both under ``file://`` and the WebUI ``/runs`` static mount.
"""

from __future__ import annotations

import html
import json
from pathlib import Path

from loguru import logger

from wiek_bench.screenshotter import MANIFEST_NAME

_CSS = """
:root{--paper:#fcfaf3;--ink:#1a1a1a;--dim:#6b6b6b;--accent:#963a25;--line:#d9d3c4;--code:#f2ecdc;}
*{box-sizing:border-box;}
body{margin:0;background:#efe9dc;color:var(--ink);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}
.page{max-width:900px;margin:0 auto;padding:40px 32px 64px;background:var(--paper);
  min-height:100vh;box-shadow:0 0 24px rgba(0,0,0,.06);}
.head{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:28px;}
.kicker{font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;
  color:var(--accent);text-transform:uppercase;}
.head h1{font:600 22px/1.2 Georgia,"Times New Roman",serif;margin:10px 0 6px;word-break:break-all;}
.stat{font:12px/1 ui-monospace,monospace;color:var(--dim);}
.step{margin:0 0 32px;}
.step-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px;}
.idx{font:600 12px/1 ui-monospace,monospace;color:var(--accent);flex:0 0 auto;}
.cmd{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);
  border:1px solid var(--line);border-radius:3px;padding:2px 7px;color:var(--ink);
  word-break:break-all;flex:1 1 240px;}
.meta{font:11px/1 ui-monospace,monospace;color:var(--dim);display:inline-flex;gap:10px;
  align-items:center;flex:0 0 auto;}
.dup{color:var(--dim);border:1px dashed var(--line);border-radius:3px;padding:1px 5px;}
.axlink{color:var(--accent);text-decoration:none;border-bottom:1px solid transparent;}
.axlink:hover{border-bottom-color:var(--accent);}
.step img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:2px;background:#fff;}
.foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);
  font:11px/1.4 ui-monospace,monospace;color:var(--dim);}
@media print{body{background:#fff;}.page{box-shadow:none;max-width:none;padding:0;}.step{break-inside:avoid;}}
"""


def _read_manifest(manifest_path: Path) -> list[dict]:
    """Parse manifest.jsonl line-by-line, skipping blank / malformed lines."""
    rows: list[dict] = []
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def _fmt_ts(raw: object) -> str:
    """ISO8601 → HH:MM:SS (escaped); best-effort passthrough for odd shapes."""
    if not raw:
        return ""
    s = str(raw)
    return html.escape(s.split("T", 1)[1][:8] if "T" in s else s)


def _render_gallery_html(task_id: str, entries: list[dict]) -> str:
    tid = html.escape(task_id)
    n_steps = len(entries)
    n_frames = len({e.get("frame") for e in entries if e.get("frame")})

    step_blocks: list[str] = []
    for i, e in enumerate(entries, 1):
        cmd = html.escape(str(e.get("command") or "")) or "—"
        frame = e.get("frame")
        tree = e.get("tree")
        ts = _fmt_ts(e.get("captured_at"))
        dup = "" if e.get("new") else '<span class="dup">画面未变</span>'
        tree_html = (
            f'<a class="axlink" href="../screenshots/{task_id}/frames/{tree}"'
            ' target="_blank" rel="noopener">AX tree ↗</a>'
            if tree
            else ""
        )
        img_html = (
            f'<img loading="lazy" src="../screenshots/{task_id}/frames/{frame}" alt="step {i}">'
            if frame
            else ""
        )
        step_blocks.append(
            '<section class="step">'
            '<div class="step-head">'
            f'<span class="idx">{i:03d}</span>'
            f'<code class="cmd">{cmd}</code>'
            f'<span class="meta">{ts}{dup}{tree_html}</span>'
            "</div>"
            f"{img_html}"
            "</section>"
        )

    steps = "\n".join(step_blocks)
    return (
        "<!doctype html>\n"
        '<html lang="zh"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{tid} · 轨迹截图</title>"
        f"<style>{_CSS}</style></head><body>"
        '<div class="page">'
        '<header class="head">'
        '<div class="kicker">WIEK-BENCH · TRAJECTORY SCREENSHOTS</div>'
        f"<h1>{tid}</h1>"
        f'<div class="stat">{n_steps} 步命令 · {n_frames} 唯一帧</div>'
        "</header>"
        f"<main>{steps}</main>"
        '<footer class="foot">按命令执行顺序排列，每帧为该命令执行后的页面状态</footer>'
        "</div></body></html>"
    )


def export_run_screenshots_html(run_dir: str | Path) -> list[Path]:
    """Render one screenshot gallery HTML per task into ``<run_dir>/screenshots_html/``.

    Tasks whose ``frames/manifest.jsonl`` is missing or empty are skipped — no gallery
    file, and the report emits no 📷 badge for them (no dead link). Returns the paths
    written.
    """
    run_dir = Path(run_dir).resolve()
    shots_root = run_dir / "screenshots"
    if not shots_root.is_dir():
        return []
    out_dir = run_dir / "screenshots_html"
    results: list[Path] = []
    for task_dir in sorted(shots_root.iterdir()):
        manifest_path = task_dir / "frames" / MANIFEST_NAME
        if not task_dir.is_dir() or not manifest_path.exists():
            continue
        entries = _read_manifest(manifest_path)
        if not entries:
            continue
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{task_dir.name}.html"
        out_path.write_text(_render_gallery_html(task_dir.name, entries), encoding="utf-8")
        results.append(out_path)
    logger.info("exported {} screenshot gallery HTML files → {}", len(results), out_dir)
    return results

"""SKILL.md resolution, enumeration, and sha256 hashing."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import yaml


def _candidates(skill_name: str, pi_home: Path, custom_skill_dir: Path | None) -> list[Path]:
    out: list[Path] = []
    if custom_skill_dir is not None:
        out += [
            custom_skill_dir / skill_name / "SKILL.md",
            custom_skill_dir / ".pi" / "agent" / "skills" / skill_name / "SKILL.md",
            custom_skill_dir / ".agents" / "skills" / skill_name / "SKILL.md",
        ]
    out += [
        pi_home / skill_name / "SKILL.md",
        pi_home / ".pi" / "agent" / "skills" / skill_name / "SKILL.md",
        pi_home / ".agents" / "skills" / skill_name / "SKILL.md",
    ]
    return out


def resolve_skill_path(
    skill_name: str, pi_home: str | Path, custom_skill_dir: str | Path | None = None
) -> Path:
    pi_home_p = Path(pi_home)
    custom = Path(custom_skill_dir) if custom_skill_dir else None
    for candidate in _candidates(skill_name, pi_home_p, custom):
        if candidate.exists():
            return candidate
    raise FileNotFoundError(
        f"SKILL.md not found for skill '{skill_name}' under {pi_home_p} "
        f"(custom_skill_dir={custom})"
    )


def _skill_roots(pi_home: Path, custom_skill_dir: Path | None) -> list[Path]:
    """The same roots ``resolve_skill_path`` searches, minus the ``<skill_name>`` leaf."""
    roots: list[Path] = []
    if custom_skill_dir is not None:
        roots += [
            custom_skill_dir,
            custom_skill_dir / ".pi" / "agent" / "skills",
            custom_skill_dir / ".agents" / "skills",
        ]
    roots += [
        pi_home,
        pi_home / ".pi" / "agent" / "skills",
        pi_home / ".agents" / "skills",
    ]
    return roots


def _read_frontmatter_name(skill_md: Path) -> str | None:
    """Parse the ``name`` field from a SKILL.md YAML frontmatter block, or None."""
    try:
        text = skill_md.read_text(encoding="utf-8")
    except Exception:  # noqa: BLE001
        return None
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return None
    try:
        data = yaml.safe_load("\n".join(lines[1:end])) or {}
    except Exception:  # noqa: BLE001
        return None
    name = data.get("name") if isinstance(data, dict) else None
    return str(name).strip() if name else None


def skill_name_from_path(skill_md: str | Path) -> str:
    path = Path(skill_md)
    return _read_frontmatter_name(path) or path.parent.name


def list_available_skills(
    pi_home: str | Path, custom_skill_dir: str | Path | None = None
) -> dict[str, Any]:
    """Enumerate selectable skills under the same roots ``resolve_skill_path`` searches.

    A skill is a directory containing ``SKILL.md``. The selectable identifier is the
    *directory name* — that is exactly what ``--skill-name`` / ``resolve_skill_path``
    consume, so it always resolves. The frontmatter ``name`` is parsed only to surface a
    diagnostic when it disagrees with the directory (pi warns but still loads on
    mismatch — we do not skip, or we would drop in-use skills whose frontmatter name
    differs from their directory name). The first occurrence of a directory name
    across roots wins (pi's collision rule). Returns
    ``{skills, diagnostics}``.
    """
    pi_home_p = Path(pi_home)
    custom = Path(custom_skill_dir) if custom_skill_dir else None
    names: list[str] = []
    seen: set[str] = set()
    diagnostics: list[str] = []
    for root in _skill_roots(pi_home_p, custom):
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            skill_md = child / "SKILL.md"
            if not child.is_dir() or not skill_md.is_file():
                continue
            dir_name = child.name
            if dir_name in seen:
                continue
            seen.add(dir_name)
            names.append(dir_name)
            fm_name = _read_frontmatter_name(skill_md)
            if fm_name is None:
                diagnostics.append(f"{skill_md}: missing frontmatter name (listed by directory)")
            elif fm_name != dir_name:
                diagnostics.append(
                    f"{skill_md}: frontmatter name '{fm_name}' != directory '{dir_name}' "
                    f"(listed/submitted as directory, which --skill-name resolves)"
                )
    return {"skills": names, "diagnostics": diagnostics}


def compute_skill_hash(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def compute_file_hash(path: str | Path) -> str:
    return compute_skill_hash(path)

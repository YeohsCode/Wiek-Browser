from __future__ import annotations

import ast
import io
import re
import subprocess
import tokenize
from collections.abc import Iterable, Iterator
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HAN_RE = re.compile(r"[\u3400-\u9fff]")
INTERNAL_DOC_RE = re.compile(r"(?i:\bprd\b|docs/prd)|§")

# Local credential files. Each has a tracked ``<name>.example`` template instead.
CREDENTIAL_FILES = (
    "agent-home/.pi/agent/auth.json",
    "agent-home/.codex/auth.json",
)

# Machine-local configuration that is not a credential but still cannot be published.
# A provider entry is the only place pi accepts a custom baseUrl — it interpolates
# $VAR in apiKey and headers but not in baseUrl — so a tracked models.json would put
# whatever gateway the author routes through into the public distribution.
LOCAL_CONFIG_FILES = ("agent-home/.pi/agent/models.json",)

TEMPLATED_FILES = CREDENTIAL_FILES + LOCAL_CONFIG_FILES

# Host names that only resolve inside the authors' network. A public checkout that
# points at them fails closed rather than silently talking to an unreachable proxy.
PRIVATE_ENDPOINT_RE = re.compile(r"(?i:citrolabs\.dev|127\.0\.0\.1:15721)")

# Absolute paths under a developer's home directory never belong in tracked source.
DEVELOPER_HOME_RE = re.compile(r"/Users/(?!test\b|runner\b)[A-Za-z0-9_.-]+/")


def _tracked_files(*patterns: str) -> list[Path]:
    output = subprocess.check_output(
        ["git", "ls-files", "--", *patterns],
        cwd=ROOT,
        text=True,
    )
    return [ROOT / value for value in output.splitlines() if value]


def _language_violations(
    source: str,
    entries: Iterable[tuple[int, str]],
) -> list[str]:
    violations: list[str] = []
    for line_number, text in entries:
        reasons: list[str] = []
        if HAN_RE.search(text):
            reasons.append("contains Han characters")
        if INTERNAL_DOC_RE.search(text):
            reasons.append("references internal product documentation")
        if reasons:
            excerpt = " ".join(text.strip().split())[:120]
            violations.append(f"{source}:{line_number}: {', '.join(reasons)}: {excerpt}")
    return violations


def _python_comments_and_docstrings(path: Path) -> Iterator[tuple[int, str]]:
    text = path.read_text(encoding="utf-8")
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.COMMENT:
            yield token.start[0], token.string

    tree = ast.parse(text, filename=str(path))
    documentable = (
        ast.Module,
        ast.ClassDef,
        ast.FunctionDef,
        ast.AsyncFunctionDef,
    )
    for node in ast.walk(tree):
        if not isinstance(node, documentable) or not node.body:
            continue
        first_statement = node.body[0]
        if (
            isinstance(first_statement, ast.Expr)
            and isinstance(first_statement.value, ast.Constant)
            and isinstance(first_statement.value.value, str)
        ):
            yield first_statement.lineno, first_statement.value.value


def _c_style_comments(text: str) -> Iterator[tuple[int, str]]:
    index = 0
    line_number = 1
    length = len(text)

    while index < length:
        current = text[index]
        if current == "\n":
            line_number += 1
            index += 1
            continue

        if current in {'"', "'", "`"}:
            quote = current
            index += 1
            while index < length:
                if text[index] == "\\":
                    index += 2
                    continue
                if text[index] == quote:
                    index += 1
                    break
                if text[index] == "\n":
                    line_number += 1
                index += 1
            continue

        if text.startswith("//", index):
            start_line = line_number
            end = text.find("\n", index)
            if end == -1:
                end = length
            yield start_line, text[index:end]
            index = end
            continue

        block_end = ""
        if text.startswith("/*", index):
            block_end = "*/"
        elif text.startswith("<!--", index):
            block_end = "-->"
        if block_end:
            start_line = line_number
            end = text.find(block_end, index + 2)
            end = length if end == -1 else end + len(block_end)
            comment = text[index:end]
            yield start_line, comment
            line_number += comment.count("\n")
            index = end
            continue

        index += 1


def _hash_comments(text: str) -> Iterator[tuple[int, str]]:
    for line_number, line in enumerate(text.splitlines(), start=1):
        if line_number == 1 and line.startswith("#!"):
            continue

        single_quoted = False
        double_quoted = False
        escaped = False
        for index, character in enumerate(line):
            if escaped:
                escaped = False
                continue
            if character == "\\" and not single_quoted:
                escaped = True
                continue
            if character == "'" and not double_quoted:
                single_quoted = not single_quoted
                continue
            if character == '"' and not single_quoted:
                double_quoted = not double_quoted
                continue
            if character == "#" and not single_quoted and not double_quoted:
                if index > 0 and line[index - 1] == "$":
                    continue
                if line.rfind("${", 0, index) > line.rfind("}", 0, index):
                    continue
                yield line_number, line[index:]
                break


def test_python_comments_and_docstrings_are_english_and_decoupled() -> None:
    violations: list[str] = []
    for path in _tracked_files("*.py"):
        entries = _python_comments_and_docstrings(path)
        violations.extend(_language_violations(str(path.relative_to(ROOT)), entries))

    assert not violations, "\n".join(violations)


def test_c_style_comments_are_english_and_decoupled() -> None:
    patterns = (
        "*.c",
        "*.cc",
        "*.cpp",
        "*.css",
        "*.go",
        "*.h",
        "*.hpp",
        "*.html",
        "*.js",
        "*.jsx",
        "*.mjs",
        "*.rs",
        "*.ts",
        "*.tsx",
    )
    violations: list[str] = []
    for path in _tracked_files(*patterns):
        entries = _c_style_comments(path.read_text(encoding="utf-8"))
        violations.extend(_language_violations(str(path.relative_to(ROOT)), entries))

    assert not violations, "\n".join(violations)


def test_hash_comments_are_english_and_decoupled() -> None:
    paths = set(_tracked_files("*.sh", "*.toml", "*.yaml", "*.yml"))
    paths.update(
        path
        for path in (ROOT / ".gitignore", ROOT / "Makefile", ROOT / "scripts/relink-wiek-browser")
        if path.exists()
    )

    violations: list[str] = []
    for path in sorted(paths):
        entries = _hash_comments(path.read_text(encoding="utf-8"))
        violations.extend(_language_violations(str(path.relative_to(ROOT)), entries))

    assert not violations, "\n".join(violations)


def test_credential_files_are_not_tracked() -> None:
    """Credentials must stay local; only their ``.example`` templates ship."""
    tracked = [path for path in CREDENTIAL_FILES if _tracked_files(path)]

    assert not tracked, (
        "credential files are tracked and would be published: "
        + ", ".join(tracked)
        + ". Run `git rm --cached <path>` and rotate the exposed credentials."
    )


def test_local_config_files_are_not_tracked() -> None:
    """Machine-local configuration must stay local; only its template ships."""
    tracked = [path for path in LOCAL_CONFIG_FILES if _tracked_files(path)]

    assert not tracked, (
        "machine-local configuration is tracked and would publish this machine's "
        "endpoints: " + ", ".join(tracked) + ". Run `git rm --cached <path>` and put "
        "any shareable content in the adjacent .example instead."
    )


def test_templates_exist_for_every_untracked_local_file() -> None:
    """Every ignored credential or local config file keeps a tracked template beside it."""
    missing = [
        f"{path}.example" for path in TEMPLATED_FILES if not _tracked_files(f"{path}.example")
    ]

    assert not missing, "missing tracked templates: " + ", ".join(missing)


def test_tracked_sources_have_no_private_endpoints_or_home_paths() -> None:
    """Tracked text must not hardcode a private gateway or a developer's home path."""
    skipped_suffixes = {".png", ".pdf", ".webp", ".zip"}
    skipped_names = {"uv.lock", "pnpm-lock.yaml", "package-lock.json"}

    violations: list[str] = []
    for path in _tracked_files("*"):
        if path.suffix in skipped_suffixes or path.name in skipped_names:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue  # Binary payloads such as the vendored fd helper.
        relative = str(path.relative_to(ROOT))
        for line_number, line in enumerate(text.splitlines(), start=1):
            for pattern, reason in (
                (PRIVATE_ENDPOINT_RE, "hardcodes a private endpoint"),
                (DEVELOPER_HOME_RE, "hardcodes a developer home path"),
            ):
                if pattern.search(line):
                    violations.append(f"{relative}:{line_number}: {reason}: {line.strip()[:120]}")

    assert not violations, "\n".join(violations)


def test_runtime_prompts_are_english_and_decoupled() -> None:
    prompt_paths = sorted((ROOT / "wiek_bench/prompts").rglob("*.j2"))
    prompt_paths.append(ROOT / "agent-home/.pi/agent/AGENTS.md")
    prompt_paths.extend(sorted((ROOT / "agent-home/.pi/agent/skills").rglob("SKILL.md")))

    violations: list[str] = []
    for path in prompt_paths:
        text = path.read_text(encoding="utf-8")
        entries = enumerate(text.splitlines(), start=1)
        violations.extend(_language_violations(str(path.relative_to(ROOT)), entries))

    assert not violations, "\n".join(violations)

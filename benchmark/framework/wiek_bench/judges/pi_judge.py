"""pi-as-judge: multimodal pi calls in two channels (single / agent), the only judge path.

Every judge call spawns one `pi --mode rpc` subprocess and sends a single multimodal
`prompt`; after agent_end it reads BOTH the last assistant text and the usage from the
judge session file via session_parser, the single authoritative usage source.
Two channels are supported: ``single`` uses no tools or skills and is naturally
single-turn; ``agent`` uses readonly+bash tools plus one judge
skill, pi runs the tool loop. No native structured output, so JSON verdicts are extracted
from text with a reformat follow-up fallback (agent uses a no-more-tools reformat).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

from loguru import logger
from pydantic import BaseModel, ValidationError

from wiek_bench.pi_rpc import PiRpcSession
from wiek_bench.session_parser import extract_stop_reason_error, safe_parse

T = TypeVar("T", bound=BaseModel)


@dataclass
class JudgeUsage:
    session_id: str | None = None
    session_file: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    # Agent-run shape: duration_s is the judge session's wall span and
    # num_turns = agent turns — both straight from safe_parse(session_file).SessionStats,
    # surfaced so the WebUI Judge view can show time/turns like Progress does for Stage A.
    # Summed across sub-calls (odysseys per-rubric) the same way tokens/cost are.
    duration_s: float = 0.0
    num_turns: int = 0

    def add(self, other: "JudgeUsage") -> None:
        """Fold a sub-call's usage into this one; first non-null session wins."""
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cost_usd += other.cost_usd
        self.duration_s += other.duration_s
        self.num_turns += other.num_turns
        if self.session_id is None:
            self.session_id = other.session_id
            self.session_file = other.session_file

    def as_meta(self) -> dict[str, Any]:
        """The judge_* keys embedded in JudgeResult.metadata."""
        return {
            "judge_session_id": self.session_id,
            "judge_session_file": self.session_file,
            "judge_input_tokens": self.input_tokens,
            "judge_output_tokens": self.output_tokens,
            "judge_cost_usd": self.cost_usd,
            "judge_duration_s": self.duration_s,
            "judge_turns": self.num_turns,
        }


@dataclass
class PiJudgeText:
    text: str
    usage: JudgeUsage = field(default_factory=JudgeUsage)
    error: str | None = None


@dataclass
class PiJudgeResult:
    value: Any | None
    usage: JudgeUsage = field(default_factory=JudgeUsage)
    error: str | None = None


def _split_model(model: str) -> tuple[str, str]:
    if "/" in model:
        provider, model_id = model.split("/", 1)
        return provider, model_id
    return "", model


_JUDGE_IMG_MAX_DIM = 1568  # downscale cap; keeps judge requests well under size limits
_JUDGE_IMG_QUALITY = 80


def _image_payload(paths: list[Path] | None) -> list[dict[str, Any]]:
    """Downscale + JPEG-encode screenshots for the judge request (non-destructive).

    Full-resolution retina captures blow past provider request-size limits, so each image is
    capped to _JUDGE_IMG_MAX_DIM and re-encoded. The on-disk frames/ WebP stay untouched.
    """
    import io

    from PIL import Image

    out: list[dict[str, Any]] = []
    for p in paths or []:
        try:
            with Image.open(p) as im:
                im = im.convert("RGB")
                w, h = im.size
                scale = min(1.0, _JUDGE_IMG_MAX_DIM / max(w, h))
                if scale < 1.0:
                    im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))))
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=_JUDGE_IMG_QUALITY)
                data = base64.b64encode(buf.getvalue()).decode("ascii")
            out.append({"type": "image", "data": data, "mimeType": "image/jpeg"})
        except Exception:  # noqa: BLE001 - fall back to raw bytes
            try:
                data = base64.b64encode(Path(p).read_bytes()).decode("ascii")
            except Exception:  # noqa: BLE001
                continue
            sp = str(p).lower()
            if sp.endswith((".jpg", ".jpeg")):
                mime = "image/jpeg"
            elif sp.endswith(".webp"):
                mime = "image/webp"
            else:
                mime = "image/png"
            out.append({"type": "image", "data": data, "mimeType": mime})
    return out


# The locked-down judge channel tail shared by both modes: no context/templates/themes.
JUDGE_COMMON_TAIL = (
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
)


def judge_channel_flags(
    *, mode: str, tools: list[str] | None = None, skill_path: str | None = None
) -> list[str]:
    """Locked-down judge channel flags for ``mode`` (single-sourced).

    - ``single``: model-only, no tools/skills — naturally single-turn.
    - ``agent``: readonly+bash tools + exactly one explicit judge skill, extensions
      disabled (agent has bash, so ``--no-extensions`` is mandatory to keep the wiek-bench
      screenshot/guard extension from firing on the judge's bash).

    Both share JUDGE_COMMON_TAIL. The judge-session HTML export (report.session_html)
    reuses this so reopening pi matches the exact shape the judge ran in — change flags
    here and both paths stay in lockstep.
    """
    if mode == "agent":
        return [
            "--tools",
            ",".join(tools or []),
            "--no-skills",
            *(["--skill", skill_path] if skill_path else []),
            "--no-extensions",
            *JUDGE_COMMON_TAIL,
        ]
    return ["--no-tools", "--no-skills", *JUDGE_COMMON_TAIL]


def _build_judge_argv(
    *,
    pi_bin: str,
    provider: str,
    model_id: str,
    thinking: str,
    mode: str = "single",
    tools: list[str] | None = None,
    skill_path: str | None = None,
    system_prompt: str | None = None,
) -> list[str]:
    argv = [pi_bin, "--mode", "rpc"]
    if provider:
        argv += ["--provider", provider]
    argv += ["--model", model_id, "--thinking", thinking]
    # Replace pi's default coding-assistant system prompt with the judge's own.
    # Odysseys single mode uses the paper's FULL_TRAJ_JUDGMENT_SYSTEM. With the channel's
    # --no-context-files/--no-prompt-templates/--no-skills/--no-tools, the system message
    # becomes exactly this text. None → pi keeps its default. Only this LIVE build threads
    # it; the session-HTML export reuses judge_channel_flags without it,
    # so an exported judge session renders pi's default system prompt — an accepted gap
    # (pi --export hardcodes systemPrompt to undefined anyway).
    if system_prompt:
        argv += ["--system-prompt", system_prompt]
    argv += judge_channel_flags(mode=mode, tools=tools, skill_path=skill_path)
    return argv


# Permanent (non-retryable) judge errors: 4xx request-shape codes and image/input
# rejections. Kept narrow so transient messages that merely contain "400" or "invalid"
# somewhere don't get wrongly short-circuited.
_PERMANENT_STATUS_RE = re.compile(r"\b(400|413|415|422)\b")
_PERMANENT_PHRASES = (
    "unexpected item type",
    "does not support image",
    "image input",
    "invalid image",
    "unsupported image",
    "modality",
)


def _is_permanent_error(message: str | None) -> bool:
    if not message:
        return False
    lowered = message.lower()
    if _PERMANENT_STATUS_RE.search(lowered):
        return True
    return any(phrase in lowered for phrase in _PERMANENT_PHRASES)


async def _one_call(
    *,
    message: str,
    images: list[dict[str, Any]],
    pi_bin: str,
    provider: str,
    model_id: str,
    thinking: str,
    cwd: str,
    env: dict[str, str],
    timeout_s: float,
    mode: str = "single",
    tools: list[str] | None = None,
    skill_path: str | None = None,
    system_prompt: str | None = None,
    reformat: str | None = None,
    needs_reformat: Callable[[str], bool] | None = None,
) -> tuple[str, JudgeUsage, str | None]:
    """Spawn one pi judge subprocess; return (last_assistant_text, usage, error_message).

    When ``reformat`` is given and ``needs_reformat(text)`` is True for the first answer (i.e.
    it is not a valid verdict because it is unparseable or fails the schema) and the
    run didn't error-stop, one reformat nudge is sent IN THE SAME session and the text re-read
    — so a formatting slip is fixed inside this subprocess rather than by re-running the whole
    (possibly agent-mode, multi-turn) investigation on the next retry.
    """
    argv = _build_judge_argv(
        pi_bin=pi_bin,
        provider=provider,
        model_id=model_id,
        thinking=thinking,
        mode=mode,
        tools=tools,
        skill_path=skill_path,
        system_prompt=system_prompt,
    )
    errbox: dict[str, str | None] = {"msg": None}

    def _capture(event: dict[str, Any]) -> None:
        # capture stopReason=="error" (incl. provider_transport_failure from
        # diagnostics) from the event stream, using the same extraction as Stage A.
        etype = event.get("type")
        if etype in ("message_end", "turn_end"):
            m = event.get("message") or {}
            if isinstance(m, dict) and m.get("role") == "assistant":
                errbox["msg"] = extract_stop_reason_error(m) or errbox["msg"]
        elif etype == "agent_end":
            for m in event.get("messages") or []:
                if isinstance(m, dict) and m.get("role") == "assistant":
                    errbox["msg"] = extract_stop_reason_error(m) or errbox["msg"]

    session = PiRpcSession(argv, cwd=cwd, env=env, on_event=_capture)
    usage = JudgeUsage()

    async def _read_state_text() -> str:
        # H2: text + usage both come from the judge session file via the single session
        # parser with no separate RPC stats path. Usage is cumulative,
        # so a re-read after the reformat turn holds the full totals.
        try:
            state = await session.get_state()
            usage.session_id = state.get("sessionId")
            usage.session_file = state.get("sessionFile")
            if usage.session_file:
                stats = safe_parse(usage.session_file)
                usage.input_tokens = stats.input_tokens
                usage.output_tokens = stats.output_tokens
                usage.cost_usd = float(stats.cost_usd or 0.0)
                # Whole-session totals are safe to reread after the reformat turn.
                usage.duration_s = stats.duration_s or 0.0
                usage.num_turns = stats.num_turns
                return stats.final_output or ""
        except Exception:  # noqa: BLE001
            pass
        return ""

    try:
        await session.start()
        await session.set_auto_retry(True)
        await asyncio.wait_for(session.run_prompt(message, images=images or None), timeout=timeout_s)
        text = await _read_state_text()
        if reformat and needs_reformat and not errbox["msg"] and needs_reformat(text):
            await asyncio.wait_for(session.run_prompt(reformat), timeout=timeout_s)
            text = await _read_state_text()
        await session.abort()
        # errbox["msg"] is set iff stopReason=="error" (incl. provider_transport_failure):
        # surface it regardless of text — an error stop's text is truncated/untrusted and
        # must not pass as a verdict, matching Stage A's error-stop handling.
        return text, usage, errbox["msg"]
    finally:
        await session.shutdown()


async def pi_judge_text(
    *,
    model: str,
    thinking_level: str,
    message: str,
    images: list[Path] | None = None,
    retry_max: int = 3,
    timeout_s: float = 180.0,
    pi_bin: str,
    pi_agent_dir: str,
    cwd: str,
    mode: str = "single",
    tools: list[str] | None = None,
    skill_path: str | None = None,
) -> PiJudgeText:
    provider, model_id = _split_model(model)
    img_payload = await asyncio.to_thread(_image_payload, images)
    env = {**os.environ, "PI_CODING_AGENT_DIR": pi_agent_dir}
    Path(cwd).mkdir(parents=True, exist_ok=True)
    last_err: Exception | str | None = None
    for attempt in range(max(1, retry_max)):
        try:
            text, usage, errmsg = await _one_call(
                message=message,
                images=img_payload,
                pi_bin=pi_bin,
                provider=provider,
                model_id=model_id,
                thinking=thinking_level,
                cwd=cwd,
                env=env,
                timeout_s=timeout_s,
                mode=mode,
                tools=tools,
                skill_path=skill_path,
            )
            if errmsg:
                # error stop wins over text: a stopReason=="error" run (incl.
                # provider_transport_failure) is untrusted even if it emitted text;
                # permanent → give up, else fall through to retry.
                last_err = errmsg
                if _is_permanent_error(errmsg):
                    return PiJudgeText(text="", usage=usage, error=errmsg)
            elif text:
                return PiJudgeText(text=text, usage=usage)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
        await asyncio.sleep(min(2**attempt, 8) + 0.1 * attempt)
    return PiJudgeText(text="", error=f"pi judge failed: {last_err}")


def _extract_json(text: str) -> dict[str, Any] | None:
    body = text.strip()
    if "```" in body:
        # strip the first fenced block if present
        start = body.find("```")
        fence = body[start + 3 :]
        if fence.lower().startswith("json"):
            fence = fence[4:]
        end = fence.find("```")
        if end >= 0:
            body = fence[:end]
    a = body.find("{")
    b = body.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        return json.loads(body[a : b + 1])
    except json.JSONDecodeError:
        return None


_REFORMAT = (
    "Your previous answer could not be parsed. Output ONLY the required JSON object, "
    "with no surrounding text, code fences, or explanation."
)

# Agent mode has just completed a tool loop before reformatting. Prevent another
# tool cycle and ask only for JSON based on the conclusion already reached.
_REFORMAT_AGENT = (
    "Stop investigating and do not call any more tools. Based on the conclusion you have "
    "already reached, output ONLY the required JSON object, with no surrounding text, code "
    "fences, or explanation."
)


async def pi_judge_json(
    *,
    model: str,
    thinking_level: str,
    message: str,
    schema: type[T],
    images: list[Path] | None = None,
    retry_max: int = 3,
    timeout_s: float = 180.0,
    pi_bin: str,
    pi_agent_dir: str,
    cwd: str,
    mode: str = "single",
    tools: list[str] | None = None,
    skill_path: str | None = None,
    system_prompt: str | None = None,
) -> PiJudgeResult:
    provider, model_id = _split_model(model)
    img_payload = await asyncio.to_thread(_image_payload, images)
    env = {**os.environ, "PI_CODING_AGENT_DIR": pi_agent_dir}
    Path(cwd).mkdir(parents=True, exist_ok=True)
    last_err: Exception | None = None
    reformat = _REFORMAT_AGENT if mode == "agent" else _REFORMAT

    def _needs_reformat(text: str) -> bool:
        """A response needs the in-session reformat when it isn't a valid verdict —
        unparseable JSON or a JSON object that fails the schema."""
        data = _extract_json(text)
        if data is None:
            return True
        try:
            schema.model_validate(data)
        except ValidationError:
            return True
        return False

    for attempt in range(max(1, retry_max)):
        try:
            text, usage, errmsg = await _one_call(
                message=message,
                images=img_payload,
                pi_bin=pi_bin,
                provider=provider,
                model_id=model_id,
                thinking=thinking_level,
                cwd=cwd,
                env=env,
                timeout_s=timeout_s,
                mode=mode,
                tools=tools,
                skill_path=skill_path,
                system_prompt=system_prompt,
                reformat=reformat,
                needs_reformat=_needs_reformat,
            )
            if errmsg:
                # error stop wins over text (symmetric with pi_judge_text): never parse
                # a verdict out of a stopReason=="error" run's truncated output.
                last_err = errmsg
                if _is_permanent_error(errmsg):
                    return PiJudgeResult(value=None, usage=usage, error=errmsg)
                await asyncio.sleep(min(2**attempt, 8))
                continue
            data = _extract_json(text)
            if data is None:
                last_err = ValueError(f"no JSON in judge output: {text[:200]!r}")
                await asyncio.sleep(min(2**attempt, 8))
                continue
            value = schema.model_validate(data)
            return PiJudgeResult(value=value, usage=usage)
        except ValidationError as exc:
            last_err = exc
        except Exception as exc:  # noqa: BLE001
            last_err = exc
        await asyncio.sleep(min(2**attempt, 8) + 0.1 * attempt)
    logger.debug("pi_judge_json exhausted retries: {}", last_err)
    return PiJudgeResult(value=None, error=f"pi judge json failed: {last_err}")

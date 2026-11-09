/**
 * safety-guard pi extension — deny destructive bash commands outright.
 *
 * pi ships no permission system by design, and the harness runs unattended, so a
 * dangerous command would otherwise just execute. This hook is the whole gate.
 *
 * Deliberately separate from the operator's own ~/.pi extensions: pi is launched with
 * PI_CODING_AGENT_DIR=<repo>/agent-home/.pi/agent, so only the extensions in this
 * directory load. The rule set is likewise a harness-owned copy
 * (wiek_bench/hooks/safety_guard.py), free to diverge from the Claude Code hook it came
 * from.
 *
 * NEVER prompt. In RPC mode ctx.ui.confirm() emits an extension_ui_request and blocks on
 * a stdin reply that the harness's RPC client (wiek_bench/pi_rpc.py) never sends — the
 * command would hang until the task timeout. Denials are unconditional and immediate;
 * the reason returns as the tool result and the agent carries on with the task.
 *
 * Fail-closed: if the helper cannot render a verdict, the command is blocked. A guard
 * that silently opens on error is not a guard.
 *
 * NEVER write to stdout (console.log) — it breaks pi's RPC LF framing. Debug → _debug.log.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = fileURLToPath(import.meta.url);
const DEBUG_LOG_PATH = EXTENSION_PATH.replace(/\.ts$/, "._debug.log");

/**
 * Cheap prefilter: spawning Python on every bash call would tax each browser command
 * for nothing. Only commands mentioning a destructive executable reach the helper.
 * Tuned to over-match (a stray `rm` in a JS heredoc costs one subprocess) — under-
 * matching would silently skip the guard, so every executable the helper knows about
 * must appear here.
 */
const SUSPICIOUS = /\b(rm|sudo|git|dd|mkfs(\.\w+)?|newfs_\w+|diskutil|chmod|chown|eval|psql|mysql|mariadb|sqlite3|duckdb|sqlcmd)\b|:\(\)/;

const HELPER_TIMEOUT_MS = 10_000;

function debugLog(line: string): void {
	try {
		appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// swallow; never break the agent
	}
}

interface Verdict {
	allowed: boolean;
	reason: string;
}

const FAIL_CLOSED: (detail: string) => Verdict = (detail) => ({
	allowed: false,
	reason:
		`Blocked by the wiek-bench safety guard: the guard could not evaluate this command (${detail}). ` +
		"Commands are denied when the guard cannot run. Continue the task without this command.",
});

function evaluate(command: string): Promise<Verdict> {
	const python = process.env.WIEK_BENCH_PYTHON || "python3";
	const root = process.env.WIEK_BENCH_HARNESS_ROOT;
	if (!root) return Promise.resolve(FAIL_CLOSED("WIEK_BENCH_HARNESS_ROOT not set"));

	return new Promise<Verdict>((resolve) => {
		const child = spawn(python, ["-m", "wiek_bench.hooks.safety_guard"], {
			cwd: root,
			env: { ...process.env, PYTHONPATH: root },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (verdict: Verdict) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(verdict);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(FAIL_CLOSED("guard timed out"));
		}, HELPER_TIMEOUT_MS);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => finish(FAIL_CLOSED(String(err))));
		child.on("close", (code) => {
			if (code === 0) return finish({ allowed: true, reason: "" });
			if (code === 1) {
				const reason = stdout.trim();
				// exit 1 is the deny path and always carries a reason; an empty one means
				// the helper died mid-write, which is still a deny.
				return finish(
					reason
						? { allowed: false, reason }
						: FAIL_CLOSED("guard denied without a reason"),
				);
			}
			finish(FAIL_CLOSED(`guard exited ${code}: ${stderr.trim().slice(0, 200)}`));
		});
		child.stdin.write(command);
		child.stdin.end();
	});
}

export default function (pi: ExtensionAPI): void {
	const enabled = (process.env.WIEK_BENCH_SAFETY_GUARD || "on").toLowerCase() !== "off";
	debugLog(`safety-guard extension loaded (enabled=${enabled})`);
	if (!enabled) return;

	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input?.command;
		if (typeof command !== "string" || command.trim() === "") return undefined;
		if (!SUSPICIOUS.test(command)) return undefined;

		const verdict = await evaluate(command);
		if (verdict.allowed) return undefined;
		debugLog(`DENY ${JSON.stringify(command.slice(0, 500))} :: ${verdict.reason}`);
		return { block: true, reason: verdict.reason };
	});
}

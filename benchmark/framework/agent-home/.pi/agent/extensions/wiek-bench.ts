/**
 * wiek-bench pi extension — Claude PreToolUse/PostToolUse equivalents + prompt-fragment
 * injection + system-prompt capture, all delegated to a single Python helper so the
 * browser-CLI parsing rules stay single-sourced in wiek_bench/browser_tools/.
 *
 * Loaded by pi auto-discovery from <PI_HOME>/.pi/agent/extensions/*.ts via jiti
 * (no build step). The harness does not modify settings.json.
 *
 * Hooks:
 *   before_agent_start
 *     - dump the full system-prompt structure (systemPrompt + systemPromptOptions +
 *       full tool schemas via getAllTools() + mode) → WIEK_BENCH_SYSPROMPT_PATH
 *       (once)
 *     - spawn helper `inject` → return its text as a session message so the task-id
 *       isolation + cleanup fragment enters the transcript (once per task)
 *   tool_call (bash)       → helper `validate`; block on instance-flag mismatch
 *   tool_execution_start   → stash command by toolCallId
 *   tool_execution_end     → helper `screenshot` (CDP capture after browser commands)
 *   message_update/end     → thinking_start→thinking_end wall-clock; persist per-assistant-message
 *                            think_ms as an "wiek-bench-think" custom entry
 *
 * NEVER write to stdout (console.log) — it breaks pi's RPC LF framing. Debug → _debug.log.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface HelperResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function getPython(): string {
	return process.env.WIEK_BENCH_PYTHON || "python3";
}

function getHarnessRoot(): string {
	const root = process.env.WIEK_BENCH_HARNESS_ROOT;
	if (!root) throw new Error("WIEK_BENCH_HARNESS_ROOT not set");
	return root;
}

const EXTENSION_PATH = fileURLToPath(import.meta.url);
const DEBUG_LOG_PATH = EXTENSION_PATH.replace(/\.ts$/, "._debug.log");

function debugLog(line: string): void {
	try {
		appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// swallow; never break the agent
	}
}

async function runHelper(args: string[], stdinPayload?: string): Promise<HelperResult> {
	const python = getPython();
	const root = getHarnessRoot();
	const env = { ...process.env, PYTHONPATH: root };
	return new Promise<HelperResult>((resolve) => {
		const child = spawn(python, ["-m", "wiek_bench.hooks.pi_extension_helper", ...args], {
			cwd: root,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			resolve({ stdout, stderr: stderr + String(err), exitCode: -1 });
		});
		child.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? -1 });
		});
		if (stdinPayload !== undefined) {
			child.stdin.write(stdinPayload);
		}
		child.stdin.end();
	});
}

// Tolerant JSON: the dump carries tool parameter schemas / skills / context files,
// which may include functions or circular refs. Never let a dump throw.
function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, current) => {
		if (typeof current === "bigint") return current.toString();
		if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
		if (current && typeof current === "object") {
			if (seen.has(current)) return "[Circular]";
			seen.add(current);
		}
		return current;
	});
}

export default function (pi: ExtensionAPI): void {
	debugLog("wiek-bench pi extension loaded");

	const pendingBashCommands = new Map<string, string>();
	let systemPromptDumped = false;
	let isolationInjected = false;

	// Dump the full system-prompt structure and inject the
	// task-id isolation + cleanup fragment once (enters the session transcript;
	// judge/report can see it).
	pi.on("before_agent_start", async (event, ctx) => {
		if (!systemPromptDumped) {
			const out = process.env.WIEK_BENCH_SYSPROMPT_PATH;
			if (out) {
				try {
					const options = event.systemPromptOptions;
					const systemPrompt =
						typeof event.systemPrompt === "string" ? event.systemPrompt : ctx.getSystemPrompt();
					const userPrompt = typeof event.prompt === "string" ? event.prompt : "";

					// Full tool schemas (name/description/parameters/sourceInfo) filtered to the
					// tools active in this prompt. getAllTools() carries the parameter schema and
					// sidesteps systemPromptOptions.toolSnippets (a Record of one-line summaries).
					const selectedToolNames = options?.selectedTools ?? pi.getActiveTools();
					const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
					const activeTools = selectedToolNames
						.map((name) => toolsByName.get(name))
						.filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);

					if (systemPrompt !== "" || activeTools.length > 0) {
						const payload = {
							schemaVersion: 1,
							mode: ctx.mode,
							cwd: options?.cwd ?? ctx.cwd,
							systemPrompt,
							systemPromptOptions: options,
							activeTools,
							allToolNames: pi.getAllTools().map((tool) => tool.name),
							prompt: userPrompt,
						};
						const dir = dirname(out);
						if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
						writeFileSync(out, safeStringify(payload), { encoding: "utf-8" });
						systemPromptDumped = true;
						debugLog(
							`sysprompt dumped: sys=${systemPrompt.length} tools=${activeTools.length} mode=${ctx.mode} -> ${out}`,
						);
					}
				} catch (err) {
					debugLog(`failed to dump sysprompt: ${String(err)}`);
				}
			}
		}

		// Injection shares the guard's mode switch; off disables both.
		const mode = (process.env.WIEK_BENCH_BROWSER_TOOL_MODE || "strict").toLowerCase();
		if (mode === "off") return undefined; // fast path: don't even spawn the helper

		if (!isolationInjected && process.env.WIEK_BENCH_TASK_ID && process.env.WIEK_BENCH_BROWSER_TOOL) {
			try {
				const r = await runHelper(["inject"]);
				const content = r.stdout.trim();
				if (r.exitCode === 0 && content) {
					isolationInjected = true;
					debugLog(`isolation fragment injected (${content.length} chars)`);
					return {
						message: { customType: "wiek-bench-isolation", content, display: true },
					};
				}
			} catch (err) {
				debugLog(`inject helper error: ${String(err)}`);
			}
		}
		return undefined;
	});

	// PreToolUse-equivalent: block browser commands that target the wrong instance.
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input?.command;
		if (typeof command !== "string" || command.trim() === "") return undefined;
		if (!process.env.WIEK_BENCH_TASK_ID || !process.env.WIEK_BENCH_BROWSER_TOOL) return undefined;
		const mode = (process.env.WIEK_BENCH_BROWSER_TOOL_MODE || "strict").toLowerCase();
		if (mode === "off") return undefined; // fast path: don't even spawn the helper
		try {
			const result = await runHelper(["validate"], command);
			if (result.exitCode === 0) return undefined;
			const reason = result.stdout.trim() || result.stderr.trim() || "blocked by wiek-bench guard";
			debugLog(`block tool_call: ${reason}`);
			return { block: true, reason };
		} catch (err) {
			debugLog(`validate helper error: ${String(err)}`);
			return undefined;
		}
	});

	pi.on("tool_execution_start", async (event) => {
		if (event.toolName !== "bash") return;
		const argsAny = (event as unknown as { args?: { command?: string } }).args;
		const command = argsAny?.command;
		if (typeof command === "string" && command.length > 0) {
			pendingBashCommands.set(event.toolCallId, command);
		}
	});

	// Stream events are the only place where thinking start/end instants are
	// start/end instants are observable — pi session v3 stores no per-block timing.
	let thinkMs = 0;
	let thinkOpenAt: number | null = null;

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		thinkMs = 0;
		thinkOpenAt = null;
	});

	pi.on("message_update", async (event) => {
		const kind = event.assistantMessageEvent?.type;
		if (kind === "thinking_start") {
			if (thinkOpenAt === null) thinkOpenAt = Date.now();
		} else if (kind === "thinking_end") {
			if (thinkOpenAt !== null) {
				thinkMs += Date.now() - thinkOpenAt;
				thinkOpenAt = null;
			}
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		// close a block left open by an abort/error mid-thinking
		if (thinkOpenAt !== null) {
			thinkMs += Date.now() - thinkOpenAt;
			thinkOpenAt = null;
		}
		if (thinkMs > 0) {
			try {
				pi.appendEntry("wiek-bench-think", { think_ms: Math.round(thinkMs) });
			} catch (err) {
				debugLog(`appendEntry think error: ${String(err)}`);
			}
		}
		thinkMs = 0;
	});

	// PostToolUse-equivalent: capture a CDP screenshot after a browser command.
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== "bash") return;
		const command = pendingBashCommands.get(event.toolCallId);
		pendingBashCommands.delete(event.toolCallId);
		if (typeof command !== "string" || command.trim() === "") return;
		if (!process.env.WIEK_BENCH_SCREENSHOT_FRAMES_DIR || !process.env.WIEK_BENCH_BROWSER_TOOL) return;
		try {
			await runHelper(["screenshot"], command);
		} catch (err) {
			debugLog(`screenshot helper error: ${String(err)}`);
		}
	});
}

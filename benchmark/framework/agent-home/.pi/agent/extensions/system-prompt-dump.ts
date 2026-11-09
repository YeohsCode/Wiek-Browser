/**
 * Dump Pi's current system prompt and base prompt inputs.
 *
 * Usage in pi:
 *   /system-prompt-dump
 *   /system-prompt-dump /tmp/pi-system-prompt.json
 *
 * The dumped data does not include the user's next query. It may include full
 * context file contents, skill metadata, and active tool schemas, so the file is
 * written with 0600 permissions.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_OUTPUT = ".pi-system-prompt-dump.json";

function outputPath(cwd: string, arg: string): string {
	const target = arg.trim() || DEFAULT_OUTPUT;
	return isAbsolute(target) ? target : resolve(cwd, target);
}

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(
		value,
		(_key, current) => {
			if (typeof current === "bigint") return current.toString();
			if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
			if (current && typeof current === "object") {
				if (seen.has(current)) return "[Circular]";
				seen.add(current);
			}
			return current;
		},
		2,
	);
}

export default function systemPromptDump(pi: ExtensionAPI) {
	pi.registerCommand("system-prompt-dump", {
		description: "Dump current system prompt, prompt options, and active tool schemas to JSON",
		handler: async (args, ctx) => {
			const file = outputPath(ctx.cwd, args);
			const options = ctx.getSystemPromptOptions();
			const selectedToolNames = options.selectedTools ?? pi.getActiveTools();

			const toolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
			const activeTools = selectedToolNames
				.map((name) => toolsByName.get(name))
				.filter((tool): tool is NonNullable<typeof tool> => tool !== undefined);

			const payload = {
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				note: "Contains system prompt data only; no user query is included. Treat contextFiles as sensitive.",
				mode: ctx.mode,
				cwd: ctx.cwd,

				// Fully assembled system prompt string currently held by Pi.
				systemPrompt: ctx.getSystemPrompt(),

				// Structured base inputs returned by the new API.
				systemPromptOptions: options,

				// Full metadata/schema for tools active in the prompt.
				activeToolNames: selectedToolNames,
				activeTools,

				// Names of all registered tools for quick comparison.
				allToolNames: pi.getAllTools().map((tool) => tool.name),
			};

			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, `${safeStringify(payload)}\n`, { mode: 0o600 });
			await chmod(file, 0o600);

			ctx.ui.notify(`System prompt dump written to ${file}`, "info");
		},
	});
}

/**
 * Status Line Extension
 *
 * Demonstrates ctx.ui.setStatus() for displaying persistent status text in the footer.
 * Shows turn progress with themed colors.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turnCount = 0;
	let taskStartTime: number | null = null;

	const formatDuration = (milliseconds: number): string => {
		const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;

		if (minutes === 0) {
			return `${seconds}s`;
		}

		return `${minutes}m ${seconds}s`;
	};

	pi.on("session_start", async (_event, ctx) => {
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("status-demo", theme.fg("dim", "Ready"));
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		turnCount = 0;
		taskStartTime = Date.now();
		const theme = ctx.ui.theme;
		const spinner = theme.fg("accent", "●");
		const text = theme.fg("dim", " Task running...");
		ctx.ui.setStatus("status-demo", spinner + text);
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		taskStartTime ??= Date.now();
		const theme = ctx.ui.theme;
		const spinner = theme.fg("accent", "●");
		const text = theme.fg("dim", ` Task running... Turn ${turnCount}`);
		ctx.ui.setStatus("status-demo", spinner + text);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const label = turnCount === 1 ? "turn" : "turns";
		const theme = ctx.ui.theme;
		const spinner = theme.fg("accent", "●");
		const text = theme.fg("dim", ` Task running... ${turnCount} ${label} completed`);
		ctx.ui.setStatus("status-demo", spinner + text);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const theme = ctx.ui.theme;
		const check = theme.fg("success", "✓");
		const label = turnCount === 1 ? "turn" : "turns";
		const duration = taskStartTime === null ? "unknown time" : formatDuration(Date.now() - taskStartTime);
		const text = theme.fg("dim", ` Task complete in ${duration} (${turnCount} ${label})`);
		ctx.ui.setStatus("status-demo", check + text);
		taskStartTime = null;
	});
}

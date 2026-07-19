import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentProgress } from "./runner.ts";

const MAX_WIDGET_LINES = 12;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
type ThemeLike = Pick<Theme, "bold" | "fg">;

export interface AgentView {
	id: string;
	displayName: string;
	task: string;
	startedAt: number;
	progress: AgentProgress;
}

function formatCount(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatDuration(milliseconds: number): string {
	if (milliseconds < 1000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
	const minutes = Math.floor(milliseconds / 60_000);
	const seconds = Math.floor((milliseconds % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
}

function statusIcon(progress: AgentProgress, theme: ThemeLike, frame?: number): string {
	switch (progress.status) {
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("warning", "■");
		default:
			return theme.fg(
				"accent",
				SPINNER[frame === undefined ? Math.floor(progress.durationMs / 80) % SPINNER.length : frame],
			);
	}
}

function contextUsage(progress: AgentProgress): string {
	if (!progress.contextTokens) return "";
	const compactions = progress.compactions ? ` · ⇊${progress.compactions}` : "";
	if (!progress.contextWindow) return `${formatCount(progress.contextTokens)} token${compactions}`;
	const percentage = Math.min(999, (progress.contextTokens / progress.contextWindow) * 100);
	return `${formatCount(progress.contextTokens)} token (${percentage.toFixed(0)}%${compactions})`;
}

function progressStatistics(progress: AgentProgress): string {
	return [
		progress.toolUses > 0 ? `${progress.toolUses} tool ${progress.toolUses === 1 ? "use" : "uses"}` : "",
		contextUsage(progress),
		formatDuration(progress.durationMs),
	]
		.filter(Boolean)
		.join(" · ");
}

function taskPreview(task: string, maxLength: number): string {
	const normalized = task.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

export function progressStatus(progress: AgentProgress, theme: ThemeLike): string {
	return `${statusIcon(progress, theme)} ${theme.fg("dim", progressStatistics(progress))}`;
}

export function dashboardLines(
	agents: AgentView[],
	theme: ThemeLike,
	now: number,
	frame: number,
	width: number,
): string[] {
	if (!agents.some((agent) => agent.progress.status === "running")) return [];

	const truncate = (line: string) => truncateToWidth(line, Math.max(1, width));
	const items = agents.map((agent) => {
		const running = agent.progress.status === "running";
		const progress = running
			? { ...agent.progress, durationMs: Math.max(0, now - agent.startedAt) }
			: agent.progress;
		const icon = statusIcon(progress, theme, running ? frame % SPINNER.length : undefined);
		const task = taskPreview(agent.task, 60);
		const header = `${icon} ${theme.bold(agent.displayName)}  ${theme.fg("muted", task)} ${theme.fg(
			"dim",
			`· ${progressStatistics(progress)}`,
		)}`;
		return running ? [header, `${theme.fg("muted", "⎿")}  ${theme.fg("dim", progress.activity)}`] : [header];
	});

	const lines = [truncate(theme.fg("accent", "● Agents"))];
	let remaining = MAX_WIDGET_LINES - 1;
	for (const [index, item] of items.entries()) {
		const hiddenAfter = items.length - index - 1;
		const reserveOverflow = hiddenAfter > 0 ? 1 : 0;
		if (item.length > remaining - reserveOverflow) {
			lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${items.length - index} more`)}`));
			break;
		}
		const last = index === items.length - 1;
		lines.push(truncate(`${theme.fg("dim", last ? "└─" : "├─")} ${item[0]}`));
		if (item[1]) {
			lines.push(truncate(`${theme.fg("dim", last ? "   " : "│  ")} ${item[1]}`));
		}
		remaining -= item.length;
	}
	return lines;
}

export class SubagentWidget {
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private timer: NodeJS.Timeout | undefined;
	private frame = 0;
	private readonly agents: () => AgentView[];

	constructor(agents: () => AgentView[]) {
		this.agents = agents;
	}

	setUI(ui: ExtensionUIContext): void {
		if (this.ui === ui) return;
		this.clear();
		this.ui = ui;
	}

	update(): void {
		if (!this.ui) return;
		const hasActive = this.agents().some((agent) => agent.progress.status === "running");
		if (!hasActive) {
			this.clear();
			return;
		}

		this.ensureTimer();
		if (this.registered) {
			this.tui?.requestRender();
			return;
		}

		this.ui.setWidget(
			"subagent-runs",
			(tui, theme) => {
				this.tui = tui;
				return {
					render: (width) => dashboardLines(this.agents(), theme, Date.now(), this.frame, width),
					invalidate: () => tui.requestRender(true),
				};
			},
			{ placement: "aboveEditor" },
		);
		this.registered = true;
	}

	dispose(): void {
		this.clear();
		this.ui = undefined;
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER.length;
			this.tui?.requestRender();
		}, 80);
		this.timer.unref();
	}

	private clear(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (this.registered) this.ui?.setWidget("subagent-runs", undefined);
		this.registered = false;
		this.tui = undefined;
	}
}

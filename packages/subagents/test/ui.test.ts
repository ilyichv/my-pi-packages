import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import type { AgentProgress } from "../lib/runner.ts";
import { type AgentView, dashboardLines, progressStatus, SubagentWidget } from "../lib/ui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		status: "running",
		turns: 5,
		toolUses: 30,
		contextTokens: 33800,
		contextWindow: 54500,
		compactions: 0,
		durationMs: 12300,
		activity: "editing 2 files…",
		...overrides,
	};
}

test("renders inline progress statistics", () => {
	const summary = progressStatus(progress(), theme);

	expect(summary).toContain("30 tool uses · 33.8k token (62%) · 12.3s");
});

test("renders completion and compaction state", () => {
	const summary = progressStatus(
		progress({
			status: "completed",
			contextTokens: 91000,
			contextWindow: 108000,
			compactions: 2,
			durationMs: 137000,
			activity: "completed",
		}),
		theme,
	);

	expect(summary).toContain("✓ 30 tool uses");
	expect(summary).toContain("91.0k token (84% · ⇊2)");
	expect(summary).toContain("2m17s");
});

test("renders concurrent agents as one stable tree", () => {
	const agents: AgentView[] = [
		{
			id: "scout",
			displayName: "Scout",
			task: "Find where agent definitions are loaded.",
			startedAt: 1000,
			progress: progress({ turns: 3, toolUses: 10, activity: "thinking…" }),
		},
		{
			id: "planner",
			displayName: "Planner",
			task: "Plan tests for agent discovery.",
			startedAt: 1400,
			progress: progress({
				turns: 3,
				toolUses: 13,
				contextTokens: 5500,
				contextWindow: 550000,
				activity: "thinking…",
			}),
		},
	];

	const lines = dashboardLines(agents, theme, 14_800, 6, 160);

	expect(lines).toEqual([
		"● Agents",
		"├─ ⠦ Scout  Find where agent definitions are loaded. · 10 tool uses · 33.8k token (62%) · 13.8s",
		"│   ⎿  thinking…",
		"└─ ⠦ Planner  Plan tests for agent discovery. · 13 tool uses · 5.5k token (1%) · 13.4s",
		"    ⎿  thinking…",
	]);
});

test("mounts the widget once, rerenders it, and clears it when idle", () => {
	const agents: AgentView[] = [
		{
			id: "scout",
			displayName: "Scout",
			task: "Find agent definitions",
			startedAt: Date.now(),
			progress: progress(),
		},
	];
	let factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
	const setWidget = vi.fn((_key: string, content: unknown) => {
		if (typeof content === "function") {
			factory = content as typeof factory;
		}
	});
	const widget = new SubagentWidget(() => agents);
	widget.setUI({ setWidget } as unknown as ExtensionUIContext);
	widget.update();

	expect(setWidget).toHaveBeenCalledOnce();
	expect(setWidget).toHaveBeenCalledWith("subagent-runs", expect.any(Function), {
		placement: "aboveEditor",
	});

	const requestRender = vi.fn();
	const component = factory?.({ requestRender }, theme);
	expect(component?.render(120)[0]).toBe("● Agents");

	widget.update();
	expect(setWidget).toHaveBeenCalledOnce();
	expect(requestRender).toHaveBeenCalled();

	agents[0].progress = progress({ status: "completed", activity: "completed" });
	widget.update();
	expect(setWidget).toHaveBeenLastCalledWith("subagent-runs", undefined);
	expect(setWidget).toHaveBeenCalledTimes(2);
});

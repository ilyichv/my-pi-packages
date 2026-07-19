import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { registerSubagent } from "../extensions/subagent.ts";
import type { AgentConfig, AgentDiscovery } from "../lib/agents.ts";
import type { AgentProgress, RunAgentOptions } from "../lib/runner.ts";

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	isError?: boolean;
}

interface CapturedTool {
	name: string;
	renderCall: (
		args: { agent: string; task: string },
		theme: {
			fg: (color: string, text: string) => string;
			bold: (text: string) => string;
		},
		context: { cwd: string },
	) => { render: (width: number) => string[] };
	execute: (
		id: string,
		params: { agent: string; task: string },
		signal: AbortSignal | undefined,
		onUpdate: ((result: ToolResult) => void) | undefined,
		context: unknown,
	) => Promise<ToolResult>;
}

interface CapturedCommand {
	name: string;
	handler: (args: string, context: unknown) => Promise<void>;
}

const completedProgress: AgentProgress = {
	status: "completed",
	turns: 2,
	toolUses: 3,
	contextTokens: 12000,
	contextWindow: 100000,
	compactions: 0,
	durationMs: 4100,
	activity: "completed",
};

function createAgent(source: AgentConfig["source"] = "user"): AgentConfig {
	return {
		name: "scout",
		displayName: "Code Scout",
		description: "Find relevant code",
		tools: ["read"],
		systemPrompt: "Investigate.",
		source,
		filePath: `/agents/${source}/scout.md`,
	};
}

function setup(discovery: AgentDiscovery, run = vi.fn()) {
	let tool: CapturedTool | undefined;
	const commands: CapturedCommand[] = [];
	const api = {
		on() {},
		registerTool(value: CapturedTool) {
			tool = value;
		},
		registerCommand(name: string, value: Omit<CapturedCommand, "name">) {
			commands.push({ name, ...value });
		},
	};

	registerSubagent(api as unknown as ExtensionAPI, {
		discover: () => discovery,
		run: run as (options: RunAgentOptions) => ReturnType<typeof run>,
		approvalGatePath: "/approval-gate.ts",
	});
	if (!tool) throw new Error("Tool was not registered");
	return { tool, commands, run };
}

test("registers the subagent tool and only the agents command", async () => {
	const agent = createAgent();
	const liveProgress: AgentProgress = {
		...completedProgress,
		status: "running",
		activity: "searching…",
	};
	const run = vi.fn(async (options: RunAgentOptions) => {
		options.onProgress?.(liveProgress);
		return {
			status: "completed" as const,
			output: "Findings",
			exitCode: 0,
			stderr: "",
			progress: completedProgress,
		};
	});
	const { tool, commands } = setup({ agents: [agent], projectDir: null }, run);

	expect(tool.name).toBe("subagent");
	expect(commands.map((command) => command.name)).toEqual(["agents"]);

	const notify = vi.fn();
	await commands[0].handler("", { cwd: "/project", ui: { notify } });
	expect(notify).toHaveBeenCalledWith(
		expect.stringContaining("Code Scout (scout) [user] — Find relevant code"),
		"info",
	);

	const renderedCallLines = tool
		.renderCall(
			{ agent: "scout", task: "Find auth" },
			{
				fg: (_color, text) => text,
				bold: (text) => text,
			},
			{ cwd: "/project" },
		)
		.render(120);
	const renderedCall = renderedCallLines.join("\n");
	expect(renderedCallLines).toHaveLength(1);
	expect(renderedCall).toContain("▸ Code Scout  Find auth");
	expect(renderedCall).toContain("Code Scout");
	expect(renderedCall).not.toContain("Subagent");

	const setWidget = vi.fn();
	const onUpdate = vi.fn();
	const result = await tool.execute("call", { agent: "scout", task: "Find auth" }, undefined, onUpdate, {
		cwd: "/project",
		mode: "tui",
		hasUI: true,
		model: undefined,
		modelRegistry: { getAll: () => [] },
		ui: {
			confirm: vi.fn(),
			setWidget,
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	});
	expect(result).toEqual(expect.objectContaining({ content: [{ type: "text", text: "Findings" }] }));
	expect(onUpdate).toHaveBeenCalledWith(
		expect.objectContaining({
			details: expect.objectContaining({
				displayName: "Code Scout",
				status: "running",
				progress: liveProgress,
			}),
		}),
	);
	expect(setWidget).toHaveBeenNthCalledWith(1, "subagent-runs", expect.any(Function), {
		placement: "aboveEditor",
	});
	expect(setWidget).toHaveBeenLastCalledWith("subagent-runs", undefined);
	expect(setWidget).toHaveBeenCalledTimes(2);
	expect(run).toHaveBeenCalledWith(
		expect.objectContaining({
			agent,
			task: "Find auth",
			cwd: "/project",
			approvalGatePath: "/approval-gate.ts",
		}),
	);
});

test("runs project agents without another prompt and reports unknown agents", async () => {
	const run = vi.fn(async () => ({
		status: "completed" as const,
		output: "Project findings",
		exitCode: 0,
		stderr: "",
		progress: completedProgress,
	}));
	const { tool } = setup({ agents: [createAgent("project")], projectDir: "/project/.pi/agents" }, run);
	const confirm = vi.fn();

	const projectResult = await tool.execute(
		"call",
		{ agent: "scout", task: "Inspect code" },
		undefined,
		undefined,
		{
			cwd: "/project",
			mode: "tui",
			hasUI: true,
			model: undefined,
			modelRegistry: { getAll: () => [] },
			ui: {
				confirm,
				setWidget: vi.fn(),
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
			},
		},
	);
	expect(projectResult.content[0].text).toBe("Project findings");
	expect(confirm).not.toHaveBeenCalled();
	expect(run).toHaveBeenCalledOnce();

	const unknown = await tool.execute(
		"call",
		{ agent: "missing", task: "Inspect code" },
		undefined,
		undefined,
		{ cwd: "/project", hasUI: true, ui: { confirm: vi.fn() } },
	);
	expect(unknown.isError).toBe(true);
	expect(unknown.content[0].text).toContain('Unknown agent "missing"');
});

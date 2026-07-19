import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentDiscovery, discoverAgents, formatAgents } from "../lib/agents.ts";
import { type AgentProgress, type RunAgentOptions, type RunAgentResult, runAgent } from "../lib/runner.ts";
import { type AgentView, progressStatus, SubagentWidget } from "../lib/ui.ts";

type AgentDiscoveryFunction = (cwd: string) => AgentDiscovery;
type AgentRunner = (options: RunAgentOptions) => Promise<RunAgentResult>;

export interface SubagentExtensionOptions {
	discover?: AgentDiscoveryFunction;
	run?: AgentRunner;
	approvalGatePath?: string;
}

interface SubagentDetails {
	agent: string;
	displayName: string;
	task: string;
	status: "running" | "completed" | "failed" | "aborted";
	progress: AgentProgress;
	exitCode?: number;
	usesWidget?: boolean;
}

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const bundledAgentsDirectory = resolve(extensionDirectory, "../agents");
const defaultApprovalGatePath = resolve(
	extensionDirectory,
	"../../approval-gate/extensions/approval-gate.ts",
);

function availableAgents(agents: AgentConfig[]): string {
	return agents.length ? agents.map((agent) => `${agent.name} [${agent.source}]`).join(", ") : "none";
}

function initialProgress(): AgentProgress {
	return {
		status: "running",
		turns: 0,
		toolUses: 0,
		contextTokens: 0,
		compactions: 0,
		durationMs: 0,
		activity: "starting…",
	};
}

function contextWindow(agent: AgentConfig, ctx: ExtensionContext): number | undefined {
	if (!agent.model) return ctx.model?.contextWindow;
	const model = ctx.modelRegistry
		.getAll()
		.find(
			(candidate) => candidate.id === agent.model || `${candidate.provider}/${candidate.id}` === agent.model,
		);
	return model?.contextWindow;
}

export function registerSubagent(pi: ExtensionAPI, options: SubagentExtensionOptions = {}): void {
	const discover =
		options.discover ??
		((cwd: string) =>
			discoverAgents(cwd, {
				bundled: bundledAgentsDirectory,
				user: join(getAgentDir(), "agents"),
			}));
	const executeAgent = options.run ?? runAgent;
	const approvalGatePath = options.approvalGatePath ?? defaultApprovalGatePath;
	const runs = new Map<string, AgentView>();
	const widget = new SubagentWidget(() => [...runs.values()]);
	const clearRuns = () => {
		runs.clear();
		widget.dispose();
	};

	pi.on("agent_end", clearRuns);
	pi.on("session_before_switch", clearRuns);
	pi.on("session_shutdown", clearRuns);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a named coding agent in an isolated Pi process. Use /agents to see available agents. Multiple subagent tool calls can run in parallel.",
		executionMode: "parallel",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name from /agents", minLength: 1 }),
			task: Type.String({
				description: "Self-contained task with all context the isolated agent needs",
				minLength: 1,
			}),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agents = discover(ctx.cwd).agents;
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent) {
				const progress = { ...initialProgress(), status: "failed" as const, activity: "unknown agent" };
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent "${params.agent}". Available agents: ${availableAgents(agents)}.`,
						},
					],
					details: {
						agent: params.agent,
						displayName: params.agent,
						task: params.task,
						status: "failed",
						progress,
					} satisfies SubagentDetails,
					isError: true,
				};
			}

			let progress = initialProgress();
			const view: AgentView = {
				id: toolCallId,
				displayName: agent.displayName,
				task: params.task,
				startedAt: Date.now(),
				progress,
			};
			const usesWidget = ctx.mode === "tui";
			runs.set(toolCallId, view);
			if (usesWidget) {
				widget.setUI(ctx.ui);
				widget.update();
			}
			let latestText = "";
			const emitUpdate = () =>
				onUpdate?.({
					content: [{ type: "text", text: latestText || progress.activity }],
					details: {
						agent: agent.name,
						displayName: agent.displayName,
						task: params.task,
						status: progress.status,
						progress,
						usesWidget,
					} satisfies SubagentDetails,
				});
			const updateProgress = (nextProgress: AgentProgress) => {
				progress = nextProgress;
				view.progress = nextProgress;
				if (usesWidget) widget.update();
				if (
					nextProgress.status !== "running" &&
					![...runs.values()].some((run) => run.progress.status === "running")
				) {
					runs.clear();
				}
			};

			try {
				const result = await executeAgent({
					agent,
					task: params.task,
					cwd: ctx.cwd,
					approvalGatePath,
					contextWindow: contextWindow(agent, ctx),
					signal,
					onUpdate: (text) => {
						latestText = text;
						emitUpdate();
					},
					onProgress: (nextProgress) => {
						updateProgress(nextProgress);
						emitUpdate();
					},
				});
				updateProgress(result.progress);
				const text =
					result.output ||
					result.stderr.trim() ||
					(result.status === "completed" ? "(no output)" : `Agent ${result.status}.`);
				return {
					content: [{ type: "text", text }],
					details: {
						agent: agent.name,
						displayName: agent.displayName,
						task: params.task,
						status: result.status,
						progress: result.progress,
						exitCode: result.exitCode,
						usesWidget,
					} satisfies SubagentDetails,
					isError: result.status !== "completed",
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				progress = {
					...progress,
					status: "failed",
					activity: "failed",
				};
				view.progress = progress;
				if (usesWidget) widget.update();
				if (![...runs.values()].some((run) => run.progress.status === "running")) runs.clear();
				return {
					content: [{ type: "text", text: `Subagent could not start: ${message}` }],
					details: {
						agent: agent.name,
						displayName: agent.displayName,
						task: params.task,
						status: "failed",
						progress,
						usesWidget,
					} satisfies SubagentDetails,
					isError: true,
				};
			}
		},
		renderCall(args, theme, context) {
			const agent = discover(context.cwd).agents.find((candidate) => candidate.name === args.agent);
			const displayName = agent?.displayName ?? args.agent ?? "Subagent";
			const task = (args.task || "...").replace(/\s+/g, " ").trim();
			const preview = task.length > 80 ? `${task.slice(0, 80)}...` : task;
			const text = `▸ ${theme.fg("toolTitle", theme.bold(displayName))}  ${theme.fg("muted", preview)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			if ((isPartial || details.status === "running") && details.usesWidget) return new Text("", 0, 0);

			const status = progressStatus(details.progress, theme);
			const activity = `${theme.fg("muted", "⎿")}  ${theme.fg("dim", details.progress.activity)}`;
			if (!expanded) return new Text(`${status}\n  ${activity}`, 0, 0);

			const container = new Container();
			container.addChild(new Text(`${status}\n  ${activity}`, 0, 0));
			const content = result.content.find((item) => item.type === "text");
			if (content?.type === "text" && content.text) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(content.text, 0, 0, getMarkdownTheme()));
			}
			return container;
		},
	});

	pi.registerCommand("agents", {
		description: "List available subagents",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /agents", "warning");
				return;
			}
			const discovery = discover(ctx.cwd);
			ctx.ui.notify(formatAgents(discovery.agents), "info");
		},
	});
}

export default function subagent(pi: ExtensionAPI): void {
	registerSubagent(pi);
}

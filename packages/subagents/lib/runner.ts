import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentConfig } from "./agents.ts";

export interface PiInvocation {
	command: string;
	baseArgs: string[];
}

export interface RunAgentOptions {
	agent: AgentConfig;
	task: string;
	cwd: string;
	approvalGatePath: string;
	contextWindow?: number;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
	onProgress?: (progress: AgentProgress) => void;
	invocation?: PiInvocation;
}

export interface AgentProgress {
	status: "running" | "completed" | "failed" | "aborted";
	turns: number;
	toolUses: number;
	contextTokens: number;
	contextWindow?: number;
	compactions: number;
	durationMs: number;
	activity: string;
}

export interface RunAgentResult {
	status: "completed" | "failed" | "aborted";
	output: string;
	exitCode: number;
	stderr: string;
	progress: AgentProgress;
}

interface JsonMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		totalTokens?: number;
	};
}

interface JsonEvent {
	type?: string;
	message?: JsonMessage;
	toolName?: string;
	args?: Record<string, unknown>;
	assistantMessageEvent?: {
		type?: string;
	};
}

export function buildPiArguments(
	agent: AgentConfig,
	task: string,
	promptPath: string,
	approvalGatePath: string,
): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-skills",
		"--no-extensions",
		"--extension",
		approvalGatePath,
		"--append-system-prompt",
		promptPath,
	];
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	if (agent.model) args.push("--model", agent.model);
	if (agent.thinking) args.push("--thinking", agent.thinking);
	args.push(`Task: ${task}`);
	return args;
}

export function resolvePiInvocation(): PiInvocation {
	const script = process.argv[1];
	const isBunVirtualScript = script?.startsWith("/$bunfs/root/");
	if (script && !isBunVirtualScript && existsSync(script)) {
		return { command: process.execPath, baseArgs: [script] };
	}

	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) {
		return { command: process.execPath, baseArgs: [] };
	}
	return { command: "pi", baseArgs: [] };
}

function messageText(message: JsonMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
		})
		.join("\n");
}

function toolActivity(toolName: string, args: Record<string, unknown> | undefined): string {
	const path = args?.path ?? args?.file_path;
	switch (toolName) {
		case "read":
			return typeof path === "string" ? `reading ${path}…` : "reading…";
		case "write":
		case "edit":
			return typeof path === "string" ? `editing ${path}…` : "editing…";
		case "grep":
		case "find":
			return "searching…";
		case "ls":
			return typeof path === "string" ? `listing ${path}…` : "listing files…";
		case "bash": {
			const command = args?.command;
			if (typeof command !== "string") return "running a command…";
			const firstLine = command.split(/\r?\n/, 1)[0];
			return `running ${firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine}`;
		}
		default:
			return `using ${toolName}…`;
	}
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
	if (!existsSync(options.approvalGatePath)) {
		throw new Error(`Approval Gate extension not found: ${options.approvalGatePath}`);
	}

	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-subagents-"));
	const promptPath = join(temporaryDirectory, "system-prompt.md");
	await writeFile(promptPath, options.agent.systemPrompt, { encoding: "utf8", mode: 0o600 });

	let output = "";
	let stderr = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let aborted = false;
	let processError: Error | undefined;
	const startedAt = Date.now();
	const progress: AgentProgress = {
		status: "running",
		turns: 0,
		toolUses: 0,
		contextTokens: 0,
		contextWindow: options.contextWindow,
		compactions: 0,
		durationMs: 0,
		activity: "starting…",
	};
	const emitProgress = () => {
		progress.durationMs = Date.now() - startedAt;
		options.onProgress?.({ ...progress });
	};

	try {
		const args = buildPiArguments(options.agent, options.task, promptPath, options.approvalGatePath);
		const invocation = options.invocation ?? resolvePiInvocation();
		const child = spawn(invocation.command, [...invocation.baseArgs, ...args], {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: JsonEvent;
			try {
				event = JSON.parse(line) as JsonEvent;
			} catch {
				return;
			}
			if (event.type === "agent_start") {
				progress.activity = "thinking…";
				emitProgress();
				return;
			}
			if (event.type === "message_update") {
				if (event.assistantMessageEvent?.type === "thinking_start") {
					progress.activity = "thinking…";
					emitProgress();
				} else if (event.assistantMessageEvent?.type === "text_start") {
					progress.activity = "responding…";
					emitProgress();
				}
				return;
			}
			if (event.type === "tool_execution_start" && event.toolName) {
				progress.toolUses++;
				progress.activity = toolActivity(event.toolName, event.args);
				emitProgress();
				return;
			}
			if (event.type === "tool_execution_end") {
				progress.activity = "thinking…";
				emitProgress();
				return;
			}
			if (event.type === "compaction_end") {
				progress.compactions++;
				progress.activity = "thinking…";
				emitProgress();
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				progress.turns++;
				progress.contextTokens = event.message.usage?.totalTokens ?? progress.contextTokens;
				const text = messageText(event.message);
				if (text) {
					output = text;
					options.onUpdate?.(text);
				}
				progress.activity = text ? "responding…" : progress.activity;
				stopReason = event.message.stopReason;
				errorMessage = event.message.errorMessage;
				emitProgress();
			}
		};

		child.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		let killTimer: NodeJS.Timeout | undefined;
		const abort = () => {
			aborted = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
			killTimer.unref();
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });

		const exitCode = await new Promise<number>((resolve) => {
			let settled = false;
			const settle = (code: number) => {
				if (settled) return;
				settled = true;
				resolve(code);
			};
			child.on("error", (error) => {
				processError = error;
				settle(1);
			});
			child.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				settle(code ?? 1);
			});
		});

		if (killTimer) clearTimeout(killTimer);
		options.signal?.removeEventListener("abort", abort);
		if (processError) throw processError;

		const failed = exitCode !== 0 || stopReason === "error" || stopReason === "aborted";
		progress.status = aborted || stopReason === "aborted" ? "aborted" : failed ? "failed" : "completed";
		progress.activity =
			progress.status === "completed" ? "completed" : progress.status === "aborted" ? "aborted" : "failed";
		emitProgress();
		return {
			status: progress.status,
			output: errorMessage || output,
			exitCode,
			stderr,
			progress: { ...progress },
		};
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

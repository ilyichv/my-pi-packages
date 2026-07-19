import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentConfig } from "../lib/agents.ts";
import { buildPiArguments, runAgent } from "../lib/runner.ts";

const agent: AgentConfig = {
	name: "worker",
	displayName: "Worker",
	description: "Worker",
	tools: ["read", "bash"],
	model: "provider/model",
	thinking: "medium",
	systemPrompt: "Work carefully.",
	source: "bundled",
	filePath: "/agents/worker.md",
};

test("builds an isolated Pi invocation with Approval Gate", () => {
	const args = buildPiArguments(agent, "Fix the bug", "/tmp/prompt.md", "/approval-gate.ts");
	expect(args).toEqual([
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-skills",
		"--no-extensions",
		"--extension",
		"/approval-gate.ts",
		"--append-system-prompt",
		"/tmp/prompt.md",
		"--tools",
		"read,bash",
		"--model",
		"provider/model",
		"--thinking",
		"medium",
		"Task: Fix the bug",
	]);
});

test("runs a child process and returns its final assistant output", async () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-runner-"));
	try {
		const fakePi = join(root, "fake-pi.mjs");
		const approvalGate = join(root, "approval-gate.ts");
		writeFileSync(approvalGate, "");
		writeFileSync(
			fakePi,
			[
				'import { readFileSync } from "node:fs";',
				"const args = process.argv.slice(2);",
				'const promptIndex = args.indexOf("--append-system-prompt");',
				'const text = JSON.stringify({ args, prompt: readFileSync(args[promptIndex + 1], "utf8") });',
				'const events = [{ type: "agent_start" }, { type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } }, { type: "tool_execution_end", toolName: "read" }, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { totalTokens: 12400 }, stopReason: "end" } }, { type: "compaction_end" }];',
				'for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");',
			].join("\n"),
		);

		const updates: string[] = [];
		const progressUpdates: string[] = [];
		const result = await runAgent({
			agent,
			task: "Fix the bug",
			cwd: root,
			approvalGatePath: approvalGate,
			contextWindow: 155000,
			invocation: { command: process.execPath, baseArgs: [fakePi] },
			onUpdate: (text) => updates.push(text),
			onProgress: (progress) => progressUpdates.push(progress.activity),
		});

		expect(result.status).toBe("completed");
		expect(result.exitCode).toBe(0);
		const child = JSON.parse(result.output) as { args: string[]; prompt: string };
		expect(child.args).toContain(approvalGate);
		expect(child.args).toContain("Task: Fix the bug");
		expect(child.prompt).toBe(agent.systemPrompt);
		expect(updates).toEqual([result.output]);
		expect(result.progress).toEqual(
			expect.objectContaining({
				status: "completed",
				turns: 1,
				toolUses: 1,
				contextTokens: 12400,
				contextWindow: 155000,
				compactions: 1,
				activity: "completed",
			}),
		);
		expect(progressUpdates).toContain("reading src/index.ts…");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fails before spawning when Approval Gate is unavailable", async () => {
	await expect(
		runAgent({
			agent,
			task: "Fix the bug",
			cwd: process.cwd(),
			approvalGatePath: "/missing/approval-gate.ts",
		}),
	).rejects.toThrow("Approval Gate extension not found");
});

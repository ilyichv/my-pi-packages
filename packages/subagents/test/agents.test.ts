import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { discoverAgents, findProjectAgentsDirectory, formatAgents } from "../lib/agents.ts";

function writeAgent(
	directory: string,
	fileName: string,
	name: string,
	description: string,
	body = "Follow the task.",
	displayName?: string,
): void {
	mkdirSync(directory, { recursive: true });
	const displayNameLine = displayName ? `display_name: ${displayName}\n` : "";
	writeFileSync(
		join(directory, fileName),
		`---\nname: ${name}\n${displayNameLine}description: ${description}\ntools: read, grep, read\nthinking: high\n---\n\n${body}\n`,
	);
}

test("discovers agents with project, user, and bundled precedence", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-discovery-"));
	try {
		const bundled = join(root, "bundled");
		const user = join(root, "user");
		const project = join(root, "project");
		const nested = join(project, "src", "nested");
		const projectAgents = join(project, ".pi", "agents");
		mkdirSync(nested, { recursive: true });

		writeAgent(bundled, "scout.md", "scout", "Bundled scout");
		writeAgent(bundled, "worker.md", "worker", "Bundled worker");
		writeAgent(user, "scout.md", "scout", "User scout");
		writeAgent(projectAgents, "scout.md", "scout", "Project scout");
		writeAgent(projectAgents, "reviewer.md", "reviewer", "Project reviewer", undefined, "Code Reviewer");
		writeFileSync(join(projectAgents, "invalid.md"), "---\nname: invalid\n---\n");

		expect(findProjectAgentsDirectory(nested)).toBe(projectAgents);
		const discovery = discoverAgents(nested, { bundled, user });

		expect(discovery.projectDir).toBe(projectAgents);
		expect(discovery.agents.map((agent) => [agent.name, agent.source, agent.description])).toEqual([
			["reviewer", "project", "Project reviewer"],
			["scout", "project", "Project scout"],
			["worker", "bundled", "Bundled worker"],
		]);
		expect(discovery.agents[0].tools).toEqual(["read", "grep"]);
		expect(discovery.agents[0].thinking).toBe("high");
		expect(discovery.agents[0].displayName).toBe("Code Reviewer");
		expect(discovery.agents[1].displayName).toBe("scout");
		expect(formatAgents(discovery.agents)).toContain("Code Reviewer (reviewer) [project] — Project reviewer");
		expect(formatAgents(discovery.agents)).toContain("scout [project] — Project scout");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("returns bundled and user agents when no project directory exists", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-user-"));
	try {
		const bundled = join(root, "bundled");
		const user = join(root, "user");
		writeAgent(bundled, "scout.md", "scout", "Bundled scout");
		writeAgent(user, "custom.md", "custom", "Custom user agent");

		const discovery = discoverAgents(root, { bundled, user });
		expect(discovery.projectDir).toBeNull();
		expect(discovery.agents.map((agent) => agent.name)).toEqual(["custom", "scout"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "bundled" | "user" | "project";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
	name: string;
	displayName: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDirectories {
	bundled: string;
	user: string;
}

export interface AgentDiscovery {
	agents: AgentConfig[];
	projectDir: string | null;
}

const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function loadAgents(directory: string, source: AgentSource): AgentConfig[] {
	if (!existsSync(directory)) return [];

	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;

		const filePath = join(directory, entry.name);
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = stringValue(frontmatter.name);
		const description = stringValue(frontmatter.description);
		if (!name || !description || !body.trim()) continue;

		const toolsValue = stringValue(frontmatter.tools);
		const tools = toolsValue
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
		const rawThinking = stringValue(frontmatter.thinking);
		const thinking =
			rawThinking && thinkingLevels.has(rawThinking as ThinkingLevel)
				? (rawThinking as ThinkingLevel)
				: undefined;

		agents.push({
			name,
			displayName: stringValue(frontmatter.display_name) ?? basename(entry.name, extname(entry.name)),
			description,
			tools: tools?.length ? [...new Set(tools)] : undefined,
			model: stringValue(frontmatter.model),
			thinking,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}
	return agents;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function findProjectAgentsDirectory(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverAgents(cwd: string, directories: AgentDirectories): AgentDiscovery {
	const projectDir = findProjectAgentsDirectory(cwd);
	const agentsByName = new Map<string, AgentConfig>();

	for (const agent of loadAgents(directories.bundled, "bundled")) agentsByName.set(agent.name, agent);
	for (const agent of loadAgents(directories.user, "user")) agentsByName.set(agent.name, agent);
	if (projectDir) {
		for (const agent of loadAgents(projectDir, "project")) agentsByName.set(agent.name, agent);
	}

	return {
		agents: [...agentsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
		projectDir,
	};
}

export function formatAgents(agents: AgentConfig[]): string {
	if (!agents.length) return "No agents found.";
	return agents
		.map((agent) => {
			const name = agent.displayName === agent.name ? agent.name : `${agent.displayName} (${agent.name})`;
			const tools = agent.tools?.join(", ") ?? "all built-in tools";
			const model = agent.model ? `; model: ${agent.model}` : "";
			return `${name} [${agent.source}] — ${agent.description}\n  tools: ${tools}${model}`;
		})
		.join("\n");
}

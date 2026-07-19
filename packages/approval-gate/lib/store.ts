import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface ApprovalStore {
	version: 1;
	projects: Record<string, string[]>;
}

const emptyStore = (): ApprovalStore => ({ version: 1, projects: {} });

export const normalizeCommand = (command: string): string => command.trim();

export function canRememberCommand(command: string): boolean {
	return !/[\r\n;&|<>`$*?[\]{}()]/.test(command);
}

export function cwdKey(cwd: string): string {
	try {
		return realpathSync.native(cwd);
	} catch {
		return resolve(cwd);
	}
}

export function parseStore(raw: string): ApprovalStore {
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || (value as ApprovalStore).version !== 1) {
		throw new Error("Invalid approval store");
	}
	const { projects: rawProjects } = value as { projects?: unknown };
	if (!rawProjects || typeof rawProjects !== "object" || Array.isArray(rawProjects)) {
		throw new Error("Invalid approval projects");
	}

	const projects: Record<string, string[]> = {};
	for (const [cwd, commands] of Object.entries(rawProjects as Record<string, unknown>)) {
		if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string")) {
			throw new Error(`Invalid approvals for ${cwd}`);
		}
		projects[cwd] = [...new Set(commands.map(normalizeCommand).filter(Boolean))];
	}
	return { version: 1, projects };
}

function readStore(path: string): ApprovalStore {
	return existsSync(path) ? parseStore(readFileSync(path, "utf8")) : emptyStore();
}

function writeStore(path: string, store: ApprovalStore): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		renameSync(temporaryPath, path);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Nothing to clean up.
		}
		throw error;
	}
}

export function loadApprovals(path: string, cwd: string): Set<string> {
	return new Set(readStore(path).projects[cwdKey(cwd)] ?? []);
}

export function purgeApprovals(path: string, shouldPurge: (command: string) => boolean): void {
	const store = readStore(path);
	let changed = false;
	for (const [key, commands] of Object.entries(store.projects)) {
		const remaining = commands.filter((command) => !shouldPurge(command));
		if (remaining.length === commands.length) continue;
		changed = true;
		if (remaining.length) store.projects[key] = remaining;
		else delete store.projects[key];
	}
	if (!changed) return;
	writeStore(path, store);
}

export function persistApproval(path: string, cwd: string, command: string): void {
	// ponytail: simultaneous Pi processes can lose one new approval; add file locking if that becomes common.
	const store = readStore(path);
	const key = cwdKey(cwd);
	store.projects[key] = [...new Set([...(store.projects[key] ?? []), command])].sort();
	writeStore(path, store);
}

export function clearApprovals(path: string, cwd: string): void {
	const store = readStore(path);
	delete store.projects[cwdKey(cwd)];
	writeStore(path, store);
}

export function targetsPath(path: string, cwd: string, candidatePath: string): boolean {
	const candidate = resolve(cwd, candidatePath);
	const expected = resolve(path);
	if (candidate === expected) return true;
	try {
		return realpathSync.native(candidate) === realpathSync.native(expected);
	} catch {
		return false;
	}
}

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

const emptyStore = () => ({ version: 1, projects: {} });

export const normalizeCommand = (command) => command.trim();

export function canRememberCommand(command) {
	return !/[\r\n;&|<>`$*?\[\]{}()]/.test(command);
}

export function cwdKey(cwd) {
	try {
		return realpathSync.native(cwd);
	} catch {
		return resolve(cwd);
	}
}

export function parseStore(raw) {
	const value = JSON.parse(raw);
	if (!value || typeof value !== "object" || value.version !== 1) {
		throw new Error("Invalid approval store");
	}
	if (!value.projects || typeof value.projects !== "object" || Array.isArray(value.projects)) {
		throw new Error("Invalid approval projects");
	}

	const projects = {};
	for (const [cwd, commands] of Object.entries(value.projects)) {
		if (!Array.isArray(commands) || !commands.every((command) => typeof command === "string")) {
			throw new Error(`Invalid approvals for ${cwd}`);
		}
		projects[cwd] = [...new Set(commands.map(normalizeCommand).filter(Boolean))];
	}
	return { version: 1, projects };
}

function readStore(path) {
	return existsSync(path) ? parseStore(readFileSync(path, "utf8")) : emptyStore();
}

function writeStore(path, store) {
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

export function loadApprovals(path, cwd) {
	return new Set(readStore(path).projects[cwdKey(cwd)] ?? []);
}

export function purgeApprovals(path, shouldPurge) {
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

export function persistApproval(path, cwd, command) {
	// ponytail: simultaneous Pi processes can lose one new approval; add file locking if that becomes common.
	const store = readStore(path);
	const key = cwdKey(cwd);
	store.projects[key] = [...new Set([...(store.projects[key] ?? []), command])].sort();
	writeStore(path, store);
}

export function clearApprovals(path, cwd) {
	const store = readStore(path);
	delete store.projects[cwdKey(cwd)];
	writeStore(path, store);
}

export function targetsPath(path, cwd, candidatePath) {
	const candidate = resolve(cwd, candidatePath);
	const expected = resolve(path);
	if (candidate === expected) return true;
	try {
		return realpathSync.native(candidate) === realpathSync.native(expected);
	} catch {
		return false;
	}
}

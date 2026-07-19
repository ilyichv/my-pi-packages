import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { isOpaqueCommand, isQuarantined, isStaticallyAllowed, parsePolicy } from "../lib/policy.ts";
import {
	canRememberCommand,
	clearApprovals,
	loadApprovals,
	persistApproval,
	purgeApprovals,
} from "../lib/store.ts";

test("approvals persist independently by working directory and fail closed", () => {
	const root = mkdtempSync(join(tmpdir(), "approval-gate-"));
	try {
		const store = join(root, "approvals.json");
		const first = join(root, "first");
		const second = join(root, "second");
		mkdirSync(first);
		mkdirSync(second);

		persistApproval(store, first, "git status");
		persistApproval(store, first, "rm -rf build");
		persistApproval(store, second, "git diff");
		persistApproval(store, second, "python -c 'print(1)'");
		persistApproval(store, second, "sudo reboot");
		expect([...loadApprovals(store, first)]).toEqual(["git status", "rm -rf build"]);
		expect([...loadApprovals(store, second)]).toEqual(["git diff", "python -c 'print(1)'", "sudo reboot"]);

		const policy = parsePolicy("{}");
		purgeApprovals(store, (command) => isQuarantined(command, policy) || isOpaqueCommand(command));
		expect([...loadApprovals(store, first)]).toEqual(["git status"]);
		expect([...loadApprovals(store, second)]).toEqual(["git diff"]);
		clearApprovals(store, first);
		expect([...loadApprovals(store, first)]).toEqual([]);
		expect([...loadApprovals(store, second)]).toEqual(["git diff"]);

		expect(canRememberCommand("git status")).toBe(true);
		expect(canRememberCommand("git status && rm -rf .")).toBe(false);
		writeFileSync(store, "not json");
		expect(() => loadApprovals(store, first)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("quarantine wins over static and learned approvals", () => {
	const policy = parsePolicy(
		JSON.stringify({
			allowCommands: ["bash", "printf", "rm"],
			allowPrefixes: ["git reset --hard", "git status"],
			quarantineCommands: ["rm"],
			quarantinePrefixes: ["git reset --hard"],
		}),
	);

	expect(policy.allowCommands).toEqual(["bash", "printf"]);
	expect(policy.allowPrefixes).toEqual(["git status"]);
	expect(isQuarantined("rm -rf .", policy)).toBe(true);
	expect(isQuarantined("/bin/rm -rf .", policy)).toBe(true);
	expect(isQuarantined("env rm -rf .", policy)).toBe(true);
	expect(isQuarantined("bash -c 'rm -rf .'", policy)).toBe(true);
	expect(isQuarantined("echo ready && rm -rf .", policy)).toBe(true);
	expect(isQuarantined("git reset --hard HEAD~1", policy)).toBe(true);
	expect(isQuarantined("git status --short", policy)).toBe(false);
	expect(isStaticallyAllowed("printf '%s\\n' hello", policy)).toBe(true);
	expect(isStaticallyAllowed("git status --short", policy)).toBe(true);
	expect(isOpaqueCommand("python -c 'print(1)'")).toBe(true);
	expect(isOpaqueCommand("env python3.12 -c 'print(1)'")).toBe(true);
	expect(isOpaqueCommand("node --version")).toBe(false);
	expect(isStaticallyAllowed("bash -c 'echo hello'", policy)).toBe(false);
	expect(isStaticallyAllowed("rm --help", policy)).toBe(false);
	expect(isStaticallyAllowed("git reset --hard", policy)).toBe(false);
	expect(isStaticallyAllowed("git statusx", policy)).toBe(false);
	expect(isStaticallyAllowed("printf hello > result.txt", policy)).toBe(false);
	expect(isStaticallyAllowed('printf "$SECRET"', policy)).toBe(false);
	expect(isStaticallyAllowed("git status && rm -rf .", policy)).toBe(false);
});

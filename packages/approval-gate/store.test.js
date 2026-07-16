import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canRememberCommand,
  clearApprovals,
  loadApprovals,
  persistApproval,
  purgeApprovals,
} from "./lib/store.js";
import {
  isOpaqueCommand,
  isQuarantined,
  isStaticallyAllowed,
  parsePolicy,
} from "./lib/policy.js";

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
    assert.deepEqual(
      [...loadApprovals(store, first)],
      ["git status", "rm -rf build"],
    );
    assert.deepEqual(
      [...loadApprovals(store, second)],
      ["git diff", "python -c 'print(1)'", "sudo reboot"],
    );

    const policy = parsePolicy("{}");
    purgeApprovals(
      store,
      (command) => isQuarantined(command, policy) || isOpaqueCommand(command),
    );
    assert.deepEqual([...loadApprovals(store, first)], ["git status"]);
    assert.deepEqual([...loadApprovals(store, second)], ["git diff"]);
    clearApprovals(store, first);
    assert.deepEqual([...loadApprovals(store, first)], []);
    assert.deepEqual([...loadApprovals(store, second)], ["git diff"]);

    assert.equal(canRememberCommand("git status"), true);
    assert.equal(canRememberCommand("git status && rm -rf ."), false);
    writeFileSync(store, "not json");
    assert.throws(() => loadApprovals(store, first));
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

  assert.deepEqual(policy.allowCommands, ["bash", "printf"]);
  assert.deepEqual(policy.allowPrefixes, ["git status"]);
  assert.equal(isQuarantined("rm -rf .", policy), true);
  assert.equal(isQuarantined("/bin/rm -rf .", policy), true);
  assert.equal(isQuarantined("env rm -rf .", policy), true);
  assert.equal(isQuarantined("bash -c 'rm -rf .'", policy), true);
  assert.equal(isQuarantined("echo ready && rm -rf .", policy), true);
  assert.equal(isQuarantined("git reset --hard HEAD~1", policy), true);
  assert.equal(isQuarantined("git status --short", policy), false);
  assert.equal(isStaticallyAllowed("printf '%s\\n' hello", policy), true);
  assert.equal(isStaticallyAllowed("git status --short", policy), true);
  assert.equal(isOpaqueCommand("python -c 'print(1)'"), true);
  assert.equal(isOpaqueCommand("env python3.12 -c 'print(1)'"), true);
  assert.equal(isOpaqueCommand("node --version"), false);
  assert.equal(isStaticallyAllowed("bash -c 'echo hello'", policy), false);
  assert.equal(isStaticallyAllowed("rm --help", policy), false);
  assert.equal(isStaticallyAllowed("git reset --hard", policy), false);
  assert.equal(isStaticallyAllowed("git statusx", policy), false);
  assert.equal(isStaticallyAllowed("printf hello > result.txt", policy), false);
  assert.equal(isStaticallyAllowed('printf "$SECRET"', policy), false);
  assert.equal(isStaticallyAllowed("git status && rm -rf .", policy), false);
});

import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	defaultPolicy,
	isOpaqueCommand,
	isQuarantined,
	isStaticallyAllowed,
	loadPolicy,
	type Policy,
} from "../lib/policy.ts";
import {
	canRememberCommand,
	clearApprovals,
	cwdKey,
	loadApprovals,
	normalizeCommand,
	persistApproval,
	purgeApprovals,
	targetsPath,
} from "../lib/store.ts";

const storePath = join(getAgentDir(), "command-approvals.json");
const policyPath = join(getAgentDir(), "approval-gate.json");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const failClosedPolicy = (): Policy => ({
	allowCommands: [],
	allowPrefixes: [],
	quarantineCommands: [...defaultPolicy.quarantineCommands],
	quarantinePrefixes: [...defaultPolicy.quarantinePrefixes],
});

export default function approvalGate(pi: ExtensionAPI): void {
	let approvals = new Set<string>();
	let policy = failClosedPolicy();

	pi.on("session_start", async (_event, ctx) => {
		try {
			policy = loadPolicy(policyPath);
		} catch (error) {
			policy = failClosedPolicy();
			ctx.ui.notify(`Approval policy could not be loaded: ${message(error)}`, "error");
		}
		try {
			purgeApprovals(storePath, (command) => isQuarantined(command, policy) || isOpaqueCommand(command));
			approvals = loadApprovals(storePath, ctx.cwd);
		} catch (error) {
			approvals.clear();
			ctx.ui.notify(`Command approvals could not be loaded: ${message(error)}`, "error");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			if (
				targetsPath(storePath, ctx.cwd, event.input.path) ||
				targetsPath(policyPath, ctx.cwd, event.input.path)
			) {
				return {
					block: true,
					reason: "Approval Gate configuration is protected.",
				};
			}
			return;
		}

		if (!isToolCallEventType("bash", event)) return;
		const command = normalizeCommand(event.input.command);
		if (!command) return { block: true, reason: "Empty Bash command blocked." };
		const quarantined = isQuarantined(command, policy);
		const oneTimeOnly = quarantined || isOpaqueCommand(command);
		if (isStaticallyAllowed(command, policy)) return;
		if (!oneTimeOnly && approvals.has(command)) return;
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Command requires approval, but no UI is available:\n${command}`,
			};
		}

		const deny = "Deny";
		const runOnce = "Run once";
		const alwaysAllow = "Always allow for this working directory";
		const options =
			!oneTimeOnly && canRememberCommand(command) ? [deny, runOnce, alwaysAllow] : [deny, runOnce];
		const title = oneTimeOnly ? "Harmful command requires approval" : "Command requires approval";
		const choice = await ctx.ui.select(`${title}:\n\n${command}`, options);

		if (choice === runOnce) return;
		if (choice === alwaysAllow && !oneTimeOnly) {
			try {
				persistApproval(storePath, ctx.cwd, command);
				approvals.add(command);
				return;
			} catch (error) {
				ctx.ui.notify(`Approval could not be saved: ${message(error)}`, "error");
				return {
					block: true,
					reason: "Command blocked because its approval could not be saved.",
				};
			}
		}

		return { block: true, reason: `Command denied by user:\n${command}` };
	});

	pi.registerCommand("approvals", {
		description: "List approvals or clear them with /approvals clear",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "clear") {
				try {
					clearApprovals(storePath, ctx.cwd);
					approvals.clear();
					ctx.ui.notify("Approvals cleared for this working directory.", "info");
				} catch (error) {
					ctx.ui.notify(`Approvals could not be cleared: ${message(error)}`, "error");
				}
				return;
			}
			if (action) {
				ctx.ui.notify("Usage: /approvals or /approvals clear", "warning");
				return;
			}

			const commands = [...approvals].sort();
			ctx.ui.notify(
				commands.length
					? `Always allowed for ${cwdKey(ctx.cwd)}:\n${commands.join("\n")}`
					: `No approvals for ${cwdKey(ctx.cwd)}.`,
				"info",
			);
		},
	});
}

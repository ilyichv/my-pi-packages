import { existsSync, readFileSync } from "node:fs";

export const defaultPolicy = {
	allowCommands: ["echo", "false", "printf", "pwd", "true"],
	allowPrefixes: [],
	quarantineCommands: [
		"dd",
		"diskutil",
		"fdisk",
		"gdisk",
		"kill",
		"killall",
		"parted",
		"pkill",
		"reboot",
		"rm",
		"rmdir",
		"sgdisk",
		"shutdown",
		"sudo",
		"truncate",
		"unlink",
		"wipefs",
	],
	quarantinePrefixes: [
		"aws s3 rm",
		"git checkout --",
		"git clean",
		"git gc --prune",
		"git push --force",
		"git push -f",
		"git reflog expire",
		"git reset --hard",
		"git restore",
		"kubectl delete",
		"mkfs",
		"newfs_",
		"terraform destroy",
	],
};

function stringList(value, fallback, name) {
	if (value === undefined) return [...fallback];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${name} must be an array of strings`);
	}
	return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

export function parsePolicy(raw) {
	const value = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Approval policy must be an object");
	}

	const policy = {
		allowCommands: stringList(value.allowCommands, defaultPolicy.allowCommands, "allowCommands"),
		allowPrefixes: stringList(value.allowPrefixes, defaultPolicy.allowPrefixes, "allowPrefixes"),
		quarantineCommands: stringList(
			value.quarantineCommands,
			defaultPolicy.quarantineCommands,
			"quarantineCommands",
		),
		quarantinePrefixes: stringList(
			value.quarantinePrefixes,
			defaultPolicy.quarantinePrefixes,
			"quarantinePrefixes",
		),
	};

	// Quarantine always wins if a command appears in both lists.
	policy.allowCommands = policy.allowCommands.filter((command) => !isQuarantined(command, policy));
	policy.allowPrefixes = policy.allowPrefixes.filter((prefix) => !isQuarantined(prefix, policy));
	return policy;
}

export function loadPolicy(path) {
	return existsSync(path) ? parsePolicy(readFileSync(path, "utf8")) : structuredClone(defaultPolicy);
}

function commandHead(command) {
	const match = command.match(/^\s*([^\s]+)/);
	if (!match) return null;
	const executable = match[1].replace(/^["']|["']$/g, "").replaceAll("\\", "/").split("/").at(-1);
	return {
		executable,
		text: `${executable}${command.slice(match[0].length)}`.trim(),
	};
}

const wrappers = new Set([
	"bash",
	"command",
	"dash",
	"env",
	"exec",
	"fish",
	"nice",
	"nohup",
	"sh",
	"sudo",
	"zsh",
]);

function commandHeads(segment) {
	const first = commandHead(segment);
	if (!first || !wrappers.has(first.executable)) return first ? [first] : [];

	// Wrapper syntax is deliberately treated conservatively: inspect each later word as a possible command.
	const words = segment.trim().split(/\s+/);
	return words.map((_, index) => commandHead(words.slice(index).join(" "))).filter(Boolean);
}

export function isQuarantined(command, policy) {
	// Inspect every shell segment. Composition is never rememberable, but still gets a quarantine prompt.
	for (const segment of command.split(/&&|\|\||[;|\r\n]/)) {
		for (const head of commandHeads(segment)) {
			if (policy.quarantineCommands.includes(head.executable)) return true;
			if (policy.quarantinePrefixes.some((prefix) => head.text.startsWith(prefix))) return true;
		}
	}
	return false;
}

export function isOpaqueCommand(command) {
	for (const head of command.split(/&&|\|\||[;|\r\n]/).flatMap(commandHeads)) {
		const args = head.text.split(/\s+/).slice(1);
		const shortFlag = (flag) =>
			args.some((arg) => arg === flag || (/^-[^-]+$/.test(arg) && arg.includes(flag[1])));

		if (["bash", "dash", "fish", "sh", "zsh"].includes(head.executable) && shortFlag("-c")) {
			return true;
		}
		if (["node", "nodejs", "perl", "ruby"].includes(head.executable)) {
			if (shortFlag("-e") || shortFlag("-p") || args.includes("--eval") || args.includes("--print")) {
				return true;
			}
		}
		if (/^python(?:\d+(?:\.\d+)*)?$/.test(head.executable) && shortFlag("-c")) return true;
		if (head.executable === "php" && shortFlag("-r")) return true;
		if (head.executable === "osascript" && shortFlag("-e")) return true;
		if (["powershell", "pwsh"].includes(head.executable)) {
			if (args.some((arg) => ["-c", "-command", "-encodedcommand"].includes(arg.toLowerCase()))) {
				return true;
			}
		}
		if (
			["cmd", "cmd.exe"].includes(head.executable.toLowerCase()) &&
			args.some((arg) => arg.toLowerCase() === "/c")
		) {
			return true;
		}
	}
	return false;
}

export function isStaticallyAllowed(command, policy) {
	// Only one simple shell command may bypass the prompt. Config cannot override this boundary.
	if (/[\r\n;&|<>`$]/.test(command)) return false;
	if (isOpaqueCommand(command)) return false;
	if (isQuarantined(command, policy)) return false;

	const head = commandHead(command);
	if (head && policy.allowCommands.includes(head.executable)) return true;

	return policy.allowPrefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
}

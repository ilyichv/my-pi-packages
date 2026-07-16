# Approval Gate

Pi extension that asks before every agent `bash` call. Choices are deny, run once, or always allow the exact command for the current working directory.

Approvals are stored in `~/.pi/agent/command-approvals.json` (or the directory selected by `PI_CODING_AGENT_DIR`) and keyed by the canonical working-directory path.

Simple commands can bypass prompts through the separate static policy at `~/.pi/agent/approval-gate.json`:

```json
{
  "allowCommands": ["echo", "false", "printf", "pwd", "true"],
  "allowPrefixes": ["git status"],
  "quarantineCommands": [
    "dd", "diskutil", "fdisk", "gdisk", "kill", "killall", "parted",
    "pkill", "reboot", "rm", "rmdir", "sgdisk", "shutdown", "sudo",
    "truncate", "unlink", "wipefs"
  ],
  "quarantinePrefixes": [
    "aws s3 rm", "git checkout --", "git clean", "git gc --prune",
    "git push --force", "git push -f", "git reflog expire",
    "git reset --hard", "git restore", "kubectl delete", "mkfs",
    "newfs_", "terraform destroy"
  ]
}
```

`allowCommands` matches the executable name. `allowPrefixes` matches exact command text prefixes. Both only apply to a single command without chaining, redirection, command substitution, or variable expansion. Missing fields use the built-in defaults shown above, except `allowPrefixes`, which defaults to empty. An explicitly configured field replaces its default list. Restart Pi or use `/reload` after editing the policy.

Quarantine has higher priority than both the static allowlist and saved approvals. A quarantined command always offers only **Run once** or **Deny**. Matching entries already present anywhere in `command-approvals.json` are removed when a session starts, and quarantined commands can never be saved from the prompt.

The built-in quarantine covers common destructive commands (`rm`, `sudo`, disk tools, process termination, and shutdown) plus destructive prefixes such as `git reset --hard`, `git clean`, `git restore`, `kubectl delete`, and `terraform destroy`. Set either quarantine field to an empty array if you intentionally want no defaults for that field.

Opaque shell and interpreter one-liners such as `bash -c`, `python -c`, and `node -e` are also always one-shot-only. This prevents a wrapper from becoming a saved bypass without adding a full shell-language parser.

```sh
pi install ./approval-gate
cd approval-gate && npm test
```

Use `/approvals` to list the current directory's approvals and `/approvals clear` to remove them.

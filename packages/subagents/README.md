# Subagents

Adds a `subagent` tool that runs named agents in isolated Pi processes.

## Install

Install both packages from the repository root:

```sh
pi install ./packages/approval-gate
pi install ./packages/subagents
```

Every child process disables extension discovery and explicitly loads
`packages/approval-gate/extensions/approval-gate.ts`. Bash commands that are statically allowed or already
approved for the working directory can run. Other commands are blocked because child processes have no
interactive UI. Approve a command from the parent Pi session with “Always allow for this working directory”
before delegating work that needs it.

## Usage

List the effective agents:

```text
/agents
```

Then ask Pi to delegate a self-contained task:

```text
Use the scout agent to find the authentication flow.
```

One tool call runs one agent. Pi can issue multiple `subagent` calls in the same turn for parallel work.


## Agent definitions

Definitions are Markdown files with YAML frontmatter:

```md
---
name: my-agent
display_name: My Agent
description: What the agent does
tools: read, grep, find, ls
model: provider/model
thinking: medium
---

System prompt for the agent.
```

`display_name` is used for the tool-call title. If omitted, it falls back to the definition filename without
the `.md` extension. `name` remains the identifier passed to the `subagent` tool.

Agents are loaded in this order:

1. Bundled definitions in `packages/subagents/agents`
2. User definitions in `~/.pi/agent/agents`
3. Definitions in the nearest `.pi/agents` directory

Later definitions override earlier ones with the same name. Project definitions are repository-controlled, so
only use them in projects you trust.

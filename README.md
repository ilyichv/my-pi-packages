# Pi Packages

A monorepo for my [Pi coding agent](https://github.com/earendil-works/pi) packages.

## Packages

| Package | Description |
| --- | --- |
| [Approval Gate](./packages/approval-gate) | Adds command approvals, allowlists, and quarantine rules. |
| [Subagents](./packages/subagents) | Runs named coding agents in isolated Pi processes. |

## Install

Install a package from the repository root:

```sh
pi install ./packages/approval-gate
```

See each package's README for configuration and usage.

## Development

This is an npm workspaces monorepo. Install once from the repository root:

```sh
npm install
```

Then run the shared tooling across every package:

```sh
npm test        # vitest
npm run lint    # biome
npm run typecheck
```

Scope a run to one package with `npm test -w @ilyichv/pi-approval-gate`.

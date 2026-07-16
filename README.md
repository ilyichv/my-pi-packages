# Pi Packages

A monorepo for my [Pi coding agent](https://github.com/earendil-works/pi) packages.

## Packages

| Package | Description |
| --- | --- |
| [Approval Gate](./packages/approval-gate) | Adds command approvals, allowlists, and quarantine rules. |

## Install

Install a package from the repository root:

```sh
pi install ./packages/approval-gate
```

See each package's README for configuration and usage.

## Development

```sh
npm test --prefix packages/approval-gate
```

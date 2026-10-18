---
title: Monorepo Support
description: Managing multi-package projects with workspace-level configuration
---

## Monorepo Support

nax supports monorepos with workspace-level and per-package configuration.

### Setup

```bash
# Initialize nax at the repo root
nax init

# Scaffold per-package context for a specific package
nax init --package packages/api
nax init --package packages/web
```

### Per-Package Config

Each package's config and context are stored centrally under the root `.nax/mono/` directory:

```
repo-root/
├── .nax/
│   ├── config.json                    # root config
│   └── mono/
│       ├── packages/
│       │   └── api/
│       │       ├── config.json        # overrides for packages/api
│       │       └── context.md        # agent context for packages/api
│       └── apps/
│           └── api/
│               ├── config.json        # overrides for apps/api
│               └── context.md        # agent context for apps/api
```

**Overridable fields per package:** `agent`, `models`, `routing`, `execution`, `review`, `acceptance`, `quality`, `context`, `project` (merged by `mergePackageConfig` in `src/config/merge.ts`). Root-only sections such as `autoMode`, `generate`, `tdd`, `decompose`, `plan`, `constitution`, `interaction`, `auth`, `advisor` and `workflow` are never overridden per-package.

**Root-scoped keys (ADR-031):** `execution.bashApproval`, `execution.approvalTimeout`, `execution.sandbox`, `execution.commandSafety` and `execution.mode` are pinned to the root config. A package config (or package profile) that sets one is warned about and ignored. `execution.permissions` and `execution.permissionProfile` stay per-package — a package's `permissions` map replaces the root's (per-stage `bashApproval` included).

A package config may also set `"profile"` (a name or list) to overlay per-package profiles on top of the merged config.

```json
// .nax/mono/packages/api/config.json
{
  "quality": {
    "commands": {
      "test": "turbo test --filter=@myapp/api",
      "lint": "turbo lint --filter=@myapp/api"
    }
  }
}
```

### Repo Gates: the Root Wins per Gate

A package's `quality.commands` set the commands its **stories** run. The **repo gates** (the
workflow's repo and final gates, the finish phase's gates, and `nax gates run`) run the root
`quality.commands`, resolved per gate key (`build`, `typecheck`, `lint`, `test`, `e2e`):

- A key the root configures runs once, from the repo root. A package overlay's command for that
  key is not run as a repo gate.
- A key the root leaves unconfigured (unset, or blank) falls back to each touched package's
  overlay, run from that package as `<gate>@<package>`. A repo whose gates live only in package
  overlays is still checked. `nax gates run` resolves the root only.

So write each root command to cover the whole workspace (`bun run --filter '*' test`,
`turbo run test`). A package check the root command skips (for example a firmware suite the
root `test` filters out) is no longer a repo gate once the root configures that key: add it to
the root command.

### Per-Package Stories

In your `prd.json`, set `workdir` on each story to point to the package:

```json
{
  "userStories": [
    {
      "id": "US-001",
      "title": "Add auth endpoint",
      "workdir": "packages/api",
      "status": "pending"
    }
  ]
}
```

nax will run the agent inside that package's directory and apply its config overrides automatically.

### Workspace Detection

When `nax plan` generates stories for a monorepo, it auto-discovers packages (`discoverWorkspacePackages` in `src/context/generator/index.ts`):
- Existing `.nax/mono/*/context.md` files — if any exist, these win and the manifests below are not read
- Otherwise the union of: `turbo.json` → `packages` field, `package.json` → `workspaces`, and `pnpm-workspace.yaml` → `packages`

### Generate Agent Files for All Packages

```bash
nax generate --all-packages
# or a single package
nax generate --package packages/api
```

`--all-packages` generates a `CLAUDE.md` (or the agent files listed in `generate.agents`) in every package that has a `.nax/mono/<package>/context.md` — scaffold one with `nax init --package` first.

---

[Back to README](../../README.md)

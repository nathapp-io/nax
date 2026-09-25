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

**Overridable fields per package:** `agent`, `models`, `routing`, `execution`, `review`, `acceptance`, `quality`, `context`, `project` (merged by `mergePackageConfig` in `src/config/merge.ts`). Root-only sections such as `autoMode`, `generate`, `tdd`, `plan`, `constitution`, and `interaction` are never overridden per-package.

**Root-scoped command-safety keys (ADR-031):** `execution.bashApproval`, `execution.approvalTimeout`, `execution.sandbox`, and `execution.commandSafety` are pinned to the root config. A package config (or package profile) that sets one is warned about and ignored. `execution.permissions` and `execution.permissionProfile` stay per-package — a package's `permissions` map replaces the root's.

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

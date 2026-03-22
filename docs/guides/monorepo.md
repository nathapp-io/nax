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

**Overridable fields per package:** `execution`, `review`, `acceptance`, `quality`, `context`

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

When `nax plan` generates stories for a monorepo, it auto-discovers packages from:
- `turbo.json` → `packages` field
- `package.json` → `workspaces`
- `pnpm-workspace.yaml` → `packages`
- Existing `.nax/mono/*/context.md` files

### Generate Agent Files for All Packages

```bash
nax generate --all-packages
```

Generates a `CLAUDE.md` (or agent-specific file) in each discovered package directory, using the package's own `.nax/mono/<package>/context.md` if present.

---

[Back to README](../../README.md)

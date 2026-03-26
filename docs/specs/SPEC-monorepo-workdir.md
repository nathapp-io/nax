# SPEC: Monorepo Workdir Support (v0.47.0)

**Status:** Implemented (v0.54.0)
**Created:** 2026-03-17
**Author:** Nax Dev (with William)

---

## Problem

nax assumes a single-package repo: one `nax/context.md` at the root, one `CLAUDE.md` output, and all stories share the same working directory. In a monorepo with multiple packages (e.g., `packages/api`, `packages/web`, `packages/sdk`), each package has different tech stacks, test commands, and conventions.

## Prior Art

MONO-001 (shipped `fea2573`) added monorepo *detection* (turborepo/nx/pnpm/bun workspaces) and init scaffolding. This spec adds monorepo *execution* — per-story workdir, per-package context, and per-package test commands.

---

## Phase 1 — Per-Story Workdir + Package Context

**Goal:** Stories can target different packages. Each package gets its own context.md and CLAUDE.md.

### MW-001: `UserStory.workdir` Field + Schema Validation (Simple)

Add optional `workdir` field to `UserStory` in `src/prd/types.ts`:

```typescript
export interface UserStory {
  // ... existing fields ...

  /**
   * Working directory for this story, relative to repo root.
   * Overrides the global workdir for pipeline execution.
   * @example "packages/api"
   */
  workdir?: string;
}
```

Schema validation in `src/prd/schema.ts`:
- Must be a string if present
- Must be relative (no leading `/`)
- Must not contain `..` (no directory traversal)
- Runtime check: directory must exist at runner start

### MW-002: Execution Stage — Workdir Override (Simple)

When `story.workdir` is set:
1. Resolve absolute path: `join(repoRoot, story.workdir)`
2. Pass as `cwd` to agent adapter (`run()`, `complete()`)
3. Both CLI adapter (`Bun.spawn`) and ACP adapter use the resolved path

**Changes:**
- `src/pipeline/stages/execution.ts` — resolve `story.workdir` into cwd
- `src/agents/adapters/claude.ts` — accept cwd override in `AgentRunOptions`
- `src/agents/acp/adapter.ts` — accept cwd override

### MW-003: Context Stage — Package-Level `context.md` Resolution (Medium)

When `story.workdir` is set, load package-level context in addition to root:

```
Effective context = root nax/context.md + <workdir>/nax/context.md
```

**Resolution:**
1. Always load `<repo-root>/nax/context.md` (shared conventions)
2. If `story.workdir` is set and `<repo-root>/<story.workdir>/nax/context.md` exists, load and append
3. Separator: `---` between root and package sections

**Changes:**
- `src/execution/helpers.ts` (`buildStoryContextFull`) — accept optional `workdir`, load package context.md
- `src/pipeline/stages/context.ts` — pass `story.workdir` to context builder

### MW-004: `nax generate --package` (Medium)

Extend `nax generate` to support per-package output:

```bash
# Root (unchanged)
nax generate

# Per-package — reads <pkg>/nax/context.md, writes <pkg>/CLAUDE.md
nax generate --package packages/api

# All packages — auto-discover */nax/context.md and */*/nax/context.md
nax generate --all-packages
```

**Key design:** per-package `CLAUDE.md` contains **only** package-specific content. Claude Code's native hierarchy merges root `CLAUDE.md` + subdirectory `CLAUDE.md` at runtime — no duplication needed.

**Changes:**
- `src/cli/generate.ts` — `--package` and `--all-packages` flags
- `src/context/generator.ts` — `generateForPackage()` function
- Package discovery: glob `*/nax/context.md` and `*/*/nax/context.md` (max 2 levels)

### MW-005: `nax init --package` Scaffold (Simple)

Scaffold per-package context:

```bash
nax init --package packages/api
```

Creates `packages/api/nax/context.md` with a minimal template:

```markdown
# packages/api — Context

<!-- Package-specific conventions. Root context.md provides shared rules. -->

## Tech Stack
...

## Commands
| Command | Purpose |
|:--------|:--------|
| `bun test` | Unit tests |
```

**Changes:**
- `src/cli/init.ts` — `--package` flag
- `src/cli/init-context.ts` — package-aware template generation

### MW-006: Verify Stage — Workdir-Scoped Test Execution (Medium)

Test runner must `cd` into `story.workdir` for test execution:

```
# Without workdir: runs from repo root
bun test

# With workdir "packages/api": runs from packages/api/
cd packages/api && bun test
```

**Smart Runner — File Path Scoping Fix:**

`getChangedSourceFiles()` currently filters git diff output by `f.startsWith("src/")`. In a monorepo, git always returns paths relative to the **git root** (e.g., `packages/api/src/foo.ts`), not the package workdir — so the `src/` filter misses all package changes and silently falls back to full suite.

Fix: when `story.workdir` is set, scope the filter to the package:

```typescript
// Single-package (current)
lines.filter((f) => f.startsWith("src/") && f.endsWith(".ts"))

// Monorepo (when story.workdir = "packages/api")
lines.filter((f) => f.startsWith(`${story.workdir}/src/`) && f.endsWith(".ts"))
```

`mapSourceToTests()` and `importGrepFallback()` are **not affected** — they operate on the filesystem using the resolved absolute `workdir`, so they already work correctly once `workdir` is passed.

**Changes:**
- `src/verification/smart-runner.ts` — `getChangedSourceFiles()` accepts optional `packagePrefix` (or derive from workdir) to scope the `startsWith` filter
- `src/verification/` — pass resolved workdir as cwd to test spawner
- `src/pipeline/stages/verify.ts` — resolve workdir before invoking test runner; pass `story.workdir` to smart runner

### MW-007: `nax plan` / `nax analyze` — Monorepo Awareness (Medium)

Teach the LLM planner to emit `workdir` per story when the repo is a monorepo:

- Detect monorepo (existing MONO-001 detection: turborepo/nx/pnpm/bun workspaces)
- Add monorepo hint to plan prompt: "This is a monorepo. Set `workdir` per story."
- Include package list in plan context (auto-discovered from workspace config)

**Changes:**
- `src/cli/plan.ts` / `src/commands/plan.ts` — inject monorepo package list
- Plan prompt template — add `workdir` instruction

---

## Phase 2 — Per-Package Config + Test Commands

**Goal:** Each package can override nax config (especially test commands) without duplicating the entire config.

### MW-008: Per-Package Config Overrides (Medium)

Allow `<package>/nax/config.json` to override specific config fields:

```
mono-repo/
  nax/config.json                  ← root config (full)
  packages/
    api/
      nax/config.json              ← package override (partial)
```

**Merge strategy:** deep merge, package overrides root. Only `quality.commands` and `execution` sections are mergeable (not routing, not plugins).

**Config resolution for story with `workdir: "packages/api"`:**
1. Load root `nax/config.json`
2. If `packages/api/nax/config.json` exists, deep-merge over root
3. Result is the effective config for that story's pipeline

**Example — package `nax/config.json`:**
```json
{
  "quality": {
    "commands": {
      "test": "npm test",
      "testScoped": "npm test -- {{files}}",
      "typecheck": "npx tsc --noEmit"
    }
  }
}
```

**Fallback chain for test command:**
1. `<package>/nax/config.json` → `quality.commands.test` (if exists)
2. Root `nax/config.json` → `quality.commands.testScoped` (if exists, for scoped runs)
3. Root `nax/config.json` → `quality.commands.test` (global fallback)

**Changes:**
- `src/config/loader.ts` — accept optional `packageDir`, merge with root config
- `src/pipeline/pipeline.ts` — resolve per-story config before pipeline stages
- New: `src/config/merge.ts` — deep-merge utility with allowed-section whitelist

### MW-009: Verify Stage — Per-Package Test Command (Simple)

Wire the per-package config into the verify stage:

- Use the story's resolved config (from MW-008) for `quality.commands.test`
- No story-level test command field needed — config handles it

**Why not story-level test command?**
- Duplicates config into PRD data (wrong layer)
- Config is the right place for environment/tooling concerns
- Per-package config already gives per-story test commands (through `workdir` → config resolution)

### MW-010: Review Stage — Package-Scoped File Checks (Simple)

When `story.workdir` is set, scope review file-path checks to the package directory instead of repo root. Prevents false positives from files in other packages.

---

## File Layout (Final State)

```
mono-repo/
  nax/
    context.md              ← shared monorepo conventions
    config.json             ← root config (routing, plugins, global quality)
  CLAUDE.md                 ← generated from root context only
  packages/
    api/
      nax/
        context.md          ← api: Express, Postgres, Jest
        config.json         ← api: quality.commands overrides
      CLAUDE.md             ← generated from api context only
    web/
      nax/
        context.md          ← web: React, Vite, Vitest
        config.json         ← web: quality.commands overrides
      CLAUDE.md             ← generated from web context only
```

## PRD Example

```json
{
  "project": "my-monorepo",
  "feature": "user-auth",
  "branchName": "feat/user-auth",
  "userStories": [
    {
      "id": "AUTH-001",
      "workdir": "packages/api",
      "title": "Add /auth/login endpoint",
      "description": "REST endpoint with JWT",
      "acceptanceCriteria": ["POST /auth/login returns JWT"],
      "complexity": "medium"
    },
    {
      "id": "AUTH-002",
      "workdir": "packages/web",
      "title": "Add login page",
      "description": "React login form",
      "acceptanceCriteria": ["Login form renders"],
      "complexity": "medium",
      "dependencies": ["AUTH-001"]
    },
    {
      "id": "AUTH-003",
      "title": "Shared JWT validator",
      "description": "No workdir = repo root",
      "acceptanceCriteria": ["validateToken() exported"],
      "complexity": "simple"
    }
  ]
}
```

---

## Non-Goals

- **No per-package plugins** — plugins stay at root level
- **No per-package routing config** — routing is global (complexity classification doesn't vary by package)
- **No story-level test command** — per-package config covers this (config is the right layer)
- **No cross-repo support** — all packages must be in the same git repo
- **No automatic workdir inference** — explicit `workdir` in PRD is clearer than heuristics

## Migration

- **Zero breaking changes** — `workdir` is optional, defaults to repo root
- Existing single-package repos work exactly as before
- Existing monorepo users (MONO-001) get enhanced support without config changes

## Prerequisites

- **BUG-074** (v0.46.1) — `working-tree-clean` precheck allowlist for nax runtime files. Not a monorepo concern — must ship before v0.47.0.

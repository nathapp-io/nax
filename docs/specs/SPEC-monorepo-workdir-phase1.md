# SPEC: Monorepo Workdir Support — Phase 1 (v0.47.0)

**Status:** Ready for Implementation
**Created:** 2026-03-17
**Parent:** `docs/specs/SPEC-monorepo-workdir.md`
---

## Goal

Stories can target different packages in a monorepo. Each package gets its own context.md and scoped test execution.

---

## MW-001: `UserStory.workdir` Field + Schema Validation

**File:** `src/prd/types.ts`

Add optional `workdir` field to `UserStory`:

```typescript
export interface UserStory {
  // ... existing fields ...
  workdir?: string;  // relative to repo root, e.g., "packages/api"
}
```

**Schema validation** (`src/prd/schema.ts`):
- Must be string if present
- Must be relative (no leading `/`)
- Must not contain `..` (no directory traversal)
- Runtime check: directory must exist at runner start

---

## MW-002: Execution Stage — Workdir Override

**Files:** `src/pipeline/stages/execution.ts`, `src/agents/adapters/claude.ts`, `src/agents/acp/adapter.ts`

When `story.workdir` is set:
1. Resolve absolute path: `join(repoRoot, story.workdir)`
2. Pass as `cwd` to agent adapter's `run()` / `complete()` methods

**CLI adapter:** pass `cwd` to `Bun.spawn` options  
**ACP adapter:** pass `cwd` to the adapter's run options

---

## MW-003: Context Stage — Package-Level Context Resolution

**File:** `src/execution/helpers.ts` (`buildStoryContextFull`)

Effective context = root `nax/context.md` + `<workdir>/nax/context.md`

**Resolution order:**
1. Always load `<repo-root>/nax/context.md` (shared conventions)
2. If `story.workdir` set AND `<repo-root>/<story.workdir>/nax/context.md` exists → load and append
3. Separator: `---` between sections

---

## MW-004: `nax generate --package`

**File:** `src/cli/generate.ts`

```bash
# Per-package
nax generate --package packages/api

# All packages (auto-discover)
nax generate --all-packages
```

- Glob discovery: `*/nax/context.md` and `*/*/nax/context.md` (max 2 levels)
- Output: `<pkg>/CLAUDE.md` with only package-specific content
- Claude Code merges root + subdirectory CLAUDE.md at runtime

---

## MW-005: `nax init --package`

**File:** `src/cli/init.ts`

```bash
nax init --package packages/api
```

Creates `packages/api/nax/context.md` with minimal template.

---

## MW-006: Verify Stage — Workdir-Scoped Test Execution

**File:** `src/verification/smart-runner.ts`

**Problem:** `getChangedSourceFiles()` filters by `f.startsWith("src/")`. In monorepo, git returns paths like `packages/api/src/foo.ts` → filter misses them.

**Fix:** When `story.workdir` is set, scope the filter:

```typescript
// Single-package (current)
lines.filter((f) => f.startsWith("src/") && f.endsWith(".ts"))

// Monorepo (new)
lines.filter((f) => f.startsWith(`${story.workdir}/src/`) && f.endsWith(".ts"))
```

Also: pass resolved `workdir` as `cwd` to test spawner in verify stage.

---

## MW-007: `nax plan` — Monorepo Awareness

**File:** `src/cli/plan.ts` / `src/commands/plan.ts`

- Detect monorepo (existing MONO-001 detection)
- Add monorepo hint to plan prompt: "This is a monorepo. Set `workdir` per story."
- Include discovered package list in plan context

---

## Deliverables

- [ ] MW-001: UserStory.workdir + schema
- [ ] MW-002: Execution cwd override
- [ ] MW-003: Package context loading
- [ ] MW-004: nax generate --package
- [ ] MW-005: nax init --package
- [ ] MW-006: Smart runner workdir scoping
- [ ] MW-007: plan monorepo awareness
- [ ] Full test suite pass

## Non-Goals (Phase 1)

- Per-package config.json overrides (Phase 2)
- Per-package test command in PRD (Phase 2)
- Automatic workdir inference

---

## Prerequisites

- BUG-074 (working-tree-clean allowlist) — already in v0.46.1

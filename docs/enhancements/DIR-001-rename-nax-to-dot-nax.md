# DIR-001: Rename `nax/` to `.nax/` — Hidden Config Directory

**Status:** Draft  
**Component:** All — `src/config/paths.ts` (SSOT), `src/commands/`, `src/cli/`, `src/config/loader.ts`, `src/context/`, tests  
**Priority:** High (pre-v1.0 / pre-GitHub-public)

---

## Problem

The project-level config directory `nax/` sits visibly in the repo root alongside source code. Convention for tool config directories is to use a hidden dot-prefix (`.git/`, `.vscode/`, `.claude/`, `.husky/`). Additionally, monorepo projects currently require a `nax/` directory inside each package for per-package config, which pollutes package directories.

## Goals

1. Rename project-level `nax/` → `.nax/`
2. Consolidate package-level configs under `.nax/packages/<workdir>/`
3. No backward compatibility (only internal users currently)

---

## Current Structure

### Single repo
```
project-root/
  nax/
    config.json
    context.md
    constitution.md
    templates/
    features/<feature>/
      prd.json
      acceptance.test.ts
      acceptance-meta.json
      runs/
      status.json
    metrics.json
```

### Monorepo
```
project-root/
  nax/
    config.json
    features/<feature>/
      prd.json
  apps/api/
    nax/
      config.json          # package-level config
      context.md
  packages/shared/
    nax/
      config.json          # package-level config
```

## Proposed Structure

### Single repo
```
project-root/
  .nax/
    config.json
    context.md
    constitution.md
    templates/
    features/<feature>/
      prd.json
      acceptance.test.ts
      acceptance-meta.json
      runs/
      status.json
    metrics.json
```

### Monorepo
```
project-root/
  .nax/
    config.json                              # root config
    context.md                               # root context
    packages/
      apps/api/config.json                   # package override
      apps/api/context.md                    # package context
      packages/shared/config.json            # package override
    features/<feature>/
      prd.json                               # stories have workdir: "apps/api"
      acceptance.test.ts
      runs/
```

**Key change for monorepo:** No more `<package>/nax/` directories. Everything lives under `.nax/` at project root. Package configs are at `.nax/packages/<workdir>/config.json`.

---

## Design Decisions

### D1: Single source of truth — `src/config/paths.ts`

```typescript
// Before
export function projectConfigDir(projectRoot: string): string {
  return join(resolve(projectRoot), "nax");
}

// After
export const PROJECT_NAX_DIR = ".nax";

export function projectConfigDir(projectRoot: string): string {
  return join(resolve(projectRoot), PROJECT_NAX_DIR);
}
```

All code uses `projectConfigDir()` or `PROJECT_NAX_DIR` — no hardcoded `"nax"` strings.

### D2: Package config resolution

```typescript
// Before: <root>/<workdir>/nax/config.json
const packageConfigPath = join(repoRoot, packageDir, "nax", "config.json");

// After: <root>/.nax/packages/<workdir>/config.json
const packageConfigPath = join(repoRoot, PROJECT_NAX_DIR, "packages", packageDir, "config.json");
```

### D3: Package context resolution

```typescript
// Before: <root>/<workdir>/nax/context.md
// After:  <root>/.nax/packages/<workdir>/context.md
```

`context/generator.ts` package discovery changes from scanning `*/nax/context.md` to scanning `.nax/packages/*/context.md`.

### D4: `nax init` for monorepo packages

```bash
nax init                        # creates .nax/config.json
nax init --package apps/api     # creates .nax/packages/apps/api/config.json
```

No auto-detection of monorepo packages. User specifies `--package` explicitly.

### D5: Workdir detection — walk-up search

`commands/common.ts` currently walks up directories looking for `nax/` with `config.json`. Same behavior, just looks for `.nax/` instead:

```typescript
// Before
const naxDir = join(current, "nax");
if (existsSync(join(naxDir, "config.json"))) { ... }

// After
const naxDir = join(current, PROJECT_NAX_DIR);
if (existsSync(join(naxDir, "config.json"))) { ... }
```

nax never needs to enumerate packages. It resolves package config only when a story has `workdir` set — then looks for `.nax/packages/<workdir>/config.json`.

### D6: Global config unchanged

`~/.nax/` (global config dir) already uses dot-prefix. No change needed.

### D7: `.gitignore` patterns

```gitignore
# Before
nax/**/runs/
nax/metrics.json
nax/features/*/status.json
nax/features/*/plan/
nax/features/*/acp-sessions.json
nax/features/*/interactions/
nax/features/*/progress.txt
nax/features/*/acceptance-refined.json

# After
.nax/**/runs/
.nax/metrics.json
.nax/features/*/status.json
.nax/features/*/plan/
.nax/features/*/acp-sessions.json
.nax/features/*/interactions/
.nax/features/*/progress.txt
.nax/features/*/acceptance-refined.json
```

---

## Implementation Plan

### Phase 1: Core rename (mechanical, all-at-once)

1. **`src/config/paths.ts`** — add `PROJECT_NAX_DIR = ".nax"`, update `projectConfigDir()`
2. **`src/config/loader.ts`** — update package config path to `.nax/packages/<workdir>/config.json`
3. **`src/commands/common.ts`** — import and use `PROJECT_NAX_DIR` for walk-up search
4. **`src/commands/logs.ts`**, **`src/commands/precheck.ts`** — use `projectConfigDir()`
5. **`src/cli/init.ts`** — update dir creation, gitignore patterns, console output
6. **`src/cli/init-detect.ts`** — update detection path
7. **`src/cli/init-context.ts`** — update context path (root + package)
8. **`src/cli/plan.ts`** — update naxDir construction
9. **`src/cli/diagnose.ts`** — update status/feature path
10. **`src/cli/interact.ts`** — update features dir
11. **`src/cli/prompts-init.ts`** — update templates dir + user-facing messages
12. **`src/cli/plugins.ts`** — update user-facing message
13. **`src/cli/constitution.ts`** — update default path
14. **`src/cli/generate.ts`** — update context.md default path
15. **`src/context/generator.ts`** — update package context discovery pattern
16. **`src/metrics/tracker.ts`** — update metrics.json path
17. **`src/pipeline/subscribers/registry.ts`** — update status/events paths
18. **`src/pipeline/stages/queue-check.ts`** — update fallback prd path
19. **`src/pipeline/stages/completion.ts`** — update fallback prd path
20. **`src/precheck/checks-warnings.ts`** — update gitignore patterns
21. **`src/execution/lifecycle/acceptance-loop.ts`** — update config path
22. **`src/execution/iteration-runner.ts`** — update config path

### Phase 2: Tests

Update ~83 test references from `"nax/"` to `".nax/"`.

### Phase 3: Documentation

Update docs, README, specs with new paths.

---

## Files Changed (estimated)

| Category | Files | Refs |
|:---------|:------|:-----|
| SSOT (`paths.ts`) | 1 | 1 constant |
| Source (`src/`) | ~22 | ~27 string literals + comments |
| Tests (`test/`) | ~30 | ~83 refs |
| Docs | ~10 | Many |
| **Total** | ~63 | ~120+ |

---

## Acceptance Criteria

- [ ] **AC-1:** `nax init` creates `.nax/config.json` (not `nax/config.json`)
- [ ] **AC-2:** `nax init --package apps/api` creates `.nax/packages/apps/api/config.json`
- [ ] **AC-3:** `nax run` discovers `.nax/` via walk-up search
- [ ] **AC-4:** Story with `workdir: "apps/api"` resolves config from `.nax/packages/apps/api/config.json`
- [ ] **AC-5:** Package context at `.nax/packages/<workdir>/context.md` is discovered
- [ ] **AC-6:** `.gitignore` patterns use `.nax/` prefix
- [ ] **AC-7:** `PROJECT_NAX_DIR` constant is the single source of truth
- [ ] **AC-8:** Global config `~/.nax/` unchanged
- [ ] **AC-9:** All existing tests pass (no regressions)
- [ ] **AC-10:** No hardcoded `"nax"` strings remain in `src/` (except package name references like `@nathapp/nax`)

---

## Risk

- **Low risk:** Mechanical find/replace with one SSOT constant
- **No backward compat needed:** Only internal users (William + nax-dev)
- **Good candidate for Claude Code on Mac01:** Repetitive across many files, clear pattern

---

*Created 2026-03-21.*

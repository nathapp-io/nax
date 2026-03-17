# SPEC: Monorepo Workdir Support — Phase 2 (v0.47.0)

**Status:** Ready for Implementation
**Created:** 2026-03-17
**Parent:** `docs/specs/SPEC-monorepo-workdir.md`
**Depends on:** Phase 1 (merged to master)

---

## Goal

Each package in a monorepo can override nax config (test commands, typecheck, lint) without duplicating the root config. Per-story test commands resolve automatically via `workdir` → package config.

---

## MW-008: Per-Package Config Overrides

**New file:** `src/config/merge.ts`  
**Modified:** `src/config/loader.ts`

### File Layout

```
mono-repo/
  nax/config.json                  ← root config (full)
  packages/
    api/
      nax/config.json              ← package override (partial)
    web/
      nax/config.json              ← package override (partial)
```

### Package Config Format

Package `nax/config.json` is **partial** — only overrideable sections:

```json
{
  "quality": {
    "commands": {
      "test": "npm test",
      "testScoped": "npm test -- {{files}}",
      "typecheck": "npx tsc --noEmit",
      "lint": "npx eslint src/"
    }
  }
}
```

**Only `quality.commands` is mergeable** — routing, plugins, execution, and agents stay root-only.

### Merge Strategy

Deep merge: package overrides root for allowed keys only.

```typescript
// src/config/merge.ts
export function mergePackageConfig(root: NaxConfig, packageOverride: Partial<NaxConfig>): NaxConfig
```

### Config Resolution

New function in `src/config/loader.ts`:

```typescript
export async function loadConfigForWorkdir(
  rootConfigPath: string,
  packageDir?: string   // e.g. "packages/api" (relative to repo root)
): Promise<NaxConfig>
```

Resolution order:
1. Load root `nax/config.json` (existing `loadConfig()`)
2. If `packageDir` set, check `<repoRoot>/<packageDir>/nax/config.json`
3. If package config exists → deep merge `quality.commands` over root
4. Return merged config

---

## MW-009: Verify Stage — Per-Package Test Command

**Modified:** `src/pipeline/stages/verify.ts`

When `story.workdir` is set:
1. Call `loadConfigForWorkdir(rootConfigPath, story.workdir)` to get the effective config
2. Use merged config's `quality.commands.test` and `quality.commands.testScoped` for this story
3. Pass `story.workdir` as cwd to the test runner (already done in Phase 1 MW-006)

**Test command fallback chain (per story):**
1. `<package>/nax/config.json` → `quality.commands.test` (if package config exists)
2. Root `nax/config.json` → `quality.commands.testScoped` (scoped run)
3. Root `nax/config.json` → `quality.commands.test` (global fallback)

---

## MW-010: Review Stage — Package-Scoped File Checks

**Modified:** `src/pipeline/stages/review.ts` (or equivalent)

When `story.workdir` is set, scope file-path checks to the package directory:
- Changed-file review only considers files under `<story.workdir>/`
- Prevents false positives from other packages' files appearing in diff

---

## Deliverables

- [ ] MW-008: `src/config/merge.ts` — deep merge utility
- [ ] MW-008: `loadConfigForWorkdir()` in `src/config/loader.ts`
- [ ] MW-009: Verify stage resolves per-story config
- [ ] MW-010: Review stage scopes file checks to package
- [ ] Unit tests for merge utility
- [ ] Unit tests for `loadConfigForWorkdir()`
- [ ] Integration test: story with workdir uses package test command
- [ ] Full test suite pass

## Non-Goals (Phase 2)

- No per-package plugins
- No per-package routing/agent config
- No story-level test command field
- No cross-repo support

---

## Example

Given:
```
root nax/config.json:     quality.commands.test = "bun test"
packages/api/nax/config.json: quality.commands.test = "bun run test:unit"
```

Story `AUTH-001` with `workdir: "packages/api"` → uses `bun run test:unit`  
Story `AUTH-003` with no workdir → uses `bun test` (root fallback)

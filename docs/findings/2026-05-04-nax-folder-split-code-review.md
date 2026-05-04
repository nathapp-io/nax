# Code Review: `feat/nax-folder-split` against `main`

**Date:** 2026-05-04
**Branch:** `feat/nax-folder-split`
**PR:** #903
**Spec:** `docs/specs/2026-05-04-nax-folder-split-design.md`
**Files changed:** 44 (1,258 insertions, 77 deletions)
**Test baseline:** 1,237 tests pass, 0 fail

**Status:** All findings open — these are work items for follow-up PRs.

---

## Summary

The branch delivers a solid foundation: new path helpers (`src/runtime/paths.ts`), config schema fields, a `migrateCommand` with dry-run and EXDEV handling, path-traversal protection on `--reclaim`/`--merge`, first-run identity claiming, and `runtime.outputDir` threading through the pipeline. Tests for the new modules are comprehensive.

Four high-severity gaps remain between the implementation and the spec: the new CLI surface is not wired into the executable, `initProject` validates the name but never persists it, identity collision does not block runs, and the run artifact writer still targets `workdir/.nax/` while the readers were moved to `outputDir`. One medium gap: `migrateCommand` ignores the `outputDir` config field.

---

## Findings

### High-1: Executable CLI is not wired to the new init/migrate surface

The implementation adds `InitOptions.name`, `InitOptions.force`, and `migrateCommand` in `src/cli/init.ts` and `src/commands/migrate.ts`, but `bin/nax.ts` does not call any of them.

- `bin/nax.ts:136–140`: the `init` command only accepts `--dir`, `--force`, and `--package`; `--name` is not registered with commander.
- `bin/nax.ts:153`: the only import from `src/cli/` is `initPackage` from `init-context` — `initProject` is never imported.
- `bin/nax.ts:1362`: the `migrate` sub-command under `rules` calls `rulesMigrateCommand` (legacy CLAUDE.md migration), not the new `migrateCommand` from `src/commands/migrate.ts`. There is no top-level `nax migrate` command.

Impact:
- `nax init --name <name>` is rejected by commander at runtime.
- `nax migrate`, `nax migrate --dry-run`, `--reclaim`, and `--merge` are unreachable from the shell.
- The name validation and collision-check logic in `src/cli/init.ts` is bypassed by normal users.

---

### High-2: `initProject()` validates the name but never writes it to config

`initProject()` at `src/cli/init.ts:257` validates `options.name` and checks for collisions, but then calls `buildInitConfig(stack)` from `src/cli/init-detect.ts` and writes its output unchanged (`src/cli/init.ts:315`, `src/cli/init.ts:326`). `buildInitConfig` returns `{ version: 1, ... }` with quality/acceptance fields; it has no `name` field.

Result: a user who provides `--name my-project` sees the validation pass and the collision check run, but the written `config.json` contains no `"name"` key. On first run the runtime falls back to `basename(workdir)`, so the collision check was performed against a key that is never actually used for output paths or identity.

---

### High-3: First-run identity collision does not block the run

The spec requires `claimProjectIdentity` to detect when a name is already claimed by a different workdir/remote and surface an actionable error. The current implementation at `src/runtime/paths.ts:82–88` silently returns when `existing.workdir !== workdir`:

```typescript
if (existing) {
  if (existing.workdir === workdir) {
    await writeProjectIdentity(projectKey, { ...existing, lastSeen: now });
  }
  // Different workdir — do not overwrite (collision detection is nax init's job)
  return;
}
```

`run-setup.ts:256` calls `claimProjectIdentity` with `.catch(warn)`, so even a thrown error would be swallowed. The run proceeds into the collision scenario the design is meant to prevent: two projects sharing the same `~/.nax/<projectKey>` output directory.

The spec's "same remote URL → worktree allowance" behaviour is also not implemented; the function only updates `lastSeen` on exact `workdir` matches.

---

### High-4: Run artifact writer still targets `workdir/.nax/`; readers moved to `outputDir`

`bin/nax.ts` writes all run output into the old project tree:

- `bin/nax.ts:468–469`: `runsDir = join(featureDir, "runs")` where `featureDir = join(naxDir, "features", options.feature)` and `naxDir = findProjectDir(workdir)` — this resolves to `workdir/.nax/features/<feature>/runs/`.
- `bin/nax.ts:532`: `statusFilePath = join(workdir, ".nax", "status.json")`.

The readers were moved to look under `runtime.outputDir` → `~/.nax/<projectKey>/`:

- `src/cli/runs.ts:80,143`: reads `join(outputDir, "features", feature, "runs")`.
- `src/cli/status-features.ts:81`: reads `join(outputDir, "status.json")`.
- `src/cli/diagnose.ts:159,170`: looks for features and `prd.json` under `outputDir`.

Impact: after a normal `nax run`, `nax runs list`, `nax status`, and `nax diagnose` all report "no runs" / "feature not found" because the output lives in `workdir/.nax/` but the readers look in `~/.nax/<projectKey>/`. This is the primary user-facing regression introduced by the partial migration.

---

### Medium-1: `migrateCommand` ignores `outputDir`; skips conflicts without aborting

`migrateCommand` reads `config.json` but only extracts `{ name?: string }` (`src/commands/migrate.ts:219`), then always computes `destBase = join(homedir(), ".nax", projectKey)` (`src/commands/migrate.ts:230`). The `outputDir` field in config is never read, so a project with a custom output path migrates to the wrong location.

On conflict (`existsSync(dest)` is true), the command logs a warning and continues (`src/commands/migrate.ts:254–256`), leaving the project in a partially migrated state while reporting success. The spec says migration should abort on conflicts.

The first-run auto-migration swallows any error with a `warn + continue` at `src/execution/lifecycle/run-setup.ts:231–239`, so a failed migration silently leaves a mixed old/new layout.

---

## Verification

- `bun run typecheck` — passed
- `bun run lint` — passed
- `bun run test` — 1,237 tests pass, 0 fail
- Spot-checked: `timeout 30 bun test test/unit/runtime/paths.test.ts test/unit/commands/migrate.test.ts test/unit/cli/init-name.test.ts --timeout=30000` — all pass

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P1 | High-4 | M | Wire `bin/nax.ts` run writer to `outputDir` (unblocks all follow-up commands) |
| P2 | High-1 | S | Add `--name` option to `nax init` and top-level `nax migrate` to `bin/nax.ts` |
| P3 | High-2 | XS | Write `name` field into config in `initProject()` when provided |
| P4 | High-3 | S | Throw `INIT_NAME_COLLISION` (or `RUN_NAME_COLLISION`) from `claimProjectIdentity` when workdir differs; don't swallow in run-setup |
| P5 | Medium-1 | S | Read `outputDir` in `migrateCommand`; abort (not skip) on destination conflict |

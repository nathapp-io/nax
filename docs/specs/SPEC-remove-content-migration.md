# SPEC: Remove Generated-Content Migration

Closes: #2457

## Summary

Remove nax's generated-content migration. That covers both the move `nax run` attempts at the start of every run and the default `nax migrate` move. `nax migrate --reclaim <name>` and `nax migrate --merge <name>` stay as they are: they recover from project-name collisions and are not migrations. `nax migrate` with neither flag refuses with a usage error, and `--dry-run` is no longer accepted.

## Motivation

The migration was written to move legacy generated content out of `.nax/` into `~/.nax/<project>/`: the top-level `runs`, `prompt-audit`, `review-audit`, `cost`, `metrics.json`, `cycle-shadow` and `curator`, and `features/<f>/runs`. That work is done; the active consumer repos have none of it left.

What the scan still matches is live in-repo data that current nax writes and reads:

- `.nax/features/<f>/sessions/` (read by the context stage and the stage assembler);
- `.nax/features/<f>/status.json` (written by the status writer);
- `.nax/features/<f>/stories/<s>/context-manifest-*.json` (the manifest store).

`featureDir()` documents `<root>/.nax/features/<id>` as the canonical home for all three. So every run writes them in-repo. The next run's auto-migration finds them, because #2276 only skips *tracked* candidates. It renames them into `~/.nax/<project>/features/...`, where an earlier move already left a destination, so it throws `MIGRATE_CONFLICT` on the first collision. The run logs `warn "Auto-migration failed — continuing without migration"`. This was observed on two live runs on 2026-10-11.

Nothing can be done about the warning, and following its advice ("remove the destination", or run `nax migrate`) is harmful. A successful move is not atomic, and it takes live data away from the in-repo readers that expect it: the manifest store and `nax context inspect`, the manifest purge, the curator collector, `nax status`, and the finish PR context. nax has a single operator today, so there are no old installs to support.

## Design

### Integration

Symbols this feature **only reads** (verified on `main` `33be27040`):

- `setupRun(options: RunSetupOptions)` (`packages/nax/src/execution/lifecycle/run-setup.ts`). It loads the PRD, primes the status writer, and then claims the project identity.
- `projectOutputDir(projectKey: string, outputDir?: string): string` (`packages/nax/src/runtime`).
- `validateProjectName` (`packages/nax/src/cli/init.ts`). `readProjectIdentity` and `writeProjectIdentity` (`packages/nax/src/runtime`).
- The kept error hints at `packages/nax/src/runtime/paths.ts:109-110` and `packages/nax/src/cli/init.ts:347-348`, which print `nax migrate --reclaim <name>` and `nax migrate --merge <name>`.

Symbols this feature **changes**. The baseline only locates the code; it is never the interface to implement.

- `MigrateOptions` (`packages/nax/src/commands/migrate.ts`)
  - Baseline: `{ workdir: string; dryRun?: boolean; reclaim?: string; merge?: string }`
  - Target: `{ workdir: string; reclaim?: string; merge?: string }`
- `migrateCommand(options: MigrateOptions): Promise<void>` (same file)
  - Baseline: `--reclaim` branch, then `--merge` branch, then the generated-content move: config read, `detectGeneratedContent`, `partitionTrackedCandidates`, dry-run report, `MIGRATE_CONFLICT` / `MIGRATE_CROSS_FS` / `MIGRATE_MOVE_FAILED`, and the `.migrated-from` marker.
  - Target: the `--reclaim` branch, then the `--merge` branch, both unchanged and in that order. With neither flag set, it throws `NaxError` with code `MIGRATE_NO_MODE`, message `nax migrate needs --reclaim <name> or --merge <name>`, and context `{ stage: "migrate", workdir }`. It touches no file.
- `_runSetupDeps` (`packages/nax/src/execution/lifecycle/run-setup.ts`)
  - Baseline: contains `autoMigrateGeneratedContent(workdir)`, which lazily imports and calls `autoMigrateGeneratedContent` from `@/commands`.
  - Target: that member is removed. `setupRun` no longer calls anything between priming the status writer and claiming the project identity.
- The `migrate` command definition (`packages/nax/bin/nax.ts`, around line 400)
  - Baseline: options `-d/--dir`, `--dry-run`, `--reclaim <name>`, `--merge <name>`, and it passes `dryRun` to `migrateCommand`.
  - Target: options `-d/--dir`, `--reclaim <name>`, `--merge <name>`. The command description is `Recover a project-name collision: --reclaim or --merge`. The existing catch prints `Error: <message>` in red and exits 1, so a `MIGRATE_NO_MODE` rejection exits 1 with the usage message.
- `packages/nax/src/commands/index.ts`
  - Baseline: exports `autoMigrateGeneratedContent`, `detectGeneratedContent`, `migrateCommand`, `partitionTrackedCandidates`, and the types `MigrateCandidate` and `MigrateOptions`.
  - Target: exports `migrateCommand` and the type `MigrateOptions` only.

Removed outright, by the terminal story: `GENERATED_NAMES`, `GENERATED_FEATURE_SUBNAMES`, `detectGeneratedContent`, `partitionTrackedCandidates`, `autoMigrateGeneratedContent`, `MigrateCandidate`, and the `_gitDeps` re-export in `migrate.ts`. No source file outside `migrate.ts` and `commands/index.ts` imports any of them. Once they are gone, `migrate.ts` no longer uses its `gitWithTimeout`, `readdir`, `getSafeLogger` or `projectOutputDir` imports, and those are removed; `mkdir` and `rename` stay, because `--reclaim` uses them. `lint:biome` runs first in `check:all` and rejects unused imports. The file's module doc comment changes to describe project-name collision recovery.

Pattern to follow: the `--reclaim` and `--merge` branches already validate their input and throw a `NaxError` with a `MIGRATE_*` code and a `stage: "migrate"` context. `MIGRATE_NO_MODE` follows the same shape.

### CLI Behavior

| Invocation | Exit | stderr |
|---|---|---|
| `nax migrate --reclaim <name>` | unchanged | unchanged |
| `nax migrate --merge <name>` | unchanged | unchanged |
| `nax migrate` (neither flag) | 1 | `Error: nax migrate needs --reclaim <name> or --merge <name>` |
| `nax migrate --dry-run` | 1 | commander's `error: unknown option '--dry-run'` |

### Failure Handling

| Condition | Behaviour |
|---|---|
| `migrateCommand` called with neither `reclaim` nor `merge` | Rejects with `NaxError` `MIGRATE_NO_MODE`. No file is read, moved or created. |
| `nax migrate` run with an unknown `--dry-run` option | commander refuses the option and exits 1 before `migrateCommand` runs. |
| `setupRun` in a repo holding `.nax/features/<f>/` run artifacts | Nothing under `.nax/` is moved, and no migration line is logged. |

### Quality gate notes

- `bun run check:all` in `packages/nax` runs the cognitive-complexity ratchet. That ratchet fails a baseline whose recorded score is higher than the code's current score (`baseline is stale`). `packages/nax/scripts/baselines/complexity-baseline.json` records `src/commands/migrate.ts` at `detectGeneratedContent: 54, migrateCommand: 41`. Each story that lowers or removes one of those functions must regenerate the baseline with `bun run check:complexity:update`.
- `packages/nax/scripts/check-worktree-id-ssot.ts` keeps `src/commands/migrate.ts` in `ALLOWED_FILES`, because the file still exists. That script only skips allowlisted files, so the entry needs no change.

## Out of Scope

- Other "migrate" code: `nax rules migrate` (`cli/rules-migrate.ts`), `config/migrations`, `pb-004-migration` and `default-agent-migration`.
- Changing `--reclaim` or `--merge` behaviour, including which of the two runs when both are passed (`--reclaim` today).
- Cleaning up `~/.nax/<project>/features/*/sessions/` directories an earlier auto-migration left behind; they are harmless.
- Moving any in-repo `.nax/features/<f>/` content anywhere; it stays where nax reads it.
- The tracked `.nax/features/run-hygiene-bugs/.nax-acceptance.test.ts`, which imports the removed functions. `.nax/` is read-only to the run, and no package test suite, typecheck or lint covers that file. Deleting it is a manual follow-up.
- Rewriting historical design documents under `docs/specs/` that describe the migration.

## Stories

### US-001 — Run setup stops migrating

Workdir: `packages/nax`

No dependencies.

Remove the `autoMigrateGeneratedContent` call from `setupRun` and its `_runSetupDeps` member. Delete the unit test that pins that seam, and add a test that a run setup leaves in-repo feature artifacts where they are.

### US-002 — `nax migrate` without a mode refuses

Workdir: `packages/nax`

No dependencies.

With neither `reclaim` nor `merge`, `migrateCommand` throws `MIGRATE_NO_MODE`, and the generated-content move branch goes. `MigrateOptions` loses `dryRun`, and the `migrate` command loses `--dry-run` and gets its new description. The content-migration cases of `migrate.test.ts`, and the `migrateCommand` cases of the tracked-candidates integration test, are removed with the branch they cover.

The CLI ACs spawn `bun bin/nax.ts`. This is a deliberate exception to the "Spawning full `nax` process in tests" rule in `.nax/rules/forbidden-patterns-tests.md`. The `migrate` command and its commander options are defined inline in `bin/nax.ts` and cannot be imported, and `test/unit/cli/trust.test.ts` already spawns the CLI this way. Every spawn sets `NAX_GLOBAL_CONFIG_DIR` to a temp dir, so no spawn reaches the real `~/.nax`.

### US-003 — Remove the migration helpers

Workdir: `packages/nax`

Depends on US-002.

Deletion only. Remove `GENERATED_NAMES`, `GENERATED_FEATURE_SUBNAMES`, `detectGeneratedContent`, `partitionTrackedCandidates`, `autoMigrateGeneratedContent`, `MigrateCandidate` and the `_gitDeps` re-export from `migrate.ts`, along with their exports in `commands/index.ts`. Delete their tests, rewrite the module doc comment, regenerate the complexity baseline, and update the architecture doc line.

Verification note: `bun run typecheck` and `bun run check:all` in `packages/nax`. The compiler rejects any remaining reference to a removed symbol, and the complexity ratchet rejects a stale `src/commands/migrate.ts` row.

Story split rationale: US-001 changes run behaviour, US-002 changes the CLI contract, and US-003 is the terminal deletion. All three are in one package and each is well under the 24-assertion `maxAcCount`.

### Context Files

**US-001**
- `packages/nax/src/execution/lifecycle/run-setup.ts`
- `packages/nax/test/unit/execution/lifecycle/run-setup.test.ts`
- `packages/nax/test/unit/execution/lifecycle/run-setup-auto-migrate.test.ts`
- `packages/nax/test/integration/commands/migrate-tracked-candidates.test.ts` — defines the local `captureLogs` helper; copy it into the new test, because US-003 deletes this file

**US-002**
- `packages/nax/src/commands/migrate.ts`
- `packages/nax/bin/nax.ts`
- `packages/nax/test/unit/commands/migrate.test.ts`
- `packages/nax/test/unit/cli/trust.test.ts` — precedent for spawning `bun bin/nax.ts` with `NAX_GLOBAL_CONFIG_DIR`

**US-003**
- `packages/nax/src/commands/migrate.ts`
- `packages/nax/src/commands/index.ts`
- `packages/nax/test/integration/commands/migrate-tracked-candidates.test.ts`

### Creates

**US-001**
- `packages/nax/test/unit/execution/lifecycle/run-setup-no-migration.test.ts`

**US-002**
- `packages/nax/test/unit/cli/migrate-cli.test.ts`

### Modifies

**US-001**
- `packages/nax/src/execution/lifecycle/run-setup.ts` — remove the `autoMigrateGeneratedContent` member of `_runSetupDeps` and its call in `setupRun`. Nothing replaces them: `setupRun` goes straight from priming the status writer to claiming the project identity.
- `packages/nax/test/unit/execution/lifecycle/run-setup-auto-migrate.test.ts` — delete the file. It pins that `setupRun` calls `_runSetupDeps.autoMigrateGeneratedContent` exactly once, and that is the call this story removes. The replacing invariant, in the new run-setup-no-migration test this story creates, is that `setupRun` leaves in-repo feature artifacts in place.

**US-002**
- `packages/nax/test/unit/commands/migrate.test.ts` — remove the `describe("migrateCommand — full migration flow")` block. Its cases pin the generated-content move: `MIGRATE_NO_CONFIG`, `MIGRATE_CONFIG_READ_FAILED`, "nothing to migrate", dry-run, the move with its `.migrated-from` marker, the basename project key, `MIGRATE_CONFLICT` and `MIGRATE_MOVE_FAILED`. The replacing invariant is that a call with neither `reclaim` nor `merge` rejects with `MIGRATE_NO_MODE` and touches no file. The `--reclaim` and `--merge` describe blocks stay unchanged. The `chmod` import, used only by the removed block, is removed too. `mkdir` stays, because the `detectGeneratedContent` block still uses it until US-003.
- `packages/nax/test/integration/commands/migrate-tracked-candidates.test.ts` — remove the `describe("US-003 migrateCommand")` block. Its cases call `migrateCommand({ workdir })` and `migrateCommand({ workdir, dryRun: true })` and expect the tracked-candidate move logs. The replacing invariant is the `MIGRATE_NO_MODE` rejection. The other describe blocks stay until US-003.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerate it with `bun run check:complexity:update`. Removing the move branch lowers `migrateCommand` below its recorded score of 41, and the ratchet fails a stale row. The replacing invariant is whatever the regenerated row for the migrate command file records.

**US-003**
- `packages/nax/src/commands/index.ts` — remove the `autoMigrateGeneratedContent`, `detectGeneratedContent` and `partitionTrackedCandidates` exports and the `MigrateCandidate` type export. `migrateCommand` and `MigrateOptions` stay.
- `packages/nax/test/integration/commands/migrate-tracked-candidates.test.ts` — delete the file. Every remaining case exercises `detectGeneratedContent`, `partitionTrackedCandidates` or `autoMigrateGeneratedContent`, which this story deletes. Nothing replaces it, because the behaviour no longer exists.
- `packages/nax/test/unit/commands/migrate.test.ts` — remove the `describe("detectGeneratedContent")` block, its import and the `mkdir` import, because the function is deleted and nothing else in the file uses `mkdir`. The `--reclaim` and `--merge` blocks and the US-002 `MIGRATE_NO_MODE` cases stay.
- `packages/nax/scripts/baselines/complexity-baseline.json` — regenerate it with `bun run check:complexity:update`. Deleting `detectGeneratedContent` (recorded at 54) leaves a stale row for the migrate command file. The replacing invariant is whatever the regenerated row records; the row is gone if no function in the file is over the limit.
- `docs/guides/cli-reference.md` — the `nax migrate` section describes moving generated content out of the project's nax directory, shows a `nax migrate --dry-run` example, and has a `--dry-run` row in its flag table. The replacing text drops the example and the flag-table row, describes project-name collision recovery only, and keeps the `--reclaim` and `--merge` examples.
- `packages/nax/README.md` — the `nax migrate` table row reads "Move generated content from the project nax directory to the output directory". The replacing row reads "Recover a project-name collision: `--reclaim <name>` or `--merge <name>`".
- `docs/architecture/subsystems.md` — line 1745 describes `migrateCommand(opts)` / `detectGeneratedContent()` as migrating legacy formats. The replacing text is that `migrateCommand` handles `--reclaim` / `--merge` project-identity collision recovery only.

### Seams

None. The feature adds no externally visible symbol. `MIGRATE_NO_MODE` is a new error code on an existing function, and its consumer (the `migrate` command) is exercised end to end by US-002's CLI ACs.

## Acceptance Criteria

### US-001

1. [unit] `setupRun` with a valid PRD, in a temp project whose `.nax/config.json` sets `outputDir` equal to the mocked `runtime.outputDir` and whose `.nax/` holds `features/demo/sessions/s1.json`, `features/demo/status.json` and `features/demo/stories/US-001/context-manifest-a.json`, leaves all three files at their original paths with their original contents.
2. [unit] After that `setupRun` call, with the mocked `runtime.outputDir` set to a directory inside the temp dir, `<runtime.outputDir>/features/demo/` holds no `sessions` entry, no `status.json` and no `stories` entry. Its only entry is the `nax.lock` that `acquireFeatureLock` writes.
3. [unit] That `setupRun` call, with log entries captured through a copy of the local `captureLogs` helper from the tracked-candidates integration test, records no entry whose message starts with `Auto-migration` or with `Found generated content`.
4. [unit] After releasing both locks the first call took (`releaseLock(workdir)` and the feature lock release), a second `setupRun` on the same temp project records no `warn` entry whose message or `error` data contains `Migration conflict`.

### US-002

1. [unit] `migrateCommand({ workdir })` with neither `reclaim` nor `merge` rejects with a `NaxError` whose `code` is `MIGRATE_NO_MODE`.
2. [unit] That rejection's message is `nax migrate needs --reclaim <name> or --merge <name>`.
3. [unit] That call, in a temp project whose `.nax/config.json` sets `outputDir` to `<temp dir>/out` and which holds `.nax/metrics.json`, leaves `.nax/metrics.json` in place, and `<temp dir>/out` (the configured `outputDir`) does not exist afterwards.
4. [unit] That call, in a temp dir with no `.nax/config.json`, rejects with `MIGRATE_NO_MODE`, not with `MIGRATE_NO_CONFIG`.
5. [cli] Spawning `bun bin/nax.ts migrate -d <temp project>`, with `NAX_GLOBAL_CONFIG_DIR` set to a temp dir, exits with code 1.
6. [cli] That spawn's stderr contains `nax migrate needs --reclaim <name> or --merge <name>`.
7. [cli] Spawning `bun bin/nax.ts migrate --dry-run -d <temp project>`, with `NAX_GLOBAL_CONFIG_DIR` set to a temp dir, exits with a non-zero code, and its stderr contains `unknown option '--dry-run'`.
8. [cli] Spawning `bun bin/nax.ts migrate --help`, with `NAX_GLOBAL_CONFIG_DIR` set to a temp dir, prints `Recover a project-name collision: --reclaim or --merge`.
9. [cli] Spawning `bun bin/nax.ts migrate --reclaim <name>`, with `NAX_GLOBAL_CONFIG_DIR` pointing at a temp dir that holds a `<name>/` directory, exits 0 and leaves a `_archive/<name>-<timestamp>/` directory under that config dir.

### US-003

1. [unit] Importing `@/commands` at runtime yields a module that exports `migrateCommand` as a function, and has no `autoMigrateGeneratedContent`, `detectGeneratedContent` or `partitionTrackedCandidates` export.
2. [unit] Importing `@/commands/migrate` at runtime yields a module with no `_gitDeps`, `detectGeneratedContent`, `partitionTrackedCandidates` or `autoMigrateGeneratedContent` export.

Verification note: `bun run typecheck` and `bun run check:all` in `packages/nax` pass. The compiler rejects any remaining import of a removed symbol, and the complexity ratchet rejects a stale `src/commands/migrate.ts` baseline row.

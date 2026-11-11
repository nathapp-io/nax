# SPEC: run-tmp-and-dead-config — run temp roots are always removed, the curator and the dead config keys are gone, rule `stages:` is retired

Closes: #2860, #2861, #2832, #2830

## Summary

Four cleanups that each leave nax silently doing the wrong thing today, shipped as one feature by the
owner's ruling (2026-11-11):

1. **#2860, run temp roots leak.** `wipeRunTmp` cannot remove a run root that holds a read-only
   directory, and only `nax run` calls it. This feature makes the removal restore owner write
   permission and retry. It moves the wipe into `runtime.close()`, so every command that owns a
   runtime removes its own root, and adds a sweep of stale sibling roots older than 48 hours.
2. **#2861, the curator.** It is unused, but enabled by default, and appends to
   `~/.nax/global/curator/rollup.jsonl` on every run. The plugin, the `nax curator` command, the
   rollup-path plumbing and the `curator` config key are removed. A config that still sets `curator`
   keeps loading, with one removed-key warning.
3. **#2832, config keys with no reader.** `quality.testing`, `prompts.behavioralGuardrails`,
   `review.nonBlockingFix` and the review keys listed in the issue comment lost their only reader with
   pipeline mode. They join the warn-and-strip list (`REMOVED_CONFIG_KEYS`), and their schema, types,
   defaults and `nax config` descriptions are deleted.
4. **#2830, rule `stages:`.** The default index delivery in workflow mode ignores `stages:`. The
   `delivery: "push"` path filters on it against a request stage that is always `"context"`, so
   stage-scoped rules are silently dropped there. `stages:` is retired: no path filters on it, the
   frontmatter parser still accepts it and warns that it is ignored, and `nax rules lint` reports that
   warning.

## Motivation

- #2860: one host held 567 leftover run roots (28 GB) under `/tmp/nax`. A root that a test suite left
  with a `0500` directory survives `rm -rf` (`EACCES`), and the roots of `nax bot review`,
  `nax bot fix` and `nax plan` (and of any other command that owns a runtime) are never wiped at all. Every leftover root
  is named after a `NaxRuntime.runId` (`crypto.randomUUID()` in `createRuntime`), because
  `resolveDispatchLauncher` builds `runTmpRoot(options.runId)` from the runtime's id. So
  `runtime.close()` is the one place that sees every root that was created. The owner currently clears
  the roots by hand.
- #2861: the curator runs after every `nax run` and grows a global JSONL file (55 MB on one host).
  The owner does not use it.
- #2832: setting any of these keys does nothing, while `nax config` and the schema still present them
  as live settings. The owner's global config sets three of them (`prompts.behavioralGuardrails`,
  `review.nonBlockingFix`, `review.conflictDetection`). Ruling 2026-11-11: strip every key. Do not wire
  `quality.testing` back in; test and mocking policy belongs in `.nax/rules/`.
- #2830: the default index delivery (`workflow/brief.ts` `resolveRulesIndex`, and the rule-delivery loop
  handlers in `context/rules/rule-delivery/`) never reads `stages:`. `StaticRulesProvider` filters
  on it (`ruleMatchesStage`, `static-rules.ts:139`), but every `ContextRequest` in `src/` carries
  `stage: "context"`. A rule tagged `stages: [review]` therefore lints clean and is delivered under
  index mode, but is dropped under push mode. The frontmatter vocabulary (`KNOWN_VALID_STAGES`) still
  lists about 14 stage names that no request carries. Ruling 2026-11-11: retire `stages:` instead of
  mapping it to workflow roles.

## Design

### Approach

**Temp roots (US-001, US-002).** Removal goes through one exported helper,
`removeRunTmpTree(path)`, in `execution/lifecycle/run-tmp-wipe.ts`:

1. `rm(path, { recursive: true, force: true })`.
2. On an error whose `code` is `EACCES` or `EPERM`: walk the tree under `path` with `lstat`, which
   never follows a symlink. Give each directory owner `rwx` (`mode | 0o700`) through `chmod`. Never
   chmod a symlink or anything outside `path`. Then call `rm` once more.
3. If the retry fails, the error propagates to the caller. Any other first error propagates unchanged
   without a retry.

`wipeRunTmp(runId)` keeps its contract (absence logged at debug, failure logged at warn and
swallowed, `dryRun` skips) and calls `removeRunTmpTree` instead of the bare `rm`.

`sweepStaleRunTmpRoots({ currentRunId, now, maxAgeMs })` lives in a new
`execution/lifecycle/run-tmp-sweep.ts`. It lists the parent directory `dirname(runTmpRoot(currentRunId))`.
It never resolves `/tmp/nax` itself, so the trust checks in `runTmpRoot` (shared parent owned by the
user, or the per-user fallback) apply unchanged. For each entry it:

- skips the current run's own root, compared by name against `basename(runTmpRoot(currentRunId))`
  (`runTmpRoot` sanitises the id),
- skips anything that `lstat` does not report as a directory (symlinks included),
- computes the entry's age as `now` minus the newest `mtimeMs` among the entry and its direct children,
- removes the entry with `removeRunTmpTree` when that age exceeds `maxAgeMs`.

`STALE_RUN_TMP_MAX_AGE_MS = 48 * 60 * 60 * 1000` is exported from the same module. A live concurrent
run's root is younger than that, because each new session creates a direct child and so refreshes the
newest mtime. A failure on one entry is logged at warn and the sweep continues. A missing parent is a
no-op. The sweep resolves for every outcome.

`runtime.close()` calls a new `closeRunTmp({ runId, dryRun })` in `src/runtime/run-tmp-close.ts`. It
wipes the runtime's root, then sweeps, and never rejects. The call goes in the `finally` of
`closeRuntime`, after `opts.memory.close()`, so a rejecting MCP close or flush cannot skip it. `close()`
is already memoised (`teardown`), so the wipe runs once per runtime. A dry-run runtime
(`opts.dryRun === true`) neither wipes nor sweeps. The test preload (`test/preload.ts`, which already
replaces other real-host deps) sets `_runTmpCloseDeps.sweepStaleRunTmpRoots` to a no-op, so the many
tests that close a real runtime never sweep the developer's real temp parent; tests of the sweep call
`sweepStaleRunTmpRoots` directly with stubbed `_runTmpSweepDeps`. The runtime owners that close their runtime today: `execution/runner.ts:439` (`nax run`, whose
runtime also hosts the run's branch review session `_run-wf-branch-review`), `bot/review-run.ts:468`,
`bot/fix-run.ts:442`, `plan/strategies/*`, `cli/plan-decompose.ts:166` (close error swallowed, which is
fine because `closeRunTmp` never rejects), `cli/setup.ts`, `cli/advisor-replay.ts`. A runtime that is
never closed is not covered by the wipe; its root ages out through the sweep.

US-006 then deletes the second wipe in `cleanupRun` (`run-cleanup.ts:381-394`) and the
`runtimeRunId` option that existed only to feed it. Until then, both wipes run, and the second sees an
absent root and logs at debug.

**Removed keys (US-003).** New entries in `REMOVED_CONFIG_KEYS`. The strip runs before
`NaxConfigSchema.safeParse` at all three loader sites, so a config that sets these keys loads and warns
once per key: `Config key "<path>" has been removed — <hint>. Remove it from your config.`

| Path | Hint |
|:--|:--|
| `curator` | `CURATOR_REMOVED_HINT` = `the curator feature was removed; nax no longer writes ~/.nax/global/curator, which is safe to delete` |
| `quality.testing` | `TESTING_POLICY_HINT` = `nothing reads this key since pipeline mode was removed; state test and mocking policy in a .nax/rules file` |
| `prompts.behavioralGuardrails` | `PIPELINE_ONLY_KEY_HINT` |
| `review.nonBlockingFix` | `PIPELINE_ONLY_KEY_HINT` |
| `review.adversarial.nonBlockingFix` | `PIPELINE_ONLY_KEY_HINT` |
| `review.parseRetryMaxAttempts` | `PIPELINE_ONLY_KEY_HINT` |
| `review.conflictDetection` | `PIPELINE_ONLY_KEY_HINT` |
| `review.semantic.demandInspectionTrail` | `PIPELINE_ONLY_KEY_HINT` |
| `review.semantic.acRegroundOnDrop` | `PIPELINE_ONLY_KEY_HINT` |
| `review.semantic.recurrenceDemotion` | `PIPELINE_ONLY_KEY_HINT` |
| `review.adversarial.demandInspectionTrail` | `PIPELINE_ONLY_KEY_HINT` |
| `review.adversarial.acRegroundOnDrop` | `PIPELINE_ONLY_KEY_HINT` |
| `review.adversarial.recurrenceDemotion` | `PIPELINE_ONLY_KEY_HINT` |
| `review.adversarial.parallel` | `PIPELINE_ONLY_KEY_HINT` |
| `review.adversarial.maxConcurrentSessions` | `PIPELINE_ONLY_KEY_HINT` |

`migrateLegacyNonBlockingFix` (`config/migrations.ts`, called from `compat-shims.ts:499`) copied
`review.adversarial.nonBlockingFix` to `review.nonBlockingFix` with a deprecation warning. Both paths
are now removed keys, so US-003 deletes the shim and its call. A config that sets the legacy path gets
the one removed-key warning and never the deprecation warning.

**Curator removal (US-005).** Delete the plugin directory, the command module and its `bin/nax.ts`
registration, the built-in registration in `plugins/loader.ts`, `CuratorConfigSchema` with its
threshold and retention schemas, `runtime-types-curator.ts`, `curatorRollupPath` (in `runtime/paths.ts`,
on `NaxRuntime`, in `RunCleanupOptions` and on the plugin run-end context in `plugins/extensions.ts`), the
curator entries in `scripts/check-worktree-id-ssot.ts` and the two baselines, the curator-only tests and
the docs. The other run-end context fields (`outputDir`, `globalDir`, `projectKey`, the run JSONL path,
`config`) stay, because external plugins read them. A `disabledPlugins` list that still names
`"curator"` is harmless: the loader only checks names against the set. Comments elsewhere in `src/`
that mention the curator are reworded or dropped. Existing `~/.nax/global/curator/` data is not
touched.

**Retiring `stages:` (US-004).** `StaticRulesProvider` stops filtering on `rule.stages`. Every
merged rule enters the `appliesTo` scoping step, whatever the request stage. `extractStages` in
`rules-frontmatter.ts` still validates the shape (a list of non-empty strings, else
`RulesFrontmatterError` as today). Instead of the per-name unknown-stage warning, it records exactly one
warning per rule that declares a non-empty list:
`Frontmatter key "stages" is ignored — rules apply to every session. Remove it from the frontmatter.`
`nax rules lint` already re-emits parser warnings (`rules-lint.ts:327`), so it reports this one with no
change of its own. `stages` stays in `KNOWN_FRONTMATTER_KEYS`, so a rule that declares it still loads.
With the filter gone, `ruleMatchesStage`, `warnOnAppliesToStageContradiction` (and its call at
`static-rules.ts:267`), `KNOWN_VALID_STAGES` and `EXTRA_KNOWN_STAGES` are dead, so US-004 deletes them
too. US-006 deletes what is left: the `stages` fields on `CanonicalRule`, `ParsedFrontmatter` and the
rule-sections input, the manifest's `stageFilteredIds` and the `stageFilteredCount` log field. `STAGE_CONTEXT_MAP` stays, because it keys `context.v2.stages` budgets,
not rule selection.

### Integration (extends existing code)

The baseline signatures below only locate the code. The target lines are the interface to implement.

Symbols this feature changes:

- `wipeRunTmp(runId: string, opts?: WipeRunTmpOptions): Promise<void>`
  (`packages/nax/src/execution/lifecycle/run-tmp-wipe.ts`).
  Baseline: removes the root through `_runTmpWipeDeps.remove` (a bare recursive `rm`).
  Target: same signature and logging, but removes through `removeRunTmpTree`.
- `_runTmpWipeDeps` (same file).
  Baseline: `{ remove, exists }`.
  Target: `{ remove, exists, lstat, chmod, readdir }`, where `lstat`, `chmod` and `readdir` are the
  `node:fs/promises` calls the permission-restoring walk uses.
- `closeRuntime` inside `createRuntime` (`packages/nax/src/runtime/index.ts:419`).
  Baseline: the `finally` awaits only `opts?.memory?.close()`.
  Target: the `finally` awaits `opts?.memory?.close()` and then
  `_runtimeTmpDeps.closeRunTmp({ runId, dryRun: opts?.dryRun ?? false })`.
- `REMOVED_CONFIG_KEYS` (`packages/nax/src/config/removed-config-keys.ts:91`).
  Baseline: the existing C1 entries. Target: the same entries plus the 15 in the table above.
- `extractStages(doc, filePath, warnings)` (`packages/nax/src/context/rules/rules-frontmatter.ts:228`).
  Baseline: pushes `Unknown stage name "<s>" — rule will still load but may never be applied` per
  unknown name. Target: pushes the single ignored-key warning above when the list is non-empty.
- `StaticRulesProvider` stage filter (`packages/nax/src/context/engine/providers/static-rules.ts:248-253`).
  Baseline: drops rules whose `stages` excludes `request.stage`. Target: no stage filter.
- `cleanupRun(options: RunCleanupOptions)` (`packages/nax/src/execution/lifecycle/run-cleanup.ts`).
  Baseline: takes `runtimeRunId` and `curatorRollupPath` and wipes the run temp root.
  Target: neither option, and no temp wipe. `runtime.close()` owns it.

Symbols read, not changed:

- `runTmpRoot(runId: string): string` (`packages/nax-agent/src/sandbox/session-tmp.ts:89`), exported from
  `@nathapp/nax-agent`.
- `stripKeysAtPaths(conf, keys, warn?)` and `PIPELINE_ONLY_KEY_HINT`
  (`packages/nax/src/config/removed-config-keys.ts`).
- `loadPlugins` built-in registration (`packages/nax/src/plugins/loader.ts:139`).
- `rulesLintCommand` re-emits `rule.warnings` (`packages/nax/src/cli/rules-lint.ts:324-330`).

New symbols:

- `removeRunTmpTree(path: string): Promise<void>`, exported from `run-tmp-wipe.ts`.
- `sweepStaleRunTmpRoots(opts: { currentRunId: string; now: number; maxAgeMs: number }): Promise<void>`,
  `STALE_RUN_TMP_MAX_AGE_MS` and `_runTmpSweepDeps` (`{ readdir, lstat, remove }`), exported from
  `execution/lifecycle/run-tmp-sweep.ts`.
- `closeRunTmp(opts: { runId: string; dryRun: boolean }): Promise<void>` and `_runTmpCloseDeps`
  (`{ wipeRunTmp, sweepStaleRunTmpRoots, now }`), exported from `src/runtime/run-tmp-close.ts`.
- `_runtimeTmpDeps` (`{ closeRunTmp }`), exported from `src/runtime/index.ts`.
- `CURATOR_REMOVED_HINT` and `TESTING_POLICY_HINT`, exported from `removed-config-keys.ts`.

`runtime/index.ts` imports the two lifecycle modules by file path (`../execution/lifecycle/run-tmp-wipe`,
`../execution/lifecycle/run-tmp-sweep`), never through the lifecycle barrel. It already imports
`../execution/pid-registry` the same way.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `rm` fails with `EACCES`/`EPERM` and the retry succeeds | root removed, nothing logged at warn |
| the retry also fails | `removeRunTmpTree` rejects; `wipeRunTmp` logs `Failed to wipe run temp dir <path> — continuing` at warn and resolves |
| `rm` fails with any other code | no chmod walk, no retry; the error propagates to the caller |
| `chmod` fails on one directory during the walk | the walk continues; the retry decides the outcome |
| `lstat` or `readdir` fails on an entry during the walk | that entry is skipped; the walk continues and the retry decides the outcome |
| sweep: parent directory missing | no-op, resolves |
| sweep: one entry fails to remove | warn `Failed to sweep stale run temp dir <path> — continuing`, continue with the next entry |
| sweep: `readdir` of the parent fails with anything but `ENOENT` | warn once, resolve |
| `closeRunTmp`: wipe or sweep throws | logged at warn, `close()` still resolves |
| config sets a removed key | one removed-key warning per path; config loads |
| rule declares `stages:` that is not a list of non-empty strings | `RulesFrontmatterError`, unchanged |

## Out of Scope

- Wiping each session's temp directory when that session closes (per-session wipe from the #2860 comment): ruled out 2026-11-11, because a re-dispatched session with the same name would lose its temp files mid-run.
- `nax chat` sessions: they do not create run temp roots (they never pass a `runId` to `resolveDispatchLauncher`), so this feature does not change chat.
- Wiring `quality.testing` (hermetic requirement, `externalBoundaries`, `mockGuidance`) into workflow prompts: ruled out 2026-11-11; the key is stripped, and test policy belongs in `.nax/rules/`.
- Mapping rule `stages:` to workflow role names: ruled out 2026-11-11 in favour of retiring the key.
- Shrinking `STAGE_CONTEXT_MAP` or the `context.v2.stages` config: they key per-stage context budgets, not rule selection.
- Deleting existing `~/.nax/global/curator/` data: nax stops writing it and leaves it in place.
- Removing `stages:` lines from this repo's `.nax/rules/*.md` and the `curator` key from this repo's `.nax/config.json`: `.nax/` is read-only to the run, so the owner does both by hand after merge.
- Stripping the removed keys from `~/.nax/config.json`, profiles and other projects' configs: the owner does it with the config-key-removal runbook and updates `~/.nax/scripts/strip-removed-config-keys.py`.
- nax-toolkit skill updates (`rules-setup` references `curator.md`; `nax-run-telemetry` reads the curator rollup): a follow-up in the skills repo.
- Removing a stale root that another OS user owns: `runTmpRoot` already falls back to a per-user parent, and the sweep only lists the parent this user's runs resolve to.

## Stories

### US-001 — the run temp wipe survives read-only trees

Workdir: packages/nax. No dependencies.

Add `removeRunTmpTree(path)` to `run-tmp-wipe.ts`: on an `EACCES`/`EPERM` failure it walks the tree
with `lstat`, gives each directory owner `rwx`, never touches symlinks or anything outside `path`, and
retries `rm` once. `wipeRunTmp` removes through it, keeping its logging contract.

### US-002 — `runtime.close()` removes its run temp root and sweeps stale roots

Workdir: packages/nax. Depends on US-001.

Create `run-tmp-sweep.ts` (`sweepStaleRunTmpRoots`, `STALE_RUN_TMP_MAX_AGE_MS`) and
`src/runtime/run-tmp-close.ts` (`closeRunTmp`), and call `closeRunTmp` from the `finally` of
`closeRuntime` through `_runtimeTmpDeps`. A dry-run runtime skips both steps.

### US-003 — removed-key warnings for the curator and the #2832 keys

Workdir: packages/nax. No dependencies.

Add the 15 paths in the Design table to `REMOVED_CONFIG_KEYS`, with the two new hints. Delete
`migrateLegacyNonBlockingFix` and its call in `compat-shims.ts`.

### US-004 — retire rule `stages:`

Workdir: packages/nax. No dependencies.

`StaticRulesProvider` stops filtering on `stages`. `extractStages` records the single ignored-key
warning instead of the unknown-stage warning. Delete the now-dead `ruleMatchesStage`,
`warnOnAppliesToStageContradiction` and its call, `KNOWN_VALID_STAGES`, `EXTRA_KNOWN_STAGES` (and the `STAGE_CONTEXT_MAP` import in `rules-frontmatter.ts`
that only they used), and
`test/unit/context/rules/nax-rules-stage-scoping.test.ts` (it pins pipeline-era stage scoping of this
repo's own rules). Update `docs/guides/static-rules.md` and
`docs/guides/context-engine.md` to say that `stages:` is ignored.

### US-005 — delete the curator feature

Workdir: packages/nax. Depends on US-003.

Delete the curator plugin, command, CLI registration, built-in registration, config schema and types,
`curatorRollupPath` plumbing, check-script entries, baseline entries, curator-only tests and
`docs/guides/curator.md`. Remove the curator sections from `docs/guides/cli-reference.md`,
`docs/guides/configuration.md`, `docs/architecture/*.md` and `packages/nax/README.md`. Verification note:
removals are checked by `bun run typecheck` and `bun run lint` in `packages/nax`.

### US-006 — terminal cleanup: dead schema, stage plumbing, the second wipe

Workdir: packages/nax. Depends on US-002, US-003, US-004, US-005.

Deletion only:

- the #2832 schema fields, runtime types, defaults (`schemas.ts:252-261`, `:365`), `PromptsConfigSchema`
  and `PromptsConfig`, `TestingConfig` and the `quality.testing` branch of `config/merge.ts:175`, the
  review type fields in `src/review/types.ts`, and their `cli/config-descriptions.ts` entries;
- the `stages` fields on `CanonicalRule` / `ParsedFrontmatter` / rule-sections input, and the manifest's
  `stageFilteredIds` and `stageFilteredCount`;
- the run-temp wipe in `cleanupRun`, the `_runCleanupDeps.wipeRunTmp` member and its import, the
  `runtimeRunId` option and the matching argument in `runner.ts`.

Add the 15 paths to the Removed Keys table in `docs/guides/configuration.md` and delete the sections for
the removed keys. Verification note: removals are checked by `bun run typecheck` and `bun run lint` in
`packages/nax`. The runtime ACs below pin the resolved defaults.

### Context Files

**US-001**
- `packages/nax/src/execution/lifecycle/run-tmp-wipe.ts`
- `packages/nax/test/unit/execution/lifecycle/run-tmp-wipe.test.ts`
- `packages/nax/test/integration/execution/lifecycle/run-tmp-wipe.test.ts`

**US-002**
- `packages/nax/src/runtime/index.ts`
- `packages/nax-agent/src/sandbox/session-tmp.ts`
- `packages/nax/test/unit/runtime/runtime-close-partial.test.ts`
- `packages/nax/src/execution/lifecycle/run-tmp-wipe.ts` — `removeRunTmpTree` created by US-001, read here

**US-003**
- `packages/nax/src/config/removed-config-keys.ts`
- `packages/nax/src/config/migrations.ts`
- `packages/nax/src/config/compat-shims.ts`
- `packages/nax/test/unit/config/removed-config-keys-unread.test.ts`

**US-004**
- `packages/nax/src/context/engine/providers/static-rules.ts`
- `packages/nax/src/context/engine/providers/static-rules-scoping.ts`
- `packages/nax/src/context/rules/rules-frontmatter.ts`
- `packages/nax/src/cli/rules-lint.ts`
- `packages/nax/test/unit/cli/rules-lint.test.ts`

**US-005**
- `packages/nax/src/plugins/loader.ts`
- `packages/nax/bin/nax.ts`
- `packages/nax/src/runtime/paths.ts`
- `packages/nax/src/plugins/extensions.ts`
- `packages/nax/src/execution/lifecycle/run-cleanup.ts`

**US-006**
- `packages/nax/src/config/schemas-review.ts`
- `packages/nax/src/config/schemas-infra.ts`
- `packages/nax/src/config/schemas-execution.ts`
- `packages/nax/src/context/engine/providers/static-rules-scoping.ts`
- `packages/nax/src/execution/lifecycle/run-cleanup.ts`

### Creates

**US-001**
- `packages/nax/test/unit/execution/lifecycle/run-tmp-wipe-readonly.test.ts`

**US-002**
- `packages/nax/src/execution/lifecycle/run-tmp-sweep.ts`
- `packages/nax/src/runtime/run-tmp-close.ts`
- `packages/nax/test/unit/execution/lifecycle/run-tmp-sweep.test.ts`
- `packages/nax/test/unit/runtime/run-tmp-close.test.ts`
- `packages/nax/test/unit/runtime/runtime-close-run-tmp.test.ts`

**US-003**
- `packages/nax/test/unit/config/removed-config-keys-2832.test.ts`

**US-004**
- `packages/nax/test/unit/context/engine/providers/static-rules-stages-ignored.test.ts`

**US-005**
- `packages/nax/test/unit/plugins/builtin-no-curator.test.ts`

**US-006**
- `packages/nax/test/unit/config/removed-keys-defaults.test.ts`

### Modifies

**US-001**
- `packages/nax/test/unit/execution/lifecycle/run-tmp-wipe.test.ts` — tests that stub `_runTmpWipeDeps.remove` to reject with an `EACCES` error and assert the single warn now go through the permission-restoring retry first; they stub `lstat`/`readdir`/`chmod` (or make the retry reject too) and still assert one `Failed to wipe run temp dir` warn when the retry fails.

**US-002**
- `packages/nax/test/preload.ts` — add one override, `_runTmpCloseDeps.sweepStaleRunTmpRoots = async () => {}`, beside the existing real-host dep overrides, so the tests that close a real runtime (the shared runtime test helper, the run-setup, plan, bot and runtime suites) never list or sweep the developer's real temp parent.

**US-003**
- `packages/nax/test/unit/config/removed-config-keys.test.ts` — the test "REMOVED_CONFIG_KEYS is exactly the closed set of keys C1 removed" (around line 592) pins the key list; extend the expected list with the 15 new paths and retitle it to the closed set of removed keys.
- `packages/nax/test/unit/config/removed-config-keys-unread.test.ts` — the assertion that `prompts.behavioralGuardrails` produces no warning (around line 212) is replaced: it now produces exactly one removed-key warning with `PIPELINE_ONLY_KEY_HINT`.
- `packages/nax/test/unit/config/migrations.test.ts` — the `migrateLegacyNonBlockingFix` cases are deleted with the shim; the invariant moves to the new removed-key test (one removed-key warning, no deprecation warning).
- `packages/nax/test/unit/config/non-blocking-fix-config.test.ts` — assertions that `review.nonBlockingFix` parses, defaults or is aliased from `review.adversarial.nonBlockingFix` are deleted or inverted: both paths are now stripped with one removed-key warning each.

**US-004**
- `packages/nax/test/unit/cli/rules-lint.test.ts` — the expected warning for a rule with `stages: [not-a-real-stage]` (around line 390) becomes the single ignored-key warning.
- `packages/nax/test/unit/context/engine/providers/static-rules-scoping.test.ts` — cases asserting that a rule is dropped because its `stages` excludes the request stage now assert that the rule is admitted; the `warnOnAppliesToStageContradiction` cases are deleted with the function.
- `packages/nax/test/unit/context/engine/providers/static-rules-sections.test.ts` — AC10/AC11 (around lines 421-470) assert a rule whose `stages` excludes the request stage is removed with its sections; they now assert the rule and its sections are admitted.
- `packages/nax/test/unit/context/engine/providers/static-rules-us002.test.ts` — the real-store stage-scoping block (around lines 587-640, `stage: "plan"`) and the tdd-test-writer/tdd-implementer stage cases (around lines 432-553) assert stage-filtered output; they are deleted or inverted to "rule admitted". The stage-contradiction warning block (around lines 530-575) is deleted with `warnOnAppliesToStageContradiction`.
- `packages/nax/test/unit/context/rules/rules-frontmatter.test.ts` — the unknown-stage-name warning cases (AC8, around line 278) and the "AC9 known stage no warning" cases (around lines 287-300, `stages: ['acceptance-setup']` and `stages: ['decompose']` expecting empty warnings) now each expect exactly the single ignored-key warning; shape-validation errors are unchanged, and `result.stages` assertions stay until US-006.
- `packages/nax/test/unit/context/rules/nax-rules-stage-scoping.test.ts` — deleted: it asserts that `StaticRulesProvider` drops this repo's test-authoring rules for pipeline stages, which no longer happens.
- `docs/guides/static-rules.md` — the `stages:` frontmatter section now says the key is ignored and every rule applies to every session.
- `docs/guides/context-engine.md` — the stage-filter description of the static rules provider is removed.

**US-005**
- `packages/nax/test/integration/cli/cli-plugins.test.ts` — expected built-in plugin listing loses `curator`.
- `packages/nax/test/integration/config/security-loader.test.ts` — curator fixtures removed from config fixtures.
- `packages/nax/test/integration/execution/runner-config-plugins.test.ts` — expected built-in plugin set loses `curator`.
- `packages/nax/test/integration/plugins/config-integration.test.ts` — curator fixtures removed.
- `packages/nax/test/integration/plugins/config-resolution.test.ts` — curator fixtures removed.
- `packages/nax/test/integration/plugins/loader.test.ts` — expected built-in registrations lose `curator`.
- `packages/nax/test/unit/config/auto-pr-config.test.ts` — curator fixture fields removed.
- `packages/nax/test/unit/config/defaults.test.ts` — the default config no longer has a `curator` key.
- `packages/nax/test/unit/context/engine/orchestrator-rebuild.test.ts` — curator references in fixtures/comments removed.
- `packages/nax/test/unit/context/engine/orchestrator.test.ts` — curator references in fixtures/comments removed.
- `packages/nax/test/unit/execution/escalation/tier-escalation-retry-cap.test.ts` — delete the two curator plugin imports, the "AC-6/AC-7 round-trip to collectObservations" describe block and `makeCollectorContext` (its `curatorRollupPath` fixture); keep the escalation-log tests.
- `packages/nax/test/unit/execution/lifecycle/run-cleanup.test.ts` — `curatorRollupPath` option removed from cleanup fixtures and expectations.
- `packages/nax/test/unit/log-format/formatter.test.ts` — curator references in fixtures removed.
- `packages/nax/test/unit/metrics/aggregator.test.ts` — curator references in fixtures removed.
- `packages/nax/test/unit/pipeline/stages/context-rules-fallback.test.ts` — curator references in fixtures removed.
- `packages/nax/test/unit/plugins/extensions.test.ts` — run-end context no longer carries `curatorRollupPath`.
- `packages/nax/test/unit/plugins/registry-resources.test.ts` — curator references removed from registry fixtures.
- `packages/nax/test/unit/runtime/paths.test.ts` — `curatorRollupPath` cases deleted with the function.
- `packages/nax/test/unit/commands/curator.test.ts` — deleted with the command.
- `packages/nax/test/unit/commands/curator-gc.test.ts` — deleted with the command.
- `packages/nax/test/unit/config/curator-config.test.ts` — deleted with the schema.
- `packages/nax/test/unit/plugins/builtin/curator.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-chunk-provider-stale.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-collector.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-collector-metrics.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-collector-rectify.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-heuristics.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-heuristics-h4-h6.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-registration.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-render.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-rollup.test.ts` — deleted with the plugin.
- `packages/nax/test/unit/plugins/builtin/curator-types.test.ts` — deleted with the plugin.
- `packages/nax/scripts/check-worktree-id-ssot.ts` — the two curator file entries (lines 95 and 115) are removed with the files.
- `packages/nax/scripts/baselines/complexity-baseline.json` — curator file entries removed with the files.
- `packages/nax/scripts/baselines/test-escape-hatches-baseline.json` — curator test entries removed with the files.

**US-006**
- `packages/nax/test/integration/execution/lifecycle/run-tmp-wipe.test.ts` — the #2300 suite asserts a dispatched session's temp dir is gone after `cleanupRun`; rewrite it to assert the dir is gone after `runtime.close()` (the new owner), keeping its file path, which the confined integration-hygiene suite lists by name.
- `packages/nax/test/unit/execution/lifecycle/run-cleanup-approvals-seal.test.ts` — `runtimeRunId` removed from the cleanup options fixture.
- `packages/nax/test/unit/execution/lifecycle/run-cleanup-locks.test.ts` — `runtimeRunId` removed from the cleanup options fixture.
- `packages/nax/test/unit/execution/lifecycle/run-cleanup-sandbox.test.ts` — `runtimeRunId` removed from the cleanup options fixture.
- `packages/nax/test/unit/execution/lifecycle/run-cleanup-scratchpad-wipe.test.ts` — `runtimeRunId` removed from the cleanup options fixture.
- `packages/nax/test/unit/config/schemas-review.test.ts` — schema-default cases for `recurrenceDemotion` and `conflictDetection` (around lines 43-69) are deleted with the fields.
- `packages/nax/test/unit/config/schemas-context-fragments.test.ts` — cases for the deleted review fields (around lines 97-128) are deleted.
- `packages/nax/test/unit/config/semantic-review.test.ts` — `recurrenceDemotion`, `demandInspectionTrail` and `acRegroundOnDrop` fixture fields and default assertions are deleted with the fields.
- `packages/nax/test/unit/config/non-blocking-fix-config.test.ts` — deleted with `NonBlockingFixConfigSchema`; the strip behaviour is covered by the US-003 test.
- `packages/nax/test/integration/cli/cli-config-explain.test.ts` — the test "explain output shows the kept prompts.behavioralGuardrails" (around line 55) is deleted with the description entry.
- `packages/nax/test/unit/context/rules/rules-frontmatter.test.ts` — every `result.stages` assertion (around lines 165-197 and 278) is deleted with the field; the ignored-key warning assertions from US-004 stay.
- `packages/nax/test/unit/context/rules/rule-sections.test.ts` — the `section.stages` assertion (around line 163) is deleted with the field.
- `packages/nax/test/unit/context/engine/providers/static-rules-us002.test.ts` — `stages:` fields in `CanonicalRule` fixtures are removed with the field.
- `packages/nax/test/unit/context/engine/providers/static-rules-sections.test.ts` — `stages:` fields in `CanonicalRule` fixtures are removed with the field.
- `docs/guides/hermetic-tests.md` — rewritten: the `quality.testing` keys are removed (warned and stripped at load), and test and mocking policy belongs in a project rules file.
- `packages/nax/test/unit/execution/lifecycle/run-cleanup-run-tmp-wipe.test.ts` — deleted: `cleanupRun` no longer wipes; `runtime.close()` owns the wipe (US-002 tests).
- `packages/nax/test/unit/execution/lifecycle/run-cleanup.test.ts` — the `runtimeRunId` option is removed from cleanup fixtures.
- `packages/nax/test/unit/config/defaults.test.ts` — default config no longer has `prompts`, `quality.testing`, `review.parseRetryMaxAttempts` or `review.conflictDetection`.

## Seams

- US-002 consumes `removeRunTmpTree` (US-001): the sweep removes each stale root through it.
- US-002 AC22 drives this chain end to end with only the two leaf deps stubbed.
- `runtime.close()` (existing outer entry point, reached by `nax run`, `nax bot review`, `nax bot fix`, `nax plan`, `nax setup` and advisor replay) to `_runtimeTmpDeps.closeRunTmp` (US-002) to `_runTmpCloseDeps.wipeRunTmp` and `_runTmpCloseDeps.sweepStaleRunTmpRoots`.

## Acceptance Criteria

### US-001

1. [integration] With a real temp tree `<root>/a/b/file` where `<root>/a/b` has mode `0o500`, calling `removeRunTmpTree(<root>)` resolves and `<root>` no longer exists.
2. [integration] With a real temp tree whose nested directory has mode `0o500`, calling `wipeRunTmp(<runId>)` (with `runTmpRoot` resolving to that tree) leaves no root and records no warn-level log entry.
3. [integration] With a real temp tree holding a nested `0o500` directory (so the first `rm` fails with `EACCES`) and a symlink `<root>/link` to a directory outside `<root>` whose mode is `0o500`, calling `removeRunTmpTree(<root>)` removes `<root>` and the link target's mode is still `0o500` afterwards.
4. [integration] With a real temp tree holding a nested `0o500` directory and a symlink to a directory outside `<root>` that contains a file, `removeRunTmpTree(<root>)` leaves the link target directory and its file in place.
5. [unit] When `_runTmpWipeDeps.remove` rejects first with an error whose `code` is `EACCES` and then resolves, `removeRunTmpTree` calls `remove` exactly twice.
6. [unit] When `_runTmpWipeDeps.remove` rejects first with an error whose `code` is `EPERM`, `removeRunTmpTree` calls `_runTmpWipeDeps.chmod` on each directory the `lstat` walk reports, each with a mode that includes `0o700`.
7. [unit] When the walk's `lstat` reports an entry as a symbolic link, `removeRunTmpTree` never passes that entry's path to `_runTmpWipeDeps.chmod`.
8. [unit] When `_runTmpWipeDeps.remove` rejects first with an error whose `code` is `ENOTDIR`, `removeRunTmpTree` rejects with that error and calls `remove` exactly once.
9. [unit] When `_runTmpWipeDeps.remove` rejects with `EACCES` on both calls, `removeRunTmpTree` rejects with the second error.
10. [unit] When `_runTmpWipeDeps.chmod` rejects for one directory during the walk, `removeRunTmpTree` still calls `remove` a second time.
11. [unit] When `_runTmpWipeDeps.remove` rejects with `EACCES` on both calls, `wipeRunTmp` resolves, has called `remove` exactly twice, and logs one warn entry whose message is `Failed to wipe run temp dir <path> — continuing`.
12. [unit] When `_runTmpWipeDeps.remove` rejects first with `EACCES` and `_runTmpWipeDeps.readdir` rejects for one directory during the walk, `removeRunTmpTree` still calls `remove` a second time.

### US-002

1. [unit] `STALE_RUN_TMP_MAX_AGE_MS` imported from `execution/lifecycle/run-tmp-sweep` equals `172800000`.
2. [unit] `sweepStaleRunTmpRoots({ currentRunId: "cur", now, maxAgeMs })` lists the directory `dirname(runTmpRoot("cur"))` through `_runTmpSweepDeps.readdir`.
3. [unit] When the parent holds a directory whose own `mtimeMs` and every direct child's `mtimeMs` are older than `now - maxAgeMs`, `sweepStaleRunTmpRoots` passes that directory's path to `_runTmpSweepDeps.remove`.
4. [unit] When the parent holds an old directory with one direct child whose `mtimeMs` is newer than `now - maxAgeMs`, `sweepStaleRunTmpRoots` does not pass that directory to `_runTmpSweepDeps.remove`.
5. [unit] When the parent holds an old directory whose name equals `basename(runTmpRoot(currentRunId))` for a `currentRunId` containing a character `runTmpRoot` sanitises (for example `a/b`), `sweepStaleRunTmpRoots` does not pass it to `_runTmpSweepDeps.remove`.
6. [unit] When `_runTmpSweepDeps.lstat` reports a parent entry as a symbolic link, `sweepStaleRunTmpRoots` does not pass it to `_runTmpSweepDeps.remove`.
7. [unit] When `_runTmpSweepDeps.lstat` reports a parent entry as a regular file, `sweepStaleRunTmpRoots` does not pass it to `_runTmpSweepDeps.remove`.
8. [unit] When `_runTmpSweepDeps.readdir` rejects with `ENOENT`, `sweepStaleRunTmpRoots` resolves without logging at warn.
9. [unit] When `_runTmpSweepDeps.readdir` rejects with `EACCES`, `sweepStaleRunTmpRoots` resolves and logs exactly one warn entry.
10. [unit] When `_runTmpSweepDeps.remove` rejects for the first of two stale directories, `sweepStaleRunTmpRoots` still passes the second to `remove` and logs one warn entry whose message starts with `Failed to sweep stale run temp dir`.
11. [unit] The default `_runTmpSweepDeps.remove` is `removeRunTmpTree` from `execution/lifecycle/run-tmp-wipe`.
12. [unit] `closeRunTmp({ runId: "r1", dryRun: false })` calls `_runTmpCloseDeps.wipeRunTmp` with `"r1"` before it calls `_runTmpCloseDeps.sweepStaleRunTmpRoots`.
13. [unit] `closeRunTmp({ runId: "r1", dryRun: false })` calls `_runTmpCloseDeps.sweepStaleRunTmpRoots` with `currentRunId: "r1"`, `maxAgeMs: STALE_RUN_TMP_MAX_AGE_MS` and `now` equal to the value `_runTmpCloseDeps.now()` returns.
14. [unit] `closeRunTmp({ runId: "r1", dryRun: true })` calls neither `_runTmpCloseDeps.wipeRunTmp` nor `_runTmpCloseDeps.sweepStaleRunTmpRoots`.
15. [unit] When `_runTmpCloseDeps.sweepStaleRunTmpRoots` rejects, `closeRunTmp` resolves and logs one warn entry.
16. [unit] When `_runTmpCloseDeps.wipeRunTmp` rejects, `closeRunTmp` still calls `_runTmpCloseDeps.sweepStaleRunTmpRoots`.
17. [unit] With `_runtimeTmpDeps.closeRunTmp` stubbed, `createRuntime(config, workdir)` followed by `runtime.close()` calls the stub once with `{ runId: runtime.runId, dryRun: false }`.
18. [unit] With `_runtimeTmpDeps.closeRunTmp` stubbed, calling `runtime.close()` twice on one runtime calls the stub exactly once.
19. [unit] With `_runtimeTmpDeps.closeRunTmp` stubbed, `createRuntime(config, workdir, { dryRun: true })` followed by `runtime.close()` calls the stub with `dryRun: true`.
20. [unit] With `_runtimeTmpDeps.closeRunTmp` stubbed and the runtime's MCP pool `close` rejecting, `runtime.close()` still calls the stub once.
21. [unit] With `_runtimeTmpDeps.closeRunTmp` stubbed and a run memory passed in `opts.memory`, `runtime.close()` calls the stub after the memory's `close`.
22. [unit] With `_runtimeTmpDeps.closeRunTmp` left as its default and only `_runTmpCloseDeps.wipeRunTmp` and `_runTmpCloseDeps.sweepStaleRunTmpRoots` stubbed, `createRuntime(config, workdir)` followed by `runtime.close()` calls `wipeRunTmp` with `runtime.runId` and calls `sweepStaleRunTmpRoots` with `currentRunId: runtime.runId`.

### US-003

1. [unit] Loading a raw config `{ curator: { enabled: true } }` through `stripRemovedConfigKeys` with a warn sink yields a result with no `curator` key and exactly one warning equal to `Config key "curator" has been removed — ${CURATOR_REMOVED_HINT}. Remove it from your config.`
2. [unit] `CURATOR_REMOVED_HINT` imported from `config/removed-config-keys` equals `the curator feature was removed; nax no longer writes ~/.nax/global/curator, which is safe to delete`.
3. [unit] Loading `{ quality: { testing: { hermetic: true, mockGuidance: "x" } } }` through `stripRemovedConfigKeys` yields a `quality` object with no `testing` key and exactly one warning naming `quality.testing` with `TESTING_POLICY_HINT`.
4. [unit] `TESTING_POLICY_HINT` equals `nothing reads this key since pipeline mode was removed; state test and mocking policy in a .nax/rules file`.
5. [unit] Loading `{ prompts: { behavioralGuardrails: "strict" } }` through `stripRemovedConfigKeys` yields exactly one warning naming `prompts.behavioralGuardrails` with `PIPELINE_ONLY_KEY_HINT`.
6. [unit] Loading `{ review: { nonBlockingFix: { enabled: true } } }` through `stripRemovedConfigKeys` yields a `review` object with no `nonBlockingFix` key and exactly one warning naming `review.nonBlockingFix`.
7. [unit] Loading `{ review: { parseRetryMaxAttempts: 5, conflictDetection: { maxOscillations: 3 } } }` through `stripRemovedConfigKeys` yields exactly two warnings, one naming `review.parseRetryMaxAttempts` and one naming `review.conflictDetection`.
8. [unit] Loading a `review.semantic` object that sets `demandInspectionTrail`, `acRegroundOnDrop` and `recurrenceDemotion` through `stripRemovedConfigKeys` yields exactly three warnings, one per `review.semantic.<key>` path.
9. [unit] Loading a `review.adversarial` object that sets `demandInspectionTrail`, `acRegroundOnDrop`, `recurrenceDemotion`, `parallel` and `maxConcurrentSessions` through `stripRemovedConfigKeys` yields exactly five warnings, one per `review.adversarial.<key>` path.
10. [unit] Loading `{ review: { adversarial: { enabled: true, parallel: true } } }` through `stripRemovedConfigKeys` keeps `review.adversarial.enabled` equal to `true`.
11. [integration] Loading a project config file that sets `review.adversarial.nonBlockingFix: { enabled: true }` through the config loader produces exactly one warning naming `review.adversarial.nonBlockingFix` with `PIPELINE_ONLY_KEY_HINT`.
12. [integration] Loading a project config file that sets `review.adversarial.nonBlockingFix` through the config loader produces no warning containing `is deprecated`.
13. [integration] Loading a project config file that sets `curator: { enabled: true }` and `disabledPlugins: ["curator"]` through the config loader produces exactly one removed-key warning naming `curator`, and the resolved `disabledPlugins` still equals `["curator"]`.

### US-004

1. [unit] `StaticRulesProvider` given a request with `stage: "context"` and a merged rule whose frontmatter declares `stages: [review]` (no `appliesTo`) includes that rule's content in its returned chunks.
2. [unit] `StaticRulesProvider` given a request with `stage: "context"` and a rule declaring `stages: [regression, acceptance-setup]` (no `appliesTo`) includes that rule's content in its returned chunks.
3. [unit] Parsing frontmatter `stages: [review]` through the canonical rules parser yields `warnings` containing exactly one entry equal to `Frontmatter key "stages" is ignored — rules apply to every session. Remove it from the frontmatter.`
4. [unit] Parsing frontmatter `stages: [not-a-real-stage, review]` yields exactly one stages-related warning, the ignored-key warning, and no warning starting with `Unknown stage name`.
5. [cli] `nax rules lint` on a rules directory holding one rule with `stages: [review]` prints the ignored-key warning for that rule's file.

### US-005

1. [unit] `loadPlugins` with no disabled list returns a registry whose loaded plugin names do not include `curator`.
2. [unit] `loadPlugins` with `disabledPlugins: ["curator"]` resolves and logs no info entry starting with `Skipping disabled plugin: 'curator'`.
3. [cli] Running `nax curator status` exits with code 1, because no `curator` command is registered and the default `chat` command rejects the extra arguments.
4. [unit] The object `createRuntime(config, workdir)` returns has no own property `curatorRollupPath`.

### US-006

1. [unit] `NaxConfigSchema.parse({})` yields a config whose `review` object has no own property `conflictDetection`.
2. [unit] `NaxConfigSchema.parse({})` yields a config whose `review` object has no own property `parseRetryMaxAttempts`.
3. [unit] `NaxConfigSchema.parse({})` yields a config with no own property `prompts`.
4. [unit] `NaxConfigSchema.parse({})` yields a config whose `quality` object has no own property `testing`.
5. [integration] With a directory created at `runTmpRoot(options.runId)` and `cleanupRun(options)` called with complete options, the directory still exists afterwards; removal belongs to `runtime.close()`.

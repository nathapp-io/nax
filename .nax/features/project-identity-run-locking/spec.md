<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Project identity by remote, and feature-scoped run locking

## Summary

`nax run -f <feature>` from a git worktree of an already-initialized project aborts with
`RUN_NAME_COLLISION`, because `claimProjectIdentity` matches an existing project identity by
exact `workdir` string and never compares the `remoteUrl` it stores, while `nax init` compares
the remote and accepts the same case. This feature makes worktrees of one repository one
project, and makes the concurrency that unlocks safe: a run lock keyed on `(project, feature)`
serializes the same feature across checkouts while the existing checkout lock keeps one run per
checkout, run records say which checkout wrote them, and the one project-level reader that would
otherwise adopt another run's data fails closed.

## Motivation

`.nax/config.json` is tracked, so every worktree carries the same `name` and derives the same
`projectKey`. `claimProjectIdentity` (`src/runtime/paths.ts:75-101`) throws whenever
`existing.workdir !== workdir`, so a worktree's differing path reads as a collision even though
the `remoteUrl` it already persists is identical. `checkInitCollision` (`src/cli/init.ts:69-79`)
computes `sameRemote` at `:77` and accepts it. The two paths disagree about what "the same
project" means, and the only workaround today is `nax migrate --merge`, which fixes the worktree
by breaking the main checkout.

Relaxing that guard alone is unsafe, because the guard is the only thing preventing concurrent
same-project runs. `acquireLock` (`src/execution/lock.ts:62-64`) locks `<workdir>/nax.lock`, so
two checkouts have no mutual exclusion at all over the `~/.nax/<projectKey>/` tree they share.

One project-level reader already falls back positionally. `collectFromMetrics`
(`src/plugins/builtin/curator/collect.ts:113`) resolves this run's entry as
`runs.find(r => r.runId === context.runId) ?? runs.at(-1)`. `metrics.json` is a project-level
append shared by every feature, locked across processes through `withPathFileLock`
(`src/metrics/tracker.ts:20`), so both features' entries coexist and under concurrency that
fallback attributes another feature's stories to this run's observations, which feed the curator
rollup and its rule proposals. The sibling reader `collectFromReviewAudit`
(`src/plugins/builtin/curator/collect.ts:209`) already guards this case by feature name and time
window at `:220-227`, citing #1422 — the class was anticipated, and one reader was missed.

## Design

Worktrees of one repository become one project, matched by normalized `origin` remote, and
concurrency is gated by feature: different features run concurrently across checkouts, the same
feature is serialized, and one checkout still runs one nax at a time.

**Merge order.** This feature must land after the `worktree-branch-identity` feature. That one
makes story worktree branches feature-scoped; without it, the concurrency this feature legalizes
lets two checkouts collide on the branch `nax/US-001`.

### Locking model

Two non-blocking try-locks, both required. Neither ever waits, so no wait cycle between them can
form.

| Lock | Path | Guarantees |
|:--|:--|:--|
| Checkout (exists today) | `<workdir>/nax.lock` | one run per checkout |
| Feature (new) | `<outputDir>/features/<feature>/nax.lock` | one run per feature across checkouts |

- **Fixed acquisition order: checkout, then feature.** A single global order is what keeps the
  two from blocking each other: two same-checkout processes cannot each take one lock and both
  abort, because the loser is refused at the checkout lock and never reaches the feature lock.
  Release runs in reverse.
- **A partial acquire never leaks.** A refused feature lock releases the checkout lock before the
  error escapes, and so does any failure during post-lock initialization — `releaseLock` has two
  call sites, `src/execution/lifecycle/run-cleanup.ts:332` and the FIX-H16 inner catch at
  `src/execution/lifecycle/run-setup-init.ts:237`, and both must release both locks. A leaked
  feature lock is project-level and would block that feature from every checkout until it ages
  out.
- **Exactly one acquisition per run.** `setupRun` is the only acquire site, and it runs once per
  run, upstream of story execution. Story worktrees under `--parallel` never re-enter it:
  `runParallelBatch` (`src/execution/parallel-batch.ts:121`) receives an already-built context
  and dispatches to `runPipeline` directly (`src/execution/parallel-worker.ts:92`).

**One staleness predicate, shared.** `feature-lock.ts` exports `isLockStale(record, now)`, and
both `acquireFeatureLock` and `checkStaleLock` use it, so "stale" means one thing:

| Record | Verdict |
|:--|:--|
| `host` is this machine, PID alive | **not stale**, regardless of age |
| `host` is this machine, PID not alive | **stale** |
| `host` absent (written before this feature, or by an older binary) | treated as **this machine**, so the PID rule above applies |
| `host` is another machine, age < 2 hours | **not stale** — a PID number from another host is meaningless, so liveness cannot be evaluated |
| `host` is another machine, age ≥ 2 hours | **stale** |

Two hours is the existing threshold at `src/precheck/checks-config.ts:46`
(`holderAlive || ageMs < twoHoursMs`); this predicate generalizes that rule rather than
introducing a second one. `host` is `os.hostname()`, compared case-insensitively, written by one
exported helper so both lock writers produce identical values.

**Lock record shapes.** The feature-lock record carries `pid`, `host`, `workdir`, `feature`,
`runId`, `startedAt` and `timestamp`. The checkout-lock record keeps its existing `pid` and
`timestamp` and gains `host`; it gains nothing else.

**Refusals carry the holder.** Both acquire functions return a result that names the current
holder on refusal, rather than a bare boolean — the error messages require holder data that a
boolean cannot carry, and re-reading the lock file after a failed acquire would race.

**Release verifies ownership.** `releaseFeatureLock` unlinks only when the on-disk record's
`runId` is the caller's. Without that check the hazard is live under this very design: run A's
lock is judged stale and reclaimed by run B, then A reaches cleanup and deletes B's lock while B
still runs. The repository already guards this shape twice — the BUG-34 re-verify at
`src/execution/lock.ts:110-160`, and the TOCTOU guard at `src/commands/unlock.ts:74-86`.

**Injection points.** Three seams are added so the new calls can be observed without
`mock.module()`, which `.nax/rules/forbidden-patterns-source.md:31` bans: `_runSetupDeps`
(`src/execution/lifecycle/run-setup.ts:62-67`) gains `acquireLock` and `acquireFeatureLock`;
`src/precheck/index.ts` gains a `_precheckDeps` object holding `checkStaleLock`; and
`src/commands/resume.ts` receives its run ID rather than generating one, so no seam is needed
there. This mirrors the existing `_lockDeps.rename` seam at `src/execution/lock.ts:20`.

**Logger.** `src/execution/lock.ts:24-30` declares a private `getSafeLogger`; five other modules
do the same. The shared export lives at `src/logger` (`src/logger/index.ts:10`), and the new
module uses it rather than adding a seventh copy.

### Run identity

`buildRunId(workdir, now)` is the single producer. Its workdir component is an 8-character
lowercase base36 hash of the absolute working directory — not the basename, which would collide
for the common `git worktree add ../repo-feat` topology where two checkouts share a trailing
name. The result contains no path separator, because it is interpolated into filenames and
directory names at more than ten sites, including `${project}-${feature}-${runId}` as a directory
at `src/pipeline/subscribers/registry.ts:53`.

Two sites generate a run ID today: `src/execution/runner.ts:176` (the run's identity) and
`src/commands/resume.ts:201` (only a log filename, at second resolution). They currently
disagree, so a resumed run's log file is named differently from the run it records. `run()` gains
an optional `runId`; `nax resume` builds one and passes it, so `buildRunId` is called once per
resumed run and the log file matches the run.

### Project-level read surface

The audit below was completed while drafting this spec; US-006 fixes the one defect it found and
guards the two shapes that must not be "fixed".

| Reader | Shape | Disposition |
|:--|:--|:--|
| `src/plugins/builtin/curator/collect.ts:113` | identity match with positional fallback | **defect** — fail closed |
| `src/plugins/builtin/curator/collect.ts:209` | feature + time-window guard (#1422) | correct; reference pattern |
| `src/metrics/aggregator.ts:194` | `getLastRun` returns the final element | deliberate latest-run semantics; leave intact |
| `src/pipeline/subscribers/registry.ts:53` | `<project>-<feature>-<runId>` directory | keyed; safe |
| `src/cli/status-features.ts:249-287` | prints `projectStatus.run.feature` from the record it read | already correct; no fallback to fix |
| `src/metrics/tracker.ts:20` | cross-process locked append | writer, not a reader; safe |

### Integration

Read-only symbols, verified present at their stated shapes:

- `isProcessAlive(pid: number): boolean` — `src/utils/process-alive.ts:43`.
- `projectOutputDir(projectKey, outputDirOverride): string` — `src/runtime/paths.ts:18`; the
  `loadConfig` → `config.name?.trim() || basename(workdir)` → `projectOutputDir` chain is
  open-coded at `src/commands/resume.ts:191-192` and `src/execution/lifecycle/run-setup.ts:327`.
- `readProjectIdentity(projectKey)` — `src/runtime/paths.ts:43`;
  `writeProjectIdentity(projectKey, identity)` — `:63`.
- `_lockDeps.rename` — `src/execution/lock.ts:20`; the injectable seam that lets a test drive the
  stale-reclaim race deterministically.
- `getLastRun(runs: RunMetrics[]): RunMetrics | null` — `src/metrics/aggregator.ts:194`.
- `StatusWriterContext` — `src/execution/status-writer.ts:28-41`; carries `runId`, `feature`,
  `startedAt`, `dryRun`, `startTimeMs`, `pid` into every snapshot. It is the only route by which
  a fixed `run.*` field reaches `buildStatusSnapshot` (`src/execution/status-file.ts:315-328`),
  and its sole construction site is `src/execution/lifecycle/run-setup.ts:173-180`, where
  `workdir` is already in scope from `:142`.

Mutated symbols. The baseline exists to locate the code; the target is the interface to
implement.

**`tryExclusiveCreate`** — `src/execution/lock.ts:38`

- Baseline: `async function tryExclusiveCreate(targetPath, content)` — module-private, not
  exported and not re-exported by `src/execution/helpers/index.ts:26` or
  `src/execution/index.ts:37`.
- Target: exported, so the feature lock reuses its `O_CREAT | O_EXCL` semantics rather than
  copying them.

**`acquireLock`** — `src/execution/lock.ts:62`

- Baseline: `acquireLock(workdir: string): Promise<boolean>`; the holding PID is read at `:88`
  and discarded, and the record written at `:170-173` is `{ pid, timestamp }`.
- Target: returns a result that is either an acquired outcome or a refusal naming the holder's
  `pid` and `host`. The written record gains `host`.

**`LockAcquisitionError`** — `src/errors.ts:62`

- Baseline: `new LockAcquisitionError(workdir)`, message `"Another nax process is already running
  in this directory"`, context `{ workdir }`, code `LOCK_ACQUISITION_FAILED`.
- Target: two distinguishable refusals. The checkout refusal names the checkout and the holding
  PID; the feature refusal names the feature, the holder's workdir, host and PID. Both keep the
  `LOCK_ACQUISITION_FAILED` code.

**`checkStaleLock`** — `src/precheck/checks-config.ts:11`

- Baseline: `checkStaleLock(workdir: string): Promise<Check>`.
- Target: `checkStaleLock(workdir: string, featureLock?: { outputDir: string; feature: string })`.
  With the argument it applies `isLockStale` to both locks and names whichever are stale; without
  it, it checks the checkout lock only, exactly as today.

**`getEarlyEnvironmentBlockers`** — `src/precheck/index.ts:134`

- Baseline: `getEarlyEnvironmentBlockers(workdir: string): CheckFn[]`, calling
  `checkStaleLock(workdir)` at `:135`.
- Target: `getEarlyEnvironmentBlockers(workdir: string, featureLock?: { outputDir: string;
  feature: string }): CheckFn[]`, forwarding the argument through `_precheckDeps.checkStaleLock`.

**`PrecheckOptions`** — `src/precheck/index.ts:102-109`

- Baseline: `{ format?, workdir, silent? }` — no output directory and no feature, which is why
  neither `runPrecheck` (`:278`) nor `runEnvironmentPrecheck` (`:219`) can supply one today.
- Target: gains an optional `featureLock?: { outputDir: string; feature: string }`, supplied by
  `src/execution/lifecycle/precheck-runner.ts:49-53`, which already holds the feature and runs
  after `run-setup.ts:327` computes the project key. `src/commands/precheck.ts:87-90` omits it and
  keeps today's checkout-only behaviour.

**`unlockCommand`** — `src/commands/unlock.ts:37`

- Baseline: `unlockCommand(options: UnlockOptions)` with `{ dir?, force? }`, resolving
  `<workdir>/nax.lock` only, and returning early at `:43-48` when that file is absent.
- Target: `UnlockOptions` gains an optional `feature`. The output directory is derived by the
  same `loadConfig` → `projectOutputDir` chain `src/commands/resume.ts:191-192` uses. With a
  feature, the command resolves that feature's lock. Without one, it reports the checkout lock
  and every `<outputDir>/features/*/nax.lock` it finds — the scan runs whether or not a checkout
  lock exists — removing only those `isLockStale` accepts. `--force` overrides the staleness
  check for both kinds, as it already does for the checkout lock at `:64-69` and `:79`.

**`claimProjectIdentity`** — `src/runtime/paths.ts:75`

- Baseline: throws `RUN_NAME_COLLISION` whenever `existing.workdir !== workdir`.
- Target: same signature. When `existing.workdir !== workdir` and `isSameProject` holds, it
  refreshes `lastSeen`, leaves the stored `workdir` at the registered value, and returns.
  Otherwise `RUN_NAME_COLLISION` is unchanged.

**`checkInitCollision`** — `src/cli/init.ts:69`

- Baseline: two local predicates — `sameRemote` on raw string equality at `:77`, and `sameWorkdir`
  at `:78`, which returns no-collision when both remotes are absent (null or empty — it is a
  falsy check) and the workdirs match.
- Target: same signature; `sameRemote` is replaced by `isSameProject`, and the `sameWorkdir`
  branch is retained unchanged.

**`NaxStatusFile.run`** — `src/execution/status-file.ts:105-127`

- Baseline: `{ id, feature, startedAt, status, dryRun, pid, crashedAt?, crashSignal? }`.
- Target: the same plus an optional `workdir: string`, carried in through `StatusWriterContext`.
  Readers tolerate its absence in files written before this change.

**`run`** — `src/execution/runner.ts:176`

- Baseline: generates `` `run-${iso}` `` internally; its options object has no `runId`.
- Target: accepts an optional `runId` and generates one through `buildRunId` when absent.

**`isSameProject`** (new) — `src/runtime/same-project.ts`

- Signature: `isSameProject(remoteA: string | null, remoteB: string | null): boolean`. It compares
  two remotes, not identity records; callers pass `identity.remoteUrl` as the second argument.

### Failure Handling

| Condition | Behavior |
|:--|:--|
| Feature lock held, and `isLockStale` rejects the record | Refuse the run; the error names the feature, the holder's workdir, host and PID. |
| Feature lock refused after the checkout lock was taken | The checkout lock is released before the error escapes. |
| Post-lock initialization fails after both locks are held | Both locks are released before the error escapes. |
| Lock file present but unparseable | Logged at warn level, treated as stale, and removed, matching the existing checkout-lock behaviour. |
| On-disk record's `runId` is not the releasing run's | The file is left in place; the release is a no-op. |
| `metrics.json` holds no entry matching this run's `runId` | Log at warn level and return no metrics-derived observations; never fall back to another entry. |
| `git remote get-url origin` fails, or the project is not a git repository | `remoteUrl` stays null and identity falls back to exact workdir equality. This is existing behaviour at `src/execution/lifecycle/run-setup.ts:319-326` and needs no change. |

## Out of Scope

- Feature-scoped story worktree branch naming is delivered by the `worktree-branch-identity`
  feature, which must merge before this one.
- Running the same feature concurrently from two checkouts stays refused; the feature lock exists
  to refuse it.
- Running two different features concurrently from the same checkout stays refused by the
  checkout lock.
- Retiring or removing `<workdir>/nax.lock`, and removing the `nax.lock` entry from `.gitignore`,
  are not part of this feature.
- Repositories whose `origin` remotes differ after normalization, including forks, still produce
  `RUN_NAME_COLLISION`; merging distinct remotes into one project is not delivered.
- `<outputDir>/status.json` stays last-writer-wins across concurrent different-feature runs; a
  per-feature project-level status file is not delivered.
- Readers of feature-scoped state under `<outputDir>/features/<feature>/` are not audited,
  because the feature lock serializes every writer of that subtree.
- The project-level directories `cost/`, `usage/`, `prompt-audit/`, `tool-audit/`,
  `finish-audit/`, `cycle-shadow/` and `mcp/` were not audited for concurrency safety; only the
  readers listed in the Design's read-surface table were examined.
- Changing `nax migrate --reclaim` or `--merge` semantics is not part of this feature.
- Reclaiming a lock held on another host by any signal other than age is not delivered; there is
  no cross-host liveness channel.
- Rewriting run IDs already recorded in the old format is not part of this feature; only newly
  generated run IDs carry the workdir component.

## Stories

**US-001 — Feature lock primitive**
`featureLockPath`, `acquireFeatureLock`, `releaseFeatureLock` and the shared `isLockStale`
predicate, over a record carrying the holder, reusing the checkout lock's exclusive-create and
stale-reclaim guarantees and verifying ownership before release. No dependencies.

**US-002 — Run lifecycle holds both locks**
Acquire the checkout lock then the feature lock in `setupRun`, release both in reverse at both
release sites, add `host` to the checkout record, and split `LockAcquisitionError` into two
refusals that name their holder. Depends on US-001.

**US-003 — Lock tooling sees both locks**
`nax unlock` gains an optional feature and a scan; `checkStaleLock` gains an optional feature
lock, threaded from the run's precheck and omitted on the environment-precheck path that has no
feature. Depends on US-001.

**US-004 — Project identity matched by remote**
One `isSameProject` predicate with remote normalization, shared by `claimProjectIdentity` and
`checkInitCollision`. Depends on US-002: this is the story that legalizes concurrency, and it
must not land before the locks that make it safe.

**US-005 — Run attribution across checkouts**
Stamp `run.workdir` into the status file through `StatusWriterContext`, and build run IDs in one
place with a workdir hash, called once per run including on the resume path. No dependencies.

**US-006 — The curator metrics reader fails closed**
Replace the positional fallback with a fail-closed match, and guard the two shapes that must not
change. Depends on US-004.

### Context Files

**US-001**

- `src/execution/lock.ts` — the checkout lock, its BUG-07/BUG-34 stale-reclaim race handling, and the exclusive-create helper to export and reuse
- `src/utils/process-alive.ts` — the liveness check
- `src/runtime/paths.ts` — the project output directory the lock path is built from
- `src/precheck/checks-config.ts` — the existing two-hour rule this predicate generalizes
- `src/commands/unlock.ts` — the existing TOCTOU re-verify pattern for ownership on delete

**US-002**

- `src/execution/lifecycle/run-setup.ts` — the single acquire site and its `_runSetupDeps`
- `src/execution/lifecycle/run-setup-init.ts` — the FIX-H16 inner catch that releases on init failure
- `src/execution/lifecycle/run-cleanup.ts` — the always-release site
- `src/errors.ts` — the error class to split
- `src/execution/feature-lock.ts` — created by US-001, consumed here

**US-003**

- `src/commands/unlock.ts` — the unlock command
- `src/precheck/checks-config.ts` — the stale-lock precheck
- `src/precheck/index.ts` — the options type and the two entry points that compose the early blockers
- `src/execution/lifecycle/precheck-runner.ts` — the run's precheck caller, which holds the feature
- `src/commands/resume.ts` — the open-coded output-directory derivation to mirror

**US-004**

- `src/runtime/paths.ts` — `claimProjectIdentity` and the identity record
- `src/cli/init.ts` — the remote comparison to replace, and the falsy-remote branch to keep
- `src/commands/migrate.ts` — the reclaim and merge flows that read the same identity

**US-005**

- `src/execution/status-file.ts` — the status snapshot shape and its builder
- `src/execution/status-writer.ts` — the context type that carries fixed run fields
- `src/execution/runner.ts` — run ID generation and the options object
- `src/commands/resume.ts` — the resume path's separate run ID derivation
- `src/execution/lifecycle/run-setup.ts` — the sole status-writer construction site

**US-006**

- `src/plugins/builtin/curator/collect.ts` — the positional fallback and the correctly-guarded sibling reader
- `src/metrics/aggregator.ts` — deliberate latest-run semantics that must survive
- `src/metrics/tracker.ts` — the cross-process locked append that keeps entries coexisting

### Creates

**US-001**

- `src/execution/feature-lock.ts` — feature-lock path, acquire, release, and the shared staleness predicate

**US-004**

- `src/runtime/same-project.ts` — the shared identity predicate and remote normalization

**US-005**

- `src/execution/run-id.ts` — the single run-ID builder

### Modifies

**US-001**

- `src/execution/lock.ts` — `tryExclusiveCreate` is module-private at line 38; it must be exported so the feature lock reuses its exclusive-create and BUG-34 restore semantics instead of copying them.

**US-002**

- `test/unit/errors.test.ts` — asserts LockAcquisitionError's exact message by equality and its whole context object by exact-object equality; both are closed-world, and the refusal now carries the holder's PID, so the assertions must allow a context holding both workdir and pid instead of exactly one key.
- `test/unit/execution/helpers.test.ts` — asserts `acquireLock`'s boolean result and the written record's fields; the result becomes a holder-carrying object and the record gains host, so the assertions must read the new shapes.
- `test/unit/utils/utils-helpers.test.ts` — asserts `acquireLock`'s boolean result by identity at four sites; the result becomes a holder-carrying object, so those assertions must read the acquired-or-refused discriminator instead of true and false.

**US-003**

- `test/unit/precheck/precheck-checks-tier1-blockers.test.ts` — calls `checkStaleLock` with a single argument and asserts checkout-lock outcomes; those calls stay valid against the optional second parameter, and the suite must add the feature-lock cases the new argument introduces.
- `test/unit/commands/unlock.test.ts` — asserts the command resolves exactly one lock path and exits early when it is absent; the scan now runs regardless, so the assertions must cover both lock kinds.

**US-005**

- `test/unit/execution/status-writer-finish.test.ts` — constructs a status-writer context without a workdir; the context type gains the field that carries `run.workdir`, so the fixtures must supply it.

### Seams

- `[unit]` set `_runSetupDeps.acquireLock` and `_runSetupDeps.acquireFeatureLock` to recording doubles; invoke `setupRun` for a feature; assert `acquireFeatureLock` was recorded exactly once and after `acquireLock`.
- `[unit]` set `_runSetupDeps.acquireFeatureLock` to a recording double; invoke `setupRun` for a run configured with three parallel stories; assert `acquireFeatureLock` was recorded exactly once.
- `[unit]` set `_precheckDeps.checkStaleLock` to a recording double; invoke `runPrecheck` for a feature; assert it was recorded once with the run's feature and output directory.
- `[unit]` stub `featureLockPath` through the feature-lock module's own deps seam; invoke `acquireFeatureLock`; assert it was called once with the output directory and the feature.

## Acceptance Criteria

### US-001 — Feature lock primitive

- `[unit]` `featureLockPath(outputDir, "f")` returns the path `<outputDir>/features/f/nax.lock`.
- `[unit]` `acquireFeatureLock` writes a record whose `pid`, `host`, `workdir`, `feature`, `runId` and `startedAt` fields are all populated.
- `[unit]` `acquireFeatureLock` writes a `host` equal to the machine's hostname.
- `[unit]` `isLockStale` returns `false` for a record whose `host` matches this machine and whose PID is alive, at an age beyond two hours.
- `[unit]` `isLockStale` returns `true` for a record whose `host` matches this machine and whose PID is not alive.
- `[unit]` `isLockStale` returns `true` for a record with no `host` field whose PID is not alive.
- `[unit]` `isLockStale` returns `false` for a record whose `host` differs from this machine, is younger than two hours, and whose PID is not alive locally.
- `[unit]` `isLockStale` returns `true` for a record whose `host` differs from this machine and is older than two hours.
- `[unit]` `isLockStale` compares `host` case-insensitively.
- `[unit]` `acquireFeatureLock` returns a refusal for the same output directory and feature from a different working directory while `isLockStale` rejects the record.
- `[unit]` the refusal returned by `acquireFeatureLock` carries the holder's `pid`, `host` and `workdir` read from the existing record.
- `[unit]` `acquireFeatureLock` returns an acquired result for a different feature in the same output directory while the first feature's lock is held.
- `[unit]` `acquireFeatureLock` logs at warn level and replaces a lock file whose contents do not parse.
- `[unit]` `acquireFeatureLock` creates the lock file with an exclusive create, so a second call running after the file appears returns a refusal rather than overwriting it.
- `[unit]` when two `acquireFeatureLock` calls both observe the same stale record and the injected rename seam lets only one claim it, exactly one returns an acquired result.

### US-002 — Run lifecycle holds both locks

- `[unit]` `setupRun` calls `acquireLock` before `acquireFeatureLock`.
- `[unit]` when `acquireFeatureLock` refuses, `setupRun` leaves no `nax.lock` file in the working directory.
- `[unit]` when `acquireLock` refuses, `setupRun` throws an error whose message names the working directory and the holding PID.
- `[unit]` when `acquireFeatureLock` refuses, `setupRun` throws an error whose message names the feature, the holder's working directory, the holder's host and the holding PID.
- `[unit]` both refusals carry the code `LOCK_ACQUISITION_FAILED`.
- `[unit]` when post-lock initialization fails, neither the checkout lock file nor the feature lock file remains.
- `[unit]` run cleanup releases the feature lock before it releases the checkout lock.
- `[unit]` after run cleanup completes, neither the checkout lock file nor the feature lock file exists.
- `[unit]` `releaseFeatureLock` leaves the lock file in place when the on-disk record's `runId` is not the releasing run's.
- `[unit]` `releaseFeatureLock` resolves without error when the lock file is already absent.
- `[unit]` the checkout lock record written by `acquireLock` carries `host` alongside `pid` and `timestamp`.
- `[unit]` `acquireLock` acquires and replaces a checkout-lock record that has no `host` field and whose recorded PID is not alive.

### US-003 — Lock tooling sees both locks

- `[cli]` `nax unlock -f <feature>` exits `0` and removes `<outputDir>/features/<feature>/nax.lock`.
- `[cli]` `nax unlock` with no feature exits `0` and removes the checkout lock.
- `[cli]` `nax unlock` with no feature reports a feature lock that `isLockStale` rejects and leaves it in place.
- `[cli]` `nax unlock` with no feature runs the feature-lock scan and reports what it finds even when no checkout lock exists.
- `[cli]` `nax unlock --force` with no feature removes a feature lock that `isLockStale` rejects.
- `[unit]` `checkStaleLock` called with a feature lock argument returns a failed check naming the feature lock when `isLockStale` accepts only the feature lock's record.
- `[unit]` `checkStaleLock` called with a feature lock argument returns a failed check naming both locks when `isLockStale` accepts both records.
- `[unit]` `checkStaleLock` called without a feature lock argument passes when the checkout lock is absent, even when a stale feature lock exists.
- `[unit]` `checkStaleLock` returns a passed check when neither lock file exists.
- `[unit]` `runEnvironmentPrecheck` composes its early blockers without a feature lock argument.
- `[unit]` the run's precheck caller passes the run's feature and output directory through to `checkStaleLock`.

### US-004 — Project identity matched by remote

- `[unit]` `isSameProject("git@github.com:o/r.git", "https://github.com/o/r")` returns `true`.
- `[unit]` `isSameProject` returns `false` when the two remotes name different repositories.
- `[unit]` `isSameProject` returns `false` when either argument is null.
- `[unit]` `claimProjectIdentity` with a workdir different from the registered one and an equal normalized remote resolves without throwing and updates the stored `lastSeen`.
- `[unit]` `claimProjectIdentity` with a workdir different from the registered one and an equal normalized remote leaves the stored `workdir` equal to the originally registered path.
- `[unit]` `claimProjectIdentity` throws a `NaxError` with code `RUN_NAME_COLLISION` when the remotes differ.
- `[unit]` `claimProjectIdentity` throws a `NaxError` with code `RUN_NAME_COLLISION` when both remotes are null and the workdirs differ.
- `[unit]` `claimProjectIdentity` with the registered workdir updates the stored `lastSeen`.
- `[unit]` `claimProjectIdentity` with the registered workdir leaves the stored `name`, `workdir`, `remoteUrl` and `createdAt` unchanged.
- `[unit]` `checkInitCollision` returns a result whose `collision` is `false` for an ssh remote against a stored identity holding the https form of the same repository.
- `[unit]` `checkInitCollision` returns a result whose `collision` is `false` when both remotes are absent and the workdir equals the stored one.
- `[unit]` `checkInitCollision` returns a result whose `collision` is `true` when the stored identity holds a different repository's remote.

### US-005 — Run attribution across checkouts

- `[unit]` the status snapshot written for a run carries `run.workdir` equal to that run's working directory.
- `[unit]` reading a status file whose `run` object has no `workdir` field resolves without throwing and reports the workdir as unknown.
- `[unit]` `buildRunId` returns different identifiers for two working directories that share a basename but differ in their absolute paths, given the same timestamp.
- `[unit]` `buildRunId` returns the same identifier for the same working directory and timestamp.
- `[unit]` `buildRunId` returns an identifier retaining millisecond precision from its timestamp.
- `[unit]` `buildRunId` returns an identifier containing no path separator and no character outside `[A-Za-z0-9._-]`.
- `[unit]` `run` uses a caller-supplied `runId` when one is given rather than generating another.
- `[unit]` a resumed run writes its log file under a name equal to the run identifier the run itself reports.

### US-006 — The curator metrics reader fails closed

- `[unit]` `collectObservations` returns no metrics-derived observations when the metrics file holds no entry whose `runId` equals the context's `runId`.
- `[unit]` `collectObservations` logs at warn level when the metrics file holds no entry whose `runId` equals the context's `runId`.
- `[unit]` `collectObservations` returns the matching run's story observations when the metrics file holds an entry whose `runId` equals the context's `runId`.
- `[integration]` when the metrics file holds entries for two runs whose `runId` values differ and the context names one of them, every returned observation carries that entry's `runId`.
- `[unit]` `getLastRun` returns the final element of the runs array, unchanged by this story.

<!-- spec-writing: completed-through-phase-5 -->
# SPEC: Project identity by remote, and feature-scoped run locking

## Summary

`nax run -f <feature>` from a git worktree of an already-initialized project aborts with
`RUN_NAME_COLLISION`, because `claimProjectIdentity` matches an existing project identity by
exact `workdir` string and never compares the `remoteUrl` it stores, while `nax init` compares
the remote and accepts the same case. This feature makes worktrees of one repository one
project, and makes the concurrency that unlocks safe: a run lock keyed on `(project, feature)`
serializes the same feature across checkouts while the existing checkout lock keeps one run per
checkout, run records say which checkout wrote them, and the project-level readers that would
otherwise adopt another run's data fail closed.

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
`runs.find(r => r.runId === context.runId) ?? runs.at(-1)`. `metrics.json` is a project-level,
cross-process locked append shared by every feature, so under concurrency that fallback
attributes another feature's stories to this run's observations, which feed the curator rollup
and its rule proposals. The sibling reader `collectFromReviewAudit`
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
- **Staleness is judged per-lock, independently.** Neither lock is consulted when deciding the
  other.
- **A live holder is authoritative regardless of age.** This matches the existing precheck rule
  at `src/precheck/checks-config.ts:46` (`holderAlive || ageMs < twoHoursMs`). Age only decides
  records whose holder cannot be shown to be alive.
- **A foreign-host record is never reclaimed by PID liveness.** A PID number from another machine
  is meaningless, so such a record is reclaimable only once older than the same two-hour
  threshold the precheck uses.
- **Exactly one acquisition per run.** Story worktrees under `--parallel` bypass `setupRun`
  (`src/execution/parallel-worker.ts` calls `runPipeline` directly) and take neither lock.
- `<workdir>/nax.lock` is **not** retired. It is what keeps two different features launched from
  one checkout from both creating `<workdir>/.nax-wt/...`, and it keeps an in-flight run started
  by an older binary visible to a new one.

**Lock record shapes.** The feature-lock record carries `pid`, `host`, `workdir`, `feature`,
`runId`, `startedAt` and `timestamp`. The checkout-lock record keeps its existing `pid` and
`timestamp` and gains `host`, so the same foreign-host rule applies to it; it gains nothing else.

**Refusals carry the holder.** Both acquire functions return a result that names the current
holder on refusal, rather than a bare boolean — the error messages below require holder data that
a boolean cannot carry, and re-reading the lock file after a failed acquire would race.

**Logger.** `src/execution/lock.ts:24-30` declares its own private `getSafeLogger`; the shared one
lives in `src/logger`. The new module uses the shared `src/logger` export rather than adding a
third copy.

### Integration

Read-only symbols, verified present at their stated shapes:

- `isProcessAlive(pid: number): boolean` — `src/utils/process-alive.ts:43`.
- `projectOutputDir(projectKey, outputDirOverride): string` — `src/runtime/paths.ts:18`.
- `readProjectIdentity(projectKey): Promise<ProjectIdentity | null>` — `src/runtime/paths.ts:43`.
- `writeProjectIdentity(projectKey, identity): Promise<void>` — `src/runtime/paths.ts:63`.
- `tryExclusiveCreate(targetPath, content): Promise<boolean>` — `src/execution/lock.ts:38`; the
  `O_CREAT | O_EXCL` helper whose BUG-34 restore semantics the new lock reuses.
- `_lockDeps.rename` — `src/execution/lock.ts:20`; the injectable seam that lets a test drive the
  stale-reclaim race deterministically.
- `getLastRun(runs: RunMetrics[]): RunMetrics | null` — `src/metrics/aggregator.ts:194`;
  deliberate latest-run semantics that the sweep must leave intact.

Mutated symbols. The baseline exists to locate the code; the target is the interface to
implement.

**`acquireLock`** — `src/execution/lock.ts:62`

- Baseline: `acquireLock(workdir: string): Promise<boolean>`; the holding PID is read at `:88`
  and discarded, and the record written at `:170-173` is `{ pid, timestamp }`.
- Target: returns a result that is either an acquired outcome or a refusal naming the holder's
  `pid` and `host`, so the caller can name them. The written record gains `host`.

**`releaseLock`** — `src/execution/lock.ts:198`

- Baseline: `releaseLock(workdir: string): Promise<void>`, unlinking `<workdir>/nax.lock`.
- Target: unchanged signature and behaviour; it is paired with the new feature-lock release at
  both call sites rather than modified.

**`LockAcquisitionError`** — `src/errors.ts:62`

- Baseline: `new LockAcquisitionError(workdir)`, message `"Another nax process is already running
  in this directory"`, context `{ workdir }`, code `LOCK_ACQUISITION_FAILED`.
- Target: two distinguishable refusals. The checkout refusal names the checkout and the holding
  PID; the feature refusal names the feature, the holder's workdir, the holder's host and the
  holding PID. Both keep the `LOCK_ACQUISITION_FAILED` code.

**`checkStaleLock`** — `src/precheck/checks-config.ts:11`

- Baseline: `checkStaleLock(workdir: string): Promise<Check>`, reading `<workdir>/nax.lock`; the
  sole production caller is `getEarlyEnvironmentBlockers(workdir)` at
  `src/precheck/index.ts:134`, reached from `runPrecheck` (which holds `prd.feature` but no
  output directory) and from `runEnvironmentPrecheck` (which holds neither).
- Target: `checkStaleLock(workdir: string, featureLock?: { outputDir: string; feature: string })`.
  With the optional argument it checks both locks and names which is stale; without it — the
  environment-precheck path, which has no feature — it checks the checkout lock only, exactly as
  today.

**`unlockCommand`** — `src/commands/unlock.ts:37`

- Baseline: `unlockCommand(options: UnlockOptions)` resolving `<workdir>/nax.lock` only.
- Target: `UnlockOptions` gains an optional `feature`. With it, the command resolves that
  feature's lock; without it, it resolves the checkout lock and reports each
  `<outputDir>/features/*/nax.lock` it finds, removing only those whose holder is neither alive
  nor foreign-host.

**`claimProjectIdentity`** — `src/runtime/paths.ts:75`

- Baseline: `claimProjectIdentity(projectKey, workdir, remoteUrl)` throws `RUN_NAME_COLLISION`
  whenever `existing.workdir !== workdir`.
- Target: same signature. When `existing.workdir !== workdir` and `isSameProject` holds, it
  refreshes `lastSeen`, leaves the stored `workdir` at the registered value, and returns.
  Otherwise `RUN_NAME_COLLISION` is unchanged.

**`checkInitCollision`** — `src/cli/init.ts:69`

- Baseline: `checkInitCollision(name, currentWorkdir, currentRemote)` with two local predicates —
  `sameRemote` on raw string equality at `:77`, and `sameWorkdir` at `:78`, which returns
  no-collision when **both** remotes are null and the workdirs match.
- Target: same signature; `sameRemote` is replaced by `isSameProject`, and the `sameWorkdir`
  branch is retained unchanged, so the null-remote case keeps its current behaviour.

**`NaxStatusFile.run`** — `src/execution/status-file.ts:105-127`

- Baseline: `{ id, feature, startedAt, status, dryRun, pid, crashedAt?, crashSignal? }`.
- Target: the same plus an optional `workdir: string`. Readers tolerate its absence in files
  written before this change.

### Failure Handling

| Condition | Behavior |
|:--|:--|
| Feature lock held by a live PID on this host | Refuse the run; the error names the feature, the holder's workdir, host and PID. |
| Feature lock record's `host` is not this machine | Never reclaimed by PID liveness; reclaimable only once older than the two-hour threshold. |
| Feature lock refused after the checkout lock was taken | The checkout lock is released before the error escapes. |
| Post-lock initialization fails after both locks are held | Both locks are released before the error escapes. |
| Lock file present but unparseable | Logged at warn level, treated as stale, and removed, matching the existing checkout-lock behaviour. |
| `metrics.json` holds no entry matching this run's `runId` | Log at warn level and return no metrics-derived observations; never fall back to another entry. |
| `git remote get-url origin` fails, or the project is not a git repository | `remoteUrl` stays null and identity falls back to exact workdir equality. |

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
- Changing `nax migrate --reclaim` or `--merge` semantics is not part of this feature.
- Reclaiming a lock held on another host by any signal other than age is not delivered; there is
  no cross-host liveness channel.
- Rewriting run IDs already recorded in the old format is not part of this feature; only newly
  generated run IDs carry the workdir component.

## Stories

**US-001 — Feature lock primitive**
`featureLockPath`, `acquireFeatureLock` and `releaseFeatureLock` over a record carrying the
holder, with host-aware staleness and the same atomic-create and stale-reclaim guarantees the
checkout lock already provides. No dependencies.

**US-002 — Run lifecycle holds both locks**
Acquire the checkout lock then the feature lock in `setupRun`, release both in reverse at both
release sites, and split `LockAcquisitionError` into two refusals that name their holder.
Depends on US-001.

**US-003 — Lock tooling sees both locks**
`nax unlock` gains an optional feature and a scan; `checkStaleLock` gains an optional feature
lock and keeps its current behaviour on the environment-precheck path that has no feature.
Depends on US-001.

**US-004 — Project identity matched by remote**
One `isSameProject` predicate with remote normalization, shared by `claimProjectIdentity` and
`checkInitCollision`. Depends on US-002: this is the story that legalizes concurrency, and it
must not land before the locks that make it safe.

**US-005 — Run attribution across checkouts**
Stamp `run.workdir` into the status file, and build run IDs in one place, shared by the runner
and `nax resume`, with a workdir component that is safe as a path segment. No dependencies.

**US-006 — Project-level readers fail closed**
Fix the confirmed positional fallback and confirm the rest of the project-level read surface,
leaving deliberate latest-run semantics intact. Depends on US-004.

### Context Files

**US-001**

- `src/execution/lock.ts` — the checkout lock, its BUG-07/BUG-34 stale-reclaim race handling, and the exclusive-create helper to reuse
- `src/utils/process-alive.ts` — the liveness check
- `src/runtime/paths.ts` — the project output directory the lock path is built from
- `src/precheck/checks-config.ts` — the existing two-hour staleness rule this one matches

**US-002**

- `src/execution/lifecycle/run-setup.ts` — the single acquire site
- `src/execution/lifecycle/run-setup-init.ts` — the FIX-H16 inner catch that releases on init failure
- `src/execution/lifecycle/run-cleanup.ts` — the always-release site
- `src/errors.ts` — the error class to split
- `src/execution/lock.ts` — the checkout lock whose result shape changes

**US-003**

- `src/commands/unlock.ts` — the unlock command
- `src/precheck/checks-config.ts` — the stale-lock precheck
- `src/precheck/index.ts` — the two entry points that compose the early blockers

**US-004**

- `src/runtime/paths.ts` — `claimProjectIdentity` and the identity record
- `src/cli/init.ts` — the existing remote comparison to replace, and the null-remote branch to keep
- `src/commands/migrate.ts` — the reclaim and merge flows that read the same identity

**US-005**

- `src/execution/status-file.ts` — the status snapshot shape
- `src/execution/runner.ts` — run ID generation
- `src/commands/resume.ts` — the resume path's separate run ID derivation
- `src/cli/status-features.ts` — the project-level status reader

**US-006**

- `src/plugins/builtin/curator/collect.ts` — the positional fallback and the correctly-guarded sibling reader
- `src/metrics/aggregator.ts` — deliberate latest-run semantics that must survive the sweep
- `src/cli/status-features.ts` — project-level status reader
- `src/metrics/tracker.ts` — the cross-process locked append that keeps entries coexisting

### Creates

**US-001**

- `src/execution/feature-lock.ts` — feature-lock path, acquire, release and host-aware staleness

**US-004**

- `src/runtime/same-project.ts` — the shared identity predicate and remote normalization

**US-005**

- `src/execution/run-id.ts` — the single run-ID builder

### Modifies

**US-002**

- `test/unit/errors.test.ts` — asserts LockAcquisitionError's exact message by equality and its whole context object by exact-object equality; both are closed-world, and the refusal now carries the holder's PID, so the assertions must allow a context holding both workdir and pid instead of exactly one key.
- `test/unit/execution/helpers.test.ts` — calls `acquireLock` and asserts on its boolean result and on the written record's fields; the acquire result becomes a holder-carrying object and the record gains `host`, so the assertions must read the new shapes.

**US-003**

- `test/unit/precheck/precheck-checks-tier1-blockers.test.ts` — calls `checkStaleLock(testDir)` with a single argument and asserts the checkout-lock outcomes; the feature-lock argument is optional so those cases stay valid, but the suite must add the both-locks cases the new argument introduces.

### Seams

- `[unit]` stub `acquireFeatureLock`; invoke `setupRun` for a feature; assert `acquireFeatureLock` was called exactly once, and that `acquireLock` was called before it.
- `[unit]` stub `isSameProject`; invoke `setupRun` in a project whose identity is already claimed by a different workdir; assert `isSameProject` was called once with the current remote and the stored identity record.
- `[unit]` stub `buildRunId`; invoke the `nax resume` command for a feature with an existing checkpoint; assert `buildRunId` was called once with the resumed run's working directory.

## Acceptance Criteria

### US-001 — Feature lock primitive

- `[unit]` `featureLockPath(outputDir, "f")` returns the path `<outputDir>/features/f/nax.lock`.
- `[unit]` `acquireFeatureLock` writes a record whose `pid`, `host`, `workdir`, `feature`, `runId` and `startedAt` fields are all populated.
- `[unit]` `acquireFeatureLock` returns a refusal for the same output directory and feature from a different working directory while the recorded PID is alive on this host.
- `[unit]` the refusal returned by `acquireFeatureLock` carries the holder's `pid`, `host` and `workdir` read from the existing record.
- `[unit]` `acquireFeatureLock` returns an acquired result for a different feature in the same output directory while the first feature's lock is held.
- `[unit]` `acquireFeatureLock` returns a refusal for a record whose `host` differs from this machine even when the recorded PID is not alive locally and the record is newer than two hours.
- `[unit]` `acquireFeatureLock` acquires and replaces a record whose `host` differs from this machine once that record is older than two hours.
- `[unit]` `acquireFeatureLock` acquires and replaces a same-host record whose recorded PID is not alive.
- `[unit]` `acquireFeatureLock` returns a refusal for a same-host record whose recorded PID is alive and whose age exceeds two hours.
- `[unit]` `acquireFeatureLock` logs at warn level, removes and replaces a lock file whose contents do not parse.
- `[unit]` `acquireFeatureLock` creates the lock file with an exclusive create, so a second call that runs after the file appears returns a refusal rather than overwriting it.
- `[unit]` when two `acquireFeatureLock` calls both observe the same stale record and the injected rename seam lets only one claim it, exactly one returns an acquired result.
- `[unit]` `releaseFeatureLock` removes the lock file, and resolves without error when the file is already absent.

### US-002 — Run lifecycle holds both locks

- `[unit]` `setupRun` calls `acquireLock` before `acquireFeatureLock`.
- `[unit]` when `acquireFeatureLock` refuses, `setupRun` leaves no `nax.lock` file in the working directory.
- `[unit]` when `acquireLock` refuses, `setupRun` throws an error whose message names the working directory and the holding PID.
- `[unit]` when `acquireFeatureLock` refuses, `setupRun` throws an error whose message names the feature, the holder's working directory, the holder's host and the holding PID.
- `[unit]` both refusals carry the code `LOCK_ACQUISITION_FAILED`.
- `[unit]` when post-lock initialization fails, neither the checkout lock file nor the feature lock file remains.
- `[unit]` run cleanup releases the feature lock before it releases the checkout lock.
- `[unit]` after run cleanup completes, neither the checkout lock file nor the feature lock file exists.
- `[unit]` the checkout lock record written by `acquireLock` carries `host` alongside `pid` and `timestamp`.
- `[unit]` a `runParallelBatch` run over three stories invokes `acquireFeatureLock` exactly once.

### US-003 — Lock tooling sees both locks

- `[cli]` `nax unlock -f <feature>` exits `0` and removes `<outputDir>/features/<feature>/nax.lock`.
- `[cli]` `nax unlock` with no feature exits `0` and removes the checkout lock.
- `[cli]` `nax unlock` with no feature leaves a feature lock whose recorded PID is alive in place and names that feature in its output.
- `[cli]` `nax unlock` with no feature leaves a feature lock whose `host` is not this machine in place and names that feature in its output.
- `[unit]` `checkStaleLock` called with a feature lock argument returns a failed check naming the feature lock when only the feature lock is older than two hours.
- `[unit]` `checkStaleLock` called with a feature lock argument returns a failed check naming both locks when both are older than two hours.
- `[unit]` `checkStaleLock` called without a feature lock argument reports only the checkout lock, and passes when the checkout lock is absent even if a stale feature lock exists.
- `[unit]` `checkStaleLock` returns a passed check when neither lock file exists.
- `[unit]` the early environment blockers composed by `runEnvironmentPrecheck` call `checkStaleLock` without a feature lock argument.
- `[unit]` the early environment blockers composed by `runPrecheck` call `checkStaleLock` with the run's feature and output directory.

### US-004 — Project identity matched by remote

- `[unit]` `isSameProject` returns `true` for the remote `git@github.com:o/r.git` against a stored identity whose `remoteUrl` is `https://github.com/o/r`.
- `[unit]` `isSameProject` returns `false` when the two remotes name different repositories.
- `[unit]` `isSameProject` returns `false` when either remote is null.
- `[unit]` `claimProjectIdentity` with a workdir different from the registered one and an equal normalized remote resolves without throwing and updates the stored `lastSeen`.
- `[unit]` `claimProjectIdentity` with a workdir different from the registered one and an equal normalized remote leaves the stored `workdir` equal to the originally registered path.
- `[unit]` `claimProjectIdentity` throws a `NaxError` with code `RUN_NAME_COLLISION` when the remotes differ.
- `[unit]` `claimProjectIdentity` throws a `NaxError` with code `RUN_NAME_COLLISION` when both remotes are null and the workdirs differ.
- `[unit]` `claimProjectIdentity` with the registered workdir updates the stored `lastSeen`.
- `[unit]` `claimProjectIdentity` with the registered workdir leaves the stored `name`, `workdir`, `remoteUrl` and `createdAt` unchanged.
- `[unit]` `claimProjectIdentity` called with a null remote and the registered workdir resolves without throwing.
- `[unit]` `checkInitCollision` returns a result whose `collision` is `false` for an ssh remote against a stored identity holding the https form of the same repository.
- `[unit]` `checkInitCollision` returns a result whose `collision` is `false` when both remotes are null and the workdir equals the stored one.
- `[unit]` `checkInitCollision` returns a result whose `collision` is `true` when the stored identity holds a different repository's remote.

### US-005 — Run attribution across checkouts

- `[unit]` the status snapshot written for a run carries `run.workdir` equal to that run's working directory.
- `[unit]` reading a status file whose `run` object has no `workdir` field resolves without throwing and reports the workdir as unknown.
- `[unit]` `buildRunId` returns different identifiers for two different working directories given the same timestamp.
- `[unit]` `buildRunId` returns the same identifier for the same working directory and timestamp.
- `[unit]` `buildRunId` returns an identifier retaining millisecond precision from its timestamp.
- `[unit]` `buildRunId` returns an identifier containing no path separator and no character outside `[A-Za-z0-9._-]`, so it is usable as a single path segment.
- `[unit]` the run identifier produced on the `nax resume` path and the one produced by the runner have the same format for the same working directory and timestamp.

### US-006 — Project-level readers fail closed

- `[unit]` `collectObservations` returns no metrics-derived observations when the metrics file holds no entry whose `runId` equals the context's `runId`.
- `[unit]` `collectObservations` logs at warn level when the metrics file holds no entry whose `runId` equals the context's `runId`.
- `[unit]` `collectObservations` returns the matching run's story observations when the metrics file holds an entry whose `runId` equals the context's `runId`.
- `[integration]` when the metrics file holds entries for two runs of different features and the context names one of them, every returned observation carries that context's `featureId`.
- `[unit]` `getLastRun` returns the final element of the runs array, unchanged by this story.
- `[unit]` the project-level status reader in `src/cli/status-features.ts` reports the feature named by the status record it read, rather than the feature of the run requesting it.

Verification note: the audit of every project-level reader under `~/.nax/<projectKey>/` —
`metrics.json`, `status.json`, `cost/`, `usage/`, `prompt-audit/`, `review-audit/`,
`tool-audit/`, `finish-audit/`, `cycle-shadow/`, `runs/` and `mcp/` — with the shape found and
the disposition for each, is recorded in the pull request body, distinguishing
identity-then-fallback defects from deliberate latest-run semantics.

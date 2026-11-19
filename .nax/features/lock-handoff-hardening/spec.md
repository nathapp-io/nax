# SPEC: lock-handoff-hardening — name an orphaned lock claim, keep a staged pid file a live creator still needs, refuse a handoff of a branch with an open PR, and keep a damaged result's good copy until the handoff lock is free

Closes: #2980, #2983, #2984, #2985

## Summary

Four follow-ups from the reviews of PR #2978, bundled because each hardens the handoff lock or the file lock beneath it. In `withFileLock` (nax-agent), a waiter that times out because a dead process left the reclamation claim behind gets a distinct `FILE_LOCK_CLAIM_ORPHANED` error naming the claim, the dead pid and the manual recovery, instead of the generic `FILE_LOCK_TIMEOUT` (#2980); the claim is still never removed automatically. The same module re-stages its pid file once when `link` reports `ENOENT`, and its orphan sweep removes only staged pid files older than an age bound, so a creator in another pid namespace whose staged file is swept between its write and its link retries instead of throwing (#2985). The chat handoff asks GitHub whether the branch already has an open PR, in its preflight and again just before the push, and refuses when it does or when the question cannot be answered (#2983). A run-end or crash repair of a damaged `result.json` that cannot take the handoff lock no longer waits 120 seconds and no longer drops the good copy: it writes a recovery file beside the result, and whoever next takes the handoff lock restores it when the result still holds the damage, or discards it when a newer write has replaced the result (#2984).

## Motivation

1. **An orphaned claim reads as a busy lock (#2980).** `withFileLock` (`packages/nax-agent/src/internal/file-lock.ts`) serializes the reclamation of a dead holder's lock through `<lock>.claim`. A claimant that crashes after creating the claim leaves it forever, by design (`reclaimAbandonedLock` never replaces a claim, because neither unlink nor rename can be conditioned on file identity). Every later caller then fails with `FILE_LOCK_TIMEOUT`, the same error a live holder causes, so the operator retries a wait that cannot succeed. The recovery (stop every user of the lock, remove the claim) is written only in the module comment.
2. **The staged-file sweep can break a creator it cannot see (#2985).** `tryCreateExclusive` writes `.lock-<pid>-<uuid>.pid` and links it to the lock path; after every acquisition `sweepOrphanedStagedFiles` removes staged files whose pid `isPidAlive` reports dead. A creator in another pid namespace (a bwrap or container sandbox sharing the directory) writes a pid that means nothing locally. If its file is swept between its `writeFile` and its `link`, `link` fails with `ENOENT`, which is neither contention (`EEXIST`) nor an unsupported-link code, so the acquisition throws.
3. **A handoff can transfer a feature that already has a PR (#2983).** A local publisher in `pr` mode opens the draft PR (`prMode` in `packages/nax/src/workflow/finalize.ts`) and then waits for CI. An abort during that wait throws `WORKFLOW_ABORTED`, and the step graph persists a step's result only after the step returns, so no record says a PR exists. HEAD still matches the older `local-only` result, `collectHandoffRecord` accepts it, and a chat handoff pushes and asks koda to own a feature whose PR is already open.
4. **A run-end repair that times out loses the good copy (#2984).** At run end `repairResult` (`packages/nax/src/runstate/repair.ts`) waits up to `HANDOFF_RESULT_LOCK_WAIT_MS` (120 s) for the feature's `.handoff.lock` before restoring a damaged `result.json`. A holder outside the run's call tree (a chat chain job publishing the same feature, or another process) can hold that lock through a whole CI wait. On timeout `failedRestore` is returned, the runner deactivates the keeper right after (`runner.ts`, `runState?.deactivate()`), and the kept bytes are gone; the run also stalls two minutes before exiting.

User rulings (2026-11-19): #2983 = the handoff asks the forge for an open PR (preflight and under the lock before the push; a forge failure refuses). #2984 = a recovery file applied by the next handoff-lock taker, the run-end attempt tries the lock once instead of waiting, and the kept-damage case is reported as a `[WARN]` line. #2980 and #2985 follow the issues' proposals: never unlink a claim automatically; re-stage once on `ENOENT` and sweep only aged staged files.

## Design

### Integration

Read-only symbols (verified on `main` `24ecdc5c2`):

- `withFileLock<T>(lockPath: string, operation: () => Promise<T>, options: FileLockOptions): Promise<T>` and `_fileLockDeps` (`writeFile`, `link`, `readdir`, `open`, `unlink`, `now`, `sleep`, `isPidAlive`), exported to nax through `@nathapp/nax-agent/internal`.
- `hasOpenPr(forge: ForgeKind, branch: string, deps: ForgeDeps, cwd: string): Promise<boolean>` and `defaultForgeDeps`, both exported from the `@/forge` barrel. `hasOpenPr` throws `FORGE_PR_LIST_FAILED` on a non-zero `gh` exit and `FORGE_PR_LIST_UNPARSEABLE` on unparseable output.
- `handoffLockPath(workflowDir: string): string`, `workflowFeatureDir(root, feature)`, `workflowRunDir(root, feature, runId)` in `src/workflow/paths.ts`.
- `runStateWrite(path, intent, write)` in `@/runstate/store`: the write path every `result.json` writer uses, so an active keeper records nax's own write.
- `KeptFile { path, rel, root, kind, content }` (`src/runstate/store/keeper.ts`); `RepairRecord { path, rel, damage, restored }` and `Damage = "missing" | "modified" | "hidden"` (`src/runstate/repair.ts`).
- The chat handoff (`src/chat/flow/flow-handoff.ts`) accepts only a GitHub `origin` (`readFlowRepoState`, `src/chat/flow/flow-repo.ts`), so the handoff's forge is always `"github"`.

Symbols this feature changes. The baseline only locates the code; the target is the interface to implement.

- `acquire` (`file-lock.ts`, not exported). Baseline: on the deadline it throws `FILE_LOCK_TIMEOUT`. Target: on the deadline it first checks for an orphaned claim (US-001) and throws `FILE_LOCK_CLAIM_ORPHANED` when one is found, else `FILE_LOCK_TIMEOUT` as today.
- `tryCreateExclusive(path)` (`file-lock.ts`, not exported). Baseline: a `link` failure other than `EEXIST` or an unsupported-link code is thrown. Target: an `ENOENT` from `link` writes a fresh staged file and links once more; a second `ENOENT` is thrown as today.
- `sweepOrphanedStagedFiles(path)` (`file-lock.ts`, not exported). Baseline: removes every staged file whose pid is proven dead. Target: removes a staged file only when its pid is proven dead **and** its mtime is at least `STAGED_PID_SWEEP_AGE_MS` (new constant, `10_000`) old.
- `_fileLockDeps`. Baseline: no `stat`. Target: gains `stat` (from `node:fs/promises`) so the sweep's age read is injectable.
- `_flowHandoffDeps` (`flow-handoff.ts`). Baseline: `collectHandoffRecord`, `handoffResultsMatch`, `readNewestHandoffMark`, `readRunMark`, `writeHandoffMark`, `withFileLock`, `now`. Target: gains `hasOpenPr: (branch: string, repoRoot: string) => Promise<boolean>`, defaulting to `hasOpenPr("github", branch, defaultForgeDeps, repoRoot)` (US-002), and `restorePendingResults: typeof restorePendingResults` (US-004).
- `preflight` and `handoffPushGuard` (`flow-handoff.ts`, not exported): both gain the open-PR check (US-002).
- `handOver` (`flow-handoff.ts`, not exported): calls `_flowHandoffDeps.restorePendingResults(workflowDir)` first, before `recheck` (US-004).
- `repairResult` (`repair.ts`). Baseline: run-end waits `HANDOFF_RESULT_LOCK_WAIT_MS`; any failure returns `failedRestore`. Target: every trigger tries the lock once (`timeoutMs: 0`); when the lock cannot be taken and the trigger is `run-end` or `crash`, it writes a recovery file (US-004) before returning `restored: false`. Inside the lock it calls `restorePendingResults(workflowDir)` before `repairLocked`.
- `withResultLock` (`src/workflow/result.ts`, not exported): calls `restorePendingResults(featureDir)` inside the lock, before `task`.

New module `src/workflow/result-recovery.ts` (US-003; wired in US-004):

```ts
/** `<runDir>/result.recovery.json`: the good bytes of a damaged result.json a repair could not restore. */
export const RESULT_RECOVERY_FILE = "result.recovery.json";

export interface ResultRecovery {
  readonly schemaVersion: 1;
  /** The result path relative to the repository root, as `KeptFile.rel` spells it. */
  readonly rel: string;
  /** What the repair saw on disk: no file, or a file whose raw on-disk bytes hash to `sha256` (lowercase hexadecimal). Do not decode or re-encode the bytes before hashing. */
  readonly damaged: { readonly kind: "missing" } | { readonly kind: "modified"; readonly sha256: string };
  /** The kept (good) result.json text. */
  readonly content: string;
}

export type RecoveryOutcome =
  | { readonly kind: "restored"; readonly resultPath: string }
  | { readonly kind: "superseded"; readonly resultPath: string }
  | { readonly kind: "unreadable"; readonly recoveryPath: string }
  | { readonly kind: "failed"; readonly recoveryPath: string };

/** Create `dirname(resultPath)` (recursive), then write the recovery file beside `resultPath` (tmp + rename). Replaces an existing one. */
export function writeResultRecovery(resultPath: string, recovery: ResultRecovery): Promise<void>;

/** Under the handoff lock: apply or discard every run's recovery file in `workflowDir`. Never throws. */
export function restorePendingResults(workflowDir: string): Promise<readonly RecoveryOutcome[]>;

/** Test seam for the module's filesystem calls, as `_resultDeps` is for result.ts. */
export const _resultRecoveryDeps: {
  readdir: typeof readdir;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  rename: typeof rename;
  unlink: typeof unlink;
};
```

`restorePendingResults` lists the entries of `workflowDir`. A missing `workflowDir` (ENOENT) yields `[]` with no log. Only entries that `lstat` as real directories are run directories: symlinks, regular files (`.handoff.lock`, `.handoff.lock.claim`) and other entries are skipped silently, as `listRunDirs` in `handoff-record.ts` skips non-directories. A run directory without `result.recovery.json` (ENOENT or ENOTDIR on it) is skipped silently. For each run directory holding `result.recovery.json`:

1. parses it; a file that does not parse, has another `schemaVersion`, or fails the structural check (`rel` and `content` are strings; `damaged.kind` is `"missing"`, or `"modified"` with a `sha256` of 64 lowercase hex characters) is left on disk and yields `unreadable` with a `[WARN]` log (fail closed: nothing is overwritten from a file it cannot read);
2. reads `result.json` in the same run directory as raw bytes and compares it with `damaged`: missing and still missing, or the SHA-256 (lowercase hex) of its raw bytes equal to `damaged.sha256`;
3. on a match, writes `content` to `result.json` through `runStateWrite` (tmp + rename, as `writeResult` in `result.ts` does), removes the recovery file, appends `_run: run-state repaired: <rel> (<missing|modified>)` to `<runDir>/ledger.md` when that ledger exists — through `runStateWrite(ledgerPath, { append: line }, ...)` inline, the form `appendLedger` in `workflow/ledger.ts` uses but without its `mirrorLedger` run-log line, so an active keeper records it as nax's own write — logs a `[WARN]` line, and yields `restored`;
4. on no match (a newer write replaced the damaged result), removes the recovery file, logs a `[WARN]` line, and yields `superseded`;
5. when any step for one run directory fails before `result.json` is written (a read, the tmp write, the rename), keeps the recovery file unchanged, logs a `[WARN]` line, yields `failed`, and goes on with the remaining run directories. If removing the recovery file fails after `result.json` is committed, report `restored`. On a later scan, compare the current result against the recovery's damage fingerprint again: if it no longer matches, remove the recovery file and report `superseded`; if it still matches, follow the normal restore path.

Every log line uses `storyId: "_run"` as its first key and the `runstate` stage. `result-recovery.ts` imports `runStateWrite` from `@/runstate/store` (as `result.ts` does), never from the `@/runstate` barrel: `repair.ts` imports this module, so the barrel would close a runtime cycle (`check:import-cycles`). `flow-handoff.ts` imports it through the same `biome-ignore lint/style/noRestrictedImports` form its other workflow imports use.

### Approach

**US-001 — file lock.** At the deadline, `acquire` runs `orphanedClaimError(lockPath, claimPath, options)` before building the timeout. It returns the new error only when all three hold: the lock is provably abandoned (`abandonedPid(lockPath)` is not `undefined`), the claim file holds a pid (`readLockMetadata(claimPath)` returns a non-null `pid`), and `isPidAlive` reports that pid dead. Any read failure in this check is swallowed and the timeout is thrown as today: the diagnosis must never change the failure into a different one. The error:

```ts
new NaxError(
  `${options.errorPrefix} The ${options.lockName} lock is blocked by a reclamation claim that dead process ${pid} left: ${claimPath}. ` +
    `Retrying cannot clear it. Stop every process that uses ${lockPath}, then remove ${claimPath}.`,
  "FILE_LOCK_CLAIM_ORPHANED",
  { stage: "file-lock", lockName: options.lockName, lockPath, claimPath, claimPid: pid },
);
```

The module comment's recovery paragraph gains one sentence naming this error. `tryCreateExclusive` re-stages on `ENOENT` once: a fresh `randomUUID()` staged name, the same `writeFile`/`link` steps, the same `finally` unlink of each staged file it wrote. The sweep reads each candidate's mtime with `_fileLockDeps.stat` and skips one whose age, `_fileLockDeps.now() - mtimeMs` (the basis `readLockMetadata` uses), is below `STAGED_PID_SWEEP_AGE_MS`; a `stat` failure skips that file (best effort, as today). `STAGED_PID_SWEEP_AGE_MS` stays module-private. The module comment's staged-file sentence ("the next acquisition there removes staged files whose pid is proven dead") gains "and whose mtime is at least `STAGED_PID_SWEEP_AGE_MS` old": the sweep skips a candidate whose age is below the bound and removes one whose age equals it.

**US-002 — handoff open-PR refusal.** `preflight` runs the check after `collectHandoffRecord` accepts the record and after the mark read, so a feature already handed over (koda then owns its PR) still gets the `handoffMarkRefusal` text. `handoffPushGuard` runs it after the run-mark read and the cancellation read and before `handoffResultsMatch`, so it is the last forge read before the push and runs under the handoff lock. Both use one helper, `openPrRefusal(feature, branch, repoRoot)`, returning a `ToolResult` or `undefined`:

- open PR: ``[chat] cannot hand off <feature>: branch <branch> already has an open PR; a handoff needs a branch with no PR``
- forge failure (any throw): ``[chat] cannot hand off <feature>: could not check branch <branch> for an open PR (<errorMessage>); nothing was pushed``

**US-004 — result recovery wiring.** `repairResult` passes `timeoutMs: 0` for every trigger, and its `HANDOFF_RESULT_LOCK_WAIT_MS` import goes (`result.ts` writers keep it). In its `catch`, when the error is a `NaxError` whose code is `FILE_LOCK_TIMEOUT` or `FILE_LOCK_CLAIM_ORPHANED`, the trigger is `run-end` or `crash`, and `needsRestore(damage)`, it reads the result's current raw bytes (none when missing); when those bytes equal the kept `file.content` (the damage healed between the damage read and the lock attempt) it writes nothing and returns no record for that file. Otherwise it writes the recovery file from the kept `file` and that observation, and logs one `.warn` line whose message starts `[WARN]`, names the result's `rel` and the recovery path, and says the next handoff-lock holder restores it; it does not call `failedRestore` then. When writing the recovery file fails, it calls `failedRestore` with that write error, whose `[FAIL]` message names the result's `rel`. Every other error keeps today's `failedRestore`. A lock left by a dead holder is not reclaimed by a zero-wait attempt (the deadline check precedes reclamation in `acquire`); the recovery file is then applied by the next lock-taker that waits, such as a result writer, which reclaims the dead holder's lock first. `processQueueFile` (`src/execution/queue-handler.ts`) today swallows a queue-lock timeout by matching the message prefix `[queue] Timed out acquiring queue lock`; US-001's new error does not match it, so an orphaned queue-lock claim would throw out of the first pipeline stage. Its catch changes to match a `NaxError` whose code is `FILE_LOCK_TIMEOUT` or `FILE_LOCK_CLAIM_ORPHANED`, keeping the warn-and-return-`undefined` behaviour. The `holdsHandoffLock` branch (a repair inside the publisher's own hold) does not call `restorePendingResults`: the publisher's `withResultLock` already ran it at lock-take.

### Failure Handling

| Case | Behaviour | Story |
|:---|:---|:---|
| Claim pid alive or liveness inconclusive at the deadline | `FILE_LOCK_TIMEOUT`, as today | US-001 |
| Claim empty (fallback create crashed before its write) | `FILE_LOCK_TIMEOUT` | US-001 |
| Claim or lock read fails during the deadline check | `FILE_LOCK_TIMEOUT`; the read error is not thrown | US-001 |
| Lock holder alive, claim pid dead | `FILE_LOCK_TIMEOUT`: the live holder is what blocks | US-001 |
| `link` `ENOENT` twice | the second `ENOENT` is thrown | US-001 |
| `stat` of a staged file fails in the sweep | that file is skipped | US-001 |
| `hasOpenPr` throws (auth, network, unparseable) | handoff refused, nothing pushed, koda not called | US-002 |
| Open PR appears between preflight and push | refused by `handoffPushGuard`, nothing pushed | US-002 |
| Recovery file unparseable or wrong schema | left on disk, `unreadable`, result untouched | US-003 |
| Run-end lock attempt fails with `FILE_LOCK_CLAIM_ORPHANED` | recovery file written, as for `FILE_LOCK_TIMEOUT` | US-004 |
| Run directory deleted by the agent | `writeResultRecovery` recreates it before writing | US-003 |
| `workflowDir` missing, or entries that are not real directories | `[]` / skipped, no log | US-003 |
| Recovery file write fails | `[FAIL]` log, record `restored: false` | US-004 |
| `restorePendingResults` hits a filesystem error | logged, never thrown; the lock holder's task still runs | US-003 |
| One run's restore write or rename fails | recovery file kept, `failed`, other runs still processed | US-003 |
| Recovery file parses but fails the structural check | left on disk, `unreadable` | US-003 |
| Result bytes equal the kept content at the recovery read | no recovery file, no record | US-004 |
| Run-end lock attempt fails with `FILE_LOCK_INVALID` or the workflow-dir `mkdir` fails | `failedRestore`, as today | US-004 |
| Queue lock blocked by an orphaned claim | `processQueueFile` warns and returns `undefined`, as for a timeout | US-004 |

## Out of Scope

- Removing an orphaned claim automatically, at any age or pid state (#2980 ruling: fail closed).
- The holder-pid liveness check's own cross-namespace weakness (a lock whose holder pid means nothing locally); only the staged-file sweep changes.
- Recording a confirmed draft PR in `result.json` before the CI wait (#2983 option not chosen); publish (`finalize.ts`) is unchanged.
- An open-PR check on GitLab for the handoff: the chat handoff accepts only a GitHub origin.
- Naming the open PR's URL in the handoff refusal: `hasOpenPr` answers only whether one exists.
- A run summary section for kept damage: the case is reported as a `[WARN]` log line, because the runner's final repair runs after the summary is printed.
- A lock holder that reads the damaged `result.json` and merges into it before the recovery file is applied (the holder's own write supersedes the recovery file); unchanged from today.
- Changing `HANDOFF_RESULT_LOCK_WAIT_MS` or the result writers' wait.
- Turn and pre-commit repairs writing a recovery file: their keeper stays active and retries on the next turn.
- A chat handoff restoring a recovery file in its preflight: preflight reads without the lock, so a run whose `result.json` is missing is refused there (`NO_FINISHED_RUN`) and its recovery file waits for the next `nax run` or publish to take the lock.
- Writing a recovery file for `FILE_LOCK_INVALID` (a symlink, FIFO or garbage at `.handoff.lock`) or a workflow-directory `mkdir` failure; both keep today's `failedRestore`.
- De-duplicating the two run-end passes (completion phase and runner `finally`): each pass that finds the damage writes the recovery file again and logs its own `[WARN]` line.
- `nax approvals rm`'s handling of a lock error: the new code falls to its existing branch, which prints the error message verbatim.

## Stories

**US-001 — file lock: orphaned claim error, staged-file re-stage and aged sweep (#2980, #2985).** Workdir: `packages/nax-agent`. No dependencies. Adds `FILE_LOCK_CLAIM_ORPHANED` at the deadline, the one-time re-stage on `link` `ENOENT`, `STAGED_PID_SWEEP_AGE_MS` with an injectable `stat`, and the module comment sentence.

**US-002 — chat handoff refuses a branch with an open PR (#2983).** Workdir: `packages/nax`. No dependencies. Adds `_flowHandoffDeps.hasOpenPr` and the `openPrRefusal` check in `preflight` and `handoffPushGuard`.

**US-003 — the result recovery file and its restore (#2984).** Workdir: `packages/nax`. No dependencies. Adds `src/workflow/result-recovery.ts`: `RESULT_RECOVERY_FILE`, `ResultRecovery`, `RecoveryOutcome`, `writeResultRecovery`, `restorePendingResults` and `_resultRecoveryDeps`, with the apply / supersede / unreadable rules, the ledger line through `runStateWrite`, and the directory-entry rules. Nothing calls it yet.

**US-004 — write the recovery file at run end and apply it at every handoff-lock take (#2984).** Workdir: `packages/nax`. Depends on US-001, US-002, US-003 (US-001 adds the `FILE_LOCK_CLAIM_ORPHANED` code the repair catch handles, US-002 changes `flow-handoff.ts` and `_flowHandoffDeps` first, US-003 provides the module). `repairResult` tries the lock once at every trigger and writes the recovery file for `run-end` and `crash`; `withResultLock`, `repairResult`'s locked path and `handOver` call `restorePendingResults` first; `_flowHandoffDeps` gains `restorePendingResults`; `processQueueFile` swallows `FILE_LOCK_CLAIM_ORPHANED` as it does the timeout.

### Context Files

**US-001**
- `packages/nax-agent/src/internal/file-lock.ts` — acquisition, reclamation, staged files
- `packages/nax-agent/test/unit/internal/file-lock.test.ts` — existing fixtures (`makeLockDir`, `PATH_LOCK_OPTS`, `_fileLockDeps` restore)
- `packages/nax-agent/src/internal/process-alive.ts` — what `isPidAlive` answers

**US-002**
- `packages/nax/src/chat/flow/flow-handoff.ts` — `preflight`, `handoffPushGuard`, `_flowHandoffDeps`
- `packages/nax/src/forge/pr.ts` — `hasOpenPr`
- `packages/nax/test/unit/chat/flow/flow-handoff-recheck.test.ts` — the locked-sequence fixtures to mirror
- `packages/nax/src/chat/flow/flow-repo.ts` — the GitHub-only origin rule

**US-003**
- `packages/nax/src/workflow/result.ts` — `writeResult` tmp + rename through `runStateWrite`
- `packages/nax/src/workflow/ledger.ts` — the ledger append through `runStateWrite`
- `packages/nax/src/workflow/handoff-record.ts` — `listRunDirs`, the run-directory entry rules to mirror
- `packages/nax/src/runstate/store/registry.ts` — `runStateWrite`
- `packages/nax/test/unit/runstate/repair.test.ts` — keeper fixtures

**US-004**
- `packages/nax/src/runstate/repair.ts` — `repairResult`, `failedRestore`, `needsRestore`
- `packages/nax/src/chat/flow/flow-handoff.ts` — `handOver`, `_flowHandoffDeps`
- `packages/nax/src/workflow/result-recovery.ts` — created by US-003, called here
- `packages/nax/src/execution/queue-handler.ts` — `processQueueFile`'s queue-lock catch
- `packages/nax/test/unit/chat/flow/flow-handoff-recheck.test.ts` — the locked-sequence fixtures to mirror

### Creates

**US-001**
- `packages/nax-agent/test/unit/internal/file-lock-diagnostics.test.ts` — the orphaned-claim, re-stage and aged-sweep tests (`file-lock.test.ts` is at 672 lines)

**US-002**
- `packages/nax/test/unit/chat/flow/flow-handoff-open-pr.test.ts` — the open-PR refusal tests (`flow-handoff.test.ts` 670 and `flow-handoff-recheck.test.ts` 662 lines)

**US-003**
- `packages/nax/src/workflow/result-recovery.ts` — `RESULT_RECOVERY_FILE`, `ResultRecovery`, `RecoveryOutcome`, `writeResultRecovery`, `restorePendingResults`, `_resultRecoveryDeps`
- `packages/nax/test/unit/workflow/result-recovery.test.ts` — apply, supersede, unreadable, ledger line, entry rules

**US-004**
- `packages/nax/test/unit/runstate/repair-recovery.test.ts` — run-end/crash recovery writes and the result-writer and repair wiring (the `processQueueFile` ACs go in the existing `test/unit/execution/queue-handler.test.ts`)
- `packages/nax/test/unit/chat/flow/flow-handoff-recovery.test.ts` — the handoff's restore wiring (`flow-handoff-recheck.test.ts` is at 662 lines)

### Modifies

**US-001**
- `packages/nax-agent/test/unit/internal/file-lock.test.ts` — "two contending waiters leave an aged claim and its abandoned lock intact" asserts each waiter rejects with `code: "FILE_LOCK_TIMEOUT"`; its fixture is an abandoned lock (`424242`, `isPidAlive` false) with an aged claim holding dead pid `999999`, which is exactly the orphaned-claim case, so it now asserts `code: "FILE_LOCK_CLAIM_ORPHANED"`. Its other assertions (operation never called, lock and claim bytes unchanged) stay.
- `packages/nax-agent/test/unit/internal/file-lock.test.ts` — "an acquisition removes staged pid files a dead process left, never a live one's" writes the dead process's staged file just before acquiring, so its mtime is younger than `STAGED_PID_SWEEP_AGE_MS` and the aged sweep keeps it; the fixture ages the dead file past the bound (as the aged-claim test does with `utimes`) and keeps both assertions (dead removed, live kept).

**US-002**
- `packages/nax/test/unit/chat/flow/flow-handoff.test.ts` — its shared setup stubs `_flowHandoffDeps` member by member and the new default `hasOpenPr` would run the real `gh` against the fake repo root and refuse every happy-path send; the setup gains `_flowHandoffDeps.hasOpenPr = async () => false` (and restores it with the others). No assertion changes.
- `packages/nax/test/unit/chat/flow/flow-handoff-recheck.test.ts` — its shared setup stubs `_flowHandoffDeps` member by member and the new default `hasOpenPr` would run the real `gh` against the fake repo root and refuse every happy-path send; the setup gains `_flowHandoffDeps.hasOpenPr = async () => false` (and restores it with the others). No assertion changes.
- `packages/nax/test/unit/chat/jobs/chain-handoff-run.test.ts` — its setup stubs `_flowHandoffDeps` member by member and the new default `hasOpenPr` would run the real `gh` and refuse the chained handoff; the setup gains `_flowHandoffDeps.hasOpenPr = async () => false` (and restores it). No assertion changes.

**US-003**

None. The module is new and nothing calls it yet.

**US-004**
- `packages/nax/test/unit/runstate/repair.test.ts` — "run-end waits for a live handoff before restoring a missing checkpoint" asserts run-end blocks on a held handoff lock and then restores the result (`restored: true`, the ledger line); run-end now tries the lock once, so it asserts the run-end record is `restored: false`, the result is still missing, and the recovery file beside it holds the kept content with `damaged.kind` `"missing"`; the restore after release is covered by the new recovery tests.

### Seams

- US-004 wires US-003's `restorePendingResults` into three existing entry points: `withLockedFeatureResult` / `upsertStoryRecord` (through `withResultLock`), `repairRunState` (through `repairResult`'s locked path) and `sendFlowHandoff` (through `handOver`). Each gets a seam AC that triggers the entry point and observes the restore.
- US-004 wires US-003's `writeResultRecovery` into `repairRunState({ trigger: "run-end" | "crash" })`; its seam AC triggers `repairRunState`.
- US-002 `_flowHandoffDeps.hasOpenPr` is called by `sendFlowHandoff`; its seam ACs trigger `sendFlowHandoff`.

## Acceptance Criteria

### US-001

1. [unit] With an abandoned lock (holder pid proven dead) and a `<lock>.claim` holding a pid `isPidAlive` reports dead, `withFileLock` rejects at its deadline with a `NaxError` whose `code` is `FILE_LOCK_CLAIM_ORPHANED`.
2. [unit] That error's `context` carries `stage: "file-lock"`, `lockPath`, `claimPath` equal to `<lock>.claim`, and `claimPid` equal to the claim's pid.
3. [unit] That error's message names the claim path and the dead pid, and states that retrying cannot clear it and that every process using the lock must be stopped before the claim is removed.
4. [unit] After the `FILE_LOCK_CLAIM_ORPHANED` rejection the claim file and the abandoned lock file still hold their original bytes, and the operation was never called.
5. [unit] With an abandoned lock and a claim whose pid `isPidAlive` reports alive, `withFileLock` rejects at its deadline with `code: "FILE_LOCK_TIMEOUT"`.
6. [unit] With a lock whose holder pid is alive and a claim holding a dead pid, `withFileLock` rejects with `code: "FILE_LOCK_TIMEOUT"`.
7. [unit] With an abandoned lock and an empty claim file, `withFileLock` rejects with `code: "FILE_LOCK_TIMEOUT"`.
8. [unit] When reading the claim during the deadline check fails (a stubbed `_fileLockDeps.open` that throws for the claim path after the deadline), `withFileLock` rejects with `code: "FILE_LOCK_TIMEOUT"`, not with the read error.
9. [unit] When `_fileLockDeps.link` rejects once with `ENOENT` for the lock path and then succeeds, `withFileLock` runs the operation and the lock file held during it contains the caller's pid.
10. [unit] In that re-stage case, `_fileLockDeps.writeFile` is called for two different staged paths, and neither staged file exists after the acquisition.
11. [unit] When `_fileLockDeps.link` rejects with `ENOENT` on both attempts, `withFileLock` rejects with that `ENOENT` error and the operation is never called.
12. [unit] A staged pid file whose pid is proven dead and whose mtime is less than 10 seconds before `_fileLockDeps.now()` is still on disk after another process's acquisition in the same directory.
13. [unit] A staged pid file whose pid is proven dead and whose mtime is at least 10 seconds before `_fileLockDeps.now()` is removed by an acquisition in the same directory.
14. [unit] When `_fileLockDeps.stat` rejects for one staged file, the acquisition still succeeds and that staged file is left on disk.

### US-002

1. [unit] `sendFlowHandoff` for a feature whose preflight otherwise passes, with `_flowHandoffDeps.hasOpenPr` resolving `true`, returns a failed result whose content is `[chat] cannot hand off <feature>: branch <branch> already has an open PR; a handoff needs a branch with no PR`.
2. [unit] In that case `options.approve` is never called, nothing is pushed, and no koda create is sent.
3. [unit] `sendFlowHandoff` calls `_flowHandoffDeps.hasOpenPr` with the checked-out branch from the repository state and the chat's `repoRoot`.
4. [unit] When `_flowHandoffDeps.hasOpenPr` rejects with a `NaxError` (code `FORGE_PR_LIST_FAILED`) during preflight, `sendFlowHandoff` returns a failed result whose content starts `[chat] cannot hand off <feature>: could not check branch <branch> for an open PR (` and contains the error's message, and nothing is pushed.
5. [unit] When `_flowHandoffDeps.hasOpenPr` resolves `false` at preflight and `true` on its second call (after approval, under the handoff lock), `sendFlowHandoff` returns the open-PR refusal, nothing is pushed, no koda create is sent, and no handoff mark is written.
6. [unit] When `_flowHandoffDeps.hasOpenPr` resolves `false` at preflight and rejects on its second call, `sendFlowHandoff` returns the could-not-check refusal and nothing is pushed.
7. [unit] When `_flowHandoffDeps.hasOpenPr` resolves `false` on both calls, the handoff proceeds to push and to the koda create as it does today.
8. [unit] A handoff refused by the open-PR check in preflight stops a chat chain whose next step is that feature's handoff (the existing `refusedHandoff` path), with the refusal text as the stop reason.
9. [unit] The default `_flowHandoffDeps.hasOpenPr` calls `hasOpenPr` with forge `"github"`, the given branch, `defaultForgeDeps` and the given `repoRoot`, observed by stubbing `defaultForgeDeps.run` and asserting the argv it receives is `gh pr list --head <branch> --state open --json number`.
10. [unit] With a handoff mark already on the newest run and `_flowHandoffDeps.hasOpenPr` resolving `true`, `sendFlowHandoff` returns the existing `handoffMarkRefusal` text and `hasOpenPr` is never called.
11. [unit] When the post-approval `hasOpenPr` call resolves `true`, `_flowHandoffDeps.handoffResultsMatch` is never called for that send.

### US-003

1. [unit] `restorePendingResults(workflowDir)` with a run directory holding `result.recovery.json` (`damaged.kind` `"missing"`) and no `result.json` writes `content` to `result.json`, removes the recovery file, and returns `[{ kind: "restored", resultPath }]`.
2. [unit] With `damaged.kind` `"modified"` and a `result.json` whose bytes hash (SHA-256, lowercase hex) to `damaged.sha256`, `restorePendingResults` writes `content` to `result.json`, removes the recovery file, and returns `restored`.
3. [unit] With `damaged.kind` `"modified"` and a `result.json` whose hash differs from `damaged.sha256`, `restorePendingResults` leaves `result.json` unchanged, removes the recovery file, and returns `[{ kind: "superseded", resultPath }]`.
4. [unit] With `damaged.kind` `"missing"` and a `result.json` present, `restorePendingResults` leaves `result.json` unchanged, removes the recovery file, and returns `superseded`.
5. [unit] With a `result.recovery.json` that is not valid JSON, whose `schemaVersion` is not `1`, or whose `content` is not a string, or whose `damaged` is `{ kind: "modified" }` with no 64-hex `sha256`, `restorePendingResults` leaves both files unchanged and returns `[{ kind: "unreadable", recoveryPath }]`.
6. [unit] A `restored` outcome appends `_run: run-state repaired: <rel> (missing)` (or `(modified)`) to `<runDir>/ledger.md` when that ledger exists, and creates no ledger when it does not.
7. [unit] `restorePendingResults` on a workflow directory with no recovery files returns `[]` and writes nothing.
8. [unit] When a keeper is active for the run and `restorePendingResults` appends the ledger line, a following `repairRunState({ trigger: "turn" })` returns `[]` and the ledger keeps that line.
9. [unit] `restorePendingResults` on a workflow directory holding a `.handoff.lock` regular file and a run directory with a recovery file returns only that run's outcome and logs no warning for the lock file.
10. [unit] A run-directory entry that is a symlink to a directory holding a recovery file is skipped: `restorePendingResults` writes nothing through it and returns no outcome for it.
11. [unit] `restorePendingResults` on a `workflowDir` that does not exist returns `[]` and logs nothing.
12. [unit] When `_resultRecoveryDeps.readdir` rejects with an error other than ENOENT, `restorePendingResults` resolves (never rejects) and logs a `[WARN]` line with `storyId: "_run"` as its first data key.
13. [unit] `writeResultRecovery(resultPath, recovery)` writes `result.recovery.json` in `resultPath`'s directory whose parsed JSON equals `recovery`, and writing again replaces it.
14. [unit] `writeResultRecovery` for a `resultPath` whose run directory does not exist creates the directory and writes the recovery file.
15. [unit] An `unreadable` outcome logs a `[WARN]` line, `storyId: "_run"` first, naming the recovery file path.
16. [unit] With two run directories holding matching recovery files and `_resultRecoveryDeps.rename` rejecting for the first run's `result.json`, the first run's recovery file bytes are unchanged and its outcome is `failed`, the second run is `restored`, and the call resolves.
17. [unit] Given a restore that changes the result so it no longer matches the recorded damage, and an unlink failure injected only on the first call, when `restorePendingResults` runs a second time with the result unchanged since that restore, it returns `superseded` for the run, removes the recovery file, and leaves the restored result bytes unchanged.

### US-004

1. [unit] `repairRunState({ trigger: "run-end" })` for a kept `result.json` that is missing on disk, while the feature's handoff lock is held by a holder outside the run's call tree, resolves with that file's record `restored: false` without waiting for the lock (an injected `_fileLockDeps.sleep` is never called for the handoff lock).
2. [unit] In that run-end case, `result.recovery.json` exists beside the result with `content` equal to the kept text, `rel` equal to the kept file's `rel`, and `damaged` equal to `{ kind: "missing" }`.
3. [unit] For a kept `result.json` modified on disk under the same held lock, the run-end recovery file's `damaged` is `{ kind: "modified", sha256 }` with `sha256` the hash of the modified bytes.
4. [unit] `repairRunState({ trigger: "crash" })` under the same held lock also writes the recovery file.
5. [unit] When the run-end lock attempt rejects with `FILE_LOCK_CLAIM_ORPHANED` (an abandoned lock with an orphaned claim), `repairRunState({ trigger: "run-end" })` writes the recovery file and the record is `restored: false`.
6. [unit] `repairRunState({ trigger: "turn" })` under the same held lock writes no recovery file and returns `restored: false`.
7. [unit] A run-end repair that writes the recovery file logs exactly one `.warn` call for that file, whose message starts `[WARN]` and names the result's `rel` and the recovery file path, with `storyId: "_run"` first; no `[FAIL]` message is logged for it.
8. [unit] When writing the recovery file fails (`_resultRecoveryDeps.rename` rejecting), the run-end repair still resolves with `restored: false` and logs a `[FAIL]` message naming the result's `rel` whose data `error` is the recovery write's error message.
9. [unit] Seam: after a run-end repair wrote a recovery file for a missing result and the lock holder released, `upsertStoryRecord` for that run (which takes the handoff lock through `withResultLock`) restores the kept content before applying its own update, so the resulting `result.json` holds the kept stories plus the upserted record.
10. [unit] Seam: after a run-end repair wrote a recovery file and the lock was released, a later `repairRunState({ trigger: "turn" })` by an active keeper that takes the handoff lock leaves `result.json` equal to the kept content and removes the recovery file.
11. [unit] Seam: `sendFlowHandoff` for an approved handoff calls `_flowHandoffDeps.restorePendingResults` with the feature's workflow directory while holding the handoff lock, before `collectHandoffRecord` is called the second time.
12. [unit] Seam: with the real `restorePendingResults`, when a recovery file for the newest run's missing `result.json` is on disk at the post-approval recheck (written after preflight read the record), the handoff restores it, then returns the existing `[chat] the run record changed while the card was open; nothing was pushed` refusal and nothing is pushed.
13. [unit] When the kept `result.json` is reported modified by the damage read but its bytes equal the kept content when the run-end repair re-reads them after the lock attempt fails (`Bun.write` of the kept content injected between the two reads), no recovery file is written and no record is returned for that file.
14. [unit] A turn repair inside a publisher's own handoff hold (`withLockedFeatureResult` task calling `repairRunState({ trigger: "turn" })`) calls `restorePendingResults` once, at the publisher's lock-take, and not again from the repair.
15. [unit] `processQueueFile` whose queue lock is abandoned with an orphaned claim (`_fileLockDeps.isPidAlive` false for both pids) resolves `undefined` and logs the `queue` warning `Failed to process queue file`.
16. [unit] `processQueueFile` whose lock acquisition rejects with a `NaxError` of another code (`FILE_LOCK_INVALID`) still rejects with that error.

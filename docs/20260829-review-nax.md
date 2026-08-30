# Deep Code Review: @nathapp/nax (full codebase)

**Date:** 2026-08-29 · **Revised:** 2026-08-30 (verification pass; status refreshed after #1768 merged)
**Reviewer:** Subrina (AI)
**Version:** 0.81.1-canary.1 (confirmed `package.json`)
**Files:** 900 TS files in `src/` + `bin/` (confirmed: `find src bin -name '*.ts' | wc -l` → 900)

**Baseline evidence — re-run for this revision, all confirmed:**

| Gate | Result |
|:---|:---|
| `bun run typecheck` | exit 0 (both `tsconfig.json` and `tsconfig.test.json`) |
| `bun run lint` | exit 0 · biome clean (2258 files) |
| `check:import-cycles` | 135 modules in cycles (baseline 135) |
| `check:nax-error` | 104 violations (baseline 104) |
| `check:file-sizes` | 16 oversized (baseline 17 — one below baseline) |
| `check:logger-storyid` / `check:no-control-bytes` / `check:alias-internals` | 0 violations |

---

## What changed in this revision

**2026-08-30 update:** status only — no finding was re-graded. The second remediation sweep shipped
as PR #1768 (`fbf37eb72`), closing the nine deferrals the first sweep had held back. The ledger below
moves them from Deferred to Shipped; 12 findings remain deferred, all of them needing a human ruling
or a verification approach other than a runtime AC.

Every CRITICAL, HIGH and MEDIUM finding was re-verified by reading the cited source. Two were
falsified by direct experiment, three were misfiled by path or severity, and two pairs were
duplicates of each other.

| Change | Findings | Reason |
|:---|:---|:---|
| **Retracted (core claim false)** | BUG-1, BUG-2 | The read-after-exit pipe-buffer deadlock does not occur on Bun. Demonstrated, not argued — see below. Residual *missing-timeout* defect retained as one LOW (BUG-1r). |
| Severity lowered | BUG-5 (HIGH→MED), SEC-11 (MED→LOW), TYPE-17 (MED→LOW), PERF-19 (MED→LOW) | Over-graded relative to demonstrated impact. |
| Recategorised | SEC-35 (Security→Bug) | Forging the sentinel corrupts a literal string; it cannot leak or resolve an env var. Not a security issue. |
| Merged duplicates | MEM-20 ≡ BUG-40 · MEM-22 ≡ ENH-39 | Same file, same lines, filed twice. |
| Path corrected | BUG-13, BUG-36 | Cited under `src/execution/operations/` and `src/execution/`; actual paths are `src/operations/` and `src/execution/escalation/`. |
| Claim narrowed | BUG-13, BUG-14, MEM-1, MEM-22 | Verifiable core kept; unverified or inaccurate framing dropped (details in each entry). |
| Claim widened | BUG-3 | Non-rectified merge conflicts also produce no `StoryMetric` at all — a second gap the original missed. |

Finding count: 47 → **45** (BUG-1 and BUG-2 retracted and merged into one residual LOW, two duplicate pairs collapsed). Note `MEM-1` and `BUG-1r` are distinct findings that happen to share the number 1.

---

## Status — as of 2026-08-30, all three tranches merged

All 45 findings are accounted for below. Nothing is silently dropped: a finding is
either shipped or deferred with a stated reason.

| | Count | Where it stands |
|:---|---:|:---|
| **Shipped — P0/P1** | 5 | PR [#1766](https://github.com/nathapp-io/nax/pull/1766), merged as `b78c75d28` |
| **Shipped — sweep 1** | 19 | PR [#1767](https://github.com/nathapp-io/nax/pull/1767), merged as `10d95e332` — `nax run -f review-remediation-sweep`, 6/6 stories passed |
| **Shipped — sweep 2** | 9 | PR [#1768](https://github.com/nathapp-io/nax/pull/1768), merged as `fbf37eb72` — `nax run -f review-remediation-sweep-2`, 5/5 stories passed |
| **Deferred** | 12 | Recorded here with reasons. No remediation-shaped finding is left open; what remains needs a human decision or a different verification approach. |

### Shipped — PR #1766

| ID | Fix |
|:---|:---|
| BUG-3 | Non-rectified parallel merge conflicts now emit `story:failed`, append progress, and get a `StoryMetric`. The missing metric was found while fixing the event gap and was not in the original finding. |
| MEM-1 | `setupRun` wrapped from `installCrashHandlers` onward; the catch calls `cleanupCrashHandlers()` and `await runtime.close()`. The redundant EXEC-2 site-specific call was removed. |
| MEM-4 | Worktree dependency provisioning spawns `detached: true` and kills the process group. |
| BUG-10 | `Logger.close()` calls `flushSync()`; `bin/nax.ts` awaits `flush()` before `resetLogger()` so the sync flush cannot race an in-flight batched append. |
| BUG-13 | `classifyMutant`'s `SUCCESS` arm requires test evidence; a zero-test success is `errored`, not `survived`. |

A post-implementation quality review of those five produced five more findings. Two did not
survive verification — a claimed exception-propagation path through `appendProgress` and
`pipelineEventBus.emit`, both of which swallow internally — and are recorded as rejected rather
than fixed. The three real ones shipped in the same PR.

### Shipped — PR #1767 (`review-remediation-sweep`)

Six independent stories, 35 acceptance criteria, no dependency chain. Selection rule: a finding
is in only if it changes a behaviour a runtime test can observe.

**Run outcome** (`run-2026-08-29T07-57-51-812Z`): 6/6 passed, 8 iterations, 3 h 53 m, $46.76 of a
$60 budget. Post-run acceptance passed. Post-run regression flagged `test/unit/config/dotenv.test.ts`
and `test/unit/acceptance/hardening.test.ts`; both were reconciled before merge and are green on
`main` (26 pass / 0 fail, re-run for this update).

| Story | Findings | Cost |
|:---|:---|---:|
| US-001 — bounded subprocess deadlines | BUG-1r, BUG-5, BUG-16 | $19.36 |
| US-002 — path and shape validation at boundaries | TYPE-18, SEC-11, SEC-26 | $2.81 |
| US-003 — unrepresentable and forgeable values | BUG-9, BUG-35, SEC-33 | $9.02 |
| US-004 — NaxError contract in the loaders | BUG-8, TYPE-32, STYLE-46 | $0.95 |
| US-005 — truthful reporting | BUG-29, BUG-30, BUG-28, BUG-23, BUG-14 | $5.56 |
| US-006 — acceptance pipeline | BUG-6, BUG-7 | $4.50 |

Two rounds of auditing preceded the plan. A contradiction pass found three blockers — two
acceptance criteria that were unsatisfiable or vacuous as written, and a three-way disagreement
between the Design, an AC and the Seams section — plus two claims that were false against the
code and were settled by running them. A `nax plan` fidelity check then found that both
`### Modifies` entries had been silently dropped, which would have deadlocked US-006: its AC-1
inverts an assertion in `test/unit/acceptance/hardening.test.ts` that the implementer would not
have been authorised to touch. `bun run spec:lint` now catches that class before a plan is paid for.

### Shipped — PR #1768 (`review-remediation-sweep-2`)

The nine small deferrals held back from the first sweep, each re-verified as still present on
`main` at `10d95e332` before planning. Five independent stories, 37 runtime acceptance criteria,
no dependency chain. Same selection rule as the first sweep: a finding is in only if it changes a
behaviour a runtime test can observe. Stories were grouped so that no two touch the same file,
since the parallel batches merge per story.

**Run outcome** (`run-2026-08-29T15-52-49-405Z`): 5/5 passed, 6 iterations, 2 h 3 m, $13.87 of a
$60 budget — well under the first sweep's $46.76, as expected for nine LOW findings. Post-run
acceptance and regression both passed.

| Story | Findings | Files | Cost |
|:---|:---|:---|---:|
| US-001 — surface worktree and changed-file git failures | MEM-20, BUG-34 | `worktree/manager.ts`, `verification/smart-runner.ts` | $5.90 |
| US-002 — loud TDD git failures, bounded cleanup grace | BUG-21, MEM-22 | `tdd/isolation.ts`, `tdd/cleanup.ts` | $1.57 |
| US-003 — native filesystem APIs for context and test scanning | ENH-24, BUG-41 | `cli/init-context.ts`, `context/test-scanner.ts` | $2.39 |
| US-004 — call-time logger, restorable webhook globals | BUG-25, ENH-27 | `interaction/plugins/telegram.ts`, `…/webhook-serve-compat.ts` | $1.83 |
| US-005 — idle-watchdog defaults from their SSOT | BUG-47 | `agents/manager.ts`, `agents/retry/hop-retry-policy.ts`, `runtime/middleware/idle-watchdog/`, `agents/acp/spawn-client.ts` | $1.43 |

**Path corrections found while re-verifying:** BUG-47's second site is
`src/agents/retry/hop-retry-policy.ts`, not `src/retry/`; and there was a **third** inline `?? 3` at
`src/runtime/middleware/idle-watchdog.ts:213` the original finding missed. Grounding US-005 also
turned up more than BUG-47 as filed — `idle-watchdog.ts` re-defaulted three fields against values
contradicting `DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG` (30 against 900, 0 against 1800, 5 against 10),
so a config omitting them got a 30-second idle timeout where the schema promises fifteen minutes.

`spec-review` found four issues before the run and all four were closed in the spec: a module path
that does not exist (`src/errors/index.ts` — it is `src/errors.ts`), a parameter typed as `NaxConfig`
that no caller could supply, an AC naming a private method, and one stale reference.

Post-run `nax-finish` review produced further fixes, shipped in the same PR: a compat-shim leak when
`Bun.serve()` throws, `initPackage`'s `mkdir` failure now wrapped as a `NaxError`, the compat-shim
restore capturing originals at module load rather than install time, and `initPackage`'s
`bunFileExists` guard skipping the wrap when `naxDir` is a regular file. One finding — converting the
`idle-watchdog` barrel import — was attempted and reverted: it reopens a real import cycle that
`check:import-cycles` catches, so the nested-barrel alias is kept instead.

A CI `test:coverage` regression on `webhook.ts` (47.93% against an 80% floor) was diagnosed as an
instrumentation artifact, not a coverage gap: an AC test re-imported the module under a cache-busting
specifier, and Bun cannot merge line hits across two instances of the same source. Fixed at the root
cause with a test-only `_resetServePortZeroCompatForTests()` export.

### Deferred

| ID | Reason |
|:---|:---|
| BUG-15 | The correct rates are facts about the outside world no test here can establish; a model supplying them from recollection replaces a known-wrong number with an unknown-wrong one. Needs a human with a current price list. |
| SEC-12 | Every candidate fix changes the permission-resolution contract — architecture, not remediation. |
| TYPE-17, TYPE-38, BUG-36 | Type-annotation and cosmetic corrections with no observable runtime behaviour, so none can be expressed as a runtime acceptance criterion. Handing them to an autonomous run produces prose contracts no AC pins, which is the shape that deadlocks stories in adversarial review. |
| BUG-37 | Exercising the uncaughtException/unhandledRejection deadline requires driving real process teardown, which cannot be asserted safely from inside the suite that would host the test. |
| PERF-19, PERF-31 | Performance work whose only honest acceptance criterion is a timing threshold; timing assertions are flaky in CI. |
| STYLE-42, STYLE-43 | A deletion and a consolidation whose blast radius needs a human decision about what the code was for. |
| STYLE-44 | 16 grandfathered oversized files — a standing ratchet, not a discrete fix. |
| ENH-45 | `resolvePermissions` failing **open** to `approve-all` when `permissionProfile` is unset is the documented default; the sibling `default:` arm failing *closed* to `approve-reads` is the same class of decision as SEC-12. Changing either disposition is a permission-contract choice, not remediation — deferred with SEC-12 for a human ruling. |

---

## Retraction: the `git ls-files` deadlock (was BUG-1 CRITICAL / BUG-2 HIGH)

**Original claim:** reading `proc.stdout` only *after* `await proc.exited` deadlocks once output
exceeds the ~64 KB OS pipe buffer, hanging the whole run unconditionally on any repo with
>~1,000 tracked files.

**Falsified.** Bun's `Subprocess` drains a piped `stdout` into an internal buffer as the child
writes; `proc.exited` resolves and the full output is readable afterwards. Two independent probes
on Bun 1.4.0 (the pinned runtime):

```
# probe 1 — the exact code path, in this repo
git ls-files → exit 0, 141,209 bytes, 9 ms      (141 KB — 2.2× the claimed 64 KB limit)

# probe 2 — read-after-exit at scale
  1 MB → exit 0, 1,048,576 bytes,    41 ms
 16 MB → exit 0, 16,777,216 bytes,  522 ms
128 MB → exit 0, 134,217,728 bytes, 5,416 ms
```

There was also a standing disconfirmation the original review walked past: this repo has 3,268
tracked files / 141 KB of `git ls-files` output, and `detect/index.ts:121` runs the Tier-3 scan on
**every** detection pass. If the finding were true, nax could never have completed a run in its own
repository.

The in-repo comments the finding cited (`executor.ts:94-97`, `git.ts:92-95`) are about a *different*
shape — draining before `await` is still correct discipline for spawns that must stay killable, since
a `SIGKILL` deadline needs the exit promise to be the thing being raced. That rationale does not make
the un-drained form deadlock.

**What survives** is the second, unglamorous half of the finding: neither scan has a deadline. A
wedged `git` (NFS stall, filesystem hang, credential prompt on a `core.askpass` repo) blocks the run
with no error and no log. That is filed below as **BUG-1r (LOW)**.

---

## Overall Grade: A− (86/100)

| Dimension | Score | Notes |
|:---|:---|:---|
| Security | 18/20 | No injection/secrets/logging issues; one unvalidated CLI path arg, one hardcoded permission literal, one spoofable tool-result boundary |
| Reliability | 17/20 | 4 verified hang/leak/event-loss paths in less-travelled code; core paths exemplary |
| API Design | 17/20 | Consistent `_deps` seams, typed surfaces; a few unsafe casts at boundaries |
| Code Quality | 16/20 | 16 grandfathered oversized files; some drift/duplication; small dead-code surface |
| Best Practices | 18/20 | Convention enforcement is scripted and self-checked; outstanding bug archaeology in comments |

*(Was B+ 82/100. The revision is +4: the retracted CRITICAL and the BUG-5 downgrade lift Reliability
15→17; SEC-35's recategorisation and SEC-11's downgrade lift Security 17→18.)*

An unusually disciplined codebase: typed spawns everywhere, centralized secret redaction, fail-closed
plugin loading, and issue-numbered rationale comments that repeatedly turned out to be accurate under
scrutiny. The defects that remain concentrate in (a) subprocess lifecycle edge paths that skip the
deadline/process-group discipline the codebase applies elsewhere, and (b) event/state asymmetries in
parallel execution and acceptance hardening.

---

## Findings

Every entry below carries a verification verdict:
**CONFIRMED** = re-read at the cited lines this pass · **CONFIRMED (narrowed)** = core holds, some
framing corrected · **PARTIAL** = one half proven, one half not checked.

### HIGH

#### MEM-1: Setup-phase throw leaks installed crash handlers and never closes the runtime
**Severity:** HIGH | **Category:** Memory/Resource leak | **Verdict:** CONFIRMED (narrowed)
**Proof:** `src/execution/lifecycle/run-setup.ts` — `createRuntime` at 234, `installCrashHandlers` at
261, the lock-guarded `try` opens at 382, and its only cleanup is:
```ts
} catch (error) {
  // Release lock before re-throwing so the directory isn't permanently locked
  await releaseLock(workdir);
  throw error;
}
```
Unprotected throw sites between handler installation and that `try`: `loadPRD` (286),
`initInteractionChain` (289), the `.nax/` auto-migration block (~300–330), `sweepOrphans` (360) — plus
everything inside the 382 block, which releases the lock but never touches handlers or runtime.
`runner.ts`'s `finally` (335–393), which calls `cleanupCrashHandlers()` and `runtime.close()`, is only
reached after `runSetupPhase` *resolves*; the setup-throw catch at `runner.ts:226` restores the
orchestrator dep stubs and rethrows without either call.
**Correction to the original:** it stated the `catch` was "the only cleanup in the file". It is not —
the lock-acquisition-failure path at 366–379 calls `cleanupCrashHandlers()` explicitly, with a written
EXEC-2 rationale describing this exact hazard. That makes the gap *more* interesting, not less: the
one path someone thought about is handled, and every sibling path was missed.
**Risk:** SIGTERM/SIGINT/SIGHUP/uncaughtException/unhandledRejection handlers stay installed for the
process lifetime, bound to a run that never started — in-process consumers (tests, embedded TUI/watch)
hit stale teardown (`pidRegistry.killAll()`, `process.exit(130)`) on a later signal.
`runtime.close()` (`src/runtime/index.ts:240,384-385`) never runs, so agentManager/sessionManager leak.
**Fix:** wrap the whole `setupRun` body — from `installCrashHandlers` onward — in try/catch calling
`cleanupCrashHandlers()` and `await runtime.close()` before rethrowing. The EXEC-2 call at 377 then
becomes redundant and should be deleted rather than left as a second source of truth.

#### BUG-3: Parallel merge-conflict failures never emit `story:failed` — stale `story:completed` persists
**Severity:** HIGH | **Category:** Bug (state corruption) | **Verdict:** CONFIRMED (widened)
**Proof:** `src/execution/unified-executor.ts:738-752`
```ts
for (const conflict of batchResult.mergeConflicts) {
  if (conflict.rectified) {
    markStoryPassed(prd, conflict.story.id);
  } else {
    markStoryFailed(prd, conflict.story.id, undefined, "merge-conflict");
  }
}
```
For a story whose worktree pipeline passed, `completionStage` already emitted `story:completed` on the
process-global bus (`completion.ts:164-181`); `skipCompletionEvents` is set only on the rectification
*re-run* (`merge-conflict-rectify.ts:140`). When the merge then conflicts and rectification fails, only
`markStoryFailed` runs — no `story:failed`, no `appendProgress`, no human-review trigger. `story:failed`
has 5 emit sites (`pipeline-result-handler.ts:121,401`, `escalation/tier-outcome.ts:74,141`,
`escalation/tier-escalation.ts:294`); none is on the parallel-conflict path. The sequential path fixed
this exact hazard and documents it (`pipeline-result-handler.ts:117-129`: *"Without this correction
every reporter, hook and the TUI keeps showing a success the PRD no longer claims"*).
**Additional gap found this pass:** `unified-executor.ts:429-451` synthesizes a `StoryMetric` only for
`conflict.rectified === true`. A non-rectified conflict therefore vanishes from `allStoryMetrics`
entirely — so it is missing from per-agent cost attribution and the run rollup as well as from the bus.
**Fix:** in `reconcileBatchOutcome` (or the executor loop that owns the bus), mirror `failStoryAfterMerge`
for non-rectified conflicts: emit `story:failed`, `appendProgress`, and synthesize the metric.

#### MEM-4: Worktree dependency provisioning orphans grandchild processes on timeout
**Severity:** HIGH | **Category:** Memory/Resource | **Verdict:** CONFIRMED
**Proof:** `src/worktree/dependencies.ts:59-78`
```ts
const proc = _worktreeDependencyDeps.spawn(argv, {
  cwd: worktreeRoot, stdout: "pipe", stderr: "pipe",
});
...
const timerId = setTimeout(() => {
  timedOut = true;
  try { proc.kill("SIGKILL"); } catch { ... }
}, timeoutMs);
```
Spawned **without `detached: true`**, so `proc.kill()` reaches only the direct child. `pnpm`/`npm`
install postinstall grandchildren survive the timeout and keep running against a worktree nax is about
to delete. The file already got the *other* half of the discipline right — it has the BUG-13 deadline
and drains both pipes concurrently with a written rationale — which makes the missing process group
the one gap. The established pattern is `executor.ts:86-92` (`detached: true` + `killProcessGroup(-pid)`),
documented as ORPHAN-1 in `bun-deps.ts:27-35` with exactly this failure mode.
**Fix:** spawn with `detached: true` and kill via `killProcessGroup(proc.pid, "SIGKILL")`.

---

### MEDIUM

#### BUG-5: TDD rollback git spawns have no timeout
**Severity:** MEDIUM *(was HIGH)* | **Category:** Bug | **Verdict:** CONFIRMED (narrowed)
**Proof:** `src/tdd/rollback.ts:34-44` and `captureSnapshotRef` (93)
```ts
const resetProc = _rollbackDeps.spawn(["git", "reset", "--hard", ref], {
  cwd: workdir, stdout: "pipe", stderr: "pipe",
});
const [exitCode, resetStderr] = await Promise.all([resetProc.exited, new Response(resetProc.stderr).text()]);
```
No deadline, no kill timer, on either spawn. Reachable from `execution/post-run.ts:492` and
`non-blocking-fix.ts:412` (both call sites verified). This is the hang class hardened everywhere else
— every other git call routes through `gitWithTimeout`, per BUG-5/BUG-31/BUG-13.
**Downgraded from HIGH for two reasons.** First, the original's second charge — "`stdout` piped but
never drained" — is void given the retraction above; it costs a buffered read, not a hang. Second,
`git reset --hard` and `git rev-parse HEAD` are among the least hang-prone git verbs there are (local,
no network, no hooks by default), so the residual exposure is a wedged filesystem, not a routine one.
The inconsistency is still worth closing: this is the last unbounded git in the tree.
**Fix:** route both through `gitWithTimeout`.

#### BUG-6: Acceptance hardening drops discard-only results — re-runs forever
**Category:** Bug (wasted spend) | **Verdict:** CONFIRMED
**Proof:** `src/acceptance/hardening.ts:289-291`
```ts
if (result.promoted.length > 0) {
  await _hardeningDeps.savePRD(ctx.prd, ctx.prdPath);
}
```
`processPackageGroup` writes `story.suggestedCriteria = toDiscard.length > 0 ? toDiscard : undefined`
on every pass (line 254), including discard-only ones — but the PRD persists only on promotion. The
next run's filter (`s.suggestedCriteria && s.suggestedCriteria.length > 0`, line 264) re-selects the
identical stories and re-pays an LLM refine + generate + test spawn. Where *every* suggestion is
discarded this repeats every run indefinitely; in-memory state also diverges from disk.
**Fix:** `if (result.promoted.length > 0 || result.discarded.length > 0)`.

#### BUG-7: AC text interpolated unescaped into generated (and executed) test-code string literals
**Category:** Bug | **Verdict:** CONFIRMED
**Proof:** `src/acceptance/generator-helpers.ts:113-120`
```ts
return `  test("${ac.id}: ${ac.text}", async () => {
    // TODO: Implement acceptance test for ${ac.id}
    // ${ac.text}
```
`ac.text` reaches here from LLM refinement output (`hardening.ts:148` feeds `c.refined` back in), so
it is not authored text under review. Any `"`, `\` or newline produces a syntactically invalid
generated test; the acceptance gate then fails on a generator artifact and the fix loop burns retries
chasing it. The Go/Python/Rust variants sanitize identifiers but still place raw AC text in line-comment
bodies, where a newline escapes comment context.
**Fix:** emit the test title through `JSON.stringify` so escaping is the serializer's job, not the template's; strip control characters before interpolating into comment bodies.

#### BUG-8: `loadPRD` surfaces raw `SyntaxError` on corrupt JSON — no stage context
**Category:** Convention / error handling | **Verdict:** CONFIRMED (widened)
**Proof:** `src/prd/index.ts:70`
```ts
const prd: PRD = await Bun.file(path).json();
```
No try/catch. Two lines below (72–77) the missing-`userStories` case *does* get
`NaxError("PRD_INVALID", { stage: "prd", path })`, and `loadJsonFileStrict` (`utils/json-file.ts:63-73`)
exists precisely for this. **Also in the same function:** the oversize guard at 61–68 throws a bare
`Error`, so this is two convention breaks in nine lines, not one. Corroborating: the `check:nax-error`
gate carries 104 grandfathered violations (re-confirmed this pass).
**Fix:** route through `loadJsonFileStrict`, or wrap and rethrow `NaxError("PRD_INVALID", { stage: "prd", path, cause })`; give the size guard a code too.

#### BUG-9: Schedule duration overflow → `Invalid Date` silently "fires immediately" or throws `RangeError`
**Category:** Bug | **Verdict:** CONFIRMED (executed)
**Proof:** `src/schedule/parse.ts:60-68`
```ts
if (totalMs <= 0) return { ok: false, error: `Duration must be positive. ${ACCEPTED}` };
return { ok: true, target: new Date(now.getTime() + totalMs) };
```
`DURATION_RE` (`^(\d+[smhd])+$`) accepts unbounded digits and only the `<= 0` case is rejected.
Executed directly against the real module:
```
parseSchedule("999999999999d", new Date())
→ { ok: true, target: null }   // JSON.stringify of an Invalid Date
→ target.getTime() === NaN
```
Downstream, `wait.ts:39-45` reads `targetMs = NaN`: the `quiet` branch calls `target.toISOString()`
first and throws an unhandled `RangeError: Invalid time value`; the non-quiet branch evaluates
`deps.now() < NaN` as false, skips the wait loop entirely and starts the run **immediately** — the
exact opposite of what the user asked for.
**Fix:** `if (!Number.isFinite(target.getTime())) return { ok: false, error: ... }`, plus a `MAX_SCHEDULE_DURATION_MS` cap.

#### BUG-10: `resetLogger()` silently drops buffered log lines
**Category:** Bug (observability) | **Verdict:** CONFIRMED
**Proof:** `src/logger/logger.ts:330-332, 433-438`
```ts
close(): void {
  // No-op: Bun handles file operations internally
}
...
export function resetLogger(): void {
  if (instance) { instance.close(); }
  instance = null;
}
```
`close()` is a no-op, so whatever sits in `pendingLines` (70, 213) is lost. `flushSync()` exists
(254–256) and is the correct call — it is already wired to `process.on("exit")` at 381. Triggered in
production, not just tests: `bin/nax.ts:479` calls `resetLogger()` between the plan and run phases
(`nax run --plan`), and the exit handler then reads the *new* instance, so the plan JSONL tail is
unrecoverable.
**Fix:** call `instance.flushSync()` before nulling; correct the stale `close()` doc comment (writes go through `node:fs/promises`, not `Bun.write`).

#### SEC-12: Hardcoded `"approve-reads"` permission decision outside `permissions.ts`
**Category:** Security / convention | **Verdict:** CONFIRMED
**Proof:** `src/agents/acp/adapter-close-physical.ts:26-28`
```ts
} else if (client.loadSession) {
  const session = await client.loadSession(handle, agentName, "approve-reads");
```
Direct violation of the project's own mandatory rule (literal permission mode outside `permissions.ts`).
Mitigation verified by reading the whole function: the session is loaded only to `close()` on the very
next line, so no agent work runs under the mode. It is nonetheless a permission decision taken outside
the SSOT, invisible to `resolvePermissions`, and it contradicts the configured profile.
**Fix:** thread resolved permissions into `closePhysicalSession`, or export a named close-path constant from `permissions.ts` with the exemption documented at the definition.

#### BUG-13: `classifyMutant` has no zero-test guard — a scoped run that runs nothing reports "survived"
**Category:** Bug (false signal) | **Verdict:** PARTIAL — general claim CONFIRMED, Rust specifics unverified
**Path corrected:** `src/operations/mutation-check.ts` (the original cited `src/execution/operations/`, which does not exist).
**Proof:** `src/verification/mutation/classify.ts:13-26`
```ts
case "TEST_FAILURE": {
  const hasValidEvidence = passCount >= 0 && failCount >= 0 && (passCount > 0 || failCount > 0);
  return hasValidEvidence ? "killed" : "errored";
}
case "SUCCESS":
  return "survived";
```
The `TEST_FAILURE` arm demands evidence that tests actually ran; the `SUCCESS` arm does not. So any
scoped command that exits 0 having executed zero tests classifies every mutant as **survived** —
reporting the worst possible test-quality verdict from a run that proves nothing.
`verify-scoped.ts:283-295` guards precisely this (`ranNoTests` → full-suite rerun, #1207, with the
rationale *"a zero-test scoped run is inconclusive, not a pass"*); `mutation-check.ts:385` calls
`classifyMutant(result)` with no counterpart.
**Narrowed:** the original framed this as Rust-specific, via `src/**/*.rs` in
`framework-defaults.ts:133-139` (confirmed present) making Cargo read positionals as test-name filters.
That chain is plausible but I did not verify how the scoped command is assembled for Cargo, so it is
not asserted here. The `classifyMutant` gap is language-independent and stands on its own — Go's
`[no test files]` and Mocha-on-a-spec-less-file (both named in the `verify-scoped` comment as real,
observed cases) reach it identically.
**Fix:** apply the #1207 guard in `classifyMutant` — `SUCCESS` with `passCount + failCount === 0` is `"errored"`, not `"survived"`. Separately consider dropping `src/**/*.rs` from run-selection patterns.

#### BUG-14: Registry `"aider"` has no ACP entry — falls through to the `claude` binary
**Category:** Bug (false reporting) | **Verdict:** CONFIRMED (narrowed)
**Proof:** `src/agents/registry.ts:13`
```ts
export const KNOWN_AGENT_NAMES = ["claude", "codex", "opencode", "gemini", "aider", "pi"];
```
`src/agents/acp/agent-entries.ts:12-44` defines rows for claude, codex, gemini, opencode, pi — no aider —
so `resolveRegistryEntry("aider")` returns `DEFAULT_ENTRY` (`binary: "claude"`, `displayName: "ACP Agent"`).
`agentsListCommand` (`src/cli/agents.ts:28-38`) maps over `KNOWN_AGENT_NAMES`, so `nax agents` prints a
row whose `installed` flag and `version` string are both `claude`'s.
**Correction to the original:** it said the row "reports aider installed". The row's display name is
actually `ACP Agent`, not `aider` — which is arguably worse, since the name gives no clue which agent
it is describing while the version and install state are silently borrowed from another binary.
**The fix is already sitting in the file:** `ACP_ADAPTER_NAMES` (`agent-entries.ts:61`) is exported as
*"names that have a real ACP adapter entry (subset of KNOWN_AGENT_NAMES)"* and has no consumers in
`src/`. Either iterate that in `agentsListCommand`, or remove `"aider"` and make
`resolveRegistryEntry` fail loudly instead of defaulting.

#### BUG-15: Stale `MODEL_PRICING` rows misprice real spend 16–33×
**Category:** Bug (cost accuracy) | **Verdict:** CONFIRMED
**Proof:** `src/agents/cost/pricing.ts:52-58`
```ts
"gemini-2.5-pro": { input: 0.075, output: 0.3 },   // actual: $1.25 / $10 per 1M → 16.7× / 33×
"gemini-2-pro":   { input: 0.075, output: 0.3 },   // not a real model id
codex:            { input: 0.02,  output: 0.06 },  // 2023 code-davinci rate
"code-davinci-002": { input: 0.02, output: 0.06 }, // model retired
```
The Claude rows are current; the Gemini and Codex rows are not. Because `pricingSource: "model-rates"`
attribution only detects a *missing* row, a wrong row is stamped authoritative in the cost ledger with
no downstream signal that it is wrong.
**Fix:** refresh the rate card; add a `RATE_CARD_REVIEWED` date constant so staleness is visible in review.

#### BUG-16: Unbounded `acpx sessions close` spawn in merge-conflict rectification
**Category:** Bug (hang) | **Verdict:** CONFIRMED (narrowed)
**Proof:** `src/execution/merge-conflict-rectify.ts:30-34`
```ts
const proc = typedSpawn(cmd, { stdout: "pipe", stderr: "pipe" });
await proc.exited;
```
No deadline and no `pidRegistry` registration. A hung `acpx` stalls `runParallelBatch`'s sequential
rectification loop indefinitely, and because the process was never registered it is also invisible to
the crash-time `killAll` sweep — so the signal path cannot rescue it either. Every sibling subprocess
path in the tree is bounded. The original also charged "stderr never drained"; per the retraction
above that is not a hang contributor and has been dropped.
**Fix:** race `proc.exited` against a deadline with SIGKILL (reuse `awaitProcExit`); register with `pidRegistry`.

#### TYPE-18: Per-package mono config cast without validation — a string `testFilePatterns` explodes into per-character globs
**Category:** Type safety / config | **Verdict:** CONFIRMED
**Proof:** `src/test-runners/resolver.ts:155-161`
```ts
type MonoConfigShape = { execution?: { smartTestRunner?: { testFilePatterns?: string[] } } };
const perPkgPatterns = (monoRaw as MonoConfigShape)?.execution?.smartTestRunner?.testFilePatterns;
if (perPkgPatterns !== undefined) { validateGlobs(perPkgPatterns, "resolver"); ... }
```
`validateGlobs` (108–114) iterates with `for..of` and checks `typeof p !== "string" || p.trim().length === 0`.
Given `"testFilePatterns": "test/**/*.ts"` (a string, which the cast asserts away), `for..of` yields
*characters* — each a non-empty string, so each passes — and 13 single-character globs are compiled and
returned as the package's "per-package" patterns, silently. The cast is the whole defect: this is raw
JSON off disk, and the project's own config rule requires Zod at the boundary.
**Fix:** `Array.isArray(perPkgPatterns) && perPkgPatterns.every(p => typeof p === "string")` before `validateGlobs` — or better, a Zod schema, matching the SSOT rule.

---

### LOW (condensed)

| ID | Category | Location | Issue | Verdict |
|:---|:---|:---|:---|:---|
| BUG-1r | Bug | `test-runners/detect/file-scan.ts:64-78`, `directory-scan.ts:40-48` | **Residue of the retracted BUG-1/BUG-2.** Neither `git ls-files` spawn has a deadline; a wedged git blocks the run with no error and no log, while every other git in the tree routes through `gitWithTimeout` | CONFIRMED |
| MEM-20 | Resource | `worktree/manager.ts:136-144` | `create()` conflates real removal failures with "not found": `catch { /* remove() throws if worktree doesn't exist — that's fine */ }` also swallows the `NaxError` `remove()` throws at 243-248 on genuine failure. **(Absorbs the original BUG-40, which was this same finding filed twice.)** | CONFIRMED |
| BUG-21 | Bug | `tdd/isolation.ts:147` | `const { stdout: output } = await runGitBounded(...)` discards `exitCode`; a failed numstat yields an empty map, which lite mode reads as hard isolation violations via `?? POSITIVE_INFINITY` | CONFIRMED (exit-code discard read directly; caller default not re-read) |
| MEM-22 | Perf | `tdd/cleanup.ts:121` | `await _cleanupDeps.sleep(gracePeriodMs)` — a full uncancellable 3 s wait even when the process group is already dead. `executor.ts:126-138` fixed this same pattern. **(Absorbs ENH-39 — same line, filed twice.)** Note: *not* unconditional, as the original claimed — the `if (!sentSigterm) return` guard at 115 means it runs only when SIGTERM actually went out | CONFIRMED (narrowed) |
| BUG-23 | Bug | `test-runners/parser.ts:251-257` | Jest dedupe key is `f.testName` alone, omitting `file` — identically-named tests in different suites collapse into one | CONFIRMED |
| ENH-24 | Enh | `cli/init-context.ts:16-19, 53-90` | Shells out to `mkdir`/`find` instead of Bun-native APIs; `mkdir` exit code ignored; a `find` failure silently yields an empty "Project Structure" section | CONFIRMED |
| BUG-25 | Bug | `interaction/plugins/telegram.ts:56` | `private readonly logger = getSafeLogger()` caches at construction — a plugin constructed pre-`initLogger` holds a permanently-noop logger. `webhook.ts:161-166` resolves at call time and documents why | CONFIRMED |
| SEC-26 | Security | `commands/curator.ts:310-313` | `curator commit` joins unvalidated `options.runId` into a path; the `status`/`dryrun` siblings validate against `runIds.includes` first | CONFIRMED |
| ENH-27 | Enh | `interaction/plugins/webhook-serve-compat.ts:120-139` | `globalThis.fetch` / `Bun.serve` monkey-patch is installed behind a one-way flag with no restore function — every in-process `fetch` pays the check for the process lifetime | CONFIRMED |
| BUG-28 | Bug | `precheck/checks-warnings.ts:61-84` | `Number.parseInt(parts[3], 10)` unchecked → `NaNGB` in a user-facing message; wrapped `df` device names unhandled | CONFIRMED |
| BUG-29 | Bug | `runtime/cost-aggregator.ts:267-298` | `byAgent`/`byStage`/`byStory` iterate only `_events`/`_inFlightEvents`, never `_errors` → `errorCount` is always 0 in those breakdowns, while `snapshot()` (262-265) and `byCall` fold errors in correctly | CONFIRMED |
| BUG-30 | Bug | `bakeoff/contestant.ts:71-85` | `tierEscalations += m.attempts` sums attempts, inflating by 1 per first-pass story. Field is latent (unread by `ranking.ts`) but wrong | CONFIRMED |
| PERF-31 | Perf | `acceptance/generator-helpers.ts:152-166` | Python fallback regex is O(n²) on large LLM output; greedy `[\s\S]+` fallbacks over-capture to EOF | CONFIRMED |
| TYPE-32 | Type | `prd/validate.ts:26-42` | Four bare `Error` throws bypass the NaxError contract, while three siblings in the same file (54, 62, 69) use `NaxError` with codes | CONFIRMED |
| SEC-33 | Security | `agents/acp/adapter-output.ts:119-125` | Context-tool result wrapper interpolates agent-controlled `name` and raw `result` into a `<nax_tool_result name="…">` boundary unescaped — either side can emit a closing tag to spoof the frame | CONFIRMED |
| BUG-34 | Bug | `verification/smart-runner.ts:512-514, 571-573` | Git errors swallowed into `[]` with zero logging; `flake-baseline-diff.ts:50-53` documents having to preflight around this blind spot | CONFIRMED |
| BUG-35 | Bug *(was SEC-35)* | `config/dotenv.ts:143-162` | The `$$` escape sentinel `__DOLLAR_ESCAPE__` is a fixed literal, so a config value containing it is rewritten to `$…` by the restore pass. **Recategorised from Security:** the forgery lands *after* both resolve passes, so it can neither leak nor resolve an env var — it corrupts a literal string. A collision-resistant sentinel (or an index-based placeholder) fixes it | CONFIRMED (recategorised) |
| BUG-36 | Bug | `execution/escalation/tier-escalation.ts:275-277` *(path corrected)* | `const failedPrd = { ...prd }` then `markStoryFailed(failedPrd, ...)` mutates the story object shared with `prd` — the copy is cosmetic and misleads the reader into thinking the original is untouched | CONFIRMED |
| BUG-37 | Bug | `execution/crash-signals.ts:136-209` | uncaughtException/unhandledRejection teardown has no hard exit deadline, while the signal path has a 10 s one | CONFIRMED |
| TYPE-17 | Type | `execution/parallel-batch.ts:157, 229, 332` | `{ ...pipelineContext, story, stories, workdir } as PipelineContext` — `pipelineContext` is typed `Omit<…, "story" \| "stories" \| "workdir" \| "routing">` (line 55) and the spread never restores `routing`, which `pipeline/types.ts:80` declares required. *Downgraded from MEDIUM:* the sole consumer, `iteration-runner.ts:262`, already reads `pipelineResult.context.routing ?? routing`, so today the lie is contained | CONFIRMED (downgraded) |
| TYPE-38 | Type | `execution/runner-execution.ts:40-41`, `runner-completion.ts:54-55` | `statusWriter: any` justified by `// biome-ignore … StatusWriter interface varies by platform` — it does not; the concrete class is at `status-writer.ts:61` | CONFIRMED |
| PERF-19 | Perf | `runtime/cost-aggregator.ts:288-298` | `byStory()` re-reduces every recorded event on each call, and `metrics/tracker.ts:314,367` call it once per story and once per batch → O(stories × events). `drain()` (363-389) also re-serializes the whole committed set per pass, up to `MAX_DRAIN_PASSES`. *Downgraded from MEDIUM:* both are bounded by per-run event volume and the drain runs once, at run end | CONFIRMED (downgraded) |
| SEC-11 | Security | `cli/init-context.ts:305-308`, `cli/generate.ts:96-97` | `--package` is joined into a path with no validation (`join` collapses `..`), so `nax init --package ../../evil` writes outside the repo. `bin/nax.ts` declares the option at 135/1269/1546 and passes it through unchecked. *Downgraded from MEDIUM:* the only actor is the user running their own CLI against their own filesystem — there is no privilege boundary to cross. It still breaks a containment invariant the project guards elsewhere (BUG-35 `bin/nax.ts:233-241`, SEC-28 `commands/resume.ts:157-166`) and `isRelativeAndSafe` (`utils/path-security.ts:60-66`) is the ready-made fix | CONFIRMED (downgraded) |
| BUG-41 | Bug | `context/test-scanner.ts:221-224, 275` | Spawns `test -d` per candidate directory (resolved via PATH — the original cited `/usr/bin/test`) instead of the already-imported in-process `stat`; fails on minimal containers and Windows | CONFIRMED |
| STYLE-42 | Style | `queue/manager.ts:41-51` | `QueueManager` is dead production code — referenced only by the barrel and its own test — and `dequeue()` never claims, aliasing `peek()`, so the contract would hand the same story to every worker | CONFIRMED |
| STYLE-43 | Style | `routing/router.ts:116-127` vs `308-331` | Deprecated `routeTask` has drifted from the live `keywordRoute` (different reasoning strings); keyword lists duplicated with `classify.ts:45-69` | CONFIRMED |
| STYLE-44 | Style | repo-wide | 16 grandfathered oversized files against a baseline of 17, incl. `bin/nax.ts` 1824, `agents/manager.ts` 782, `prompts/builders/rectifier-builder.ts` 902; `runFixCycle` ~470 lines against a ≤30 rule; two conflicting documented limits (400 vs 600 in `session/manager-run.ts:4`) | CONFIRMED (`bun run lint` re-run this pass) |
| ENH-45 | Enh | `config/permissions.ts:39-43` | `resolvePermissions` fails **open** to `approve-all` when `permissionProfile` is unset — the documented default, but silent; note the `default:` arm one branch below fails *closed* to `approve-reads`, so the file has both dispositions and neither is logged | CONFIRMED |
| STYLE-46 | Style | `config/loader.ts:252-259` | Root-config validation throws a bare `Error` while the per-package path at 567-571 correctly uses `NaxError` | CONFIRMED |
| BUG-47 | Bug | `agents/manager.ts:462` + `retry/hop-retry-policy.ts:85` | Idle-watchdog retry cap re-defaulted inline (`?? 3`) in two files that must stay in sync despite `DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG` existing; `spawn-client.ts:92` uses falsy `\|\|`, mapping an explicit `0` to 1800 | CONFIRMED |

---

## Explicitly Verified as Clean (checked, not assumed)

- **No `eval`/`new Function`**, no hardcoded secret shapes, no shell-string execution with user input — all 51 spawn sites use argv arrays
- **Zero `dangerouslySkipPermissions` / `skipPermissions`** in `src/` (pinned by test); the `resolvePermissions` SSOT genuinely holds across all dispatch paths
- **Secret redaction** centralized (`src/logger/redact.ts`): runs on message + data before all sinks; PEM/JWT/Bearer/URL-credential coverage; log injection defended (JSONL encoding + OSC/CSI stripping)
- **Webhook server hardened**: loopback-only bind, HMAC-SHA256 + `timingSafeEqual`, two-bucket rate limiting, streamed bounded body read
- **Prototype pollution**: `DANGEROUS_MERGE_KEYS` guard in config deep-merge; profile-name traversal validation
- **`typecheck` clean, `lint` clean** — both re-run for this revision, exit 0, all 10 convention gates at or under baseline
- Timer hygiene and `Promise.race` cleanup are exemplary in core paths (`resume-hypute.ts`, `completion.ts`, `event-bus.ts` — losers always `.catch`ed, timers cleared in `finally`)
- TUI: all 13 bus subscriptions unwound in one cleanup; intervals/listeners removed; agent-controlled strings stripped of control bytes before render
- **Subprocess stdout buffering**: `await proc.exited` before reading a piped stream is safe on Bun (verified to 128 MB). It is a legibility and killability wart, not a correctness bug — see the retraction

---

## Priority Fix Order

The original priority ordering has been resolved into the status ledger above: P0 and P1
shipped in #1766, and P2/P3 were triaged into the two `review-remediation-sweep` specs (shipped in
#1767 and #1768) or deferred with a reason. What remains open:

| Order | Where | Contents |
|:---|:---|:---|
| Done | PR #1766 → #1767 → #1768 | The 5 P0/P1 fixes, then 19 sweep findings as six stories, then the 9 remaining as five file-disjoint stories |
| Human input needed | — | BUG-15 (a current price list) and SEC-12 + ENH-45 (permission-contract decisions) |
| Standing | — | STYLE-44's oversized-file ratchet; the type-only and timing-bound findings, which want a different verification approach than a runtime AC |

---

## Methodology

**First pass (original):** 6 parallel subsystem reviews covering all 43 `src/` directories + `bin/`,
each finding read in surrounding context so guards were checked before reporting.

**Second pass (this revision):** every CRITICAL/HIGH/MEDIUM finding re-read at its cited lines, plus a
spot-check of 24 of the 27 LOW entries. Two findings were tested by execution rather than by reading —
`parseSchedule("999999999999d")` against the real module, and the pipe-buffer hypothesis against three
output sizes up to 128 MB. The second of those falsified the review's only CRITICAL.

The lesson worth keeping: BUG-1 was argued from a code shape plus a corroborating in-repo comment, and
both were real — the shape is there and the comment says what it says. What was missing was the
disconfirming observation sitting in plain view, that nax runs in this repository every day and this
repository is 2.2× over the claimed limit. A finding that predicts the tool cannot work should be
tested against the fact that it does before it is graded CRITICAL.

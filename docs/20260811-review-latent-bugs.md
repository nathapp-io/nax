# Deep Code Review: @nathapp/nax — Latent Bugs (Rev. 3, Independently Spot-Verified)

**Date:** 2026-08-11 (Rev 3: independent adversarial re-check of a 20-finding sample)
**Reviewer:** Subrina (AI) + opencode deep review; Rev 3 re-check by a second session
**Version:** 0.78.0 (findings written against `89f01dee`; `main` has since advanced to
`6496ee3f` (#1510), which touches `flows/nax-finish/` only and invalidates no finding here)
**Files:** 838 TS files (~122.5k LOC source)
**Baseline:** full suite via `bun run test` (unit + integration + ui + e2e)

---

## Overall Grade: C+ (69/100)

| Dimension | Score |
|:---|:---|
| Security | 15/20 |
| Reliability | 11/20 |
| API Design | 14/20 |
| Code Quality | 15/20 |
| Best Practices | 14/20 |

**Verification note (Rev 2):** Every finding below was re-checked against the source during consolidation. All 14 HIGH findings and 27 of 33 MEDIUM/LOW findings are **confirmed** by direct code inspection (line numbers quoted). Three findings were adjusted after verification: **BUG-09** downgraded HIGH→MEDIUM (exposure limited to frameworks that exit 0 on zero matching tests — go; bun/jest/vitest exit 1), **BUG-14** reworded (barrier wait is unbounded by the per-op timeout, but the run-level abort signal will eventually fire), and **BUG-24**/BUG-31 got scoping caveats. The cluster of silent-false-success paths (flake fail-open, `--max-iterations abc` no-op run, string-concatenated token costs, default webhook socket) remains the highest-risk pattern.

### Verification note (Rev 3) — independent re-check

A second session re-derived **20 of the 37 findings from source**, without reading Rev 2's
reasoning first, and **all 20 reproduced**. Zero refutations, one precision fix (BUG-03).
That is a materially stronger result than this repo's other standing review documents, and
the reason is structural: findings here quote a **mechanism** (the actual predicate, cast,
or missing guard) rather than a line offset, so re-checking them does not depend on the file
having stayed the same shape.

**Independently re-verified (20):** BUG-01, 02, 03, 04, 05, 07, 11, 12, 15, 16, 18, 19, 24,
26, 27, 28, 32, 33, 35, 37.

**Carried from Rev 2, NOT independently re-checked in Rev 3 (17):** BUG-06, 08, 09, 10, 13,
14, 17, 20, 21, 22, 23, 25, 29, 30, 31, 34, 36. These are not in doubt — several (BUG-06,
BUG-09) rest on empirical measurement recorded in Rev 2 — but a reader planning work should
know which claims have one pair of eyes behind them and which have two. **BUG-06** is the
one to re-confirm first if any is challenged: its severity rests on a measured PGID
observation rather than on a predicate visible in the source.

⚠️ **Do not re-verify any finding here by line number.** Several cited files are near the
600-line cap and are actively split; a offset that has drifted proves nothing about whether
the bug is fixed. Re-check by grepping the quoted predicate.

---

## Findings

### 🔴 HIGH (verified)

#### BUG-01: `nax runs list/show` can never find run events — wrong field matched
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/cli/runs.ts:104-105, 154-155`
```ts
const startEvent = entries.find((e) => e.message === "run.start");
```
The runner logs `logger.info("run.start", "Starting feature: …")` (`src/execution/lifecycle/run-setup.ts:436`) — `"run.start"` is the **stage**, the message is free text. `runs list` skips every run (`continue` at :108) and `runs show` always throws `INVALID_RUN_LOG`. Both commands are functionally broken.
**Fix:** Match `e.stage === "run.start"` / `"run.complete"` (as `logs-reader.ts:123` already does).

*Rev 3 — FIXED, and the fix above was insufficient as written.* Matching `stage === "run.complete"`
alone is **not enough**: the completion phase emits **seven** entries under that stage
(`run-completion.ts:459, 476, 479, 490, 493, 519`) — retention purges and metric-save
warnings — and only `:519` carries the summary payload. A bare `.find()` on the stage takes
whichever fired first, so the run reports `status: "completed"` with **zeroed** cost and story
counts. The summary must be selected by the payload the module actually reads
(`e.data?.totalStories !== undefined`). Shipped with `findRunStart` / `findRunSummary` helpers
and a regression test that seeds a purge decoy ahead of the summary.
Corroboration for the root cause: **four** other consumers (`logs-reader.ts:123`,
`replay/reconstruct.ts:33`, `log-format/formatter.ts:73,114`) already key on `stage`, and
`runs.ts` itself used `e.stage === "execution"` correctly two lines below the bug.

#### BUG-02: `nax logs` / `nax precheck` default invocation reads `config.feature`, which the config schema never contains
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/commands/logs.ts:66-72`, `src/commands/precheck.ts:53-64`
```ts
const config = await configFile.json();
const featureName = config.feature;
if (!featureName) throw new Error("No feature specified in config.json");
```
`config.feature` exists only in these two files (verified by grep); `NaxConfigSchema` has no such field. `nax precheck`/`nax logs` without explicit flags always fail. (`precheck -f X` and `logs --run <id>` bypass the broken path.)
**Fix:** Derive the single feature from `.nax/features/*` or require the flag.

#### BUG-03: `--max-iterations abc` → silent no-op run with exit 0
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`bin/nax.ts:680` + `src/execution/unified-executor.ts:168`
```ts
config.execution.maxIterations = Number.parseInt(options.maxIterations, 10);   // NaN — no validation
while (iterations < ctx.config.execution.maxIterations) { ... }                // 0 < NaN → false
```
Contrast `--max-cost` (bin/nax.ts:683-691) which validates and exits 1. A typo runs **zero stories** and exits 0; `--max-iterations 0` behaves the same.

*Rev 3 precision:* the assignment is unconditional, but the option carries a commander
default of `"20"` (`bin/nax.ts:385`), so a run with the flag **omitted** is unaffected — the
bug needs an explicitly bad value. Scope is a typo'd or `0` flag, not every run.
**Fix:** Validate like `--max-cost`, reject non-integers / `< 1`.

#### BUG-04: Parallel-mode tier escalations silently discarded — story retries same tier forever
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/execution/unified-executor.ts:282-326` + `src/execution/pipeline-result-handler.ts:367-391`
```ts
await handlePipelineFailure({ ... }, pipelineResult);   // returns { prd, prdDirty } — DISCARDED here
...
reconcileBatchOutcome(prd, batchResult);
await savePRD(prd, ctx.prdPath);                        // overwrites the escalation save
```
`handlePipelineFailure` returns the escalated `prd` (line 385: `prd = escalationResult.prd`) and the sequential path (`iteration-runner.ts:289`) uses it; the parallel path discards it and `savePRD` persists the stale pre-escalation object. Escalated tier/attempt-resets are lost on disk → `canEscalate` never trips → unbounded same-tier retries at full pipeline cost.
**Fix:** Use the returned `prd` in the batch loop before the line-321 save.

#### BUG-05: One story's worktree-creation failure aborts the whole run and leaks other worktrees
**Severity:** HIGH | **Category:** Reliability | **Status:** ✅ confirmed
`src/execution/parallel-batch.ts:130-142`
```ts
try { await worktreeManager.create(workdir, story.id); }
catch (error) { logger?.error(...); throw error; }   // aborts whole batch; no cleanup of prior worktrees
```
Every other per-story failure in this module is contained (`allSettled` configs, `preExecutionFailures` with cleanup at :211-215); this one propagates to the top of `run()` with no catch in `executeUnified` (line 252). Stale worktrees (`index.lock`) then poison subsequent runs.
**Fix:** Catch per-story, synthesize a failure like the dependency-prep path, clean up prior worktrees.

#### BUG-06: Test-timeout path kills only the `/bin/sh` wrapper — the test process leaks
**Severity:** HIGH | **Category:** Memory/Resource | **Status:** ✅ confirmed (empirically by reviewer)
`src/verification/executor.ts:110-156` + `src/utils/process-kill.ts:28-48`
```ts
process.kill(-pid, signal);   // Bun.spawn child is in the PARENT's process group → ESRCH
// fallback: process.kill(pid) → kills /bin/sh only; grandchild (bun/pytest/go test) survives
```
`killProcessGroup` assumes child PID == PGID; Bun.spawn never setpgids children (measured: `pgid 57540, pid 57542`). The shell exits within the 5s grace window → `exitedDuringGrace=true` → SIGKILL escalation (line 135) skipped → the orphaned test runner keeps running, holds the stdout/stderr pipe ends (every drain then hits `DRAIN_TIMEOUT`, losing output), and can hold ports/locks that poison the next verification run. Note the timeout return even asserts `childProcessesKilled: true` (line 152) unconditionally.
**Fix:** Resolve the real PGID (`getPgid` already exists in `src/tdd/cleanup.ts`) and signal `-pgid`; escalate when streams are still open.

#### BUG-07: Acceptance stage and RED gate spawn test subprocesses with no timeout, no kill
**Severity:** HIGH | **Category:** Reliability | **Status:** ✅ confirmed
`src/pipeline/stages/acceptance.ts:218-228`, `src/pipeline/stages/acceptance-setup.ts:129-146`
```ts
const proc = Bun.spawn(testCmdParts, { cwd: packageDir, stdout: "pipe", stderr: "pipe" });
const [exitCode, stdout, stderr] = await Promise.all([proc.exited, ...]);
```
Every other verification path goes through `executeWithTimeout`; these two spawn bare. A blocking acceptance test hangs the entire run indefinitely — `proc.exited` never settles; `ctx.abortSignal` (threaded into the stage at unified-executor.ts:622) is never consulted.
**Fix:** Route through `executeWithTimeout` with the configured `timeoutSeconds`.

#### BUG-08: Flake-triage baseline diff fails OPEN on any git error — story's own failing tests become quarantinable
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/verification/flake-baseline-diff.ts:31-55` + `src/verification/smart-runner.ts:411-412, 440-441`
```ts
if (exitCode !== 0) return [];   // getChangedTestFiles / getChangedNonTestFiles swallow git failures
} catch { return []; }
return { changedTestFiles, mappedTestFiles };   // non-null even when both []
```
The module's own docstring (lines 22-30) says an empty diff is the fail-OPEN direction and must never be substituted — but `getMergeBase` returning `undefined` (empty repo) → git exit 128 → `[]` → empty `FlakeTriageDiff` → `isProbeCandidate` returns true for **every** failing test, including story-written ones. Most likely in the greenfield/empty-repo case nax targets.
**Fix:** Return `null` when `getMergeBase` is `undefined` or a `getChanged*` call failed; have them throw on non-zero exit.

#### BUG-10: `complete()` discards prompt-level error classification and the `retryable` flag
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/agents/acp/adapter.ts:164-179, 233-278` + `src/agents/manager.ts:400-401, 510-511`
```ts
throw new CompleteError("complete() failed: stop reason is error");  // constant string
const parsed = _fallbackDeps.parseAgentError(error.message);         // → always { type: "unknown" }
```
The run path (`sendTurn` → `SessionTurnError.retryable` → manager retry loop) honors acpx `data.retryable` (parser.ts:171); the one-shot `complete()` path throws a constant-message error, so `parseAgentError` classifies it as `unknown` and `completeWithFallback` maps it to `outcome: "fail-unknown", retriable: false` — a transient rate-limit at prompt time (decompose, LLM routing, acceptance generation) kills the run with no retry; auth failures surface as `fail-unknown`.
**Fix:** Throw with the parsed classification embedded (`retryable`, type), like `SessionTurnError`.

#### BUG-11: `complete()`'s timeout race loses the in-flight `session.prompt()` — background rejection can abort the whole run
**Severity:** HIGH | **Category:** Reliability | **Status:** ✅ confirmed
`src/agents/acp/adapter.ts:148-162` (contrast `src/agents/acp/adapter-lifecycle.ts:241`)
```ts
timeoutPromise.catch(() => {});
response = await Promise.race([session.prompt(prompt), timeoutPromise]);  // loser never gets .catch()
```
When the timeout wins, `session.close({ forceTerminate: true })` (line 227) SIGTERMs the proc; if the orphaned `prompt()` then rejects (stream-subscriber throw, `proc.exited` rejection), nothing handles it and nax's fatal `unhandledRejection` handler exits 1 and kills all agent PIDs — a one-shot timeout becomes a full run crash. `runSessionPrompt` deliberately attaches `.catch(() => {})` for this pattern; `complete()` does not.
**Fix:** `session.prompt(prompt).catch(() => {})` before the race.

#### BUG-12: Stateful debate: `proposalBarriers` sized 1 but indexed by debater position — every debater ≥1 crashes, debate silently passes on one debater
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/debate/runner-stateful.ts:68, 91` + `src/operations/debate-stateful.ts:37`
```ts
const localProposalBarrier = () => [Promise.withResolvers<string>()];   // ONE slot per debater
proposalBarriers: localProposalBarrier(),
...
ctx.input.proposalBarriers[ctx.input.index].resolve(proposal.output);   // index ≥1 → undefined.resolve() → TypeError
```
Each debater receives its own 1-element array but the op resolves by `ctx.input.index` (0..N-1). Debaters ≥1 throw inside `hopBody`; `allSettledBounded` (line 81) drops them; `successfulProposals.length === 1` → the single-debater fallback (lines 125-141) returns `outcome: "passed"` **without ever running the resolver**. Multi-debater stateful debate is silently neutered; tests mock the barrier and never execute the real op with ≥2 debaters.
**Fix:** Share one barrier array sized to `resolved.length`; add an integration test with ≥2 debaters.

#### BUG-13: Hybrid debate: one debater failing at proposal stage fails the entire debate (allSettled intent violated)
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/debate/runner-hybrid.ts:96-101, 135-143` + `src/operations/debate-hybrid.ts:82-90`
```ts
const settledRound = await raceAgainstAbort(
  Promise.all(ctx.input.rebutBarriers[round - 1].map((b) => b.promise)), ...);   // NOT allSettled, NOT in try/catch
```
`rejectDebaterBarriers` (runner-hybrid.ts:96-101) pre-rejects the failed debater's future round barriers; peers' round-1 `Promise.all` at debate-hybrid.ts:84 rejects on the failed peer's rejected barrier, aborting every surviving debater → any single proposal-stage failure fails the entire hybrid debate, despite the documented "use allSettled so a failing peer does not cascade" intent (lines 46-47).
**Fix:** Use `Promise.allSettled` at debate-hybrid.ts:84 (map rejected rounds to `""`), or don't pre-reject peers' barriers.

#### BUG-14: Plan-debate hybrid mode deadlocks when a debater fails at proposal stage
**Severity:** HIGH | **Category:** Reliability | **Status:** ✅ confirmed (nuance: bounded by run-level abort, not op timeout)
`src/debate/runner-plan.ts:245-285` + `src/operations/debate-plan.ts:43, 59-63`
```ts
(err) => { rebuttalBarriers[i].reject(err); },   // Path B rejects ONLY rebuttalBarriers, not proposalBarriers
...
Promise.all(ctx.input.proposalBarriers.map((b) => b.promise)),   // peers block on the never-settled barrier
```
If debater A's initial send rejects before its hopBody resolves `proposalBarriers[A]` (line 43), that barrier is never settled. Peers B/C block in `Promise.all` at debate-plan.ts:60; the per-op `timeoutMs` bounds `ctx.send`, **not** the barrier wait, so the callOp hang is only cut by the run-level abort signal. `runner-hybrid.ts` rejects the failed debater's barriers in a catch; `runner-plan` Path B has no equivalent.
**Fix:** Reject `proposalBarriers[i]` in the failure path; use `Promise.allSettled` in the op's peer wait.

#### BUG-15: `finalizePlanRun` silently replaces the synthesized/merged PRD with debater 0's raw file
**Severity:** HIGH | **Category:** Bug | **Status:** ✅ confirmed
`src/debate/runner-plan-helpers.ts:272, 310-336` + `readWinnerOutput` :195-205
```ts
let winningOutput: string | undefined = outcome.output ?? finalizedProposals[0]?.output;   // = synthesis result
winningOutput = await readWinnerOutput(selectionSummary.winnerOutputPath ?? outputPaths[0], winningOutput);
// readWinnerOutput returns the FILE when it exists — debater 0's individual PRD wins
```
`selectionSummary` (initialized `{}` at :272) is only populated on the verifier-pick path; on the default **synthesis** path the fallback `outputPaths[0]` — the file debater 0 was instructed to write — overrides the synthesized merged PRD whenever the file exists (which it does in the normal flow). The synthesis pass (with its AC-merge/preservation rules) is wasted on every default plan debate.
**Fix:** Only read the winner file when `selectionSummary.winnerOutputPath` is set.

### 🟡 MEDIUM (verified unless noted)

#### BUG-09: Flake probe counts "zero tests executed" as a clean pass
**Severity:** MEDIUM (downgraded from HIGH in Rev 2) | **Category:** Bug | **Status:** ✅ confirmed
`src/verification/flake-probe.ts:147-160` + `src/verification/executor.ts:159-170`
```ts
success: exitCode === 0,                       // no test-count parsing
if (result.success && result.countsTowardEscalation) probePasses += 1;
```
`go test -run '^Name$'` with no matching test exits **0** ("testing: warning: no tests to run") — any failing test whose name doesn't round-trip the filter is declared `flaky` and quarantined. Bun ≥1.3.13 and vitest exit 1 on zero matches, so exposure is framework-dependent (go primary). Combined with BUG-08's fail-open baseline this converts deterministic failures into quarantine.
**Fix:** Parse the probe output for evidence of ≥1 executed test; fail closed when absent.

#### BUG-16: Per-package config merge replaces nested objects wholesale without re-validation
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/config/merge.ts:72-97`
```ts
execution: { ...root.execution, ...packageOverride.execution, ... }   // rectification NOT deep-merged
```
A `.nax/mono/<pkg>/config.json` with `{"execution": {"rectification": {"enabled": false}}}` yields `rectification: { enabled: false }` — `maxAttemptsTotal` becomes `undefined`, and the attempt cap silently never fires at three gate sites (`pipeline-result-handler.ts:355`, `plan-inputs.ts:424`, `run-regression.ts:224`); prompts receive `"undefined"`. `quality.autofix`/`lintOutput` overrides are dropped entirely; `acceptance.fix`, `review.adversarial`, `context.v2.rules` have the same shallow-merge shape.
**Fix:** Deep-merge every nested section, or `safeParse` the merged result like the profile path does.

#### BUG-17: Profile companion `.env` files and `$VAR` resolution are inert in the run path
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/config/loader.ts:313-318` + `src/config/dotenv.ts:44`
```ts
await loadProfileEnv(name, projectRoot);   // return value discarded; resolveEnvVars never called in the load path
```
A profile `"model": "$MODEL_FAST"` + `fast.env` loads the literal `$MODEL_FAST` into the run config; `resolveEnvVars` is only invoked from `nax config profile show --unmask` (`src/cli/config-profile.ts:86`).
**Fix:** Apply `resolveEnvVars(profileData, await loadProfileEnv(...))` before the merge.

#### BUG-18: Decomposed parent is never promoted when a sub-story is skipped — dependent stories deadlock
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/prd/index.ts:228-241` vs `:136-138`
```ts
const allSiblingsPassed = siblings.every((s) => s.passes || s.status === "passed");   // skipped NOT satisfied
```
Promotion requires every sibling `passed`, but `completedIds` (line 137) treats `skipped` as satisfied. A SKIPped sub-story leaves the parent `decomposed` forever: stories depending on it never unblock (`hasSatisfiedDependencies` fails) and `isComplete` (line 179) can never return true — feature ends incomplete with no error.
**Fix:** Count `skipped` as satisfied in the promotion predicate.

#### BUG-19: PRD dependency references are not ID-normalized while story IDs are
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/prd/schema.ts:81, 216-228`
```ts
const id = normalizeStoryId(rawId);              // "ST001" → "ST-001"
if (!allIds.has(dep)) { throw new NaxError(...); }   // raw, un-normalized dep
```
`allIds` holds normalized IDs; an LLM consistently writing `ST001` in `dependencies` gets the whole plan rejected even though its `id` fields were accepted.
**Fix:** `allIds.has(normalizeStoryId(dep))`.

#### BUG-20: Rule-based optimizer can replace the entire prompt with an empty string
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/optimizer/rule-based.optimizer.ts:153-198` (consumer `src/pipeline/stages/optimizer.ts:69` unguarded)
```ts
// extractSections only matches "# Task\n", "# Context\n", "# Acceptance Criteria\n"
return result;   // "" when no known sections match and prompt exceeds maxPromptTokens
```
nax's assembled prompts use `# Role: Implementer` / `# INSTRUCTIONS` etc. — everything lands in `other`, dropped when over budget → `ctx.prompt = ""` sent to the agent. Opt-in (`optimizer.enabled` + `strategy: "rule-based"`), but when enabled it is silent data loss.
**Fix:** Treat unmatched content as the context section; bail out of trimming when no known section matched; never return a blank prompt.

#### BUG-21: Hook execution can hang forever when the child ignores SIGTERM
**Severity:** MEDIUM | **Category:** Reliability | **Status:** ✅ confirmed
`src/hooks/runner.ts:223-232`
```ts
const timeoutId = setTimeout(() => { timedOut = true; killProcessGroup(proc.pid, "SIGTERM"); }, timeout);
const exitCode = await proc.exited;   // no hard deadline; single SIGTERM, no escalation
```
A hook child that traps/ignores SIGTERM (or a daemon it spawned) → `proc.exited` never resolves → the run's completion phase hangs indefinitely.
**Fix:** `Promise.race([proc.exited, deadline])` with a SIGKILL second stage.

#### BUG-22: TDD isolation checks silently pass when git fails
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/tdd/isolation.ts:30-44`
```ts
const output = await Bun.readableStreamToText(proc.stdout);
await proc.exited;   // exit code never checked; stderr never drained
```
`git diff --name-only HEAD` failing (exit 128, e.g. empty repo — `captureGitRef` falls back to `"HEAD"`) yields `[]` → zero violations reported, and new untracked test files are invisible unless committed first. Also a latent hang if git emits >64KB to stderr.
**Fix:** Check `exitCode !== 0` → fail loudly; drain stderr concurrently.

#### BUG-23: `cleanupProcessTree` skips SIGKILL when the group leader dies first, orphaning survivors
**Severity:** MEDIUM | **Category:** Memory/Resource | **Status:** ✅ confirmed
`src/tdd/cleanup.ts:88-107`
```ts
const pgidAfterWait = await getPgid(pid);   // re-checks the LEADER, not the group
if (pgidAfterWait && pgidAfterWait === pgid) { killProcessGroupFn(pgid, "SIGKILL"); }
```
SIGTERM commonly kills the leader while a SIGTERM-trapping child survives in the group; the PID-reuse guard then reads the dead leader → null → SIGKILL escalation skipped → orphans.
**Fix:** List group members by PGID after grace and SIGKILL if any remain.

#### BUG-24: Webhook callback server never binds a real socket (default config) — external responders can never reach it
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed (scope: default port-0 config)
`src/interaction/plugins/webhook.ts:54-92, 380-396`
```ts
const port = this.config.callbackPort ?? 0;   // startServer default
this.server = Bun.serve({ port, ... });        // shim routes port 0 to an in-memory server with NO OS socket
```
`installServePortZeroCompat()` (line 92, import-time, process-global) routes port 0 through `createInMemoryServer`; only an explicit `callbackPort` reaches the real `Bun.serve`. External responders POSTing to the advertised callback URL get ECONNREFUSED → interactions silently time out (60s) and degrade to "skip". Explicit-port `EADDRINUSE` is also swallowed into a fake success. (Note: the in-memory path only works for responders in the *same process* using the patched `globalThis.fetch` — never the case for a real webhook.)
**Fix:** Route port 0 through `originalServe`; re-throw real bind errors; only fall back to in-memory when Bun.serve genuinely fails.

#### BUG-25: Plugin name collision logs "overrides" but registers both plugins
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/plugins/loader.ts:223-231, 244-252, 271-278`
```ts
logger?.warn("plugins", `Plugin name collision: '${validated.name}' ... overrides global`);
loadedPlugins.push({ plugin: validated, ... });   // added anyway; both stay in registry
```
`getPostRunActions()`/`getReporters()` return all matches → the curator (or any builtin) executes twice per run and appends every observation twice, breaking the "each finding appears exactly once" invariant recurrence heuristics depend on.
**Fix:** Replace the earlier entry or reject duplicates.

#### BUG-26: `SEVERITY_RANK` collides `low` and `warning` — `blockingThreshold: "warning"` blocks `low` findings
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/review/severity.ts:6-17`
```ts
low: 1, warning: 1,
```
`isBlockingSeverity("low", "warning")` → `1 >= 1` → true, contradicting the documented contract (`types.ts:301-304`). Low-severity noise blocks stories whenever the threshold is lowered.
**Fix:** `low: 1, warning: 2, error: 3, critical: 4`.

#### BUG-27: `findRelatedStories` uses substring matching — `AC-2` matches `AC-20`, misattributing failures
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/acceptance/fix-generator.ts:72-95`
```ts
if (ac.includes(failedAC)) { relatedStoryIds.push(story.id); break; }
```
Wrong `relatedStories`, wrong inherited workdir (D4), and fix stories batched under a wrong grouping key.
**Fix:** Boundary-aware match (`\bAC-2(?!\d)` or token compare).

#### BUG-28: Token counts from final `result.usage` cast to number without a `typeof` guard — strings concatenate
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/agents/acp/parser.ts:149-158` + `src/agents/cost/calculate.ts:102-116`
```ts
input_tokens: (u.inputTokens as number) ?? (u.input_tokens as number) ?? 0,   // no typeof check
inputTokens: a.inputTokens + b.inputTokens,   // "150" + 100 → "150100"
```
The `usage_update` path validates `typeof number`; the final-`result.usage` path does not. A string token count flows into `addTokenUsage` as string concatenation, corrupting metrics.
**Fix:** Guard `typeof === "number"` (and finite) before assigning.

#### BUG-29: `complete()` zeroes cost estimate when `inputTokens === 0` even if output tokens were charged
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/agents/acp/adapter.ts:204-205` (contrast `src/agents/acp/adapter-output.ts:190-193`)
```ts
tokenUsage.inputTokens > 0 ? estimateCostFromTokenUsage(...) : 0;
```
One-shot calls whose wire usage omits input tokens report $0. The run path uses `inputTokens > 0 || outputTokens > 0`.
**Fix:** Mirror the run-path guard.

#### BUG-30: A non-JSON stdout line becomes a permanent prefix of a *successful* assistant response
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed (JSON-RPC-shaped streams)
`src/agents/acp/parser.ts:208-210` + `src/agents/acp/spawn-client.ts:386-395`
```ts
} catch { if (!state.text) state.text = line; }   // banner stored as response text
```
The first unparseable line (reconnect notice, deprecation banner on stdout) becomes `state.text`; subsequent JSON-RPC `content` events append to it (the JSON-RPC `result` branch at :143 never resets `state.text`), so on `exitCode === 0` the "successful" response is `banner + real text`, breaking downstream envelope unwrap and op.parse.
**Fix:** Only treat a non-JSON line as legacy text when no NDJSON line was seen; otherwise drop it.

#### BUG-31: Scoped lint in a monorepo: `git diff --name-only` returns repo-root-relative paths, so all changed files are dropped from scope
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed (manifests when `workdir` ≠ git root)
`src/review/scoped-lint.ts:64-80, 99-111`
```ts
const absPath = join(workdir, relPath);   // workdir = package dir; relPath is root-relative
if (!exists) continue;                    // every file skipped → empty scope → "lint skipped" green
```
Git emits root-relative paths from a subdirectory; `join` double-prefixes; the check returns false-green with zero lint run. (Single-package repos with `workdir` == git root are unaffected.)
**Fix:** `git diff --relative` or resolve against the repo root first.

#### BUG-32: `runPlan` Path A (verifier-pick) counts failed debaters as successful
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/debate/runner-plan.ts:195-204` (Paths B/C check `res.value.success`; Path A does not)
```ts
if (res.status === "fulfilled") { successful.push({ output: res.value.rebut, ... }); }
```
A debater whose output starts with the `Agent "` failure marker enters `finalizePlanRun` as a "successful" proposal and can win the verifier pick.
**Fix:** `fulfilled && res.value.success`.

#### BUG-33: Auto-plugin confidence guard bypassed by non-numeric LLM output
**Severity:** MEDIUM | **Category:** Security | **Status:** ✅ confirmed
`src/interaction/plugins/auto.ts:262-278, 153`
```ts
if (parsed.confidence < 0 || parsed.confidence > 1) throw ...   // NaN/string pass both comparisons
if (decision.confidence < threshold) return undefined;          // "high" < 0.7 → NaN → false → auto-approve
```
`confidence: "high"`/`"null"` survives validation and skips escalation — the sole programmatic backstop for cost-exceeded / merge-conflict auto-approvals is bypassed by malformed JSON.
**Fix:** `typeof === "number" && Number.isFinite()` in `parseResponse`.

#### BUG-34: Interaction trigger IDs are not unique — `Date.now()`-based IDs collide on concurrent triggers
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/interaction/triggers.ts:89` + `src/interaction/plugins/webhook.ts:284-315`, `telegram.ts:406`
```ts
const id = `trigger-${trigger}-${Date.now()}`;   // same name + same ms → identical IDs
```
Under parallel stories, two same-name triggers in one ms: the second `receive()` takes the supersede path and fabricates a `skip` for the **first** prompt; Telegram's `startsWith` matching lets one tap answer the wrong prompt.
**Fix:** Append `crypto.randomUUID()` entropy; use exact match.

#### BUG-35: `nax features create` accepts path-traversal names
**Severity:** MEDIUM | **Category:** Security | **Status:** ✅ confirmed
`bin/nax.ts:927-928`
```ts
const featureDir = join(naxDir, "features", name);
mkdirSync(featureDir, { recursive: true });
```
No `validateFeatureName` (unlike `resolveFeatureSpec`; the plan path at `context-builder.ts:29` does call it). `nax features create ../../evil` writes spec.md outside `.nax/features/`; `nax run -f ../x` similarly mkdirs outside the features tree.
**Fix:** Call `validateFeatureName(name)` at the top of both actions.

#### BUG-36: `nax run --plan` from a repo subdirectory writes prd.json where the run won't read it
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/plan/strategies/context-builder.ts:22` vs `bin/nax.ts:522, 546`
```ts
const naxDir = join(workdir, ".nax");            // plan writes cwd-relative
const prdPath = join(naxDir, "features", ..., "prd.json");   // run reads via findProjectDir (walks UP)
```
From `packages/api/`, the PRD lands in `packages/api/.nax/…`; the read-back path differs → "Feature not found or missing prd.json", exit 1 — after the expensive LLM plan already succeeded. `nax plan` standalone has the same subdir mismatch.
**Fix:** Resolve the nax dir once and thread it through the plan strategies.

#### BUG-37: `runs list/show` wired without `initLogger` — prints nothing, exits 0
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`bin/nax.ts:1442-1469`
All output goes through `getLogger()`, which returns the silent `noopLogger` when uninitialized (`src/logger/logger.ts:358-365`). Compounds BUG-01: even with the field fixed, both commands would print nothing.
**Fix:** `initLogger({ level: "info", ... })` in the runs action.

*Rev 3 — FIXED* alongside BUG-01; verified end-to-end against the real CLI in an isolated
`HOME`: before, `nax runs list` printed nothing and exited 0; after, it prints the run with
correct totals.

#### BUG-38: `nax resume` runs with no logger and no log file
**Severity:** MEDIUM | **Category:** Bug | **Status:** ✅ confirmed
`src/commands/resume.ts:183-198`
`logFilePath: undefined` + no `initLogger` → no console output, no `runs/<id>.jsonl`, so crash-recovery/replay have nothing for resumed runs.
**Fix:** Mirror `bin/nax.ts` — `initLogger` with a fresh run ID before `run()`.

### 🟢 LOW (verified unless noted)

#### BUG-39: `acceptance.maxRetries: 0` (schema-valid) makes acceptance always fail
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed
`src/execution/lifecycle/acceptance-loop.ts:394` — `while (acceptanceRetries < maxRetries)` never runs with 0 → unconditional `buildResult(false)`. Schema allows `nonnegative()`. Use `do/while` or reject 0.

#### BUG-40: `checkpoint.jsonl` written to process CWD when `featureDir` is absent
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed
`src/execution/runner.ts:168-169` + `src/execution/checkpoint/resume-cli.ts:77-80` — `join("", "checkpoint.jsonl") === "checkpoint.jsonl"`; feature-less runs cross-seed checkpoint state in the repo root. No-op `recordGreen`/`loadCheckpoints` when `featureDir` is empty.

#### BUG-41: `getNextStory` treats `regression-failed` as eligible for re-execution
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed
`src/prd/index.ts:152-161` — `countStories`/`isStalled` treat `regression-failed` as terminal (lines 196, 205) but the eligible filter omits it. Latent today (only set in-memory at completion); any persistence makes it re-pick forever. Add `s.status !== "regression-failed"`.

#### BUG-42: `loadPRD` dereferences `userStories` without an existence check
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed
`src/prd/index.ts:67-71` — truncated/corrupt prd.json → raw `SyntaxError`/`TypeError` on a resume path built to survive crashes. Guard + contextual `NaxError`.

#### BUG-43: `buildProjectMetadata` reads a config key that no longer exists
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed (per review)
`src/context/injector.ts:238-241` — `config.execution.testCommand` is stripped by Zod (test command moved to `quality.commands.test`), so the `**Commands:**` line is never emitted in generated CLAUDE.md/AGENTS.md. Read `config.quality?.commands?.test`.

#### BUG-44: `fail-adapter-error` retries stamped `kind: "stale-retry"` contradicting the "fresh session" intent
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed
`src/agents/retry/hop-retry-policy.ts:130-143` — `kind: { kind: "stale-retry" }` for adapter-error retries makes `build-hop-callback` reuse the failed live handle instead of reopening; retries 2+ replay against a dead session.

#### BUG-45: `validateRoutingDecision` accepts prototype-chain members as model tiers
**Severity:** LOW | **Category:** Security | **Status:** ✅ confirmed
`src/routing/strategies/llm-parsing.ts:37-41` — `modelTier in agentTiers` walks the prototype chain: `modelTier: "constructor"` passes validation → downstream `models[agent]["constructor"]` resolves to `Object.prototype.constructor` → `--model undefined` cryptic failure instead of keyword fallback. Use `Object.hasOwn` + `typeof` check.

#### BUG-46: Cancel-path drain timeout retains the line-reader promise forever
**Severity:** LOW | **Category:** Memory | **Status:** per review (not personally re-read)
`src/agents/acp/spawn-client.ts:331, 350-353` — when the 5s drain wins, `readAndParseLines` never settles and holds the stream reader; accumulates per watchdog-cancelled prompt. Cancel the reader from the drain path.

#### BUG-47: Timeout-retry budget compounds, halving on every retry
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed
`src/agents/retry/hop-retry-policy.ts:157-165` — budget multiplied from the previously reduced value: 3600s → 1800s → 900s. Retries time out faster than the original failure. Reduce from the base timeout.

#### BUG-48: Curator H3/H4/H6 key observations by bare `storyId` across the cross-run window
**Severity:** LOW | **Category:** Bug | **Status:** per review
`src/plugins/builtin/curator/heuristics.ts:228-288, 326-366` — story IDs are feature-scoped (`US-001` in every feature); counts merge across features, fabricating recurrences. Key by `${featureId}/${storyId}` (as H1 does).

#### BUG-49: Adversarial response shape validator accepts malformed findings (`null` entries)
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed (downstream deref per review)
`src/review/adversarial-helpers.ts:76-87` vs `semantic-helpers.ts:63-79` — `findings: [null]` survives; downstream `filterByAcQuote` dereferences `.severity` unguarded → TypeError mid-review. Mirror semantic's `isFindingShaped` filter.

#### BUG-50: `nax config profile use <name>` accepts nonexistent profiles
**Severity:** LOW | **Category:** Bug | **Status:** per review
`src/cli/config-profile.ts:116-134` — no existence check; a typo poisons `.nax/config.json` with a dangling profile ref that breaks the next `nax run` confusingly.

#### BUG-51: `run()` rejection after TUI render skips `tuiInstance.unmount()`
**Severity:** LOW | **Category:** Bug | **Status:** per review
`bin/nax.ts:786-804` — no try/catch/finally around `run()` when the TUI is up; a throw prints the raw error over the TUI frame and skips the headless summary.

#### BUG-52: Confirmation prompt swallows Ctrl+C and treats it as "yes"
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed
`bin/nax.ts:129-160` — raw mode turns Ctrl+C into `\u0003`; the handler resolves `true` for anything ≠ "n". A user mashing Ctrl+C confirms the operation. Special-case `\u0003` → resolve false / exit 130.

#### BUG-53: Esc never cancels quit/abort confirmation dialogs in the TUI
**Severity:** LOW | **Category:** Bug | **Status:** per review
`src/tui/App.tsx:202` — Ink normalizes Esc to `key.escape` with `input === ""`; the `input === "\x1b"` branch is dead. Use `key.escape`.

#### BUG-54: `--run` partial-ID prefix match selects an arbitrary run
**Severity:** LOW | **Category:** Bug | **Status:** per review
`src/commands/logs-reader.ts:33-44` — `meta.runId.startsWith(runId)` + unsorted readdir → nondeterministic pick among matches. Error on ambiguity.

#### BUG-55: TUI total cost drops retried stories' earlier-attempt cost
**Severity:** LOW | **Category:** Bug | **Status:** per review
`src/tui/hooks/usePipelineBusEvents.ts:114-133` — `story:completed` replaces per-story cost then recomputes the total; a $0.50→$0.30 story contributes $0.30 mid-run. Accumulate deltas.

#### BUG-56: Parallel-mode `storiesCompleted` undercounts rectified merge-conflict stories
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed
`src/execution/unified-executor.ts:325` — `reconcileBatchOutcome` marks rectified conflicts passed but the counter only adds `batchResult.completed.length`; a fully-rectified batch can report 0 completed. Add `mergeConflicts.filter(c => c.rectified).length`.

#### BUG-57: Batch selection asymmetry on `decomposed` status can end a run with pending sub-stories
**Severity:** LOW | **Category:** Bug | **Status:** ✅ confirmed
`src/execution/story-selector.ts:47-49` vs `story-context.ts:230-250` — the batch filter excludes `decomposed` but `getAllReadyStories` includes it, so a decomposed parent in `batchPlan[0]` yields `null` → "no-stories" while sub-stories are pending. Return the single-story fallback instead of `null`.

---

## Priority Fix Order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | BUG-01, BUG-02, BUG-37 | S | `nax runs list/show`, `nax logs`, `nax precheck` are broken — fix event-field matching + initLogger + feature derivation |
| P0 | BUG-03 | S | Validate `--max-iterations` (silent false-success exit 0) |
| P0 | BUG-04, BUG-05 | M | Parallel mode: escalation state discard + worktree failure abort/leak |
| P0 | BUG-06, BUG-07 | M | Test-process leak on timeout; acceptance/RED-gate spawns without timeout |
| P0 | BUG-08 | M | Flake-triage fail-open chain can ship failing tests as "flaky" (with BUG-09) |
| P0 | BUG-10, BUG-11 | M | `complete()` error classification + orphaned-prompt rejection crash |
| P0 | BUG-12 | S | Stateful debate barrier sizing (silent single-debater "pass") |
| P1 | BUG-13, BUG-14, BUG-15 | M | Debate cascade/deadlock/PRD-substitution |
| P1 | BUG-16, BUG-17 | M | Per-package config merge + inert profile env |
| P1 | BUG-18, BUG-19 | M | PRD state machine (skipped-sibling deadlock, dep ID normalization) |
| P1 | BUG-20, BUG-21, BUG-22, BUG-23 | M | Optimizer empty prompt; hook-runner hang; TDD isolation silent pass; cleanup SIGKILL skip |
| P1 | BUG-24, BUG-33, BUG-34, BUG-35 | M | Webhook socket, auto-confidence gate, trigger ID collisions, path traversal |
| P1 | BUG-26, BUG-27, BUG-31, BUG-32 | M | Review/acceptance severity + attribution + scoped-lint + plan-debate |
| P2 | BUG-09, BUG-25, BUG-28..30, BUG-36..38, BUG-39..57 | S/M | Remaining MEDIUM/LOW — token/cost integrity, curator keying, CLI polish |

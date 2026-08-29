# SPEC: Review Remediation Sweep

<!-- spec-writing: completed-through-phase-6 -->

## Summary

Close 19 verified findings from the 2026-08-29 deep code review (`docs/20260829-review-nax.md`) that remain open after the P0/P1 fixes shipped in #1766. Every finding selected here changes a behaviour that a runtime test can observe: an unbounded subprocess that must now be bounded, a malformed input that must now be rejected, a raw `Error` that must now carry a code, a reported number that must now be correct, or agent-controlled text that must now be escaped. Findings whose only expression is a type annotation, a comment, or a judgement call about the outside world are deferred — see Out of Scope.

## Motivation

The review verified each of these against source, and the P0/P1 tranche shipped separately. What is left is a long tail with a common shape: in each case the codebase already solves the same problem correctly somewhere else, and one site was missed.

- **Three subprocess spawns have no deadline** while every other spawn in the tree is bounded. A wedged `git` or `acpx` blocks the run with no error and no log.
- **Four boundaries accept values they should reject.** A per-package `testFilePatterns` string is iterated character-by-character into per-character globs; `--package` and `curator commit --run-id` are joined into paths unvalidated; a schedule duration overflows to `Invalid Date` and either starts the run immediately or throws an unhandled `RangeError`.
- **Six error sites throw bare `Error`** where a sibling call in the same file throws `NaxError` with a code, leaving callers unable to branch on failure kind.
- **Five reported numbers are wrong**: error counts are always zero in three cost breakdowns, escalations are inflated by one per story, disk space renders as `NaNGB`, same-named tests in different suites collapse into one failure, and `nax agents` prints a row for an agent that has no adapter, borrowing another binary's install state and version.
- **Two acceptance-pipeline defects waste spend and break generated code**: a discard-only hardening pass never persists, so the next run re-pays the same LLM refine, generate and test spawn — every run, indefinitely; and LLM-refined acceptance-criteria text is interpolated unescaped into generated test source, so a quote or newline produces a syntactically invalid test and the fix loop burns retries on a generator artifact.

None of these is individually urgent. Together they are the difference between a codebase whose conventions are enforced and one where the convention is aspirational.

## Design

The unifying rule: **each fix mirrors the pattern the codebase already applies elsewhere.** No new abstractions, no new exported symbols, no new files. Every story is a local correction at a site that has a working sibling to copy.

### Integration

All symbols below were opened and verified at the shapes listed.

**Read-only — existing helpers the work may reuse. None of these changes.**

- `gitWithTimeout(args: string[], workdir: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }>` — `src/utils/git.ts:71`. Spawns git with a hard deadline and SIGKILL; returns exit code 1 on timeout.
- `raceWithDeadline<T>(p: Promise<T>, deadlineMs: number): Promise<T | typeof DRAIN_TIMEOUT>` — `src/verification/executor.ts:23`.
- `killProcessGroup(pid: number, signal: NodeJS.Signals | number): boolean` — `src/utils/process-kill.ts:28`.
- `NaxError` — `src/errors.ts:11`. Constructor is `(message: string, code: string, context?: Record<string, unknown>)`.
- `isRelativeAndSafe(filePath: string): boolean` — `src/utils/path-security.ts:60`. Segment-wise `..` check plus an absolute-path gate; rejects both.
- `accumulateError(snap: CostSnapshot): CostSnapshot` — `src/runtime/cost-aggregator.ts:225`. Increments `errorCount` only.
- `CostErrorEvent` — `src/runtime/cost-aggregator.ts:74`. Carries `agentName: string` (required), `stage?: string`, `storyId?: string` — the three keys the broken breakdowns bucket on.
- `_fileScanDeps.spawn`, `_directoryScanDeps.spawn`, `_rollbackDeps.spawn` — existing injectable spawn seams.
- `buildRunInteractionHandler(options: AgentRunOptions): InteractionHandler` — `src/agents/acp/adapter-output.ts:127`. Its `onInteraction` reaches `buildContextToolResult` for a `context-tool` request, gated on `contextToolRuntime` being present **and** `contextPullTools` being non-empty.

**Changed — baseline shown only to locate the code. The Target is the interface to implement.**

- `detectFromFileScan(workdir: string): Promise<DetectionSource | null>` — `src/test-runners/detect/file-scan.ts:89`.
  - Baseline: its internal `gitLsFiles` awaits `proc.exited` with no deadline.
  - Target: signature unchanged; a child that never exits no longer prevents the promise from settling.
- `detectFromDirectoryScan(workdir: string): Promise<DetectionSource | null>` — `src/test-runners/detect/directory-scan.ts:77`. Same baseline and target.
- `rollbackToRef(workdir: string, ref: string, untrackedBefore: string[] | null): Promise<void>` and `captureSnapshotRef(workdir: string, storyId: string): Promise<SnapshotRef>` — `src/tdd/rollback.ts:30,91`.
  - Baseline: both spawn git directly with no deadline.
  - Target: signatures unchanged; both settle under a deadline when git wedges.
- `rectifyConflictedStory(options: RectifyConflictedStoryOptions): Promise<RectificationResult>` — `src/execution/merge-conflict-rectify.ts:154`.
  - Baseline: its internal `closeStaleAcpSession` calls `typedSpawn` imported inline from `../utils/bun-deps` and awaits `proc.exited` unbounded, with no injection seam.
  - Target: signature unchanged; the module gains a module-private injectable spawn seam following the `_<module>Deps` convention already used across the codebase, and a hung `acpx` no longer stalls rectification.
- `resolveTestFilePatterns` — `src/test-runners/resolver.ts`.
  - Baseline: casts raw per-package JSON to `MonoConfigShape` and passes `testFilePatterns` straight to `validateGlobs`, which iterates it; a string iterates as characters, each passing the per-element check.
  - Target: a non-array `testFilePatterns` is rejected as a configuration error rather than silently degraded.
- `loadPRD(path: string): Promise<PRD>` — `src/prd/index.ts`.
  - Baseline: the oversize guard throws a bare `Error`, and `Bun.file(path).json()` is uncaught so a corrupt file surfaces a raw `SyntaxError`.
  - Target: signature unchanged; both failures carry a `NaxError` code, as the missing-`userStories` case two lines below already does.
- `validateStoryId(id: string): void` — `src/prd/validate.ts:24`.
  - Baseline: four bare `Error` throws, while three siblings in the same file throw `NaxError` with codes.
  - Target: signature unchanged; every rejection carries a code.
- `aggregateTotals` — `src/bakeoff/contestant.ts:71`.
  - Baseline: `tierEscalations += m.attempts`, which counts the first attempt as an escalation.
  - Target: escalations are derived from attempts beyond the first. `ContestantStoryMetric` is `{ cost: number; durationMs: number; attempts: number }` — it carries no escalation field, so the count must be derived from `attempts`, not read from a new one.
- `agentsListCommand(config: NaxConfig, workdir: string): Promise<void>` — `src/cli/agents.ts:26`.
  - Baseline: maps over `KNOWN_AGENT_NAMES` (`src/agents/registry.ts:13`), which includes `"aider"`; `resolveRegistryEntry("aider")` finds no row in `AGENT_REGISTRY` and returns `DEFAULT_ENTRY`, so the row reports the `claude` binary's install state and version under the display name `ACP Agent`.
  - Target: the listing is driven by the set of names that have a real ACP adapter entry. `ACP_ADAPTER_NAMES: ReadonlySet<string>` (`src/agents/acp/agent-entries.ts:61`) already exposes exactly that set and currently has no consumer in `src/`.
  - **`KNOWN_AGENT_NAMES` itself must not change.** It is a wider set than the ACP roster on purpose: `aider` is a supported *context-generation* target with its own generator (`src/context/generators/aider.ts`) and its own member in the `generate.agents` config enum. Removing it would break `test/unit/config/generate-config-schema.test.ts` and the agent loops in `test/unit/precheck/checks-blockers-agent.test.ts`, neither of which this story owns.
- `runHardeningPass(ctx: HardeningContext): Promise<HardeningResult>` — `src/acceptance/hardening.ts`.
  - Baseline: persists only when `result.promoted.length > 0`, though `processPackageGroup` mutates `story.suggestedCriteria` on discards too.
  - Target: signature unchanged; a pass that changed the PRD persists it, whether the change was a promotion or a discard.

### Failure Handling

| Situation | Behaviour |
|:---|:---|
| A bounded subprocess exceeds its deadline | The whole process group is killed and the caller settles. Detection scans degrade to their existing empty/`null` result — a detection scan is advisory, so a timeout must not fail the run. |
| `rollbackToRef` cannot complete its reset within the deadline | Raise, as it already does for a non-zero git exit. A rollback that did not happen must never be reported as done. |
| `closeStaleAcpSession` exceeds its deadline | Swallow and continue, matching its existing best-effort contract — it is an eviction optimisation, not a correctness step. |
| A per-package `testFilePatterns` is not an array of non-empty strings | Raise a `NaxError`. Silently degrading to per-character globs is what this fixes. |
| `--package` or `--run-id` names an absolute path or escapes the repo | Reject before any path is built. |
| A schedule duration is not representable as a date | Reject at parse time with a message naming the accepted forms. |

## Out of Scope

- Refreshing the `MODEL_PRICING` rate card (review BUG-15). The Gemini and Codex rows are wrong by 16-33x, but the correct values are facts about the outside world that no test in this repo can establish; supplying them from a model's recollection would replace a known-wrong number with an unknown-wrong one. This needs a human with a current price list.
- Threading resolved permissions into `closePhysicalSession` (review SEC-12). The hardcoded `"approve-reads"` literal violates the permission SSOT rule, but every candidate fix changes the permission-resolution contract, which is architecture requiring human sign-off rather than remediation.
- Restoring the `routing` field to the synthesized failure contexts in `parallel-batch.ts` (review TYPE-17) and replacing `statusWriter: any` with the concrete `StatusWriter` type (review TYPE-38). Both are type-annotation corrections with no observable runtime behaviour, so neither can be expressed as a runtime acceptance criterion.
- Replacing the cosmetic shallow `{ ...prd }` copy in `tier-escalation.ts` (review BUG-36). The copy misleads a reader but changes no behaviour.
- Adding a hard exit deadline to the uncaughtException and unhandledRejection teardown path (review BUG-37). Exercising it requires driving real process teardown, which cannot be asserted safely from inside the suite that would host the test.
- Incremental snapshots in `CostAggregator` and the O(n^2) Python fallback regex in the acceptance generator (review PERF-19, PERF-31). Both are performance work whose only honest acceptance criterion is a timing threshold, and timing assertions are flaky in CI.
- Deleting the dead `QueueManager` (review STYLE-42) and de-duplicating the drifted `routeTask` against `keywordRoute` (review STYLE-43). Both are removals or consolidations whose blast radius needs a human decision about what the code was for.
- The remaining small findings BUG-21, BUG-25, BUG-34, BUG-41, BUG-47, MEM-20, MEM-22, ENH-24, ENH-27 and ENH-45. Each is individually valid; they are excluded to keep this spec at six stories, and remain recorded in the review document.
- Making `resolveRegistryEntry` fail loudly for an agent name that has no ACP entry, instead of silently returning `DEFAULT_ENTRY` (the second half of review BUG-14). That changes what `nax run --agent aider` does, not just what `nax agents` prints, and its blast radius reaches the agent precheck and the `generate.agents` config enum — a behaviour change needing its own decision rather than a reporting fix.
- US-002 only: symlink-based path escape is not rejected — a validated relative path that is itself a symlink out of the repo still resolves. Segment-wise validation is deliberately filesystem-blind; symlink containment lives in a different helper whose semantics this spec does not change.
- Lowering any ratchet baseline. Several stories reduce the `check:nax-error` violation count, which the gate accepts because it fails only on growth. No baseline file may be re-baselined as part of this work.

## Stories

Six stories, no dependency chain — every story is independent and they may run in any order or in parallel.

### US-001 — Bound the three remaining unbounded subprocess spawns

Every subprocess in the tree except three is bounded by a deadline. Bring those three in line so a wedged child cannot block a run indefinitely.

- Context Files: `src/utils/git.ts`, `src/verification/executor.ts`, `src/utils/process-kill.ts`
- Creates: none
- Modifies: none

### US-002 — Reject unsafe paths and malformed config shapes at CLI and config boundaries

Three boundaries accept values they should reject. Validate at the boundary, before any path is built or any glob is compiled.

- Context Files: `src/utils/path-security.ts`, `src/errors.ts`
- Creates: none
- Modifies: none

### US-003 — Reject unrepresentable durations and stop agent text from forging delimiters

A schedule duration that overflows to `Invalid Date`, an escape sentinel a config value can forge, and agent-controlled text that can close a delimiter it does not own.

- Context Files: `src/errors.ts`
- Creates: none
- Modifies: none

### US-004 — Give every error path in the PRD and config loaders a code

Six sites throw bare `Error` while siblings in the same files throw `NaxError` with codes, so callers cannot branch on failure kind.

- Context Files: `src/errors.ts`, `src/utils/json-file.ts`
- Creates: none
- Modifies: none

### US-005 — Correct five numbers and one status nax reports to the user

Error counts, escalation counts, disk space, failure counts and the agent list are each reported wrongly today.

- Context Files: `src/agents/acp/agent-entries.ts`, `src/runtime/cost-aggregator.ts`
- Creates: none
- Modifies:
  - **US-005** `test/unit/bakeoff/contestant.test.ts` — the test named "maps total cost -> costUsd, total durationMs -> wallTimeMs, attempts -> tierEscalations" pins the old mapping in its name. Its assertion is a loose `toBeGreaterThanOrEqual(0)` that survives the change, which is exactly why the name must be corrected rather than left to pass silently: rename it to state the escalations-derived-from-attempts-beyond-the-first mapping, and tighten the assertion to the exact expected count.

### US-006 — Persist discard-only hardening passes and escape generated test titles

Two defects in the acceptance pipeline: one re-pays an LLM round trip every run forever, the other emits test source that cannot parse.

- Context Files: none beyond the two files changed
- Creates: none
- Modifies:
  - **US-006** `test/unit/acceptance/hardening.test.ts` — the test named "discards failing suggested criteria" asserts `expect(_hardeningDeps.savePRD).not.toHaveBeenCalled()` for a pass in which one criterion was discarded and none promoted. That is precisely the case AC-1 inverts, so a correct implementation fails this assertion. Replace it with an assertion that `savePRD` was called once, keeping every other assertion in that test unchanged — the discard bookkeeping it pins (`result.discarded`, `story.acceptanceCriteria`, `story.suggestedCriteria`) is still correct and must keep passing.

### Seams

No story introduces a new externally-visible symbol, and no story consumes a symbol another story creates, so there are no cross-story seam invariants. Every acceptance criterion below exercises an entry point that already exists at the shape stated in Integration.

## Acceptance Criteria

### US-001 — Bounded subprocess deadlines

1. `[unit]` With `_fileScanDeps.spawn` returning a child whose `exited` promise never settles, `detectFromFileScan(workdir)` settles rather than remaining pending, and resolves to `null`.
2. `[unit]` With `_directoryScanDeps.spawn` returning a child whose `exited` promise never settles, `detectFromDirectoryScan(workdir)` settles rather than remaining pending, and resolves to `null`.
3. `[unit]` With `_rollbackDeps.spawn` returning a child whose `exited` promise never settles, `rollbackToRef(workdir, ref, null)` rejects rather than remaining pending, and the rejection value is an `Error` whose message names the rollback failure.
4. `[unit]` With `_rollbackDeps.spawn` returning a child whose `exited` promise never settles, `captureSnapshotRef(workdir, storyId)` rejects rather than remaining pending, and the rejection is a `NaxError` whose `code` is `SNAPSHOT_REF_FAILED`.
5. `[unit]` With the merge-conflict-rectify module's injectable spawn seam returning a child whose `exited` promise never settles, `rectifyConflictedStory` proceeds past its stale-session eviction step and reaches its pipeline call, rather than remaining pending on the eviction.

### US-002 — Path and shape validation at boundaries

1. `[unit]` `resolveTestFilePatterns` reading a per-package config whose `execution.smartTestRunner.testFilePatterns` is the string `test/**/*.ts` rejects with a `NaxError` whose `code` is `INVALID_TEST_GLOB`.
2. `[unit]` `resolveTestFilePatterns` reading a per-package config whose `execution.smartTestRunner.testFilePatterns` is the array `["test/**/*.ts"]` resolves successfully and yields that single pattern, confirming the new guard admits the valid shape.
3. `[unit]` `initPackage(repoRoot, "../../evil")` rejects with a `NaxError` before creating any directory, and the rejection names the package argument as the offending value.
4. `[unit]` Invoking the generate command with a `package` option of `/etc` rejects with a `NaxError` rather than resolving a directory outside the repo.
5. `[unit]` `curatorCommit` called with a `runId` of `../../etc` rejects with a `NaxError` before any file under the run directory is read.
6. `[unit]` `initPackage(repoRoot, "")` rejects with a `NaxError` rather than resolving to the repo root itself.

**Out of scope:**
- *Symlink-based escape.* A `--package` or `--run-id` value naming a real relative path that is itself a symlink pointing outside the repo is not rejected. `isRelativeAndSafe` deliberately inspects raw path segments without resolving the filesystem — normalising first would collapse `src/../etc/passwd` and hide the `..` segment, which is the documented reason for the segment-wise check. Symlink containment is a distinct check (`safeRealpathForComparison`, used by `validateModulePath`) and applying it here would change the behaviour of every caller of the shared helper.
- *Percent-encoded and Unicode-normalised traversal.* These values arrive as process argv and are never URL-decoded or re-normalised on the way to `join`, so an encoded `..` reaches the check as literal text and fails the segment comparison as a non-matching directory name rather than as traversal.
- *Windows drive-relative and UNC paths* (`C:..\evil`, `\\server\share`). The absolute-path gate is POSIX-shaped; Windows is not a supported nax platform today.

### US-003 — Unrepresentable and forgeable values

1. `[unit]` `parseSchedule("999999999999d", now)` returns a result whose `ok` is `false`, and whose `error` names the accepted duration forms.
2. `[unit]` `parseSchedule("2h", now)` returns a result whose `ok` is `true` and whose `target` is two hours after `now`, confirming the new overflow guard still admits ordinary durations.
3. `[unit]` Resolving a config whose value is the literal text of the module's double-dollar escape placeholder followed by `HOME` yields that same literal text unchanged, rather than the value of the `HOME` environment variable.
4. `[unit]` A handler from `buildRunInteractionHandler`, built with a non-empty `contextPullTools` and a `contextToolRuntime` whose `callTool` resolves to text that itself includes a `nax_tool_result` closing delimiter, returns an `answer` in which exactly one `nax_tool_result` closing delimiter is present.
5. `[unit]` The same handler, invoked for a `context-tool` request whose `name` includes a double-quote character, returns an `answer` whose opening `nax_tool_result` delimiter parses to a single `name` attribute whose value equals the request's `name` exactly.

### US-004 — NaxError contract in the PRD and config loaders

1. `[unit]` `loadPRD` on a file whose contents are not valid JSON rejects with a `NaxError` whose `code` is `PRD_INVALID` and whose `context` carries the file path.
2. `[unit]` `loadPRD` on a file larger than the PRD size limit rejects with a `NaxError` carrying a code, and the message states the observed size and the limit.
3. `[unit]` `validateStoryId("")` throws a `NaxError` carrying a code, rather than a bare `Error`.
4. `[unit]` `validateStoryId("../escape")` throws a `NaxError` whose message names path traversal as the reason.
5. `[unit]` Loading a root config that fails schema validation rejects with a `NaxError` carrying a code, and the message still lists each failing field path as it does today.

### US-005 — Truthful reporting

1. `[unit]` After recording one cost event and one error event that share an `agentName`, that agent's entry in `byAgent()` has an `errorCount` of `1`.
2. `[unit]` After recording one cost event and one error event that share a `stage`, that stage's entry in `byStage()` has an `errorCount` of `1`.
3. `[unit]` After recording one cost event and one error event that share a `storyId`, that story's entry in `byStory()` has an `errorCount` of `1`.
4. `[unit]` Aggregating two contestant story metrics whose `attempts` are `1` and `1` yields a `tierEscalations` of `0`.
5. `[unit]` Aggregating two contestant story metrics whose `attempts` are `1` and `3` yields a `tierEscalations` of `2`.
6. `[unit]` The disk-space warning check, given command output whose second line has fewer columns than the available-space column, returns a result whose `passed` is `false` and whose `message` states that the output could not be parsed, and the message includes no `NaN` text.
7. `[unit]` Parsing Jest output reporting a failure named `renders` in two different spec files yields two entries in `failures`, one per file.
8. `[cli]` The agents list command, run in an environment where the `claude` binary resolves, produces no row for `aider` and no row whose display name is `ACP Agent`.
9. `[unit]` `KNOWN_AGENT_NAMES` still includes `aider`, confirming the listing was narrowed at the presentation layer rather than by shrinking the registry that context generation and the agent precheck also read.

### US-006 — Acceptance pipeline

1. `[unit]` `runHardeningPass` over a PRD whose only suggested criterion is discarded persists the PRD, and the persisted story's `suggestedCriteria` reflects the discard.
2. `[unit]` `runHardeningPass` over a PRD in which nothing was promoted and nothing was discarded does not persist the PRD, so an unchanged pass still performs no write.
3. `[unit]` `runHardeningPass` over a PRD with one promoted criterion persists the PRD and the persisted story's `acceptanceCriteria` includes the promoted text, confirming the widened persistence condition preserves the promotion path.
4. `[unit]` Generating TypeScript skeleton acceptance tests for a criterion whose text includes a double-quote character yields source in which that criterion's test title is a single well-formed string literal that round-trips to the original text.
5. `[unit]` Generating TypeScript skeleton acceptance tests for a criterion whose text includes a newline yields source in which no generated comment line carries part of the criterion text onto a line outside a comment.

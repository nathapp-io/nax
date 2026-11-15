# SPEC: Review and gate guards

Closes: #2924, #2923

## Summary

Harden two failure boundaries in one explicitly requested bundle: branch reviews that request changes without naming blocking work, and deterministic gates that keep running without useful progress. Branch review gets one bounded clarification opportunity and then holds readiness without inventing a defect; gates get configurable consecutive repeated-line detection and opt-in silence detection, using their existing timeout cleanup and routing.

## Motivation

`parseStoryReviewReply` already reports verdict mismatches without manufacturing findings. Branch review diverges: `parseBranchReviewReply` injects important spec/quality findings, and `withQualityFloor` in `feature-steps.ts` can inject another quality target. These become `B` findings, consume fix rounds and inflate branch-found/fixed counts even though the reviewer named no defect. The honest alternative is to ask the reviewer once, then retain an explicit uncertainty reason that keeps the PR draft.

Gate execution has two engines, not one. Verification tests use `verification/executor.ts:executeWithTimeout`, whose `Response.text()` collectors reveal output only after closure. Mechanical checks and repository gates use `quality/runner.ts:runQualityCommand`, which already collects streams incrementally. Both otherwise wait for their wall-clock limit when a command endlessly repeats a line. Silence can also indicate a hang, but quiet compilers and tests are legitimate: silence detection must remain disabled unless configured.

## Design

### Scope, approach and conventions

This is an in-place extension of `packages/nax`; there is no new workspace package or dependency. The two arcs are independently deliverable but remain one spec/PRD/branch at the user's explicit request. Their dependency graph is stated below; do not introduce an artificial dependency between review and subprocess work.

Use deterministic stream observation, not an LLM or a test-runner-specific output parser, for gate stalls. Use the existing operation retry interface for reviewer clarification, not an extra review session, an inline dispatch loop or a fix attempt. Follow `.nax/rules/config-patterns.md`, `retry-strategy.md`, `monorepo-awareness.md`, and the test-helper/architecture rules. No rule-store edits are needed. Tests use `bun:test`, injected dependencies, `makeFakeClock`, controlled streams, shared spawn factories and runtime teardown.

Grounding used direct repository reads/search because graph tools were unavailable. The root story-size policy resolves to enabled=true, maxAcCount=24, maxDescriptionLength=3000 and maxBulletPoints=12 (schema default; verified with `nax config --json` in `repos/nax`). All story file paths below are repository-root-relative, even though each workdir is `packages/nax`.

### Integration and target contracts

Baselines below locate current code only; the target is the contract to implement.

| Mutated surface | Baseline | Target |
| --- | --- | --- |
| `QualityConfigSchema` in `src/config/schemas-execution.ts`, `QualityConfig` in `runtime-types.ts`, root `schemas.ts` default, `mergePackageConfig` | No gate-stall policy; package quality merging explicitly merges commands/lintOutput | A schema-defaulted `quality.stallDetection` block whose defaults come from the new leaf constant, field-wise package override support, and the block present in a whole-config parse and in the root default literal |
| `executeWithTimeout(command, timeoutSeconds, env?, options?)` | Fourth argument holds shell, grace, drain, cwd; raw result has timeout flags | Same call shape with optional `options.stallDetection`; streaming observation and optional structured `stopReason` on a stopped result |
| `VerificationGateOptions`, `VerificationResult`, `TestExecutionResult` | No stall policy/reason | Optional `stallDetection` input and `stopReason` result; `VerificationResult.stopReason` is also the list-level interruption evidence; existing statuses and `countsTowardEscalation` semantics retained |
| `QualityCommandOptions`, `QualityCommandResult` | Options have origin/timeout/env; result has `timedOut` | Optional `stallDetection` input and `stopReason` result; single-command and list execution share the policy |
| `GateCommand`, `GateRunRecord` in `finish/gates/quality.ts`; `BotCheck` in `bot/checks.ts` | Gate descriptions carry name/command/cwd/setup; bot projection drops other fields | Descriptions carry resolved `stallDetection`; records carry optional `stopReason`; bot projections preserve the trusted policy |
| `LintCheckOutput`, `TypecheckCheckOutput`, `VerifyScopedOutput`, `FullSuiteGateOutput` | Test ops have timeout statuses; lint/typecheck have no timeout metadata | Add optional `stopReason`; lint/typecheck additionally expose optional `timedOut: true` so workflow gate-timeout handling can recognize their stopped runs |
| `RunOperation` in `operations/types.ts` | `parseRunOutcome` returns `op.parse`'s null for a nonempty malformed reply; the strategy fallback is used only when `op.parse` throws | One opt-in `preferRetryFallbackOnNullParse` flag; operations without it keep today's precedence |
| `parseBranchReviewReply(output, minorIds)` | Discards story mismatch metadata and synthesizes blockers | Keep mismatch kinds and reviewer-authored findings, with existing minor-triage normalization; no verdict-derived finding |
| `workflowBranchReviewOp.retry` | Shape-only parse strategy wrapped by coverage strategy | Shape, mismatch clarification and coverage decisions with independent bounded budgets, in the order specified below |
| `withQualityFloor` / `branchReviewStep` | Enforce changes verdict by synthesizing important work | Assign B ids only to actual blocking drafts and genuine promoted minors; persist unresolved mismatch evidence separately |
| `WorkflowFeatureRecord`, `ReadinessFacts`, `publish` | Coverage/skipped-review fields affect readiness | Optional persisted `reviewMismatch` and corresponding readiness input; one deterministic reason per unresolved kind flows to publishing and the run summary |
| `FEATURE_GRAPH` `branch-review` node in `src/workflow/feature-graph.ts` | `produces` is `reviewRan`, `cannotVerify`, `reviewUnread`, `reviewOpen`, `nextFindingId`, `minors`, `newMinors` | The same list plus `reviewMismatch`, because `runStepGraph` rejects any patched key the node does not declare — including one patched as `undefined` when stale evidence is cleared |

Read-only precedents: `parseStoryReviewReply` and `VerdictMismatch` in `operations/workflow-{replies,types}.ts`; `workflowStoryReviewOp` and `buildWorkflowVerdictMismatchRetry`; `makeParseRetryStrategy`, `makeCoverageRetryStrategy`, `callOp`'s same-session retry loop; `underReviewLimit`; `readinessReasons`, `buildOpenItems`, `buildWorkflowRunSummary`, `formatWorkflowSummary`; and both engines' existing process-group shutdown code. Story-review semantics are not changed by this feature.

### New identifiers, declared once

Every new name this feature introduces, and where it lives:

| Identifier | Home | Kind |
| --- | --- | --- |
| `GateStallPolicy` | `src/utils/gate-stall.ts` | structural type `{ repeatedLineThreshold; silenceTimeoutSeconds }` |
| `GateStopReason` | `src/utils/gate-stall.ts` | discriminated union `repeated-output` \| `silence` |
| `GateStallMonitor` | `src/utils/gate-stall.ts` | interface `observe` / `end` / `dispose` |
| `createGateStallMonitor` | `src/utils/gate-stall.ts` | factory |
| `DEFAULT_GATE_STALL_POLICY` | `src/utils/gate-stall.ts` | the one `{ repeatedLineThreshold: 100, silenceTimeoutSeconds: 0 }` literal |
| `resolveStallDetection` | `src/utils/gate-stall.ts` | fills absent fields from `DEFAULT_GATE_STALL_POLICY`; returns `GateStallPolicy` |
| `StallDetectionConfigSchema` | `src/config/schemas-execution.ts` | Zod schema whose two defaults read `DEFAULT_GATE_STALL_POLICY` |
| `stallDetection` | existing config/option/result/carrier types | optional additive field on `QualityConfig`, `VerificationGateOptions`, `QualityCommandOptions`, `GateCommand`, `BotCheck` |
| `stopReason` | existing result/record types | optional additive field on `TestExecutionResult`, `VerificationResult`, `QualityCommandResult`, `LintCheckOutput`, `TypecheckCheckOutput`, `VerifyScopedOutput`, `FullSuiteGateOutput`, `GateRunRecord` |
| `timedOut` | `LintCheckOutput`, `TypecheckCheckOutput` | optional `true` marker only |
| `makeMismatchClarificationStrategy` | `src/agents/retry/mismatch-clarification-retry.ts`, exported by the retry barrel | `RetryStrategy` factory |
| `MismatchClarificationOpts` | same module | its options interface |
| `buildWorkflowBranchVerdictMismatchRetry` | `src/prompts/builders/workflow-branch-builder.ts`, exported by `src/prompts/index.ts` | prompt builder reusing the existing per-kind sentences |
| `preferRetryFallbackOnNullParse` | `RunOperation` in `src/operations/types.ts` | optional opt-in flag |
| `reviewMismatch` | `WorkflowFeatureRecord` in `src/workflow/types.ts` | optional `{ kinds: readonly VerdictMismatch[] }` |
| `branchReviewMismatch` | `ReadinessFacts` in `src/workflow/approval.ts` | optional `readonly VerdictMismatch[]` |
| `branchMismatchReasons` | `src/workflow/approval.ts` | the one text source for the two stable sentences, the pattern `describeUnread` already follows |
| `isPlainRecord` | `src/operations/call-dispatch-run.ts` | module-private predicate guarding the opt-in null-parse fallback only |
| `_branchReviewRetryDeps` | `src/operations/workflow-branch-review.ts` | injectable seam `{ makeMismatchClarificationStrategy, buildWorkflowBranchVerdictMismatchRetry }` the op's `retry` delegates through |
| `_approvalDeps` | `src/workflow/approval.ts` | injectable seam `{ branchMismatchReasons }` that `readinessReasons` and `branchReviewStep` delegate through |

`src/utils/gate-stall.ts` is a leaf: it imports neither quality nor verification, and nothing else under `src/utils` — the existing quality-runner → verification-executor dependency must not become a cycle. It carries the policy/reason types, the default and the monitor; `src/config/schemas-execution.ts` may import it (config → leaf is not a cycle), which is what keeps one default literal rather than two.

The monitor's target interface is:

```typescript
export type GateStopReason =
  | { readonly kind: "repeated-output"; readonly stream: "stdout" | "stderr"; readonly count: number; readonly threshold: number }
  | { readonly kind: "silence"; readonly silenceTimeoutSeconds: number };
export interface GateStallMonitor {
  observe(stream: "stdout" | "stderr", chunk: Uint8Array): void;
  end(stream: "stdout" | "stderr"): void;
  dispose(): void;
}
export function createGateStallMonitor(options: {
  readonly policy: GateStallPolicy;
  readonly onStop: (reason: GateStopReason) => void;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}): GateStallMonitor;
```

`stopReason` is optional and only describes an early detector stop, never an ordinary wall timeout, stream-drain deadline, spawn error or normal exit. `VerificationResult.stopReason` additionally means "an entry of this list was interrupted" — see the mixed-list contract below. No schema version bump is necessary for these additive optional result fields. Consumers of historical results treat absent fields as no detector evidence. Policy fields in public config types may remain optional for sparse programmatic config compatibility; parsed config supplies both values. The engines receive resolved policy values and never read config files themselves.

### Gate policy and line semantics

The new configuration surface, showing every supported field and its default, is:

```json
{
  "quality": {
    "stallDetection": {
      "repeatedLineThreshold": 100,
      "silenceTimeoutSeconds": 0
    }
  }
}
```

`repeatedLineThreshold` is 0 (disabled) or an integer >=2. Default 100 counts the first occurrence, so the 100th consecutive matching eligible line triggers. This deliberately conservative default catches runaway loops while reducing false positives from legitimate duplicate diagnostics. `silenceTimeoutSeconds` is an integer >=0; 0 disables it, and positive values explicitly opt in. Negative values, fractions, booleans, strings, null, non-finite programmatic values, and repeat threshold 1 are invalid. There is no extra enabled switch; setting both fields to 0 disables both detectors. Silence stays 0 when only repetition is configured. Global/project/profile/CLI layering uses the existing loader; package fields override root fields individually without losing an unset sibling or resurrecting a disabled value.

The schema's two defaults are `DEFAULT_GATE_STALL_POLICY`'s fields, and the root `schemas.ts` literal spreads the parsed block rather than restating numbers; a second hand-written default is what this forbids. A whole-object Zod default returns the literal as given, so a literal omitting the block would leave it absent from `NaxConfigSchema.parse({})` — the root literal must therefore carry it.

Low-level engine calls with no `stallDetection` argument observe neither detector. Harness gate entry points explicitly pass the schema-derived policy, including defaults; this prevents the shared runners from silently imposing heuristics on unrelated pre-run steps or native agent tools. A manually constructed `GateCommand` without the optional field gets `DEFAULT_GATE_STALL_POLICY` at `runQualityGates`, not a new literal default in the engine.

Rules for one spawned shell-command entry:

1. Maintain independent stdout and stderr repetition state; never concatenate their bytes into one line or interleave their repetition counts. Activity on the other stream does not reset a stream's repetition count.
2. Incremental UTF-8 decoding survives split multibyte characters and arbitrary chunk boundaries. LF ends a line; CRLF is one delimiter even when split across chunks. Bare CR is ordinary content, not a progress-line delimiter. At stream EOF, a nonempty unterminated tail is one final line if the process is still live.
3. Compare complete decoded line text exactly, excluding its LF or CRLF delimiter. Preserve indentation, trailing spaces, ANSI sequences and case in the comparison. A whitespace-only line is ineligible and resets that stream's repetition run; it never counts toward a stop. A different eligible line starts a new count at 1.
4. Bound detector-only pending/previous-line storage at 16,384 UTF-16 code units per stream. An overlong line resets that stream's run and is ignored through its delimiter; it must not match a truncated prefix. This does not truncate captured output.
5. Every nonempty byte chunk on either stream, including blanks and partial lines, resets the silence deadline. Empty chunks and EOF do not. Silence starts at process spawn, so a process producing no bytes is covered only when silence is enabled. Repetition remains useful against a noisy loop because repeated lines themselves reset silence.
6. State is per spawn, not per command name, story, gate list or retry. No progress or timer state leaks between consecutive commands or concurrent invocations.

The repetition and silence policies are independent of the existing wall-clock timeout. Any may stop a live process first. There is no required numerical relationship between positive silence and wall timeout: a silence threshold at least as large as the wall limit may intentionally never win. Blank/partial output keeps silence alive without manufacturing line progress.

### Subprocess lifecycle, output and races

Use concurrent incremental collectors in both engines, starting both reads before waiting on exit. The verification collector needs to expose the text accumulated so far instead of depending on `Response.text()` finishing. The quality collector already provides a useful precedent. Feed bytes to the monitor as they arrive while retaining original output text; detector normalization must not rewrite the captured stream.

A single terminal latch arbitrates normal leader exit, wall timeout, repetition and silence. The first event observed while the invocation is live wins. If leader exit has already been observed, queued detector/deadline callbacks and output drained afterwards cannot change that exit into a timeout. If a detector wins first, a subsequent exit 0 cannot turn the interrupted run into a pass. On an exact scheduling tie, callback observation order decides; tests drive each ordering rather than asserting an OS-level simultaneity guarantee.

An early stop enters the same cleanup lane as a wall timeout: detached process group, SIGTERM, bounded grace, group liveness probe, SIGKILL for remaining members even when the leader exited, no single-pid fallback after leader exit, bounded concurrent stream drains. Each invocation starts at most one termination sequence. Clear all wall/silence/grace/drain timers, disable detector callbacks on settlement, and cancel readers best-effort when drain deadlines expire. A stream error keeps bytes already collected and leaves existing exit/error policy intact; it is not itself repetition or silence.

Raw verification early stops return `success:false`, `timeout:true`, `killed:true`, `childProcessesKilled:true`, `countsTowardEscalation:false`, plus `stopReason`. Their `error` begins `EXECUTION_STALLED:` and identifies repeated output (stream/count/threshold) or configured silence, rather than falsely saying the wall timeout elapsed. Raw quality early stops return `success:false`, `timedOut:true`, `exitCode:-1`, plus `stopReason`. Quality output begins `[nax] <commandName> stopped early: repeated-output ...` or `[nax] <commandName> stopped early: silence ...`.

Keep existing output exposure: verification returns collected stdout then stderr; successful quality commands preserve the existing combined output; stopped quality harness commands expose only the diagnostic notice, while `origin:"agent-tool"` retains its bounded 4,000-character, line-boundary tail. Merely adding a stop reason must not enable heuristic stopping for agent-tool calls. Existing environment stripping, agent-output markers, NO_COLOR behavior, shell quoting, trusted-cwd checks, and actual working directories are unchanged. New structured logging carries reason/threshold/stream/count, not a copy of the repeated line or raw output.

### Bounded settlement when the child's exit never arrives

The verification executor already races its timeout signal against `proc.exited` and then bounds the post-kill wait. The quality runner does not: it awaits `proc.exited` directly before its bounded drains, and its timeout callback only signals the group. With a detector added, a callback that wins while the exit promise never settles would leave the invocation pending forever, so neither reader cancellation nor timer cleanup would be reached.

The quality runner adopts the executor's shape: one terminal race between the child exit and the first stop signal (wall, repetition or silence), a post-signal wait bounded by the configured grace period, then the existing bounded drains, then the stopped result — every armed timer cleared and stalled readers cancelled best-effort. A never-settling `proc.exited` with pending pipes must still produce the stopped result after those bounds. Process-group escalation and the no-bare-pid rule after an observed leader exit are unchanged.

A rejected `proc.exited` keeps today's floating `.catch(() => {})`: it is not stall evidence, it does not reclassify a result, and repairing exit-rejection handling is explicitly out of this feature's scope (see Out of Scope).

### Mixed verification lists: failure and interruption

A verification command list keeps its historical raw aggregation, and interruption evidence is carried independently so a consumer cannot mistake a mixed list for an ordinary code failure:

- `status`, `exitCode` and `error` remain the first unsuccessful entry's values. `success` remains "every entry succeeded". `countsTowardEscalation` remains the any-entry `some`. `output`, `passCount` and `failCount` are unchanged.
- The list's `stopReason` is the first detector reason in command order, and is absent when no entry was stopped. Its presence — not the aggregate `status` — is the interruption evidence.

Both orders are pinned:

| Order | Aggregate `status` | Aggregate `stopReason` | Consumer route |
| --- | --- | --- | --- |
| `[ordinary failure, detector stop]` | `TEST_FAILURE` (first failure) | the later entry's reason | interruption |
| `[detector stop, ordinary failure]` | `TIMEOUT` (first failure) | the first entry's reason | interruption |

`verifyScopedOp` treats `status === "TIMEOUT" || stopReason !== undefined` as interrupted: it never starts the zero-tests full-suite rerun, and it returns `status:"timeout"` with the reason instead of a code-failure verdict. `fullSuiteGateOp` derives its internal `timedOut` from the same predicate, so the existing `acceptOnTimeout` translation still decides `passed-on-timeout` versus `timeout` — with the reason on both forms, and `runWorkflowSuiteGate` still reporting `passed-on-timeout` as red and timed out. Lists with no stopped entry keep today's behaviour exactly; ordinary historical list semantics are not rewritten.

### Actual gate execution-path inventory

Every row was inspected. Coverage is about harness-owned gate commands, not every subprocess in the repository.

| Entry/path | Actual engine | Policy and reason integration |
| --- | --- | --- |
| `runStoryGates` -> `lintCheckOp`, `typecheckCheckOp` | `runQualityCommand` | Pass package-view policy, preserve stop reason, surface `timedOut` into `GateRunResult.timedOut` |
| `runStoryGates` -> `verifyScopedOp`, including zero-tests full-suite fallback | `regression` -> verification runners -> `executeWithTimeout` | Pass package-view policy through every test run; interruption evidence still bypasses the zero-tests fallback |
| `runWorkflowSuiteGate` -> `fullSuiteGateOp` | `regression` -> `executeWithTimeout` | Pass gate-context policy; retain timeout/acceptOnTimeout translation and stop reason |
| Feature `repo-gates`, final gates, final-gate repairs and post-CI-repair gate passes -> `runRepoGates` | `resolveGateCommands` -> `runQualityGates` -> quality runner | Resolved policy travels with root/overlay GateCommand; e2e setup receives the same policy as its e2e command |
| `nax gates run` -> `gatesRunCommand` | Same finish gate helpers | Inherits resolved policy; stopped gate is `timed-out`, command exit 2, optional structured reason in the JSON gate-report entry |
| Bot fix/repair -> `gatesStep`, bot baseline -> `failingOnHead` | `runQualityGates` | Preserve trusted resolved policy across BotCheck projection, snapshot/worktree remapping and baseline checkout; do not reread policy from the fixed branch |
| `runReview` mechanical checks, including all `runScopedLintCheck` fallback/template paths | Quality runner | Pass provided `naxConfig` policy, or schema-derived default when caller has no full config; keep red/fail-fast semantics |
| `runSetupGate` (the setup command's verification test) | Quality runner | Pass supplied config policy and return the existing nonzero result on stop |
| `captureRunBaseline` | Direct `executeWithTimeout` | Not a gate verdict; intentionally leave detector options absent and its existing baseline degradation behavior unchanged |
| `runPreRunSteps`, including bot review's `reviewBuildSteps` bootstrap; `maybeRunNewPackageSetup` | Verification executor / own argv spawn | Installation/bootstrap work, not gate verdicts; unchanged and no heuristic stop added |
| Native declared `RunCommand` via `coding-tool-support-resolve.ts` | Quality runner with `origin:"agent-tool"` | No policy added by this feature; default low-level opt-out preserves the agent's own iteration behavior |
| Raw Bash/exec tools, external ACP tools, hooks, git helpers, plugin reviewer callbacks, remote CI wait | Other owners | No stream detector added; existing watchdogs/deadlines remain |

For repository gates, root-command precedence by key and current ordering stay intact. Overlay gates use field-wise root+overlay policy. Include the resolved policy in overlay run identity so otherwise identical command/setup runs with different policies are not silently deduplicated; identical resolved policies still dedupe as they do today. `GateCommand` is the policy carrier so bot worktree remapping need not reload configuration. For instruction/detection-derived bot checks, attach the trusted resolver input's configured policy (schema defaults if unset), not LLM-extracted thresholds. `BotCheck.stallDetection` stays optional so hand-built check literals remain valid; an absent value falls back to `DEFAULT_GATE_STALL_POLICY` at the quality gate runner.

`resolveStallDetection` is not a decorative export: completing a sparse or absent policy is a production step reached from `runQualityGates`, so `_qualityGateDeps` (`run`, `loadConfig`, `loadPackageOverride`) gains a `resolveStallDetection` entry and the finish gate calls it through that seam for every gate before the quality runner runs, and `resolveGateCommands` calls it for the root policy and for the field-wise merged overlay policy it attaches. The deps entry is a plain delegation to the leaf function, the same shape as `run`; it exists so the resolution is observable at the production entry instead of being re-implemented inline.

In `runReview`, the policy crosses the injected `_scopedLintDeps.runLintCommand` helper boundary, so the helper signature carries it and every degraded, template, derived and full-lint path passes the same value. No story, projectDir, storyGitRef or scope is threaded into the production `runReview` adapter by this change. `_scopedLintDeps` additionally gains a `runQualityCommand` entry that the module's `runLintCommand` delegates to — the same plain-delegation shape as `_qualityGateDeps.run` — so a test can keep the real helper and capture the policy arriving at command execution for the derived arm, which is a distinct call site from the template and full-lint arms and is otherwise unpinned.

### Existing timeout routing

Early stops are environmental interruption evidence, not parsed code failures. Verification `scoped`/`regression` retain `status:"TIMEOUT"` and `countsTowardEscalation:false`. `verifyScopedOp` returns `status:"timeout"`, never starts its zero-test full-suite fallback, and exposes the reason. `fullSuiteGateOp` retains its current `acceptOnTimeout` output contract, with the reason on both timeout forms; workflow's suite wrapper still treats `passed-on-timeout` as red and timed out. Lint/typecheck expose `timedOut:true` to the same workflow timeout path rather than pretending a partial linter report is a completed diagnostic result. Their reason-bearing sentinel identifies the interruption. `runQualityGates` classifies early stops as timed-out before considering exit -1; existing caller repair/advisor routing is not broadened.

### Branch verdict mismatch and bounded retry composition

A mismatch follows the story parser's existing definition: spec fail needs a critical/important spec finding; quality changes needs any critical/important finding. Empty, dropped-invalid and minor-only findings do not justify a blocking verdict. Both kinds are reported in stable order `spec`, `quality`. Concrete promoted deferred minors remain real fix work, but do not supply evidence for a missing spec finding or retroactively make an inconsistent reviewer reply consistent.

`parseBranchReviewReply` stays a lenient shape parser. A usable reply carries its real findings, normalized triage, cannotVerify, inspectedFiles and optional mismatch. It never injects a finding to make the verdict look justified. `branchReviewStep` also computes/recognizes inconsistency on direct injected verdicts so a sparse legacy/custom step that omits the optional mismatch field cannot evade readiness.

Within the existing `callOp` session, the retry strategy applies these rules:

1. Invalid JSON/shape uses the existing one shape-repair turn, with the existing normal/condensed prompts. This budget is per op invocation: it does not reset after another retry kind, and it does not reset when a manager-owned fallback hop restarts `sendWithParseRetry` at attempt 0.
2. A parseable mismatch gets at most one clarification turn for the entire invocation (both kinds together). Reuse the existing per-kind sentences; require the complete branch-review object, preserving findings, coverage evidence and minor triage, and ask to name the defect/failed AC or correct the verdict. This is read-only reviewer work, not a fix instruction.
3. Coverage uses the existing independent `workflow.review.coverageRetries` budget (default 3), required-file/diff-part prompt and no-progress stop rule. A clarification or shape-repair turn spends no coverage retry and cannot reset its budget. Evaluate coverage progress only against responses to coverage prompts, not against intermediate clarification/shape turns.
4. Message priority is shape repair, then the unused mismatch clarification, then coverage. For a reply both inconsistent and incomplete, clarify first; coverage can still ask after a persistent mismatch. If a coverage response introduces a mismatch, use the one clarification only if unspent. Coverage budget/no-progress exhaustion never suppresses an otherwise unused clarification, and clarification cannot reopen stopped coverage.
5. On persistent mismatch, keep the last parseable verdict and mismatch; do not return null solely because it is inconsistent. If the clarification is malformed, the remaining shape allowance may repair it; once exhausted, retain the last parseable verdict, including real findings, rather than certifying it clean. Without any parseable reply, retain existing null/skipped-review behavior; the handoff below leaves that outcome untouched. A parseable corrected reply is authoritative for findings/triage, as other branch-review retries already are; the clarification prompt asks it to retain real findings.
6. Within one completed hop, coverage budget C permits no more than 3+C replies under these semantic budgets (initial + one shape repair + one clarification + C coverage replies). Strategies must stop within that composition with a safe last-parseable fallback, rather than introduce an unbounded loop. Abort propagates; transport failures remain manager-owned and are not converted into clarification prompts.

Composition: `makeCoverageRetryStrategy` wraps `makeMismatchClarificationStrategy`, which wraps the existing shape strategy. Each wrapper consults its inner strategy first, so shape repair, then clarification, then coverage is the effect of the nesting rather than a second priority table. Each wrapper subtracts the prompts it issued from the attempt number it passes inward, so the shape allowance stays one turn while clarification and coverage prompts are interleaved; the clarification wrapper owns one `clarified` latch and sets it when it issues, and the coverage wrapper records the attempt at which it last issued so a reply counts as a coverage response only when it answers that prompt. Because the shape strategy decides from the attempt number it is handed and holds no spent latch of its own, the clarification wrapper also owns an invocation-local count of shape-repair prompts already issued and adds it to the attempt it passes inward: a repair spent in one hop is therefore not reissued when a manager-owned fallback hop restarts the loop at 0. All of these counters live on the strategy instance, which `callOp` resolves once per invocation; the wrappers carry no other state and never see raw bytes or config. `workflowBranchReviewOp.retry` reaches the factory and the clarification builder through the exported `_branchReviewRetryDeps` seam — a plain-delegation object of the `_qualityGateDeps` shape — so the production resolver's use of both exports is observable in a test instead of being inline logic that duplicate wiring could replace undetected.

### Send ceiling scope

The existing hard bound is `MAX_COMPLETE_RETRY_ATTEMPTS + 1` = 21 sends, counted inside one `sendWithParseRetry` loop — one completed semantic review hop. It is not a cap on manager-owned transport retries or agent-fallback hops: the strategy is resolved once per `callOp`, so semantic budgets are invocation-scoped, while each fallback hop runs its own loop and keeps its own 21-send ceiling. This feature adds no global availability policy and no cross-hop availability cap. The 21-send AC is driven through one completed hop.

### Last-parseable dispatch handoff

A retry decision alone cannot deliver the last parseable verdict: on nonempty output `callOp` returns `op.parse`'s result — null for a malformed reply — and consults the strategy's recorded fallback only when `op.parse` throws. The handoff is therefore explicit and opt-in, not a global change of fallback precedence:

- `RunOperation.preferRetryFallbackOnNullParse?: true` is declared on the operation type.
- The opt-in branch validates with a new strict predicate, `isPlainRecord(value)`: `typeof value === "object"`, not null, not an array, and its prototype is either `Object.prototype` or `null`. This is deliberately **not** the check the existing throwing path uses — `validatedFallbackRecord` rejects only non-objects and null, so arrays and class instances pass it; the two predicates are separate and this feature does not claim the legacy one validates plain records.
- When set, `op.parse` returns null/undefined and `retryState.retryFallback` satisfies `isPlainRecord`, that object is the parse result.
- A `retryState.retryFallback` that is `undefined` or `null` counts as no fallback: the null parse result stands, so "no parseable reply" keeps today's skipped-review outcome and nothing is substituted.
- A `retryState.retryFallback` that is present but fails `isPlainRecord` (array, class instance, function, string, number, boolean) raises the existing `CALL_OP_INVALID_FALLBACK` error naming the observed value, before `runPostParse`, so neither `verify` nor `recover` runs and no malformed verdict reaches the branch step.
- The post-parse hooks keep their existing meaning for a substituted value: `verify` is called with the fallback object as the parsed value it observes, and `recover` runs only when `verify` returns null — exactly the split `runPostParse` implements today. Substituting the fallback must therefore happen before `runPostParse`, not by returning the fallback around it.
- Operations without the flag keep today's behaviour exactly, including `validatedFallbackRecord`'s broader object check on the throwing path; `workflowBranchReviewOp` is the only op that sets it.

The ACs are asserted through real `callOp`, not a strategy-only unit assertion, and the dispatch test that pins today's fallback precedence needs a few added opt-in cases rather than a rewritten ladder. US-012 asserts the retry decision, the prompts sent and its two captured-exports seams; US-013 owns every assertion about the delivered parsed value, because delivery is what US-013 implements.

### Persistent mismatch, readiness and artifacts

Persist `WorkflowFeatureRecord.reviewMismatch?: { kinds: readonly VerdictMismatch[] }` and the mismatch-bearing branch verdict artifact. Absence/empty means no new mismatch reason; historical records require no migration. A fresh consistent branch review clears stale mismatch evidence; rerunning or resuming downstream fix/adjudication/publish steps does not clear it. A later full branch review, not a fix reviewer addressing B ids, can resolve this evidence.

The stable readiness sentences, produced once by `branchMismatchReasons`, are:

- `branch review verdict inconsistent: spec fail without a blocking spec finding`
- `branch review verdict inconsistent: quality changes without a blocking finding`

Persist/log each applicable sentence once per branch-review step, in stable spec/quality order. Both call sites — `branchReviewStep`'s ledger note, which follows the existing `describeUnread` note pattern, and `readinessReasons` reached from `publish` — obtain those sentences through the `_approvalDeps.branchMismatchReasons` seam rather than re-implementing the text inline, which is what makes the shared source observable at the production entries. `publish` passes the mismatch fact to `readinessReasons`; it is a deterministic reason that keeps an otherwise green PR draft and skips finish-approval adjudication. An approving advisor or green CI cannot override it. Preserve local-only/push-only publish modes: they carry the reason without inventing a PR operation.

A mismatch is not a `WorkflowFindingDraft`, B id, fix target or advisor ruling. Real findings, promoted minors, fix-now minors and gate findings continue through their current fix paths, even alongside a mismatch. Fixing those findings does not claim to resolve the mismatch. `nextFindingId` and branch found/fixed/left statistics count only real issued work. `reviewRan` remains true for a parseable inconsistent review; do not label it skipped.

Use the existing reason channel through `PublishOutcome.reasons`, `result.json` verdict reasons, generic reason open items, PR draft explanation and `buildWorkflowRunSummary`/`formatWorkflowSummary` Publish line. No new fabricated open finding is needed. Preserve the established distinction between readiness and `workflowPassed`/`RunResult.success`: mismatch alone holds readiness but does not falsely claim tests or implementation failed.

### Failure handling

- Repeated-output or opted-in silence wins while live: fail closed through the existing timeout lane with the structured reason and bounded process-group cleanup (US-003/US-005).
- Normal exit wins before a detector callback: keep its actual exit result; drain time is not execution silence (US-003/US-005).
- Stream read fails: preserve collected bytes and existing result policy, without inventing stall evidence (US-003/US-005).
- A quality child never settles its exit after a stop signal: return the stopped result after bounded grace and drains, with timers cleared and readers cancelled (US-005).
- Shape or coverage retry exhausts: use the bounded last-parseable/null behavior above; incomplete coverage still separately holds readiness (US-012/US-013).
- Mismatch remains after clarification: retain real findings, persist mismatch and hold draft readiness (US-009/US-010/US-012).
- Review step timeout/package failure/no dispatch: preserve the existing skipped-review/abort behavior; no extra session or budget extension (US-012). The preservation anchor is named rather than implied: `workflow/story-review.ts`'s review-limit override and abort propagation (which `workflow/branch-review.ts` shares) and `call-dispatch-run.ts`'s zero-dispatch and abort guards, including the retry sleep; `test/unit/workflow/branch-review-sliced.test.ts` already pins package failure, abort propagation and a timeout that overrides a returned parseable verdict, and those cases stay green unedited. The new interleaved retries execute inside that deadline and cannot extend, retry or bypass it, so this feature adds no timeout or abort acceptance criterion and no new assertion to US-012 for it.

### CLI and verification notes

There is no new CLI command or flag. `nax gates run` keeps exit 0 for all gates passed, 2 for an unsuccessful/empty gate run, 1 for usage/trust/execution setup errors. `--json` writes one document to stdout: each internal `GateRunRecord` is projected into the existing `GateReportEntry` (`name`, `status`, `exitCode`, `durationMs`, optional `failedPhase`, optional `outputTail`), and this feature adds only an optional `stopReason` to that entry, present only on a detector-stopped gate. `outputTail` keeps its current behavior, including its omission for a `passed` gate; the record's `cwd` and raw `output` stay internal fields of `GateRunRecord` and are not added to the CLI JSON. Plain output shows the reason in that gate's output. Existing stderr behavior is unchanged. For example, one JSON gate entry gains `"stopReason":{"kind":"repeated-output","stream":"stderr","count":100,"threshold":100}` while its existing `name`, `status`, `exitCode`, `durationMs` and `outputTail` fields keep their current values. No raw line is added as structured metadata.

Implementation verification is scoped to `packages/nax`: targeted tests with the repository's outer timeout wrapper, then `bun run typecheck`, `bun run check:all`, and `bun run test` under the normal pipeline. Use static gates for any obsolete floor helper/import cleanup naturally required by the implementation; do not create a separate refactor or change unrelated contracts. Coverage validation belongs outside a sandboxed nax session/CI, per repository rules. Authoring this spec runs only deterministic spec lint if local command tooling is available; it never invokes plan/run, agents or paid services.

### Story sizing and dependency graph

The AC section below holds **206 markdown bullets carrying 215 independently observable assertions**. Eight bullets are deliberately kept compound rather than split, because each pairs distinct effects of one mechanism that `nax plan` will split: US-003 AC12 carries three (empty-group escalation cancellation, timer cleanup, reader cleanup) and US-006 AC6, US-009 AC2, US-009 AC18, US-010 AC12, US-011 AC8, US-012 AC22 and US-013 AC5 carry two each — that accounts for the 204-bullet / 213-assertion gap on the pre-existing section, on top of the two publish-side seam criteria US-010 gained. The table below counts assertions first with the bullet count in parentheses, so neither number can be read as the other. Every story is within the project's 24-assertion cap and none needs a forced split, but **US-012 sits exactly at 24 with no remaining headroom**: this spec adds no assertion to it, and any later criterion for that story must displace an existing one. Dependency graph: `US-001 -> US-002`, `US-001 -> US-003`, `US-002 + US-003 -> US-004`, `US-001 -> US-005 -> US-006`, `US-002 + US-005 -> US-007`, `US-004 + US-007 -> US-008`, `US-009 -> US-010`, and independently `US-009 -> US-011 -> US-012 -> US-013`. `US-004` needs `US-002` as well as `US-003` because it reads `quality.stallDetection` from the parsed config, which only `US-002` creates; `US-003` supplies the executor support alone. `US-012` and `US-013` separate the clarification/coverage composition from the opt-in dispatch handoff so neither story has to compress independent assertions into longer sentences: everything US-012 asserts is observable through `workflowBranchReviewOp.retry` and the prompts `callOp` sends, and every assertion that needs the *delivered* parsed value — the exhausted-malformed-follow-up verdict, findings surviving coverage exhaustion, the null/skipped-review outcome, and the strict fallback classes — belongs to US-013, which implements that delivery.

| Story | Scope | Assertions (AC bullets) | Depends on |
| --- | --- | ---: | --- |
| US-001 | Gate-stall leaf observer and policy default | 21 (21) | none |
| US-002 | Gate-stall configuration surface and package merge | 11 (11) | US-001 |
| US-003 | Verification executor stall lifecycle | 22 (20) | US-001 |
| US-004 | Verification lists, interruption routing and test operations | 16 (16) | US-002, US-003 |
| US-005 | Quality runner stall lifecycle and bounded settlement | 18 (18) | US-001 |
| US-006 | Quality list aggregation | 7 (6) | US-005 |
| US-007 | Gate policy carrier, gate records and e2e setup | 16 (16) | US-002, US-005 |
| US-008 | Gate entry points: story gates, review, setup, bot, CLI | 21 (21) | US-004, US-007 |
| US-009 | Honest branch findings and persisted mismatch | 20 (18) | none |
| US-010 | Mismatch readiness, publish and summary channel | 15 (14) | US-009 |
| US-011 | Branch reply mismatch parsing | 10 (9) | US-009 |
| US-012 | Bounded clarification and coverage retry composition | 24 (23) | US-011 |
| US-013 | Opt-in last-parseable dispatch handoff | 14 (13) | US-012 |

Every story is within the 24-assertion cap on that basis — US-012 exactly at it, the rest with headroom — and every story is gate-safe alone: no story's completion leaves a suite that another story's authorization was needed to fix. The parser and its consumer are ordered consumer-first (`US-009` before `US-011`) precisely so the parser change lands against a consumer that already handles mismatch evidence; the residual test changes are attributed in Modifies to the story that makes them true.

## Out of Scope

- Splitting #2924 and #2923 into separate feature bundles; the user explicitly requested one bundle despite the independent arcs.
- Changes to story-review verdict handling, finding substantiation, severity rules, minor-triage policy, branch-fix limits, or availability/tier escalation policy.
- Treating an inconsistent branch verdict as an invented B finding, automatically approving it, or accepting an advisor waiver as a substitute for clarification.
- Silencing a real reviewer finding, promoted minor, gate failure or independent coverage/readiness reason because mismatch evidence is present.
- Silence detection enabled by default, adaptive silence thresholds, CPU-based liveness, heartbeat protocols, substring/fuzzy matching, repeated multi-line cycles, or test-framework-specific hang detection.
- ANSI stripping, terminal-progress emulation, treating bare carriage returns as line breaks, or cross-stream ordering reconstruction.
- Raw-output retention caps, a new log artifact format, broad result-schema migrations, or changing existing output-redaction/tail contracts.
- Applying stall policy to installation/pre-run/bootstrap steps, run-start baseline capture, native agent tools, ACP-owned tools, hooks, git processes, remote CI jobs/waits or plugin-owned subprocesses.
- Repairing or reclassifying a rejected child-exit promise: this feature keeps today's floating catch and defines no new result policy for that error class.
- Refactoring all command runners into one engine, changing shell/trust/sandbox behavior, platform expansion beyond the current process-group support, or dependency/version changes.
- Editing repository `.nax/` configuration, rules, PRDs or generated agent instructions as an implementation story; configuration examples describe user opt-in, not a repository config edit.

## Stories

### US-001 — Gate-stall leaf observer and policy default

Workdir: packages/nax

No dependencies.

Create `src/utils/gate-stall.ts` with the structural policy/reason types, the single `DEFAULT_GATE_STALL_POLICY` literal, `resolveStallDetection` and the bounded per-spawn observer. Keep detector state separate from captured output, and keep the module a leaf.

21 atomic ACs.

### US-002 — Gate-stall configuration surface and package merge

Workdir: packages/nax

Depends on US-001.

Add `quality.stallDetection` to the quality schema with its defaults read from the leaf constant, carry the block in the root quality literal, expose it as an optional field on the public config type, and merge a package overlay field-wise.

11 atomic ACs.

Verification notes: the "one default literal" requirement is a static-review fact, not a runtime one — runtime equality of two numbers cannot distinguish reading `DEFAULT_GATE_STALL_POLICY` from copying `100` and `0`, and a test that inspects source text is not a valid acceptance criterion. Verify it by review of the two edit sites (the schema's two defaults read the leaf constant's fields; the root `schemas.ts` literal spreads the parsed block rather than restating numbers), together with `bun run typecheck` for the import. The behavioural anchors are the resolvable default values, absent-equals-empty, and `DEFAULT_CONFIG` exposing the block.

### US-003 — Verification executor stall lifecycle

Workdir: packages/nax

Depends on US-001.

Wire the observer into `executeWithTimeout`: concurrent incremental collectors, the single terminal latch, detector evidence on the raw result and the existing process-group cleanup. Preserve trust-before-spawn, output exposure and every ordering guarantee.

20 AC bullets, 22 atomic assertions.

### US-004 — Verification lists, interruption routing and test operations

Workdir: packages/nax

Depends on US-002, US-003.

Preserve raw first-failure list aggregation while carrying independent interruption evidence, and route it in `verifyScopedOp` and `fullSuiteGateOp`: no zero-tests rerun, the interruption route, and the existing accept-on-timeout contract with the reason on both forms.

The config dependency is real, not bookkeeping: both operations read the policy off the parsed `quality` block (`verify-scoped.ts` and `full-suite-gate.ts` forward `quality.quality?.…` options to `regression`), and that field arrives with US-002 while US-003 supplies only the executor-side support.

16 atomic ACs.

### US-005 — Quality runner stall lifecycle and bounded settlement

Workdir: packages/nax

Depends on US-001.

Extend the quality runner's existing incremental collectors with the same observer and single-stop latch, replace the direct exit await with the bounded terminal race, and carry the reason through single-command results without changing output exposure or cleanup behavior.

18 atomic ACs.

Verification notes: the runner's existing environment stripping, `NO_COLOR`, agent-output markers, shell quoting and working-directory behavior is not re-asserted as a new acceptance criterion — `test/unit/quality/runner.test.ts` already pins it, and this story's change must keep those cases green without editing them (they assert spawn-time env and argv, which the streaming change does not touch). The authorization to adjust the drain and process-group cases lives in this story's `### Modifies` entries on `runner-drain.test.ts` and `runner-timeout-kill.test.ts`. Equally, timer and reader cleanup after a never-settling exit is asserted once through the general early-stop lifecycle criteria plus the bounded-settlement criterion, not restated for that one exit shape.

### US-006 — Quality list aggregation

Workdir: packages/nax

Depends on US-005.

Give every list entry fresh detector state, keep running later entries after a stop, and surface the first detector reason in command order while preserving first-failure exit, any-entry timeout, duration and combined output.

6 AC bullets, 7 atomic assertions.

### US-007 — Gate policy carrier, gate records and e2e setup

Workdir: packages/nax

Depends on US-002, US-005.

Resolve the policy onto every gate description, include it in overlay run identity, apply the leaf default to a policy-less gate, classify a stopped run as timed-out, copy its reason to the record, and pass the e2e gate's policy to its setup.

16 atomic ACs.

### US-008 — Gate entry points: story gates, review, setup, bot, CLI

Workdir: packages/nax

Depends on US-004, US-007.

Wire mechanical story/review checks, setup verification and trusted bot gate projections to the resolved policy, carry early-stop evidence into gate records and the workflow gate-timeout route, and expose it through `nax gates run`. Preserve provenance, command order and bot snapshot trust. Every scoped-lint arm the design names — degraded, template, derived and full-lint — carries the policy, and the derived arm is pinned at command execution rather than only at the helper call.

21 atomic ACs.

### US-009 — Honest branch findings and persisted mismatch

Workdir: packages/nax

No dependencies.

Stop synthesizing verdict-floor work in `withQualityFloor`/`branchReviewStep`, derive mismatch kinds from the verdict itself, persist `reviewMismatch` through the feature machine, and keep every real fix path and finding count intact. Persistence needs the `branch-review` node to declare `reviewMismatch` among its `produces`, because the step graph rejects any patched key — including one patched as `undefined` when stale evidence is cleared — that the node does not declare. The step writes its ledger sentences through the shared `_approvalDeps.branchMismatchReasons` seam, so the one text source is observable where it is used.

18 AC bullets, 20 atomic assertions.

### US-010 — Mismatch readiness, publish and summary channel

Workdir: packages/nax

Depends on US-009.

Carry the persisted mismatch into publish readiness through the existing deterministic reason channel, so an otherwise green PR stays draft and the same reason reaches open items and the run summary without becoming a finding. The readiness text comes from `_approvalDeps.branchMismatchReasons`, the same shared source the branch-review step uses, not an inline copy at the publish entry.

14 AC bullets, 15 atomic assertions.

### US-011 — Branch reply mismatch parsing

Workdir: packages/nax

Depends on US-009.

Make `parseBranchReviewReply` a lenient shape parser that keeps its real findings and the parser's mismatch metadata instead of synthesizing blockers. The parser's floor marker and the consumer's now-dead exclusion of it go with it as natural cleanup; no other consumer contract changes.

9 AC bullets, 10 atomic assertions.

### US-012 — Bounded clarification and coverage retry composition

Workdir: packages/nax

Depends on US-011.

Compose the branch operation's sanctioned retry strategy: shape repair, then one mismatch clarification, then independent coverage, with the shape allowance spent once per invocation rather than once per manager fallback hop. The strategy reports the last parseable reply as its exhausted fallback; delivering that fallback through `callOp` is US-013, so this story asserts only what the retry decision and the sent prompts show. Export the new factory through `src/agents/retry/index.ts` and the clarification builder through `src/prompts/index.ts`, following those barrels' existing export convention, and reach both from `workflowBranchReviewOp.retry` through the `_branchReviewRetryDeps` delegation seam.

23 AC bullets, 24 atomic assertions — exactly at the cap, with no further assertion added here.

Verification notes: the existing 21-send ceiling stays exactly one completed hop's retry-loop bound, and its current test is unchanged — this story adds no cross-hop availability cap, so the ceiling needs no new acceptance criterion. The design's "same session" requirement is asserted by its own criterion rather than folded into the send assertion. The outer review deadline and abort contract is not re-asserted here: its preservation anchor is the named existing runtime contracts and `test/unit/workflow/branch-review-sliced.test.ts` cases described in the failure-handling section, which stay green unedited; the inner retry bounds above cannot extend them.

### US-013 — Opt-in last-parseable dispatch handoff

Workdir: packages/nax

Depends on US-012.

Declare `RunOperation.preferRetryFallbackOnNullParse` and honour it in `parseRunOutcome`: when the flag is set, `op.parse` returns null and the strategy recorded a fallback that passes the new strict `isPlainRecord` predicate, that object becomes the parsed value before `runPostParse`, so `verify` observes it and the existing conditional `recover` still applies. A null or absent fallback keeps the null result, and a present non-record fallback raises `CALL_OP_INVALID_FALLBACK` before any post-parse hook runs. Operations without the flag keep today's null-parse precedence and the legacy throwing-path check. This story also owns the assertions that need the delivered value: the exhausted-malformed-follow-up verdict from US-012's composition, findings surviving coverage exhaustion, and the null/skipped-review outcome.

13 AC bullets, 14 atomic assertions.

Verification notes: the existing parse-failure ladder cases in `test/unit/operations/call.test.ts` keep their current precedence for non-opt-in operations — that preservation is the invariant carried by this story's `### Modifies` entry, not a new criterion. The strict predicate is asserted only through real `callOp` with rejected and accepted fallback classes; it is not restated as a predicate-level unit test, and the legacy `validatedFallbackRecord` behaviour is left as it is.

### Context Files

**US-001**
- `packages/nax/src/utils/path-frame.ts` — the neighbouring leaf module this one's import discipline follows.
- `packages/nax/test/helpers/fake-clock.ts` — deterministic timer seam.
- `packages/nax/src/verification/executor.ts` — the existing timer and stream-read conventions the observer mirrors.
- `packages/nax/src/quality/runner.ts` — the existing incremental collector conventions.

**US-002**
- `packages/nax/src/config/schemas-execution.ts` — quality schema, validation and defaults.
- `packages/nax/src/config/schemas.ts` — the root quality literal that bypasses nested field defaults.
- `packages/nax/src/config/runtime-types.ts` — public quality config shape.
- `packages/nax/src/config/merge.ts` — explicit per-package quality merge.
- `packages/nax/src/config/defaults.ts` — DEFAULT_CONFIG construction.

**US-003**
- `packages/nax/src/verification/executor.ts` — collectors, timeout and process-group cleanup.
- `packages/nax/src/verification/types.ts` — options and results.
- `packages/nax/src/quality/runner.ts` — the sibling engine whose extractions are shared.
- `packages/nax/test/unit/verification/executor.test.ts` — existing drain/kill expectations.
- `packages/nax/test/helpers/fake-clock.ts` — deterministic timer seam.

**US-004**
- `packages/nax/src/verification/runners.ts` — raw-result translation and list aggregation.
- `packages/nax/src/operations/verify-scoped.ts` — scoped fallback and timeout behavior.
- `packages/nax/src/operations/full-suite-gate.ts` — full-suite options and accept-on-timeout.
- `packages/nax/src/workflow/gates.ts` — story and suite gate timeout evidence.
- `packages/nax/test/unit/verification/runners.test.ts` — existing TIMEOUT and acceptOnTimeout cases.

**US-005**
- `packages/nax/src/quality/runner.ts` — incremental collection, exit wait and output-tail policy.
- `packages/nax/src/quality/index.ts` — quality barrel for the option and result types.
- `packages/nax/test/unit/quality/runner-drain.test.ts` — pending pipes and large-output coverage.
- `packages/nax/test/unit/quality/runner-timeout-kill.test.ts` — virtual-clock process-group coverage.
- `packages/nax/src/verification/executor.ts` — the terminal-race shape the runner adopts.

**US-006**
- `packages/nax/src/quality/aggregate.ts` — first-failure and any-timeout list semantics.
- `packages/nax/src/quality/runner.ts` — the list loop, already changed by US-005.
- `packages/nax/test/unit/quality/aggregate.test.ts` — existing aggregate expectations.

**US-007**
- `packages/nax/src/finish/gates/quality.ts` — root/overlay gate descriptions, setup and records.
- `packages/nax/src/finish/index.ts` — finish barrel for the gate types.
- `packages/nax/src/bot/checks.ts` — the projection that must stop dropping policy.
- `packages/nax/test/unit/finish/gates-quality.test.ts` — exact gate-object expectations.
- `packages/nax/test/unit/finish/gates-quality-e2e.test.ts` — e2e setup and inheritance expectations.

**US-008**
- `packages/nax/src/workflow/gates.ts` — story gates and their timeout evidence.
- `packages/nax/src/operations/lint-check.ts` — mechanical lint gate op.
- `packages/nax/src/review/runner/index.ts` — mechanical review checks and scoped-lint path.
- `packages/nax/src/cli/setup-verify.ts` — setup's verification gate.
- `packages/nax/src/bot/fix-steps.ts` — bot gate remapping that must keep the policy.

**US-009**
- `packages/nax/src/workflow/feature-steps.ts` — quality floor, B assignment and artifacts.
- `packages/nax/src/workflow/feature-graph.ts` — the `branch-review` node's declared outputs, which the persisted and cleared mismatch must join.
- `packages/nax/src/workflow/types.ts` — feature persistence contract.
- `packages/nax/src/workflow/approval.ts` — deterministic readiness reasons and the shared sentence source.
- `packages/nax/src/operations/workflow-replies.ts` — the story parser whose mismatch shape is reused.

**US-010**
- `packages/nax/src/workflow/approval.ts` — readiness reasons and the sentence source.
- `packages/nax/src/workflow/finalize.ts` — publish's readiness fact projection.
- `packages/nax/src/workflow/run-summary.ts` — branch counts and publish reason channel.
- `packages/nax/src/workflow/open-items.ts` — reason-item channel.
- `packages/nax/src/workflow/types.ts` — the persisted record and publish outcome types.

**US-011**
- `packages/nax/src/operations/workflow-replies.ts` — branch floor and story mismatch precedent.
- `packages/nax/src/operations/workflow-types.ts` — verdict and mismatch types.
- `packages/nax/test/unit/workflow/feature-minor-promotion.test.ts` — the consumer whose parsed expectations this story completes.
- `packages/nax/test/unit/operations/workflow-replies.test.ts` — parser expectations.
- `packages/nax/src/operations/workflow-story-review.ts` — the existing mismatch retry caller.

**US-012**
- `packages/nax/src/operations/workflow-branch-review.ts` — branch retry resolver.
- `packages/nax/src/agents/retry/coverage-retry.ts` — independent budget and no-progress semantics.
- `packages/nax/src/agents/retry/parse-retry.ts` — the shape strategy the clarification wrapper wraps and offsets.
- `packages/nax/src/agents/retry/index.ts` — the retry barrel the new factory is exported through.
- `packages/nax/src/prompts/builders/workflow-branch-builder.ts` — branch coverage prompt precedent and the new clarification builder's home.

**US-013**
- `packages/nax/src/operations/call-dispatch-run.ts` — the parse ladder, the authoritative parse and the retry-state carrier.
- `packages/nax/src/operations/post-parse.ts` — the `verify`-then-conditional-`recover` split the substituted value must satisfy.
- `packages/nax/src/operations/types.ts` — the operation type that gains the opt-in flag.
- `packages/nax/src/operations/workflow-branch-review.ts` — the one operation that sets the flag.
- `packages/nax/src/workflow/branch-review.ts` — the wrapper whose delivered verdict and skipped-review outcomes this handoff decides.

### Creates

**US-001**
- `packages/nax/src/utils/gate-stall.ts` — shared bounded observer, policy/reason types and the one default.
- `packages/nax/test/unit/utils/gate-stall.test.ts` — stream, delimiter, cap and timer behavior.

**US-002**
- `packages/nax/test/unit/config/gate-stall-schema.test.ts` — policy defaults, validation and merge.

**US-003**
- `packages/nax/test/unit/verification/executor-stall.test.ts` — controlled-stream detector and lifecycle cases, split by concern rather than ticket.

**US-004**
- `packages/nax/test/unit/verification/runners-stall.test.ts` — list aggregation in both orders and the interruptible-fallback contract.

**US-005**
- `packages/nax/test/unit/quality/runner-stall.test.ts` — early-stop, bounded-settlement and lifecycle cases; the existing runner test is already 781 lines.

**US-006**
None. Extend the existing aggregate and runner list coverage.

**US-007**
None. Extend the existing finish gate tests.

**US-008**
- `packages/nax/test/integration/gate-stall-routing.test.ts` — production entry-point policy/evidence wiring with injected child streams and fake clocks; no nax process or paid agent.

**US-009**
None. Extend existing feature-machine and equivalence coverage.

**US-010**
None. Extend existing readiness, publish and summary coverage.

**US-011**
None. Extend the existing branch reply parser tests.

**US-012**
- `packages/nax/src/agents/retry/mismatch-clarification-retry.ts` — the clarification strategy wrapper, exported through the existing retry barrel.
- `packages/nax/test/unit/agents/retry/mismatch-clarification-retry.test.ts` — the wrapper's latch, attempt offsetting, spent-shape accounting and interleaving with the shape and coverage strategies.

**US-013**
None. Extend the existing dispatch ladder and branch-operation tests.

### Modifies

Entries grant specific permission, not an instruction to weaken unrelated assertions. New optional fields do not authorize broad snapshot regeneration. Every entry names the old assertion that conflicts with the intended behavior and the invariant that replaces it.

**US-002**
- `packages/nax/test/unit/config/defaults.test.ts` — extend the schema/DEFAULT_CONFIG equality and default-surface assertions for the new quality block; the replacing invariant is that an absent quality block and an empty one resolve the same repeat-100/silence-0 policy from the leaf default, not two independently maintained defaults.
- `packages/nax/test/unit/config/merge.test.ts` — extend quality merge cases for a partial stallDetection overlay; preserve existing command/lintOutput assertions, with the added invariant that an explicit zero wins and an omitted policy sibling retains its root value.

**US-003**
- `packages/nax/test/unit/verification/executor.test.ts` — its timeout/kill/drain tests may observe streaming collector mechanics; preserve timeout flags, trust-before-spawn, bounded post-exit drains and every timer cleared, while permitting bytes already read to survive a drain deadline instead of requiring one buffered whole-stream read.

**US-004**
- `packages/nax/test/unit/verification/runners.test.ts` — preserve existing TIMEOUT and acceptOnTimeout assertions while extending stopped-result and list-aggregate shapes with the optional stop reason; list aggregation still runs every entry and keeps first-failure fields.
- `packages/nax/test/unit/operations/verify-scoped.test.ts` — option-forwarding and timeout cases may gain the policy and stop reason; TIMEOUT still returns status timeout and forbids the zero-tests full-suite rerun, and list interruption evidence now selects that same route.
- `packages/nax/test/unit/operations/full-suite-gate.test.ts` — runTests option and timeout result assertions may gain the policy and stop reason; existing passed-on-timeout versus timeout behavior remains the replacing invariant, not unconditional success or failure at this op layer.

**US-005**
- `packages/nax/test/unit/quality/runner-drain.test.ts` — pending-pipe and large-output cases may observe the bounded settle; preserve retained bytes, the drain deadline and every timer cleared.
- `packages/nax/test/unit/quality/runner-timeout-kill.test.ts` — virtual-clock process-group cases may observe the bounded settle; preserve one termination sequence, group escalation and the single-pid fallback rules.

**US-006**
- `packages/nax/test/unit/quality/aggregate.test.ts` — extend aggregate assertions with the first detector stop reason in command order; first nonzero exit, any-entry timeout, summed duration and every entry's output retain their existing meaning.

**US-007**
- `packages/nax/test/unit/finish/gates-quality.test.ts` — exact resolver assertions currently name only name/command/cwd/setup; authorize the added resolved policy while preserving root precedence, ordering, dedupe and distinct root keys, and authorize an optional stop reason only on a detector-stopped gate record.
- `packages/nax/test/unit/finish/gates-quality-e2e.test.ts` — the e2e and setup-inheritance exact-object assertions gain the resolved policy; e2e setup still precedes the journey in the same cwd, and a failed or stopped setup prevents the journey.
- `packages/nax/test/unit/workflow/repo-gates.test.ts` — the real-resolver assertion that pins a single root gate object gains that gate's same resolved policy; root precedence and the single-gate outcome are unchanged.
- `packages/nax/test/integration/runtime/package-profile-registry.test.ts` — the exact profile-resolved lint gate assertion gains the merged overlay policy while keeping the same name, command and package cwd.

**US-008**
- `packages/nax/test/unit/bot/checks.test.ts` — exact BotCheck gate assertions gain the trusted policy: the config-tier case, the extracted instruction-tier case, the preserved-setup case, the detected ordered-gates case, the usable-scripts table, the lockfile-prefix table and the lockfile-priority case; source, order, setup and preRun assertions are unchanged.
- `packages/nax/test/unit/review/scoped-lint.test.ts` — the production-adapter contract pin asserts the exact five-argument `runLintCommand(workdir, storyId, env, command, stripEnvVars)` call, which the added policy necessarily widens; authorize the policy-bearing call shape while preserving its actual invariant: the adapter still threads no story, projectDir, storyGitRef or scope, the missing-story-ref arm still logs the degraded warning and runs full lint (now with the schema-derived default policy), and the single-check, command and success assertions stand. This entry also authorizes the derived-arm fixture — restoring the real `runLintCommand` helper with `_scopedLintDeps.runQualityCommand` stubbed — that captures the policy arriving at command execution for the appended-files scoped command.
- `packages/nax/test/unit/cli/gates.test.ts` — JSON gate-report assertions may gain an optional stop reason only on a stopped gate; passed and not-run records, exit codes and the single-document contract are unchanged.
- `packages/nax/test/unit/workflow/gates.test.ts` — extend story-gate assertions so a stopped lint or typecheck report appears in the timed-out list; green, red and skipped states and the existing scoped and full-suite timeout assertions are unchanged.

**US-009**
- `packages/nax/test/unit/workflow/feature-machine-honesty.test.ts` — the synthetic-quality-floor case expects a branch fix, a B id and a bumped counter; the replacing invariant is persisted mismatch evidence, no verdict-only fix call and an unchanged counter, while cases with real blocking findings keep their real fix target.
- `packages/nax/test/unit/workflow/feature-minor-promotion.test.ts` — the direct-verdict quality-floor leave case loses its synthesized finding; the replacing invariant is that only authored blockers and genuine promoted minors receive B ids, and reviewer-authored text identical to the old floor text remains real work; the cases that parse a reply keep their current expectations until the parser stops injecting its floor.
- `packages/nax/test/unit/workflow/feature-machine-equivalence.test.ts` — the quality-floor scenario becomes a mismatch-only trace with no invented fix target; unrelated scenarios are not authorized for blanket regeneration.
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — its exact `branch-review` produces pin currently lists `reviewRan`, `cannotVerify`, `reviewUnread`, `reviewOpen`, `nextFindingId`, `minors` and `newMinors`; authorize adding `reviewMismatch` to that expected set so the graph accepts both the persistence patch and the explicit stale-evidence clear. Preserve every other node's expected outputs, every node kind, exit and transition assertion.
- `packages/nax/test/fixtures/workflow-equivalence/feature/quality-floor.json` — this golden trace encodes the synthetic floor fix session and counter; update only this scenario's affected events and end record to mismatch evidence with no synthetic fix.

**US-010**
- `packages/nax/test/unit/workflow/approval.test.ts` — extend deterministic reason fixtures with the ordered branch mismatch sentences; retain every independent gate, CI, unread-file, skipped-review and story reason assertion.
- `packages/nax/test/unit/workflow/run-summary.test.ts` — extend branch-count and publish-summary cases so mismatch contributes zero found/fixed findings and its persisted reason survives; existing story mismatch counts are unchanged.

**US-011**
- `packages/nax/test/unit/operations/workflow-replies.test.ts` — the branch tests that currently require synthesized findings or a missing mismatch now expect the real drafts plus the same mismatch kinds as the story parser; malformed shape still returns null.
- `packages/nax/test/unit/workflow/feature-minor-promotion.test.ts` — the parsed spec-fail and parsed quality-floor cases now expect only real and promoted work; the replaced expectation is the parser-injected blocker, not the promoted minor.

**US-012**
- `packages/nax/test/unit/operations/workflow-branch-review.test.ts` — retry assertions may account for the one-turn clarification prompt and the captured `_branchReviewRetryDeps` factory and builder calls; clean, malformed-only and coverage-only cases keep their current prompts and bounds. US-012's permission here covers the clarification prompt, the priority order, the send counts and the two seam captures only — never a delivered-value assertion.
- `packages/nax/test/unit/operations/workflow-branch-review-coverage.test.ts` — coverage budget and no-progress assertions remain, extended for shape and clarification interleavings; a clarification response alone is not a coverage no-progress event.

**US-013**
- `packages/nax/test/unit/operations/call.test.ts` — the parse-failure ladder cases keep their precedence for operations that do not opt in; authorize the added opt-in null-parse cases, including the rejected fallback classes that raise `CALL_OP_INVALID_FALLBACK`, without rewriting the existing ladder.
- `packages/nax/test/unit/operations/workflow-branch-review.test.ts` — US-013's permission in this file is limited to the opt-in handoff outcomes: the flag set on `workflowBranchReviewOp`, the last parseable verdict reached through real `callOp` after a malformed clarification and exhausted repair, the findings that survive coverage exhaustion, and the null result with no parseable reply. US-012 owns the clarification-prompt and send-count cases in the same file; neither story may rewrite the other's cases.
- `packages/nax/test/unit/workflow/branch-review-sliced.test.ts` — extend the wrapper cases with the opt-in handoff outcome (an inconsistent last-parseable verdict delivered as the branch verdict, and a null result still reported as skipped review); the existing package-failure, abort-propagation and review-timeout cases stay green unedited as the outer deadline anchor.

Collision sweep performed for the two closed-world shapes this feature widens. `GateCommand` exact objects are asserted only in the two finish gate test files listed under US-007, in the workflow repo-gates test, and in the package-profile-registry integration test; the CLI gate tests assert JSON report records rather than gate objects, and the other resolver call sites stub the resolver with empty or local arrays. `BotCheck` exact objects are asserted only in the bot checks test file listed under US-008; the review-build-steps test and the bot fix helpers build their own literals, which stay valid because the field is optional. A third closed-world pin is the injected-helper argument list in `test/unit/review/scoped-lint.test.ts`: the policy must cross `runLintCommand`, so that call shape necessarily widens, and US-008 carries the authorization together with the invariant it preserves. A fourth is the `branch-review` produces list in `test/unit/workflow/feature-graph.test.ts`, authorized under US-009; the graph's own validator covers every other node's declaration, so no other exact output set needs editing.

### Seams

- US-001 -> US-003/US-005: trigger `executeWithTimeout` and `runQualityCommand` with explicit policies and controlled child streams; capture monitor construction and observations at the existing injected runner seams, then observe one stop result. A second late callback must not launch another kill sequence.
- US-001 -> US-002 -> US-007: enter `runRepoGates` with a configured gate whose policy is sparse, and capture `resolveStallDetection` through the finish gate's dependency seam with that input, then the completed policy at `_qualityGateDeps.run`. A behavior test that only sees final values cannot tell the shared resolver from inline merging, so the resolver call itself is the assertion.
- US-004/US-007 -> US-008: enter `runStoryGates`, `runWorkflowSuiteGate`, `runRepoGates`, `gatesRunCommand`, `runSetupGate`, `runReview` and bot `gatesStep`/`failingOnHead`; capture the real engine options above command-provenance and projection guards and assert the configured policy reaches the spawn execution path. Stub LLM-facing collaborators, not the policy mapping under test.
- US-009 -> US-010: persist the record from the production branch-review step, then call production `publish` with green gates, green CI and an approving advisor double. Assert the unresolved mismatch keeps draft readiness without becoming B work. Capture `_approvalDeps.branchMismatchReasons` being called with the persisted kinds at **both** owning call sites in that one flow: from the branch-review step (the ledger note) and again from `readinessReasons` reached by that `publish` call, so the shared sentence source is used at each production entry rather than re-spelled inline. A capture at the step alone passes a build whose `readinessReasons` still hard-codes the text, which is why both are asserted.
- US-009 -> US-011 -> US-012: enter `runFeatureMachine` and `runBranchReview` with the production reply parser and outcome, then drive real `callOp(workflowBranchReviewOp)` with scripted replies for the clarification and coverage paths. Capture `makeMismatchClarificationStrategy` and `buildWorkflowBranchVerdictMismatchRetry` at the `_branchReviewRetryDeps` entries during that same driven call, asserting the factory's options and that the sent clarification prompt is the builder's output; a real-`callOp` outcome alone passes with both exports replaced by inline duplicates. Resume from the persisted post-review record and verify no new clarification or fix is caused solely by that evidence.
- US-012 two-hop budget: drive real `callOp(workflowBranchReviewOp)` with a scripted manager fallback double — the first hop spends the JSON repair, the hop then fails on the adapter, and the second hop's first malformed reply must receive no second repair prompt. Assert the second hop's reply count, not just the final verdict: a per-hop subtraction looks correct on a single hop and is only distinguishable across two.
- US-012 -> US-013: with the opt-in flag set on the branch operation, drive real `callOp` with a strategy double whose recorded fallback is a plain record and an `op.parse` that returns null; assert the fallback reaches `runBranchReview` and that the operation's `verify` double observes that object while `recover` is invoked only when the `verify` double returns null. Then drive the rejected classes — an array and a class instance — and assert `CALL_OP_INVALID_FALLBACK` with neither hook reached, and the absent/null fallback and the no-parseable-reply paths and assert the null result reaching the wrapper's skipped-review outcome.

## Acceptance Criteria

### US-001

- [unit] `createGateStallMonitor` emits repeated-output on the Nth consecutive equal eligible line of one stream for threshold N, counting the first occurrence as 1.
- [unit] `createGateStallMonitor` keeps stdout and stderr repetition counts independent under interleaved identical text.
- [unit] `createGateStallMonitor` resets a stream's repetition count on a different eligible line.
- [unit] `createGateStallMonitor` resets a stream's repetition count on a whitespace-only line.
- [unit] `createGateStallMonitor` never counts a whitespace-only line toward a stop.
- [unit] `createGateStallMonitor` compares decoded text exactly, so indentation, trailing spaces, case and ANSI differences are distinct lines.
- [unit] `createGateStallMonitor` produces the same line decisions for arbitrarily split UTF-8 multibyte sequences as for unsplit input.
- [unit] `createGateStallMonitor` treats a CRLF delimiter split across chunks as one delimiter, and LF as the line end.
- [unit] `createGateStallMonitor` treats a bare CR as ordinary content rather than a delimiter.
- [unit] `createGateStallMonitor.end` treats a nonempty unterminated tail as one final line while the monitor is live.
- [unit] `createGateStallMonitor` ignores an over-16,384-code-unit line through its delimiter instead of matching a truncated prefix.
- [unit] `createGateStallMonitor` with positive silenceTimeoutSeconds emits silence after that many seconds without nonempty bytes since spawn.
- [unit] `createGateStallMonitor` resets silence on a nonempty chunk on either stream, including blank and partial-line chunks.
- [unit] `createGateStallMonitor` does not reset silence on an empty chunk.
- [unit] `createGateStallMonitor` does not reset silence at stream EOF.
- [unit] `createGateStallMonitor` with both policy values zero emits no stop while fake time advances and repeated lines arrive.
- [unit] `createGateStallMonitor` with repeated lines arriving before each silence deadline stops for repeated-output rather than deferring repetition to silence.
- [unit] `createGateStallMonitor.dispose` prevents later callbacks from emitting a stop.
- [unit] `createGateStallMonitor.dispose` leaves no active silence timer.
- [unit] Two `createGateStallMonitor` instances maintain isolated counters and silence deadlines when their streams are interleaved.
- [unit] `resolveStallDetection` fills an absent field from `DEFAULT_GATE_STALL_POLICY` and preserves an explicit zero.

### US-002

- [unit] `NaxConfigSchema.parse` with quality absent resolves `stallDetection.repeatedLineThreshold` to 100.
- [unit] `NaxConfigSchema.parse` with quality absent resolves `stallDetection.silenceTimeoutSeconds` to 0.
- [unit] An empty quality block resolves the same policy as an absent quality block.
- [unit] `StallDetectionConfigSchema` accepts repeatedLineThreshold 0.
- [unit] `StallDetectionConfigSchema` accepts an integer repeatedLineThreshold of 2 or more.
- [unit] `StallDetectionConfigSchema` rejects repeatedLineThreshold 1, negatives, fractions, strings, booleans, null and non-finite programmatic numbers.
- [unit] `StallDetectionConfigSchema` accepts silenceTimeoutSeconds 0 and a positive integer.
- [unit] `StallDetectionConfigSchema` rejects negative, fractional, non-numeric, null, boolean and non-finite silenceTimeoutSeconds values.
- [unit] The root quality literal carries the block, so `DEFAULT_CONFIG` and a whole-config parse both expose it.
- [unit] `mergePackageConfig` retains an unset root-policy sibling when a package overrides one stallDetection field.
- [unit] `mergePackageConfig` honors an explicit package zero over a non-zero root value.

### US-003

- [integration] `executeWithTimeout` with an explicit repetition policy feeds controlled stdout and stderr chunks into `createGateStallMonitor` before child exit, so a live repeated-line process stops before its wall timeout.
- [unit] `executeWithTimeout` on repeated-output or opted-in silence returns success false with the raw timeout-lane flags.
- [unit] That raw stopped result carries the matching structured `stopReason`.
- [unit] `executeWithTimeout` detector-stop `error` starts with `EXECUTION_STALLED:` and identifies the actual threshold and stream, or the silence setting, rather than claiming the wall deadline elapsed.
- [unit] `executeWithTimeout` leaves `stopReason` absent on an ordinary wall timeout.
- [unit] `executeWithTimeout` leaves `stopReason` absent on a normal exit.
- [unit] `executeWithTimeout` leaves `stopReason` absent on a stream error or a drain-deadline expiry.
- [unit] `executeWithTimeout` with no stallDetection argument retains a quiet live process until its ordinary wall timeout.
- [unit] `executeWithTimeout` with no stallDetection argument creates no monitor, so no detector can stop the run.
- [unit] `executeWithTimeout` uses one SIGTERM-to-SIGKILL group-cleanup sequence when detector stop wins.
- [unit] `executeWithTimeout` SIGKILLs surviving group members after leader exit with single-pid fallback disabled.
- [unit] `executeWithTimeout` cancels escalation when its stopped process group is empty and clears all timers and readers within the bounded drain lifecycle.
- [unit] `executeWithTimeout` preserves a normal leader result when exit is observed before a queued detector or deadline event, even if an inherited pipe remains open.
- [unit] `executeWithTimeout` keeps timeout failure when detector stop is observed before an exit-0 event.
- [unit] `executeWithTimeout` starts no second termination sequence when a later stop or deadline callback fires after the first one.
- [unit] `executeWithTimeout` retains already-collected stdout then stderr when a stream errors or a drain deadline expires.
- [unit] `executeWithTimeout` does not reclassify a normal exit as a detector stop when a stream errors.
- [unit] `executeWithTimeout` drains simultaneous output larger than an OS pipe buffer without deadlock.
- [unit] `executeWithTimeout` captured output text is unchanged by detector normalization.
- [unit] `executeWithTimeout` refuses an untrusted cwd before creating a monitor or spawning a child.

### US-004

- [unit] The `scoped` and `regression` verification list runs every entry in command order after a detector stop.
- [unit] In the failure-then-stop order, list status, exitCode and error remain the first failing entry's values.
- [unit] In the stop-then-failure order, list status, exitCode and error remain the first entry's values.
- [unit] Both orders expose the first detector reason in command order as the list `stopReason`.
- [unit] `countsTowardEscalation` keeps its any-entry semantics in both orders.
- [unit] A list with no stopped entry carries no `stopReason`.
- [unit] `scoped` and `regression` pass their configured stallDetection into the executor.
- [unit] `scoped` and `regression` retain `status:TIMEOUT` and countsTowardEscalation false on a detector interruption.
- [integration] `verifyScopedOp.execute` forwards package-view stallDetection into scoped selection.
- [integration] `verifyScopedOp.execute` forwards the same policy into its ordinary zero-tests full-suite rerun path.
- [integration] `verifyScopedOp.execute` returns status timeout with the stopReason when the scoped run is interrupted.
- [integration] `verifyScopedOp.execute` starts no zero-tests full-suite rerun when the aggregate carries a stop reason although its status is a test failure.
- [integration] `fullSuiteGateOp.execute` forwards gate-context stallDetection to regression.
- [integration] `fullSuiteGateOp.execute` derives its timeout evidence from a list-level stop reason even when the aggregate status is a test failure.
- [integration] `fullSuiteGateOp.execute` keeps the acceptOnTimeout passed-on-timeout and timeout outcomes and carries the stopReason on both.
- [integration] `runWorkflowSuiteGate` reports a stopped full suite as red and timed out even when the operation returns passed-on-timeout.

### US-005

- [integration] `runQualityCommand` with explicit stallDetection feeds live child chunks into `createGateStallMonitor`, so repetition or opted-in silence can interrupt before the wall timeout.
- [unit] `runQualityCommand` detector interruption returns success false, timedOut true, exitCode -1 and the matching structured stopReason.
- [unit] `runQualityCommand` harness output identifies stopped-early repeated-output or silence.
- [unit] `runQualityCommand` stopped harness output does not expose partial test diagnostics as a completed run.
- [unit] `runQualityCommand` agent-tool output retains the existing bounded line-boundary tail when explicitly given a stall policy.
- [unit] An ordinary agent-tool call with no policy remains detector-disabled.
- [unit] `runQualityCommand` with no stallDetection argument retains existing normal-exit and wall-timeout output contracts without stopReason.
- [unit] `runQualityCommand` detector interruption preserves group escalation after leader exit with single-pid fallback disabled for the remaining group.
- [unit] `runQualityCommand` clears all armed timers by the existing drain deadline after a detector stop.
- [unit] `runQualityCommand` cancels stalled readers best-effort by the existing drain deadline after a detector stop.
- [unit] `runQualityCommand` returns the observed normal exit result when leader exit wins over a queued detector callback or slow inherited pipe drain.
- [unit] `runQualityCommand` retains detector failure when the detector callback wins over exit 0.
- [unit] Repetition, silence and wall callbacks collectively start at most one termination sequence.
- [unit] `runQualityCommand` stream errors preserve text already collected without producing stopReason by themselves.
- [unit] `runQualityCommand` consumes both pipes concurrently without losing a large nonrepeating output body.
- [unit] `runQualityCommand` returns the stopped result after bounded grace and bounded drains when the child exit promise never settles.
- [unit] `runQualityCommand` performs the existing trust check before creating a monitor or spawning a child.
- [unit] `runQualityCommand` keeps the existing floating `.catch` behavior when `proc.exited` rejects: no `stopReason` and no reclassified result.

### US-006

- [unit] `runQualityCommand` gives every list entry fresh repetition and silence state.
- [unit] `runQualityCommand` continues later list entries after a stopped entry.
- [unit] `aggregateResults` exposes the first detector stopReason in command order.
- [unit] `aggregateResults` preserves the first non-zero step's exit code.
- [unit] `aggregateResults` preserves any-entry timedOut semantics.
- [unit] `aggregateResults` preserves summed duration and every entry's output.

### US-007

- [unit] `resolveGateCommands` attaches the root's resolved policy to root commands.
- [unit] `resolveGateCommands` attaches the field-wise merged overlay policy to eligible package commands.
- [unit] `resolveGateCommands` keeps root-key precedence unchanged when an overlay names the same gate key.
- [unit] `resolveGateCommands` includes the resolved policy in overlay run identity, so identical command, setup and cwd with different policies stay distinct runs.
- [unit] `resolveGateCommands` still deduplicates overlay gates whose resolved policies are identical.
- [integration] `runRepoGates` reaches `runQualityCommand` with the resolved policy for configured gates through the real finish helpers.
- [integration] `runRepoGates` reaches `resolveStallDetection` through `_qualityGateDeps` for a configured gate, passing that gate's sparse policy input and handing the completed policy to the quality runner.
- [unit] `runQualityGates` gives a manually constructed GateCommand with no policy `DEFAULT_GATE_STALL_POLICY`.
- [unit] `runQualityGates` honors an explicit both-zero policy instead of the default.
- [unit] `runQualityGates` classifies detector-stopped exit -1 as timed-out.
- [unit] `runQualityGates` copies the stopReason to the gate record.
- [unit] `runQualityGates` continues subsequent gates after a stopped gate.
- [unit] A gate record carries stopReason only when a detector stopped the run.
- [integration] `runQualityGates` passes the e2e gate's policy to its setup command.
- [integration] A stopped e2e setup yields that gate's timed-out record with failedPhase setup.
- [integration] The e2e journey does not start after a stopped setup.

### US-008

- [integration] `runStoryGates` passes the package-view stallDetection to lint, including manifest-detected commands, after resolving command provenance.
- [integration] `runStoryGates` reports a stopped lint command in `GateRunResult.timedOut`.
- [integration] `runStoryGates` passes the package-view stallDetection to typecheck.
- [integration] `runStoryGates` reports a stopped typecheck command in `GateRunResult.timedOut`.
- [integration] `runStoryGates` keeps a green lint or typecheck gate out of the timed-out list.
- [integration] `runReview` mechanical checks pass the provided config policy to the quality runner.
- [integration] `runScopedLintCheck` template, full and degraded paths pass the same policy.
- [integration] `runScopedLintCheck`'s supported derived-command arm — no template, no degraded reason, a derivable full-lint command — passes that same policy to command execution, captured at the quality-runner seam with the appended-files scoped command.
- [unit] `runReview` with no full config gets the schema-derived policy rather than detector-disabled behavior.
- [integration] `runSetupGate` forwards the supplied config policy to its verification command.
- [integration] `runSetupGate` returns the existing nonzero result when the command is stopped.
- [unit] `resolveBotChecks` preserves a configured gate's policy when projecting trusted snapshot gates.
- [unit] `resolveBotChecks` attaches the trusted input-config policy to instruction-derived gates rather than accepting extracted thresholds.
- [unit] `resolveBotChecks` attaches the same trusted policy to detection-derived gates.
- [integration] Bot `gatesStep` retains the reviewed gate policy while mapping execution to the checkout worktree.
- [integration] `failingOnHead` retains the reviewed gate policy when running the baseline on the unmodified head.
- [integration] Neither bot `gatesStep` nor `failingOnHead` rereads the policy from the fixed tree.
- [integration] `gatesRunCommand` with a stopped configured gate returns exit 2.
- [integration] `gatesRunCommand` writes one JSON document containing that gate's structured stopReason.
- [integration] `gatesRunCommand` plain output shows the reason in that gate's output.
- [integration] `runStoryGates` with an enabled detector and controlled child streams surfaces an early-stop reason in its timeout finding text instead of returning a false green from partial parser output.

### US-009

- [unit] `branchReviewStep` writes the branch-review artifact with real assigned finding ids and no synthesized verdict-floor draft.
- [unit] `withQualityFloor` adds no draft of its own: B ids come from the verdict's blocking drafts plus promoted minors, and the existing exclusion of a parser-marked quality floor when promoted minors exist is unchanged.
- [unit] A quality changes verdict with no blocking finding and no promoted minor issues no B id.
- [integration] `runFeatureMachine` dispatches no branch fix for mismatch-only evidence.
- [integration] `runFeatureMachine` recognizes spec-fail-without-evidence on a directly injected verdict that omits mismatch metadata.
- [integration] `runFeatureMachine` recognizes changes-without-a-blocking-finding on a directly injected verdict that omits mismatch metadata.
- [integration] `runFeatureMachine` persists `reviewMismatch.kinds` in spec then quality order.
- [integration] `runFeatureMachine` keeps reviewRan true for a parseable inconsistent review.
- [integration] `runFeatureMachine` still fixes real blocking findings and gate findings alongside a mismatch.
- [integration] `runFeatureMachine` still fixes fix-now minors alongside a mismatch.
- [integration] `runFeatureMachine` still assigns B ids to promoted minors alongside a mismatch.
- [integration] `runFeatureMachine` retains a spec mismatch when a quality minor is promoted.
- [unit] `branchMismatchReasons` emits each applicable stable sentence once, in spec then quality order.
- [integration] `runFeatureMachine`'s branch-review step obtains those sentences through `_approvalDeps.branchMismatchReasons` with the persisted kinds, so the shared formatter is the source of the ledger text rather than an inline duplicate.
- [integration] `runFeatureMachine` resumed downstream of branch review retains mismatch evidence without launching clarification or a fix solely for it.
- [unit] A newly consistent full branch review clears stale reviewMismatch evidence.
- [unit] A downstream finding re-review does not clear reviewMismatch.
- [unit] A historical record lacking reviewMismatch produces no readiness reason and unchanged finding counts.

### US-010

- [unit] `readinessReasons` yields the exact spec mismatch sentence for the spec kind.
- [unit] `readinessReasons` yields the exact quality mismatch sentence for the quality kind.
- [unit] `readinessReasons` yields both sentences in spec then quality order when both kinds are persisted.
- [unit] `readinessReasons` preserves independent unread-file, gate, CI, skipped-review and story reasons alongside the mismatch sentences.
- [integration] Production `publish` with green gates, green CI and an approving advisor double leaves the PR a draft.
- [integration] That publish path never asks finish approval to overrule the deterministic mismatch reason.
- [integration] Production `publish` retains the mismatch reason under local-only mode without inventing a PR operation.
- [integration] Production `publish` retains the mismatch reason under push-only mode without inventing a PR operation.
- [integration] Production `publish` obtains the mismatch readiness reason through `_approvalDeps.branchMismatchReasons`, captured during that `publish` call with the persisted kinds, so the shared formatter is the source of the readiness text rather than an inline duplicate.
- [integration] The sentence `_approvalDeps.branchMismatchReasons` returns during that `publish` call is the mismatch reason `PublishOutcome.reasons` carries.
- [unit] `buildWorkflowRunSummary` reports zero added branch findings for mismatch-only evidence.
- [unit] `buildWorkflowRunSummary` carries the published mismatch reason and `formatWorkflowSummary` renders it on the Publish line.
- [unit] `buildOpenItems` represents a persisted publish mismatch reason as a reason item rather than a finding or ruling.
- [unit] Mismatch-only readiness leaves `workflowPassed` and `RunResult.success` unchanged.

### US-011

- [unit] `parseBranchReviewReply` returns the spec mismatch for a fail verdict with no critical or important spec finding.
- [unit] `parseBranchReviewReply` preserves only the real drafts when the reply has no findings.
- [unit] `parseBranchReviewReply` preserves only the real drafts when findings were dropped as invalid.
- [unit] `parseBranchReviewReply` preserves only the real drafts when findings are minor-only.
- [unit] `parseBranchReviewReply` returns the quality mismatch for a changes verdict with no critical or important finding.
- [unit] `parseBranchReviewReply` adds no important quality draft for that case.
- [unit] `parseBranchReviewReply` reports both mismatch kinds once in spec then quality order when neither verdict has its evidence.
- [unit] `parseBranchReviewReply` preserves concrete blocking findings and the existing known-minor triage normalization for a consistent reply.
- [unit] `parseBranchReviewReply` still returns null for a malformed verdict shape.

### US-012

- [integration] `callOp(workflowBranchReviewOp)` sends exactly one mismatch clarification when a parseable review lacks blockers.
- [integration] `callOp(workflowBranchReviewOp)` issues that clarification on the initial review's session handle, so no second review session is opened.
- [integration] `buildWorkflowBranchVerdictMismatchRetry`'s clarification text asks for the failed kind's remedy and to name the missing defect or failed AC, or to correct the verdict.
- [integration] The clarification requires the complete branch-review object naming findings, inspectedFiles, cannotVerify and minorTriage.
- [integration] `callOp(workflowBranchReviewOp)` accepts a corrected clean verdict with no fix target.
- [integration] `workflowBranchReviewOp.retry` returns real blocking work for the clarified reply that names the missing defect.
- [integration] A persistently inconsistent reply receives no second mismatch clarification from `callOp(workflowBranchReviewOp)` after its one clarification.
- [unit] `workflowBranchReviewOp.retry` reports the last parseable reply, with its mismatch evidence and real findings, as its exhausted fallback rather than returning null solely because the reply is inconsistent.
- [integration] `workflowBranchReviewOp.retry` repairs a malformed clarification only with the remaining one-turn JSON allowance.
- [integration] `workflowBranchReviewOp.retry` clarifies an initially inconsistent and incomplete reply before sending any coverage prompt.
- [integration] `workflowBranchReviewOp.retry` keeps the configured `coverageRetries` allowance for coverage prompts sent after a clarification.
- [integration] Those post-clarification coverage prompts from `workflowBranchReviewOp.retry` keep their diff-part references.
- [unit] `workflowBranchReviewOp.retry` measures coverage no-progress only against responses to coverage prompts.
- [unit] `workflowBranchReviewOp.retry` spends no `coverageRetries` budget on a clarification or shape response.
- [unit] `workflowBranchReviewOp.retry` cannot reset an active coverage allowance with a clarification or shape response.
- [unit] `workflowBranchReviewOp.retry` cannot reopen a stopped coverage state with a clarification or shape response.
- [integration] A mismatch first introduced by a coverage response is clarified by `workflowBranchReviewOp.retry` only while its invocation-local clarification latch remains unspent.
- [integration] `workflowBranchReviewOp.retry` does not suppress the unspent clarification on coverage budget or no-progress exhaustion.
- [integration] For coverage allowance C, `callOp(workflowBranchReviewOp)` sends no more than 3+C semantic replies in one completed hop.
- [integration] `workflowBranchReviewOp.retry` issues no JSON repair in a manager fallback hop when one was already issued in an earlier hop, because the shape allowance is spent once per invocation.
- [integration] No clarification, JSON or coverage prompt is sent for an adapterFailure transport result.
- [integration] `workflowBranchReviewOp.retry` obtains its clarification wrapper from `_branchReviewRetryDeps.makeMismatchClarificationStrategy`, captured during a real `callOp(workflowBranchReviewOp)` mismatch run with the parsed-reply callback and clarification prompt factory in its options, and the wrapper that stub returns decides the follow-up prompts.
- [integration] The clarification prompt `callOp` sends is the output of the captured `_branchReviewRetryDeps.buildWorkflowBranchVerdictMismatchRetry` call, made with the failed kind.

### US-013

- [integration] With `preferRetryFallbackOnNullParse` set, `callOp` returns the strategy's plain-record fallback when `op.parse` returns null.
- [integration] That opt-in result passes the fallback object to a declared `verify` as the value it observes, driven through real `callOp` with an operation double that sets the flag and declares `verify`.
- [integration] `recover` runs for that opt-in result only when that `verify` returns null.
- [integration] A fallback record whose prototype is null is substituted as the parsed value under the flag.
- [integration] An array fallback under the flag raises `CALL_OP_INVALID_FALLBACK` before any post-parse hook runs.
- [integration] A class-instance fallback under the flag raises `CALL_OP_INVALID_FALLBACK` and substitutes nothing.
- [integration] Under `preferRetryFallbackOnNullParse`, `callOp` leaves the null parse result intact when the strategy's `retryFallback` is null or absent.
- [integration] With the flag set and no parseable reply, `runBranchReview` reports skipped review for the resulting null verdict instead of a clean one.
- [integration] `runBranchReview` receives the last parseable inconsistent review as the branch verdict instead of a skipped review, because `workflowBranchReviewOp` sets the flag.
- [integration] Through real `callOp(workflowBranchReviewOp)`, a parseable inconsistent verdict followed by a malformed clarification and an exhausted malformed shape repair returns the last parseable verdict.
- [integration] `workflowBranchReviewOp.retry` keeps the real findings of the last-parseable verdict after coverage exhaustion.
- [integration] `workflowBranchReviewOp.retry` also keeps the mismatch kinds carried by that last-parseable verdict after coverage exhaustion.
- [integration] An operation without the flag whose parse throws keeps today's precedence, returning the recorded fallback through the existing throwing-path check even when that fallback is an array.

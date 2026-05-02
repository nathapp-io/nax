# ADR-022: Fix Strategy and Cycle Orchestration

**Status:** Proposed
**Date:** 2026-05-02
**Author:** William Khoo, Claude
**Builds on:** ADR-021 (Finding Type SSOT)
**Related:** ADR-006 (Acceptance Retry Loop Restructure — superseded in part by phase 4 of this ADR)

---

## Context

Three subsystems each implement their own diagnose-fix-validate loop:

| Subsystem | Loop entry point | Carry-forward mechanism |
|:---|:---|:---|
| Acceptance | [`runAcceptanceLoop`](../../src/execution/lifecycle/acceptance-loop.ts) → [`applyFix`](../../src/execution/lifecycle/acceptance-fix.ts#L153) | `previousFailure: string` blob ([acceptance-loop.ts:299](../../src/execution/lifecycle/acceptance-loop.ts#L299)) |
| Autofix (lint / typecheck / adversarial) | [`runAgentRectification`](../../src/pipeline/stages/autofix-agent.ts#L89) calls [`runRetryLoop`](../../src/verification/shared-rectification-loop.ts) | per-attempt prompt rebuild via `RectifierPromptBuilder` |
| Test rectification | [`rectify.ts`](../../src/pipeline/stages/rectify.ts#L38) calls `runRectificationLoop` | inline in rectification loop |

Adversarial review additionally maintains a `priorFindingsBlock` in its prompt builder, asking the reviewer to verdict each prior finding before scanning for new ones — but this is not invoked by acceptance or autofix.

ADR-021 introduces a unified `Finding` type. This ADR introduces unified orchestration: a `FixStrategy` abstraction declarable per finding source, a `runFixCycle` that drives strategies through an iteration history, and a shared `buildPriorIterationsBlock` prompt helper that all rectifier-class prompts can consume.

A separate critical review (2026-05-02) of an earlier draft surfaced eleven design decisions that this ADR makes explicit:

1. **`runRetryLoop` overlap** — `runFixCycle` does not replace it; it sits above it.
2. **Cycle granularity** — per-subsystem cycles, multi-source within subsystem.
3. **Validator coupling** — what validator runs, and when, in a co-run iteration.
4. **Validator failure semantics** — retry once, then terminal.
5. **Verdict overload** — acceptance's `verdict` is more than routing; it drives fast-paths that produce no findings.
6. **`stubRegenCount` cycle-wide state** — not representable as a strategy-level `bailWhen`.
7. **Co-run validation order** — validate after each strategy or once at iteration end.
8. **`Iteration` records multiple `FixApplied` per validation** — strategy invocations are not 1:1 with iterations.
9. **`classifyOutcome` cross-source algorithm** — per-source bucket, then aggregate.
10. **Strategy is a value not a class** — constructed at the cycle entry point, captures closure context.
11. **`co-run-parallel` removed** — reserved but unused; YAGNI.

## Decision

### 1. Three-layer nesting: cycle → strategy group → retry loop

`runFixCycle` does not replace `runRetryLoop`. The layers compose:

```
runFixCycle<F>(cycle, ctx)
  per iteration:
    1. select matching strategies (appliesTo)
    2. exclusive strategy wins; else co-run group runs sequentially
    3. for each strategy in group:
         strategy.fixOp invoked via callOp
           (strategy.fixOp may internally use runRetryLoop for same-session JSON-parse retries — that is opaque to the cycle)
    4. validate ONCE at end of iteration (see §4)
    5. classify outcome, push Iteration, repeat
```

`runRetryLoop` continues to handle:
- Same-session retry on transient parse failures
- Progressive prompt urgency (rethink-at-attempt, urgency-at-attempt)
- Per-attempt session lifecycle

`runFixCycle` adds, on top:
- Multi-strategy iteration with co-run discipline
- Validator deduplication per iteration
- Outcome classification (resolved / partial / regressed / unchanged)
- Cross-iteration history for prompt carry-forward

### 1b. Cycle granularity — per-subsystem, multi-source within subsystem

A cycle is **scoped to a subsystem** (the unit that owns its validator), not to a single finding source. Within that subsystem, the cycle holds strategies for every source that can flow through the same validator.

| Cycle | Strategies | Why grouped |
|:---|:---|:---|
| **Autofix** (review checks) | `lint`, `typecheck`, `adversarial`, `plugin`, `test-writer`, `implementer` | All re-validated by the same `recheckReview` pass; cross-source drift (e.g. lint fix introduces typecheck error) is naturally handled because the next iteration sees the new finding and the matching strategy picks it up |
| **Acceptance** | `acceptance-source-fix`, `acceptance-test-fix` | Single-source by nature; both validated by re-running the acceptance test suite |
| **Test rectification** (if/when migrated) | `tdd-verifier` | Validated by re-running the test command |

This mirrors current code: `runAgentRectification` already receives a mixed-source `failedChecks` array (lint + typecheck + adversarial together) and dispatches the implementer once for everything. Phase 7's autofix migration preserves that behaviour by composing all those strategies in one `FixCycle`.

**Consequence:** strategies must use discriminating `appliesTo` selectors (by `source`, `category`, or `fixTarget`) to avoid collisions when two strategies could match the same finding. Reviewer discipline; not enforced by the type system.

### 2. Iteration shape — multiple fixes per validation

```typescript
interface Iteration<F extends Finding = Finding> {
  iterationNum: number;                 // 1-indexed
  findingsBefore: F[];
  fixesApplied: FixApplied[];           // ≥1 — one per strategy that ran in this iteration
  findingsAfter: F[];
  outcome: IterationOutcome;
  startedAt: string;
  finishedAt: string;
}

interface FixApplied {
  strategyName: string;
  op: string;                           // operation name from RunOperation.name
  targetFiles: string[];
  summary: string;                      // first ~500 chars of agent response or stdout
  costUsd?: number;
}

type IterationOutcome =
  | "resolved"                          // findingsAfter is empty
  | "partial"                           // findingsAfter is a strict subset of findingsBefore
  | "regressed"                         // findingsAfter contains new findings not in findingsBefore
  | "unchanged"                         // findingsAfter equals findingsBefore (same files+rules+lines)
  | "regressed-different-source";       // before had source A, after has source B
```

`fixesApplied: FixApplied[]` (plural) accommodates current behaviour where one diagnose-fix iteration runs `acceptanceFixSourceOp` then `acceptanceFixTestOp` (verdict=both), and where autofix runs test-writer then implementer.

**`classifyOutcome` algorithm — per-source bucket, then aggregate.** Mixed cross-source comparisons (e.g. `before: [lintA, lintB]`, `after: [lintA, typecheckC]`) are not meaningful at the unified level — severity comparisons across sources don't share a vocabulary. Algorithm:

```typescript
function classifyOutcome(before: Finding[], after: Finding[]): IterationOutcome {
  const sources = new Set([...before, ...after].map((f) => f.source));
  const perSource = [...sources].map((source) =>
    classifySingleSource(
      before.filter((f) => f.source === source),
      after.filter((f) => f.source === source),
    ),
  );
  // Aggregate:
  if (perSource.every((o) => o === "resolved")) return "resolved";
  if (perSource.some((o) => o === "regressed")) return "regressed";
  if (perSource.some((o) => o === "regressed-different-source")) return "regressed-different-source";
  if (perSource.every((o) => o === "unchanged")) return "unchanged";
  return "partial";
}
```

`classifySingleSource` uses `findingKey` from ADR-021 to compute set difference within one source. The `regressed-different-source` outcome surfaces when a fix introduces findings of a source that wasn't present before.

### 3. FixStrategy declares routing + co-run discipline

```typescript
interface FixStrategy<F extends Finding, I, O, C> {
  name: string;
  appliesTo: (finding: F) => boolean;
  appliesToVerdict?: (verdict: string) => boolean;   // optional fallback when findings is empty (see §5)
  fixOp: Operation<I, O, C>;
  buildInput: (findings: F[], priorIterations: Iteration<F>[], ctx: FixCycleContext) => I;
  bailWhen?: (priorIterations: Iteration<F>[]) => string | null;
  maxAttempts: number;
  coRun?: "exclusive" | "co-run-sequential";
}
```

**Strategy selection per iteration:**
- Filter `cycle.strategies` by `appliesTo` against current findings.
- If any matching strategy is `"exclusive"` (default), it runs alone — highest precedence.
- Otherwise all matching `"co-run-sequential"` strategies run in declaration order.

**`co-run-parallel` was considered and removed (YAGNI).** The only conceivable use case (parallel disjoint-file lint fixes) doesn't justify the file-locking discipline required, and LLM latency dominates IO so wall-clock improvement is negligible. Re-introduce only if a concrete use case arrives.

**Acceptance:** source-fix and test-fix are both `"co-run-sequential"`. When the diagnosis emits both source-targeted and test-targeted findings, both run in one iteration.
**Autofix:** test-writer and implementer are both `"co-run-sequential"`. Test-writer naturally drops out in subsequent iterations once test-targeted findings are resolved — its `appliesTo` selector returns false, no special "runOnce" modifier needed (selector-based dropout).
**Lint, typecheck:** `"exclusive"` per source within the autofix cycle.

**`FixStrategy` is a value, not a class.** Each cycle entry point constructs its strategies inline, capturing closure variables (testOutput, diagnosis reasoning, verdict, packageDir) needed by `buildInput`. This avoids forcing every strategy to thread context through a generic `extras` field. Strategies are not registered globally or discovered at runtime — they live where they're used.

**`appliesTo` discipline.** Selectors must be discriminating (by `source`, `category`, `fixTarget`, or file pattern), never `() => true`. A non-discriminating selector silently preempts every other strategy when paired with `"exclusive"`. Reviewer responsibility; no type-system enforcement.

### 4. Validator lives on the cycle, not the strategy

The earlier draft attached `validate` to the strategy. The review found this breaks down for mixed acceptance source+test (both strategies share the same validator: re-run acceptance tests) and for autofix (test-writer and implementer can have different validators).

Resolution: **validator lives on the cycle, scoped per finding-source-group.**

```typescript
interface FixCycle<F extends Finding> {
  findings: F[];
  iterations: Iteration<F>[];
  strategies: FixStrategy<F, any, any, any>[];
  validate: (ctx: FixCycleContext) => Promise<F[]>;     // SINGLE validator for the cycle
  config: FixCycleConfig;
}

interface FixCycleConfig {
  maxAttemptsTotal: number;        // default 10
  validatorRetries: number;        // default 1 — see §4 retry-once-then-terminal
}
```

The validator runs **once per iteration**, after all co-run strategies have completed. No per-strategy validation.

Why: in practice, the validator is a property of the failure source (acceptance test suite, lint runner, semantic review), not of the fix lane. Source-fix and test-fix in acceptance both validate by re-running the acceptance test suite. Autofix's test-writer and implementer both validate by re-running the merged review checks. Forcing per-strategy validators creates phantom flexibility that doesn't match how rectification actually works.

**Tradeoff accepted:** if source-fix breaks something that test-fix would otherwise have noticed, validation only catches it at end of iteration. This matches today's acceptance behaviour ([applyFix:190-211](../../src/execution/lifecycle/acceptance-fix.ts#L190) calls both ops then the outer loop re-tests once). For autofix, test-writer's one-shot completes before implementer's loop starts, so cascading errors from test-writer surface in the implementer's first prompt — same as today.

**Validator failure semantics — retry once, then terminal.** When `validate(ctx)` throws (LSP server crash, file lock, network blip), the cycle:

1. Retries the validator immediately (default `validatorRetries: 1`).
2. If the retry also throws, exits with `reason: "validator-error"`.
3. The throw is logged with `storyId` and the original error chained via `cause`.

Treating any validator throw as immediately terminal would make one flaky lint runner kill the cycle. Treating throws as "no findings = resolved" would silently suppress regressions — far worse. Retry-once-then-terminal is the pragmatic middle: tolerates transient glitches without papering over real validator breakage.

### 5. Verdict is preserved as a hypothesis tag, not derived

The review found `DiagnosisResult.verdict` is triple-overloaded:
1. Routing (which fix ops to call) — addressable via per-finding `fixTarget`.
2. **Heuristic fast-paths** that produce `verdict` *without* findings:
   - `strategy === "implement-only"` → verdict `"source_bug"`, no findings
   - `semanticVerdicts.every(v => v.passed)` → verdict `"test_bug"`, no findings
   - `isTestLevelFailure(failedACs, totalACs)` → verdict `"test_bug"`, no findings
3. Signaling (logged + accumulated in prompt context).

A pure "derive verdict from findings" model breaks #2. Resolution: **`verdict` stays on `DiagnosisResult` as a hypothesis tag.** It can exist without findings and is consumed by the cycle as a *strategy selector hint*:

```typescript
interface DiagnosisResult {
  verdict: "source_bug" | "test_bug" | "both";    // preserved
  reasoning: string;
  confidence: number;
  findings: Finding[];                              // may be empty for fast-path verdicts
}
```

The cycle uses verdict to **bias strategy selection** when findings are absent:

```typescript
strategies: [
  {
    name: "acceptance-source-fix",
    appliesTo: (f) => f.fixTarget === "source",
    // when findings is empty, fall through to verdict-based selection
    appliesToVerdict: (v) => v === "source_bug" || v === "both",
    ...
  },
  {
    name: "acceptance-test-fix",
    appliesTo: (f) => f.fixTarget === "test",
    appliesToVerdict: (v) => v === "test_bug" || v === "both",
    ...
  },
]
```

`appliesToVerdict` is an optional fallback selector consulted only when `findings.length === 0`. For non-acceptance strategies (lint, semantic, adversarial), it stays unset.

This preserves all three uses of verdict and keeps fast-paths cheap.

### 6. Stub regen stays as a prelude, not a strategy

`stubRegenCount` ([acceptance-loop.ts:110-238](../../src/execution/lifecycle/acceptance-loop.ts#L110)) caps stub-test regenerations at 2 *before* the diagnosis loop starts. The review found this is cycle-wide state that strategy-level `bailWhen` cannot express.

Resolution: **stub regen remains a prelude phase outside the cycle.** The cycle only runs after stubs are exhausted (or never present). Reasoning:
- Stub regen is fundamentally different — full regeneration of the test file, not surgical fix.
- Its cap is orthogonal to fix attempt counts.
- The current code path is correct; we don't need to force it into the cycle just for symmetry.

The cycle is only entered when there's a real test file to fix. The stub-regen counter and its cap stay where they are. `runFixCycle` is invoked by `runAcceptanceLoop` after the stub-guard check passes.

### 7. Dual budget — preserved from autofix

| Budget | Lives on | Default | Bail reason |
|:---|:---|:---|:---|
| Per-strategy attempt cap | `FixStrategy.maxAttempts` | acceptance: 3, lint: 5, semantic: 2 | `"max-attempts-per-strategy"` |
| Cycle-wide total cap | `FixCycleConfig.maxAttemptsTotal` | 10 | `"max-attempts-total"` |

Mirrors `quality.autofix.{maxAttempts, maxTotalAttempts}` ([autofix-agent.ts:96-120](../../src/pipeline/stages/autofix-agent.ts#L96)). Per-strategy attempts are counted from `iterations.flatMap(i => i.fixesApplied).filter(f => f.strategyName === X).length`.

### 8. Shared `buildPriorIterationsBlock` prompt helper

Verdict-first table consumed by all rectifier-class prompts:

```
## Prior Iterations — verdict required before new analysis

| # | Strategies run                                | Files touched                  | Outcome    | Findings before → after   |
|---|-----------------------------------------------|--------------------------------|------------|---------------------------|
| 1 | acceptance-test-fix                           | .nax-acceptance.test.ts        | unchanged  | 1 [stdout-capture] → 1 [stdout-capture] |
| 2 | acceptance-test-fix                           | .nax-acceptance.test.ts        | unchanged  | 1 [stdout-capture] → 1 [stdout-capture] |

When outcome is "unchanged", the prior hypothesis is FALSIFIED — the change did
not affect what was tested. Choose a different category before producing a new
verdict. Do NOT repeat fixes listed above.
```

Replaces:
- `buildPriorFindingsBlock` ([adversarial-review-builder.ts:202](../../src/prompts/builders/adversarial-review-builder.ts#L202))
- `buildAttemptContextBlock` ([review-builder.ts:186](../../src/prompts/builders/review-builder.ts#L186))
- The freeform `previousFailure` accumulator in [acceptance-loop.ts:299](../../src/execution/lifecycle/acceptance-loop.ts#L299)

## Phased implementation

| Phase | Scope | Risk |
|:---|:---|:---|
| **1. Cycle types** | new `src/findings/cycle-types.ts` — `Iteration`, `IterationOutcome`, `FixApplied`, `FixStrategy`, `FixCycleContext`, `FixCycleConfig`, `FixCycleResult` | zero |
| **2. `runFixCycle` + `classifyOutcome`** | new `src/findings/cycle.ts` + tests under `test/unit/findings/` | low — pure logic, all bail paths covered by tests |
| **3. `buildPriorIterationsBlock`** | new `src/prompts/builders/prior-iterations.ts` + tests | zero |
| **4. Acceptance migration** | replace `applyFix` with `runFixCycle` invocation; preserve verdict fast-paths via `appliesToVerdict`. Behind `acceptance.fix.cycleV2` flag. | medium — bench against `nax-dogfood/fixtures/hello-lint` audit fixtures with both modes |
| **5. Adversarial migration** | adversarial review already structured; replace `AdversarialFindingsCache` carry-forward with `Iteration[]` via shared `buildPriorIterationsBlock` | low |
| **6. Semantic migration** | replace `PriorFailure[]` with `Iteration[]` | low |
| **7. Autofix migration** | replace `runAgentRectification`'s hand-rolled split-and-route with `runFixCycle` driving two strategies (test-writer, implementer). Behind `quality.autofix.cycleV2` flag, shadow mode for two releases | medium — autofix on hot path |
| **8. Cleanup** | delete legacy carry-forward types, remove feature flags | zero |

Phase 4 ships the dogfood regression fix.

## Test plan

- Phase 2: cycle unit tests cover all bail paths (no-strategy, per-strategy cap, total cap, validator-error, bailWhen) and outcome classification (resolved, partial, regressed, unchanged, regressed-different-source).
- Phase 3: `buildPriorIterationsBlock` snapshot tests (empty, single, multi-iteration, `unchanged` outcome rendering).
- Phase 4: dogfood `hello-lint` audit shows attempt 2's diagnose prompt contains the verdict-first table; the model selects a different strategy than attempt 1.
- Phase 5–6: existing review integration tests pass.
- Phase 7: shadow-mode telemetry shows old + new autofix paths agree on routing for ≥95% of test fixtures over two releases before flag flip.

## Consequences

### Positive

- Acceptance gains the verdict-first carry-forward that adversarial already has. Falsified-hypothesis detection ships with phase 4 (the dogfood regression).
- Three loop implementations collapse to one (`runFixCycle`), with `runRetryLoop` preserved as the inner per-op retry primitive.
- `Iteration<F>` history is queryable across all subsystems — a single "what fixes ran on this story" view becomes possible.
- Prompt builder duplication eliminated (`buildPriorFindingsBlock` + `buildAttemptContextBlock` + acceptance accumulator → one helper).

### Negative

- Phase 4 introduces a feature-flagged parallel implementation; there are two acceptance fix loops in the codebase for one release.
- Phase 7's shadow mode requires telemetry plumbing that doesn't exist today — adds two release cycles before legacy autofix can be removed.

### Neutral

- The verdict field on `DiagnosisResult` is preserved indefinitely. It's small, well-defined, and the alternative (deriving from empty findings via heuristics-as-data) is more complex.

## Telemetry

Standardised iteration log shape — every cycle emits this on iteration completion so dashboards and post-mortem audits work uniformly across subsystems:

```typescript
logger.info("findings.cycle", "iteration completed", {
  storyId,                                  // first key, per project conventions
  packageDir,                               // for monorepo correlation
  cycleName: "acceptance" | "autofix" | …,  // matches the subsystem owning the cycle
  iterationNum,
  strategiesRan: ["acceptance-test-fix"],   // FixApplied[].strategyName
  outcome: "unchanged",
  findingsBefore: 1,
  findingsAfter: 1,
  costUsd: 0.012,
});
```

Bail events emit `"cycle exited"` with the same shape plus `reason` and (when applicable) `exhaustedStrategy` / `bailDetail`. Validator-retry events emit `"validator retry"` with the original error chained via `cause`.

## Audit logging

Cycle iteration history stays **ephemeral by default** — `Iteration<F>[]` lives in memory in the cycle's owning context, used for prompt carry-forward via `buildPriorIterationsBlock` and discarded at end of run.

Forensic post-mortem persistence (writing iteration history to `.nax/cycle-history/<cycleId>.jsonl` for after-the-fact debugging) is deferred to the broader audit redesign tracked in [docs/findings/2026-04-30-context-curator-design.md](../findings/2026-04-30-context-curator-design.md). The shape is already well-defined here; the persistence policy and storage location belong with the broader audit work.

## Out of scope

These are deliberately not addressed by this ADR:

- **Plugin-supplied fix strategies.** Plugin reviewers (`IReviewPlugin`) emit `Finding[]` per ADR-021 phase 2 but cannot supply their own `FixStrategy`. The plugin contract stays check-only. If plugin-driven fixes become a concrete need, they get their own ADR with a contract extension.
- **Hook integration.** The cycle does not fire its own hook events (`cycle:iteration-start`, etc.). Existing hooks remain at the run-lifecycle layer. Add only if a concrete observer/plugin needs them.
- **Co-run-parallel.** Removed from the design (see §3). Re-add if a concrete use case arrives.
- **Cross-package cycle composition.** A cycle is scoped to one package; cross-package finding aggregation is a consumer concern (see ADR-021 §3).
- **Persistence beyond logging.** No on-disk iteration history in V1 (see Audit section above).

## References

- [src/verification/shared-rectification-loop.ts](../../src/verification/shared-rectification-loop.ts) — `runRetryLoop` (preserved as the inner primitive)
- [src/execution/lifecycle/acceptance-fix.ts:78-116](../../src/execution/lifecycle/acceptance-fix.ts#L78) — verdict fast-paths (preserved via `appliesToVerdict`)
- [src/execution/lifecycle/acceptance-loop.ts:110-238](../../src/execution/lifecycle/acceptance-loop.ts#L110) — `stubRegenCount` (preserved as prelude)
- [src/pipeline/stages/autofix-agent.ts:96-120](../../src/pipeline/stages/autofix-agent.ts#L96) — dual-budget pattern (mirrored in `FixCycleConfig`)
- [src/prompts/builders/adversarial-review-builder.ts:202](../../src/prompts/builders/adversarial-review-builder.ts#L202) — `buildPriorFindingsBlock` (replaced by `buildPriorIterationsBlock`)
- ADR-021 — Finding Type SSOT (companion ADR; types prerequisite for this one)
- ADR-006 — Acceptance Retry Loop Restructure (introduced `previousFailure: string`; superseded in part by phase 4)

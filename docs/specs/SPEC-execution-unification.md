# SPEC: Execution Unification — One Builder Per Story

**ADR:** [ADR-023-execution-unification.md](../adr/ADR-023-execution-unification.md)
**Status:** Draft
**Date:** 2026-05-23
**Author:** William Khoo, Claude
**Supersedes (partial):**
- [SPEC-story-orchestrator-consolidation.md](./SPEC-story-orchestrator-consolidation.md) — review-as-builder-phase portion (`addSemanticReview` / `addAdversarialReview` slots gated by `execution.inlineReview`)
- [SPEC-rectification-unification.md](./SPEC-rectification-unification.md) — US-006a wiring + US-006b terminal cleanup

**Resolves:** [docs/findings/2026-05-23-inlinereview-legacy-stage-gap.md](../findings/2026-05-23-inlinereview-legacy-stage-gap.md)

---

## Summary

Per-story execution in nax runs through three overlapping sequencing abstractions today: pipeline stages (`src/pipeline/stages/`), builder phases (`StoryOrchestratorBuilder.CANONICAL_ORDER`), and fix strategies (`FixStrategy[]` inside `runFixCycle`). Each was sound when introduced; the composite is messy — the `execution.inlineReview` flag exists because two of them duplicate review work, and SPEC-rectification-unification US-006a's gate rectification is unreachable in production because of the same flag. This spec collapses the three abstractions to two: builder phases for ordering, FixStrategies for finding-driven fixes, with `applyPostRunInspection` as the single thin glue layer between the builder and the pipeline. Five pipeline stages (`verify`, `rectify`, `review`, `autofix`, `regression`) and the legacy `runRectificationLoop` framework are deleted. Net change: ~2,400 LOC removed across six user stories (Phases A–E from ADR-023, with the cutover split into additive + terminal-cleanup per the spec-writing guide's hard split rule).

## Motivation

Three concrete problems trace to the same architectural split:

1. **`execution.inlineReview` is a placeholder, not a feature.** The flag was added in commit `1792b391` because US-005 wired `semanticReview` / `adversarialReview` / `rectification` slots into the builder but `pipeline/stages/review.ts` and `pipeline/stages/rectify.ts` were not retired in the same story. With the default `false`, the slots are dormant. With `true`, the LLM checks double-fire. The flag has no good resolution within the current architecture.

2. **US-006a is dormant in production.** [src/operations/full-suite-gate.ts:28](../../src/operations/full-suite-gate.ts#L28) declares "Rectification is now handled externally by the general runFixCycle phase", but [src/execution/plan-inputs.ts:258-265](../../src/execution/plan-inputs.ts#L258-L265) gates `inputs.rectification` on `inlineReviewEnabled`. With the default flag, gate failures fall through to legacy `runRectificationLoop` instead. The US-006a code shipped (commit `35486416`) but never activated.

3. **Three implementations of "fix failing tests".** Builder's `addRectification` for gate failures (when wired), `pipeline/stages/rectify.ts` for verify failures, `src/execution/lifecycle/run-regression.ts` for regression failures. Each calls a different framework or wraps `runFixCycle` differently. Adding a new fix concern means picking a host abstraction with no principled answer.

The findings doc ([docs/findings/2026-05-23-inlinereview-legacy-stage-gap.md](../findings/2026-05-23-inlinereview-legacy-stage-gap.md)) surfaced #1; deeper investigation surfaced #2 and #3. ADR-023 resolves all three by completing both pending migrations (US-005 review portion, US-006a/b/c rectification) and removing the flag they together created.

## Design

### Approach

The unified model uses two primitives that already exist and are in production use:

- **`StoryOrchestratorBuilder`** ([src/execution/story-orchestrator.ts](../../src/execution/story-orchestrator.ts)) — owns per-story phase ordering via `CANONICAL_ORDER`. Each phase produces `Finding[]` in its parsed output per ADR-021.
- **`runFixCycle`** ([src/findings/cycle.ts](../../src/findings/cycle.ts)) — owns finding-driven fix dispatch via `FixStrategy[]` per ADR-022. Used today by autofix, acceptance, full-suite gate (when wired), and the builder's rectification phase.

`applyPostRunInspection` ([src/execution/post-run.ts](../../src/execution/post-run.ts)) is the sole bridge between the builder's `phaseOutputs` and the pipeline's `StageResult`. It owns stage-level routing decisions (verdict reading, rollback, pause-reason extraction, mechanical-only suppression).

The pipeline shrinks to context-gathering plus a single execution stage:

```
Today:    queueCheck → routing → constitution → context → prompt → optimizer →
          execution → verify → rectify → review → autofix → regression → completion

Target:   queueCheck → routing → constitution → context → prompt → optimizer →
          execution → completion
```

### Integration

#### CANONICAL_ORDER (post-migration)

Every phase is independently gated by config. The builder only adds a phase to the plan when its inputs slot is populated (`buildPlanForStrategy` skips phases with undefined inputs).

| Phase | Gated by |
|:---|:---|
| `test-writer` | `isThreeSession && freshRun` |
| `greenfield-gate` | `isThreeSession && freshRun` |
| `implementer` | always (every story has an implementer) |
| `full-suite-gate` | `isThreeSession` |
| `verifier` | `isThreeSession` |
| `verify-scoped` | `!isThreeSession` |
| `lint-check` | `config.review.enabled && config.review.checks.includes("lint") && config.quality.commands.lint` configured |
| `typecheck-check` | `config.review.enabled && config.review.checks.includes("typecheck") && config.quality.commands.typecheck` configured |
| `semantic-review` | `config.review.enabled && config.review.checks.includes("semantic") && config.review.semantic` defined |
| `adversarial-review` | `config.review.enabled && config.review.checks.includes("adversarial") && config.review.adversarial` defined |
| `rectification` | `config.execution.rectification.enabled` |

Linear order when all gates pass:

```
test-writer → greenfield-gate → implementer →
  (TDD)     full-suite-gate → verifier
  (non-TDD) verify-scoped
→ lint-check → typecheck-check
→ semantic-review → adversarial-review
→ rectification
```

**Plugin reviewers are not a builder phase.** Per resolved decision D2, per-story plugin reviewer integration is dropped (zero internal consumers audited). The deferred-mode plugin reviewer at [src/execution/deferred-review.ts](../../src/execution/deferred-review.ts) is unaffected — it runs once at run completion via the lifecycle, not via the builder.

**Format is not a check phase.** It exists only as a mechanical fix strategy (`makeMechanicalFormatFixStrategy`) within rectification, gated by `config.quality.commands.formatFix` presence. Today's `pipeline/stages/review.ts` does not run a standalone format check; format issues are detected as lint findings (or not at all) and resolved by running `formatFix` before re-checking lint. The migration preserves this — there is no `formatCheckOp`.

#### Strategy assembly — also per-strategy gated

The rectification phase's `strategies` array is populated conditionally. Each entry below is included only if its precondition holds; the array order encodes priority within whatever subset is present.

| Strategy | Included when |
|:---|:---|
| `makeMechanicalLintFixStrategy()` | `config.quality.commands.lintFix` configured (or `lintFixScoped`) |
| `makeMechanicalFormatFixStrategy()` | `config.quality.commands.formatFix` configured (or `formatFixScoped`) |
| `makeFullSuiteRectifyStrategy(story)` | `isThreeSession && inputs.fullSuiteGate` defined |
| `makeAutofixImplementerStrategy(ctx)` | `config.quality.autofix?.enabled !== false` |
| `makeAutofixTestWriterStrategy(ctx)` | `config.quality.autofix?.enabled !== false` |

So a project that disables autofix (`quality.autofix.enabled: false`) but keeps mechanical fixes (`lintFix` / `formatFix` configured) gets cheap mechanical rectification only — no agent invocations. A project that only configures `lint` (no `typecheck`, no `semantic`) gets a single check phase, and rectification sees only lint findings — agent strategies still apply if enabled. The unified architecture preserves today's gating granularity.

#### New check operations (extending the `DeterministicOperation` pattern)

Each new check op mirrors `fullSuiteGateOp` ([src/operations/full-suite-gate.ts](../../src/operations/full-suite-gate.ts)) — declares `kind: "deterministic"`, runs a shell command, parses output to `Finding[]`:

```typescript
// src/operations/lint-check.ts (worked skeleton)
import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { Finding } from "../findings/types";
import { runQualityCommand } from "../quality";
import { parseLintOutput } from "../review/lint-parsing";  // existing parser SSOT
import type { CallContext, DeterministicOperation } from "./types";

export interface LintCheckInput {
  readonly workdir: string;
  readonly storyId: string;
}

export interface LintCheckOutput {
  readonly success: boolean;
  readonly findings: Finding[];
  readonly durationMs: number;
}

export const lintCheckOp: DeterministicOperation<LintCheckInput, LintCheckOutput, QualityConfig> = {
  kind: "deterministic",
  name: "lint-check",
  stage: "review",
  config: qualityConfigSelector,
  async execute(input, ctx, _deps) {
    const start = Date.now();
    const command = ctx.config.quality.commands.lint;
    if (!command) return { success: true, findings: [], durationMs: 0 };
    const result = await runQualityCommand({ commandName: "lint", command, workdir: input.workdir, storyId: input.storyId });
    if (result.exitCode === 0) {
      return { success: true, findings: [], durationMs: Date.now() - start };
    }
    const parsed = parseLintOutput(
      result.output,
      ctx.config.quality.lintOutput?.format ?? "auto",
      { workdir: input.workdir },
    );
    return {
      success: false,
      findings: parsed?.findings ?? [],
      durationMs: Date.now() - start,
    };
  },
};
```

`parseLintOutput` (signature: [src/review/lint-parsing/parse.ts:21](../../src/review/lint-parsing/parse.ts#L21)) is a one-step SSOT — given `workdir` in `opts`, it parses the lint output, detects the tool (eslint / biome / text), and produces `Finding[]` internally via `lintDiagnosticToFinding`. The op skeleton above does not need to import `lintDiagnosticToFinding` or perform a separate tool-detection step. The same single-call pattern applies to `typecheckCheckOp` via the typecheck parser (verify exact API when implementing US-003).

`typecheckCheckOp` and `verifyScopedOp` follow the same shape with `name`, `command`, and adapter function differing. (No `formatCheckOp` per the format-is-fix-only rule above; no plugin-reviewer op per resolved decision D2 — see §Resolved Decisions.)

#### New fix strategies — including the novel shell-command strategy shape

Two strategy categories. Agent strategies (LLM `fixOp`) follow the existing pattern in `makeFullSuiteRectifyStrategy` ([src/operations/full-suite-rectify.ts](../../src/operations/full-suite-rectify.ts)).

**Mechanical strategies** are novel — `FixStrategy.fixOp` is typically a `RunOperation` invoking an LLM agent. Mechanical strategies use a `DeterministicOperation` as the `fixOp`. Worked skeleton:

```typescript
// src/operations/mechanical-lintfix-strategy.ts (worked skeleton)
import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import type { FixStrategy } from "../findings";
import type { Finding } from "../findings/types";
import { runQualityCommand } from "../quality";
import type { DeterministicOperation } from "./types";

interface MechanicalLintFixInput { readonly workdir: string; readonly storyId: string; readonly scopeFiles?: string[]; }
interface MechanicalLintFixOutput { readonly applied: true; readonly exitCode: number; }

const mechanicalLintFixOp: DeterministicOperation<MechanicalLintFixInput, MechanicalLintFixOutput, QualityConfig> = {
  kind: "deterministic",
  name: "mechanical-lintfix",
  stage: "rectification",
  config: qualityConfigSelector,
  async execute(input, ctx) {
    const broad = ctx.config.quality.commands.lintFix;
    if (!broad) return { applied: true, exitCode: 0 };
    const command = input.scopeFiles?.length ? `${broad} ${input.scopeFiles.join(" ")}` : broad;
    const result = await runQualityCommand({ commandName: "lintFix", command, workdir: input.workdir, storyId: input.storyId });
    return { applied: true, exitCode: result.exitCode };
  },
};

export function makeMechanicalLintFixStrategy(): FixStrategy<Finding, MechanicalLintFixInput, MechanicalLintFixOutput, QualityConfig> {
  return {
    name: "mechanical-lintfix",
    appliesTo: (f) => f.source === "lint" && /* mechanical-fixable predicate ports from autofix-scope-split */ true,
    fixOp: mechanicalLintFixOp,
    buildInput: (_findings, _prior, cycleCtx) => ({ workdir: cycleCtx.workdir, storyId: cycleCtx.storyId, scopeFiles: undefined }),
    extractApplied: () => ({ targetFiles: [], summary: "lint --fix" }),
    maxAttempts: 1,
    coRun: "exclusive",
  };
}
```

The strategy array's order encodes priority — mechanical strategies appear before agent strategies, so `runFixCycle` tries cheap fixes first.

#### `PlanInputs` shape (post-migration)

```typescript
// src/execution/plan-inputs.ts (post-migration shape — fields shown are the deltas;
// existing required fields story / config / resolvedTestPatterns are unchanged)
export interface PlanInputs {
  readonly story: UserStory;                       // unchanged (required)
  readonly config: NaxConfig;                      // unchanged (required)
  readonly resolvedTestPatterns?: ResolvedTestPatterns; // unchanged (optional)
  readonly testWriter?: TestWriterInput;
  readonly greenfieldGate?: GreenfieldGateInput;
  readonly implementer?: ImplementerInput;         // unchanged (optional today; stays optional)
  readonly fullSuiteGate?: FullSuiteGateInput;
  readonly verifier?: VerifierInput;
  readonly verifyScoped?: VerifyScopedInput;       // new (non-TDD only)
  readonly lintCheck?: LintCheckInput;             // new (gated by review.checks ∋ "lint")
  readonly typecheckCheck?: TypecheckCheckInput;   // new (gated by review.checks ∋ "typecheck")
  readonly semanticReview?: SemanticReviewInput;   // gated by review.checks ∋ "semantic"
  readonly adversarialReview?: AdversarialReviewInput; // gated by review.checks ∋ "adversarial"
  readonly rectification?: RectificationPhaseOptions;
}
```

Slot population is the single source of truth for phase gating — `buildPlanForStrategy` calls `builder.addX(input)` only when `input !== undefined`. The CANONICAL_ORDER gating table above maps each slot to its config preconditions; this interface mirrors them.

There is no `formatCheck` slot — format is mechanical-fix-only, not a check phase (see §CANONICAL_ORDER note).

#### Strategy assembly order (priority encoded by array position; each entry conditional)

```typescript
// src/execution/build-plan-for-strategy.ts (post-migration excerpt)
const strategies: FixStrategy<Finding, any, any, any>[] = [];

if (config.quality.commands.lintFix || config.quality.commands.lintFixScoped) {
  strategies.push(makeMechanicalLintFixStrategy());
}
if (config.quality.commands.formatFix || config.quality.commands.formatFixScoped) {
  strategies.push(makeMechanicalFormatFixStrategy());
}
if (isThreeSession && inputs.fullSuiteGate) {
  strategies.push(makeFullSuiteRectifyStrategy(story));
}
if (config.quality.autofix?.enabled !== false) {
  strategies.push(makeAutofixImplementerStrategy(ctx));
  strategies.push(makeAutofixTestWriterStrategy(ctx));
}
```

A project configuring only `lint` and disabling autofix gets `[makeMechanicalLintFixStrategy()]` only — `runFixCycle` will try the mechanical fix; if findings remain, the cycle exits with `rectification-exhausted` and `applyPostRunInspection` applies the `mechanicalFailedOnly` rule.

**Mechanical-then-recheck-bail semantics — preserved implicitly.** Today's `autofixStage` runs mechanical fixes, calls `recheckReview`, and returns early if the recheck passes — skipping agent rectification. In the unified model, mechanical strategies run first; after each strategy completes, `runFixCycle.validate` re-runs the check phases. If no findings remain, the cycle's next strategy iteration finds an empty `appliesTo` result for every agent strategy and exits with `exitReason: "no-findings-applicable"`. Net behavior: same — mechanical fix that resolves all findings skips agent invocation. No special-case code; the framework's existing iterate-and-validate loop produces the same outcome.

#### `StoryOrchestratorResult` shape extension (US-005a)

To surface rectification exhaustion to `applyPostRunInspection`, `StoryOrchestratorResult` ([src/execution/story-orchestrator.ts:51-57](../../src/execution/story-orchestrator.ts#L51-L57)) gains two optional fields:

```typescript
// src/execution/story-orchestrator.ts (post-migration shape)
export interface StoryOrchestratorResult {
  readonly success: boolean;
  readonly phaseCosts: Record<string, number>;
  readonly totalCostUsd: number;
  readonly durationMs: number;
  readonly phaseOutputs: Record<string, unknown>;
  /** Set by runRectification when the inner FixCycle exits via max-attempts or bail-when. */
  readonly rectificationExhausted?: boolean;       // new
  /** Findings remaining in the cycle when it exited. Set together with rectificationExhausted. */
  readonly unfixedFindings?: readonly Finding[];   // new
}
```

`runRectification` ([src/execution/story-orchestrator.ts:327](../../src/execution/story-orchestrator.ts#L327)) writes both fields when `cycleResult.exitReason !== "no-findings-applicable"` and `cycleResult.finalFindings.length > 0`.

#### `applyPostRunInspection` additions

A single new branch handles the `mechanicalFailedOnly` rule ported from [src/pipeline/stages/autofix.ts:182-199](../../src/pipeline/stages/autofix.ts#L182-L199):

```typescript
// src/execution/post-run.ts (excerpt)
if (planResult.rectificationExhausted && planResult.unfixedFindings && planResult.unfixedFindings.length > 0) {
  const sources = new Set(planResult.unfixedFindings.map(f => f.source));
  const allMechanical = [...sources].every(s => s === "lint" || s === "typecheck");
  if (allMechanical) {
    logger.warn("execution", "Mechanical-only failure unfixable — proceeding (LLM review passed)", { storyId: ctx.story.id });
    return { /* continue, no escalation */ };
  }
}
```

#### Existing patterns to follow

| New code | Pattern reference |
|:---|:---|
| `DeterministicOperation` check ops | [src/operations/full-suite-gate.ts](../../src/operations/full-suite-gate.ts) |
| Agent-fix `FixStrategy` | [src/operations/full-suite-rectify.ts](../../src/operations/full-suite-rectify.ts), [src/pipeline/stages/autofix-cycle.ts:100-178](../../src/pipeline/stages/autofix-cycle.ts#L100-L178) |
| Mechanical (shell) `FixStrategy` | Worked skeleton above — no codebase precedent |
| Builder phase method (`addLintCheck` etc.) | Existing `addImplementer` / `addRectification` overload pattern in [src/execution/story-orchestrator.ts:558-572](../../src/execution/story-orchestrator.ts#L558-L572) |
| Finding adapter for lint output | [src/findings/adapters/](../../src/findings/adapters/) |

### Failure Handling

| Condition | Behavior |
|:---|:---|
| Check op's shell command exits non-zero with parse failure | Op returns `success: false, findings: []` (parser-empty fail). Rectification has no strategy applying → cycle ends. `applyPostRunInspection` surfaces as `execution-failed` failure category (matches today's `verifyStage` behavior). |
| Check op runs successfully but reports findings | Findings flow into rectification phase. Applicable strategies dispatch. |
| Rectification exhausts retries with findings still present | If all remaining findings are mechanical sources: `applyPostRunInspection` returns `{ action: "continue" }` with warn log (the `mechanicalFailedOnly` rule). Otherwise: `{ action: "escalate" }` with `failureCategory: "rectification-exhausted"`. |
| Mechanical strategy's shell command fails | Treated as no-progress iteration. Next strategy in array order runs. If all strategies exhausted: same as "rectification exhausts retries" above. |
| Legacy config with `execution.inlineReview` after deletion | Loader logs deprecation warning, strips the key, continues. No error. |
| `IReviewPlugin` reviewer throws during deferred review (`deferred-review.ts`, post-run) | Caught at op boundary, logged as error, marks reviewer result `passed: false` with `error` field — existing behavior at [src/execution/deferred-review.ts:96-105](../../src/execution/deferred-review.ts#L96-L105). Per D2, no per-story builder phase exists; only the post-run path runs reviewers. |
| Builder phase produces `pauseReason` | `applyPostRunInspection` surfaces via `ctx.interaction.send({ type: "notify" })` and returns `{ action: "pause" }`. Unchanged from today. |

### Polyglot / monorepo

Per [.claude/rules/monorepo-awareness.md](../../.claude/rules/monorepo-awareness.md): all new check ops resolve `config.quality.commands.*` per-package via `.nax/mono/<packageDir>/config.json`. No hardcoded `bun test` / `eslint` literals. `verifyScopedOp` uses the existing `resolveTestFilePatterns(config, workdir, packageDir)` SSOT.

### Logging

Per [.claude/rules/project-conventions.md](../../.claude/rules/project-conventions.md) "Structured Log Fields — Mandatory": every `logger.*` call in new ops and strategies includes `storyId` as the first key. Cross-package work additionally includes `packageDir`.

## Stories

Seven stories, dependency chain follows ADR-023 phase boundaries. The Phase E cutover splits into three stories (wiring, gating-preservation verification, terminal cleanup) per the spec-writing guide's ≤8-AC-per-story hard rule and the additive-vs-destructive split rule.

### US-001: Activate gate-internal rectification (Phase A)

**Depends on:** none (lowest-risk story; ships first)

Drop the `inlineReviewEnabled` gate on `rectificationInput` only. Keep gate on `semanticReviewInput` / `adversarialReviewInput` until US-005b. After this story, US-006a's gate rectification activates in production.

#### Context Files

- [src/execution/plan-inputs.ts](../../src/execution/plan-inputs.ts) — `rectificationInput` block at lines 258-265 (gate to drop)
- [src/execution/story-orchestrator.ts](../../src/execution/story-orchestrator.ts) — `gatherRectificationFindings` at lines 190-209 (signature to simplify)
- [src/operations/full-suite-rectify.ts](../../src/operations/full-suite-rectify.ts) — strategy reference

---

### US-002: Retire `runRectificationLoop` (Phase B)

**Depends on:** US-001

Terminal-cleanup story for the legacy rectification framework. Converts both call sites to `runFixCycle`. Deletes the legacy framework files.

#### Context Files

- [src/pipeline/stages/rectify.ts](../../src/pipeline/stages/rectify.ts) — call site #1
- [src/execution/lifecycle/run-regression.ts](../../src/execution/lifecycle/run-regression.ts) — call site #2 (line 322)
- [src/verification/rectification-loop.ts](../../src/verification/rectification-loop.ts) — file to delete
- [src/verification/shared-rectification-loop.ts](../../src/verification/shared-rectification-loop.ts) — file to delete
- [src/findings/adapters/](../../src/findings/adapters/) — `testSummaryToFindings` adapter to reuse

---

### US-003: Add check operations (Phase C)

**Depends on:** none (additive, can run in parallel with US-001/US-002)

Create new `DeterministicOperation`s for lint, typecheck, format, verify-scoped checks. Add builder methods (`addLintCheck` etc.). Extend `CANONICAL_ORDER`. **Do not yet call from `buildPlanForStrategy`** — wiring is US-005a.

Per resolved decision D2, this story does **not** include a `pluginReviewerOp`. The deferred plugin-reviewer path at [src/execution/deferred-review.ts](../../src/execution/deferred-review.ts) is untouched by the migration.

#### Context Files

- [src/operations/full-suite-gate.ts](../../src/operations/full-suite-gate.ts) — `DeterministicOperation` pattern reference
- [src/operations/index.ts](../../src/operations/index.ts) — barrel to extend
- [src/execution/story-orchestrator.ts](../../src/execution/story-orchestrator.ts) — `CANONICAL_ORDER` + builder method pattern (lines 558-572)
- [src/quality/](../../src/quality/) — `runQualityCommand` consumer
- [src/findings/adapters/](../../src/findings/adapters/) — output → `Finding[]` adapters

---

### US-004: Add fix strategies (Phase D)

**Depends on:** US-003 (uses check ops as `validate` targets)

Extract `buildAutofixStrategies` from `autofix-cycle.ts` into `src/operations/` as named factories. Add novel mechanical strategies wrapping `DeterministicOperation` shell-command fix-ops. Behavior preservation matrix (see Design table) implemented as test fixtures. **Strategies are not yet wired into `buildPlanForStrategy`** — wiring is US-005a.

#### Context Files

- [src/pipeline/stages/autofix-cycle.ts](../../src/pipeline/stages/autofix-cycle.ts) — lines 100-178 (existing strategy construction to extract)
- [src/pipeline/stages/autofix.ts](../../src/pipeline/stages/autofix.ts) — lines 312-336 (mechanical fix scope detection to port)
- [src/operations/full-suite-rectify.ts](../../src/operations/full-suite-rectify.ts) — pattern reference for fix strategies
- [src/findings/cycle.ts](../../src/findings/cycle.ts) — `FixStrategy` interface contract

---

### US-005a: Wire unified phases (Phase E — additive wiring)

**Depends on:** US-001, US-002, US-003, US-004

Populate all new `PlanInputs` slots subject to `config.review.enabled` / `config.review.checks` membership. Wire all new check phases and fix strategies in `buildPlanForStrategy`. Extend `StoryOrchestratorResult` with `rectificationExhausted` / `unfixedFindings`. Extend `applyPostRunInspection` with the `mechanicalFailedOnly` rule.

**Do not yet delete legacy stages or the `inlineReview` flag** — that is US-005c. Behavior preservation verification is US-005b.

After this story, both paths exist temporarily. US-005b validates equivalence; dogfood for one release before US-005c.

#### Context Files

- [src/execution/plan-inputs.ts](../../src/execution/plan-inputs.ts) — slot population
- [src/execution/build-plan-for-strategy.ts](../../src/execution/build-plan-for-strategy.ts) — builder wiring
- [src/execution/story-orchestrator.ts](../../src/execution/story-orchestrator.ts) — `StoryOrchestratorResult` shape + `runRectification` writes to new fields
- [src/execution/post-run.ts](../../src/execution/post-run.ts) — `applyPostRunInspection` to extend
- [src/pipeline/stages/autofix.ts:182-199](../../src/pipeline/stages/autofix.ts#L182-L199) — `mechanicalFailedOnly` rule to port

---

### US-005b: Gating-preservation verification (Phase E — additive verification)

**Depends on:** US-005a

Behavior-preservation story. With US-005a wired but legacy stages still present, run integration tests asserting that every config-driven gate behaves the same under the unified builder as under the legacy stages. This story produces no new production code — only test fixtures.

Pure verification — provides the gating safety net for the US-005c terminal cleanup.

#### Context Files

- [test/integration/pipeline/](../../test/integration/pipeline/) — existing scenarios to verify against
- [src/execution/build-plan-for-strategy.ts](../../src/execution/build-plan-for-strategy.ts) — gating logic under test
- [src/config/schemas-review.ts](../../src/config/schemas-review.ts) — `review.checks` enum
- [src/config/schemas-execution.ts](../../src/config/schemas-execution.ts) — `quality.autofix.enabled` gate

---

### US-005c: Terminal cleanup (Phase E — destructive)

**Depends on:** US-005b (verification must pass before deletion)

Delete pipeline stages, autofix subsystem, `src/review/orchestrator.ts`, the `execution.inlineReview` schema field, and the builder methods `addSemanticReview` / `addAdversarialReview` plus their PlanInputs slots. Remove deleted stages from `defaultPipeline`. Add config loader deprecation warning. Update specs.

Pure deletion story — no new functionality. Composed almost entirely of `[verbatim]` negative assertions per the guide's terminal-cleanup rule.

Per Open Question #1: `regressionStage` is **retained** (post-run regression check is independently valuable; out of scope for this migration). It stays in `defaultPipeline`.

#### Context Files

- [src/pipeline/stages/index.ts](../../src/pipeline/stages/index.ts) — `defaultPipeline` to trim
- [src/execution/story-orchestrator.ts](../../src/execution/story-orchestrator.ts) — `addSemanticReview` / `addAdversarialReview` methods to remove
- [src/execution/plan-inputs.ts](../../src/execution/plan-inputs.ts) — `semanticReview` / `adversarialReview` slots to remove
- [src/config/schemas-execution.ts](../../src/config/schemas-execution.ts) — `inlineReview` field to remove
- [src/config/loader.ts](../../src/config/loader.ts) — deprecation shim site

---

### Seams

Cross-story invariants asserting producer/consumer wiring is complete.

- **Seam-001 (US-001 → US-002):** [verbatim] [grep] After US-002, `grep -n "runFixCycle" src/pipeline/stages/rectify.ts` returns ≥1.
- **Seam-002 (US-003 → US-005a):** [verbatim] [grep] After US-005a, `grep -nE "addLintCheck|addTypecheckCheck|addVerifyScoped" src/execution/build-plan-for-strategy.ts | wc -l` returns ≥3.
- **Seam-003 (US-004 → US-005a):** [verbatim] [grep] After US-005a, `grep -nE "makeAutofixImplementerStrategy|makeAutofixTestWriterStrategy|makeMechanicalLintFixStrategy|makeMechanicalFormatFixStrategy" src/execution/build-plan-for-strategy.ts | wc -l` returns ≥4.
- **Seam-004 (US-005a → US-005b):** behavioral — US-005b's gating-preservation tests cannot pass until US-005a's wiring is in place.
- **Seam-005 (US-005b → US-005c):** behavioral — US-005c's terminal cleanup cannot run until US-005b's gating-preservation tests are green (dual-path equivalence verified).

## Acceptance Criteria

### US-001: Activate gate-internal rectification

- AC-001.1 [verbatim] [grep] `grep -n "inlineReviewEnabled" src/execution/plan-inputs.ts` shows no occurrences inside the `rectificationInput` block (occurrences inside `semanticReviewInput` / `adversarialReviewInput` blocks remain, removed by US-005a).
- AC-001.2 [unit] [integration] `assemblePlanInputsFromCtx` returns `rectification: { maxAttempts, strategies: [], abortOnIncreasingFailures }` (non-undefined) whenever `config.execution.rectification.enabled === true`, regardless of `config.execution.inlineReview`.
- AC-001.3 [integration] Given TDD strategy with `rectification.enabled: true` and `inlineReview: false`, when the full-suite gate phase produces `failed-test` findings, then `runFixCycle` inside the builder dispatches `makeFullSuiteRectifyStrategy` and `implementerOp` is invoked at least once.
- AC-001.4 [grep] [verbatim] `grep -nE "semanticPhase|adversarialPhase" src/execution/story-orchestrator.ts` shows the `gatherRectificationFindings` function signature no longer accepts those parameters.
- AC-001.5 [unit] `gatherRectificationFindings(phaseOutputs, verifierPhase, fullSuiteGatePhase)` returns only `test-runner` source findings; the function no longer reads `semanticPhase` or `adversarialPhase`.

---

### US-002: Retire `runRectificationLoop`

Terminal-cleanup story — predominantly negative assertions.

- AC-002.1 [verbatim] [grep] `grep -rn "runRectificationLoop" src/ --include="*.ts" | grep -v "test\|deprecat" | wc -l` returns `0`.
- AC-002.2 [verbatim] [file] File `src/verification/rectification-loop.ts` does not exist after this story.
- AC-002.3 [verbatim] [file] File `src/verification/shared-rectification-loop.ts` does not exist after this story.
- AC-002.4 [verbatim] [grep] `grep -nE "runRectificationLoop|_rectificationDeps" src/verification/index.ts | wc -l` returns `0`.
- AC-002.5 [integration] When `verifyStage` reports `success: false` with `failCount > 0`, `rectifyStage` invokes `runFixCycle` with a strategy array containing `makeFullSuiteRectifyStrategy(story)` and the `implementerOp` is called within the cycle.
- AC-002.6 [integration] `run-regression.ts` regression rectification produces equivalent outcomes (same fix-then-revalidate cycle, same escalation conditions) as the prior `runRectificationLoop` call.

---

### US-003: Add check operations

- AC-003.1 [verbatim] [file] Files `src/operations/lint-check.ts`, `src/operations/typecheck-check.ts`, `src/operations/verify-scoped.ts` each exist. (No `format-check.ts` — format is fix-only, see §Design CANONICAL_ORDER note.)
- AC-003.2 [verbatim] [grep] Each new op file contains `kind: "deterministic"` exactly once.
- AC-003.3 [unit] For each op (`lintCheckOp`, `typecheckCheckOp`, `verifyScopedOp`): `execute({...})` returns `{ success: true, findings: [] }` when its configured command exits `0`, and `{ success: false, findings: <non-empty> }` with every finding's `source` matching the op's domain (`"lint"`, `"typecheck"`, `"test-runner"`) when the command exits non-zero.
- AC-003.4 [unit] When the underlying `quality.commands.*` value is `undefined`, the op returns `{ success: true, findings: [], durationMs: 0 }` without invoking `runQualityCommand` — applies uniformly to `lintCheckOp`, `typecheckCheckOp`, `verifyScopedOp`.
- AC-003.5 [verbatim] [grep] `grep -nE '"lint-check"|"typecheck-check"|"verify-scoped"' src/execution/story-orchestrator.ts` shows each phase name appears in the `CANONICAL_ORDER` array.
- AC-003.6 [verbatim] [grep] `grep -nE "addLintCheck|addTypecheckCheck|addVerifyScoped" src/execution/story-orchestrator.ts | wc -l` returns ≥6 (two overloads per method).
- AC-003.7 [verbatim] [grep] `grep -nE "addLintCheck|addTypecheckCheck|addVerifyScoped" src/execution/build-plan-for-strategy.ts | wc -l` returns `0` (additive story only — wiring is US-005a; this AC prevents premature wiring).
- AC-003.8 [unit] Each new check op resolves `quality.commands.*` via the config layering — given a per-package override at `.nax/mono/<pkg>/config.json`, the op runs the override command (not the root command).

---

### US-004: Add fix strategies

- AC-004.1 [verbatim] [file] Files `src/operations/autofix-implementer-strategy.ts`, `autofix-test-writer-strategy.ts`, `mechanical-lintfix-strategy.ts`, `mechanical-formatfix-strategy.ts` each exist.
- AC-004.2 [verbatim] [grep] Each new file exports a `make*Strategy` factory function: `grep -nE "export function make(Autofix|Mechanical)" src/operations/ -r | wc -l` returns ≥4.
- AC-004.3 [unit] `makeAutofixImplementerStrategy(ctx).appliesTo(finding)` returns `true` when `finding.fixTarget === "source"` and `finding.source` is one of `"lint" | "typecheck" | "semantic-review"`; returns `false` otherwise.
- AC-004.4 [unit] `makeAutofixTestWriterStrategy(ctx).appliesTo(finding)` returns `true` when `finding.fixTarget === "test"` or `finding.source === "adversarial-review"`; returns `false` otherwise.
- AC-004.5 [unit] `makeMechanicalLintFixStrategy().fixOp.execute({...})` invokes `runQualityCommand` with `commandName: "lintFix"` and the resolved `quality.commands.lintFix`.
- AC-004.6 [unit] `makeMechanicalLintFixStrategy().appliesTo(finding)` matches the today-equivalent predicate at `src/pipeline/stages/autofix.ts:331` (lint findings with mechanical-fixable scope).
- AC-004.7 [behavior] Test fixture for each row of the Design "behavior preservation matrix" passes against the new strategy implementations.
- AC-004.8 [verbatim] [grep] `grep -n "buildAutofixStrategies" src/pipeline/stages/autofix-cycle.ts | wc -l` returns ≥1 (additive story — `autofix-cycle.ts` still uses `buildAutofixStrategies`; migration is US-005a).

---

### US-005a: Wire unified phases

- AC-005a.1 [verbatim] [grep] `grep -nE "lintCheckInput|typecheckCheckInput|verifyScopedInput" src/execution/plan-inputs.ts | wc -l` returns ≥3.
- AC-005a.2 [verbatim] [grep] After this story, `grep -n "inlineReviewEnabled" src/execution/plan-inputs.ts | wc -l` returns `0` — the flag's last gating-site is removed.
- AC-005a.3 [verbatim] [grep] Seam-002 invariant: `grep -nE "addLintCheck|addTypecheckCheck|addVerifyScoped" src/execution/build-plan-for-strategy.ts | wc -l` returns ≥3.
- AC-005a.4 [verbatim] [grep] Seam-003 invariant: `grep -nE "makeAutofixImplementerStrategy|makeAutofixTestWriterStrategy|makeMechanicalLintFixStrategy|makeMechanicalFormatFixStrategy" src/execution/build-plan-for-strategy.ts | wc -l` returns ≥4.
- AC-005a.5 [verbatim] [grep] `grep -nE "rectificationExhausted" src/execution/story-orchestrator.ts src/execution/post-run.ts | wc -l` returns ≥2 (`StoryOrchestratorResult` declares the field; `applyPostRunInspection` reads it).
- AC-005a.6 [unit] After this story, `ExecutionPlan.run()` returns a `StoryOrchestratorResult` with `rectificationExhausted: true` and `unfixedFindings: <findings>` populated when its internal `runRectification` call produces a `FixCycleResult` whose `exitReason` is one of `"max-attempts-total"`, `"max-attempts-per-strategy"`, or `"bail-when"` and `finalFindings.length > 0`. Implementation may either change `runRectification` to return `FixCycleResult | undefined` (capturing the result up to `run()`) or thread a mutable result-holder; either is acceptable provided the observable `run()` output meets the AC.
- AC-005a.7 [integration] When `applyPostRunInspection` observes `planResult.rectificationExhausted` with all remaining findings having `source ∈ {"lint", "typecheck"}`, it returns `{ action: "continue" }` with a warn log (not `{ action: "escalate" }`).
- AC-005a.8 [unit] Per D3, `applyPostRunInspection` populates three new ctx fields from `planResult.phaseOutputs`: `ctx.verifyPassed` (derived from `verifier` or `verify-scoped` phase), `ctx.semanticReviewResult` (derived from `semantic-review` phase, undefined when absent), `ctx.rectificationIterationCount` (derived from `rectification` phase's iteration count, `0` when absent). Legacy fields `ctx.reviewResult` / `ctx.verifyResult` / `ctx.autofixAttempt` remain populated by their existing stages this story; deletion is US-005c.

---

### US-005b: Gating-preservation verification

Verification story. Asserts that today's per-check + per-strategy gating granularity survives the unified path. No new production code — only integration test fixtures.

- AC-005b.1 [integration] Per-check gating preserved: a config with `review.enabled: true`, `review.checks: ["lint"]` (no `"typecheck"`, no `"semantic"`, no `"adversarial"`) produces a plan whose `phaseOutputs` contains `"lint-check"` but does not contain `"typecheck-check"`, `"semantic-review"`, or `"adversarial-review"`.
- AC-005b.2 [integration] Per-check gating preserved: a config with `review.enabled: false` produces a plan whose `phaseOutputs` contains none of `"lint-check"`, `"typecheck-check"`, `"semantic-review"`, `"adversarial-review"`.
- AC-005b.3 [integration] Command-missing skip preserved: a config with `review.checks` including `"lint"` but `config.quality.commands.lint` undefined skips the lint-check phase entirely (no phase output produced) — verified by `phaseOutputs["lint-check"]` being absent. Equivalent fixture for `typecheck`.
- AC-005b.4 [integration] Strategy gating preserved: a config with `quality.autofix.enabled: false` produces a rectification phase whose `strategies` array contains no `makeAutofixImplementerStrategy` / `makeAutofixTestWriterStrategy` entries — verified by `runFixCycle` never dispatching `implementerRectifyOp` or `testWriterRectifyOp` during the cycle.
- AC-005b.5 [integration] Mechanical-strategy gating preserved: a config with `quality.commands.lintFix` and `lintFixScoped` both undefined produces a rectification phase whose `strategies` array contains no `makeMechanicalLintFixStrategy` entry. Equivalent fixture for `formatFix` / `formatFixScoped` undefined.
- AC-005b.6 [unit] When `quality.commands.lintFix` and `lintFixScoped` are both `undefined`, `makeMechanicalLintFixStrategy().fixOp.execute({...})` returns `{ applied: true, exitCode: 0 }` without invoking `runQualityCommand`. Equivalent AC for `makeMechanicalFormatFixStrategy()` with `formatFix` undefined. *(Defends against the strategy being constructed but invoked with no-op command — belt-and-braces gating.)*
- AC-005b.7 [integration] [behavior] Existing E2E test scenarios in `test/integration/pipeline/` covering TDD success path, TDD failure-then-fix path, non-TDD path, review-finding rectification, mechanical-only failure suppression, and partial-progress retry all pass without modification against the unified path.

---

### US-005c: Terminal cleanup

Pure deletion story. Composed of `[verbatim]` negative assertions per the spec-writing guide's terminal-cleanup rule.

Per Open Question #1: `regressionStage` is retained. The ACs below reflect that — `regressionStage` is NOT in the grep-zero list and `regression.ts` is NOT in the file-deletion list.

- AC-005c.1 [verbatim] [grep] `grep -rnE "execution\\.inlineReview|review\\.dialogue|reviewDialogue|\\.inlineReview" src/ --include="*.ts" | grep -v "deprecat\\|legacy" | wc -l` returns `0` (covers both `inlineReview` and `review.dialogue` config field removal per D4).
- AC-005c.2 [verbatim] [file] Files do not exist after this story: `src/pipeline/stages/verify.ts`, `rectify.ts`, `review.ts`, `autofix.ts`, `autofix-cycle.ts`, `autofix-guards.ts`, `autofix-scope-split.ts`, `autofix-test-writer.ts`, `autofix-agent.ts`, `autofix-prompts.ts`. File `src/review/orchestrator.ts` does not exist.
- AC-005c.3 [verbatim] [grep] `defaultPipeline` array in `src/pipeline/stages/index.ts` contains exactly the elements `queueCheckStage, routingStage, constitutionStage, contextStage, promptStage, optimizerStage, executionStage, regressionStage, completionStage` — verified by `grep -cE "Stage,?$" src/pipeline/stages/index.ts` (inside the `defaultPipeline` definition) returning exactly `9`, and `grep -nE "verifyStage|rectifyStage|reviewStage|autofixStage" src/pipeline/stages/index.ts | wc -l` returning `0`.
- AC-005c.4 [verbatim] [grep] `grep -nE "addSemanticReview|addAdversarialReview" src/execution/story-orchestrator.ts | wc -l` returns `0` — the builder methods are removed.
- AC-005c.5 [verbatim] [grep] `grep -nE "semanticReview\\??:|adversarialReview\\??:" src/execution/plan-inputs.ts | wc -l` returns `0` — the PlanInputs slot fields are removed.
- AC-005c.6 [verbatim] [grep] `grep -rnE "ctx\\.reviewerSession|ctx\\.reviewResult|ctx\\.verifyResult|ctx\\.autofixAttempt" src/ --include="*.ts" | grep -vE "src/debate/|test" | wc -l` returns `0` — per D3 + D4, no non-debate consumer of these legacy ctx fields after cleanup.
- AC-005c.7 [integration] When a legacy config containing `execution.inlineReview: true` or `review.dialogue.enabled: true` is loaded, `src/config/loader.ts` logs a warning at level `warn` per key (message contains the key name and `"removed"`), and the loaded config does not contain either key.
- AC-005c.8 [verbatim] [grep] Specs at `docs/specs/SPEC-story-orchestrator-consolidation.md`, `docs/specs/SPEC-rectification-unification.md` each contain the literal string `PARTIALLY SUPERSEDED` in their first 30 lines.

## Resolved Decisions

All four open questions resolved 2026-05-23 via codebase audit. Documented here for traceability; the ACs reflect each resolution.

### D1 — `regressionStage`: retain

Stays as a post-run stage. Folding into the per-story builder would change regression-check semantics (per-story instead of per-run) and is out of scope. AC-005c.3 reflects this — `regressionStage` is included in the post-cleanup `defaultPipeline`.

### D2 — `IReviewPlugin`: drop per-story integration, retain deferred-only

**Audit:** Two production callers of `pluginRegistry.getReviewers()`:
- [src/review/orchestrator.ts:497](../../src/review/orchestrator.ts#L497) — per-story plugin reviewer (deleted with `reviewStage` in US-005c)
- [src/execution/deferred-review.ts:72](../../src/execution/deferred-review.ts#L72) — post-run mode (`pluginMode: "deferred"`), runs once per run with full diff

Zero internal consumers of per-story mode (nax-dogfood audit empty). Per-story plugin reviewers are de facto unused.

**Decision:** Delete per-story plugin reviewer support entirely. Keep `deferred-review.ts` and the `IReviewPlugin` interface — they support the genuinely-used post-run reviewer mode. The `config.review.pluginMode` field becomes obsolete (only `"deferred"` remains valid); collapse to a boolean (`config.review.deferredReview.enabled`) or remove the enum and infer mode from registry presence.

Concrete impact:
- US-003 does **not** include `pluginReviewerOp` — no builder phase for plugin reviewers.
- CANONICAL_ORDER (§Design) drops the `plugin-reviews` row.
- US-005c adds removal of `config.review.pluginMode` field (or simplification to a boolean).
- `deferred-review.ts` and its caller in the run-completion lifecycle are unchanged.

### D3 — Pipeline-context derived fields: explicit migration map

**Audit:** Live consumers of stage-populated ctx fields outside stages-being-deleted:

| Reader (file:line) | Field consumed | New source under unified path |
|:---|:---|:---|
| [src/pipeline/stages/completion.ts:122](../../src/pipeline/stages/completion.ts#L122) | `ctx.reviewResult.checks` (semantic check info for metrics) | `planResult.phaseOutputs["semantic-review"]` |
| [src/pipeline/stages/completion.ts:149](../../src/pipeline/stages/completion.ts#L149) | `ctx.reviewerSession.destroy()` | Remove — `reviewStage` no longer creates a dialogue session (see D4) |
| [src/pipeline/stages/regression.ts:30](../../src/pipeline/stages/regression.ts#L30) | `ctx.verifyResult.success` (gate predicate) | `planResult.phaseOutputs["verifier"]` (TDD) or `phaseOutputs["verify-scoped"]` (non-TDD) — derive a unified `verifyPassed: boolean` in `applyPostRunInspection` and surface on `ctx` |
| [src/metrics/tracker.ts:107-110](../../src/metrics/tracker.ts#L107-L110) | `ctx.autofixAttempt` (autofix invocation count) | `planResult.phaseOutputs["rectification"]` iteration count (cycle output exposes `iterations.length`) |
| [src/metrics/tracker.ts:175-176](../../src/metrics/tracker.ts#L175-L176) | `ctx.verifyResult.scopeTestFallback` (smart-runner metric) | `planResult.phaseOutputs["verify-scoped"].scopeTestFallback` |
| [src/execution/escalation/tier-escalation.ts:267,287](../../src/execution/escalation/tier-escalation.ts#L267) | `shouldRetrySameTier(ctx.verifyResult)` | Same derivation as `regression.ts`; refactor `shouldRetrySameTier` to take the unified `verifyPassed` + `verifyStatus` instead of the legacy `verifyResult` shape |

**Decision:** US-005a includes the derivation work as in-scope. Add `applyPostRunInspection` to populate three new ctx fields from `planResult.phaseOutputs`:
- `ctx.verifyPassed: boolean` — derived from verifier or verify-scoped phase
- `ctx.semanticReviewResult: { passed, findings } | undefined` — for completion-stage metric reads
- `ctx.rectificationIterationCount: number` — replacing `autofixAttempt`

Legacy `ctx.reviewResult` / `ctx.verifyResult` / `ctx.autofixAttempt` fields are deleted in US-005c.

### D4 — Dialogue (`ReviewerSession` non-debate use): remove

**Audit:** `ReviewerSession` non-debate consumers:
- [src/pipeline/stages/review.ts](../../src/pipeline/stages/review.ts) — `reviewStage` creates and uses it for dialogue mode (deleted in US-005c)
- [src/pipeline/stages/completion.ts:149-151](../../src/pipeline/stages/completion.ts#L149-L151) — calls `.destroy()` on the session (deleted in US-005c per D3)

Debate consumers (`src/debate/`, `src/review/semantic-debate.ts`) genuinely use it for multi-agent review sessions. `config.review.dialogue.enabled` defaults `false` and is unused outside reviewStage's per-story dialogue path.

**Decision:** Delete `config.review.dialogue` config field. Keep `ReviewerSession` class — debate consumers continue using it. After US-005c, `ReviewerSession` is debate-internal only; if debate is later deprecated (separate track per ADR §6 Out-of-Scope), the class can go in that PR.

Concrete impact:
- US-005c adds: `grep -n "review\\.dialogue\\|reviewDialogue" src/config/schemas-review.ts | wc -l` returns `0`.
- US-005c adds: `grep -n "ctx.reviewerSession" src/pipeline/` returns `0` (only debate-internal callers remain).
- `ReviewerSession` class file stays.

## Out-of-Scope Tracks (Coordinated, Not Bundled)

- **Debate subsystem deprecation/removal.** Separate ADR if pursued. Migration code in this spec does not reference `src/debate/`.
- **`IReviewPlugin` removal.** Separate PR after US-005c if the Phase C decision gate selects "deprecate".
- **Configuration cleanup.** `review.dialogue`, `review.debate` config keys may become dead post-migration; sweep in a follow-up.

## References

- [ADR-023-execution-unification.md](../adr/ADR-023-execution-unification.md) — architectural decision
- [ADR-021-findings-and-fix-strategy-ssot.md](../adr/ADR-021-findings-and-fix-strategy-ssot.md) — Finding type SSOT
- [ADR-022-fix-strategy-and-cycle.md](../adr/ADR-022-fix-strategy-and-cycle.md) — Fix Strategy + Cycle orchestration
- [SPEC-story-orchestrator.md](./SPEC-story-orchestrator.md) — base spec for the builder (`CANONICAL_ORDER` amended by this spec)
- [SPEC-story-orchestrator-consolidation.md](./SPEC-story-orchestrator-consolidation.md) — US-005 (review portion superseded)
- [SPEC-rectification-unification.md](./SPEC-rectification-unification.md) — US-006a/b (wiring + cleanup superseded)
- [docs/findings/2026-05-23-inlinereview-legacy-stage-gap.md](../findings/2026-05-23-inlinereview-legacy-stage-gap.md) — the investigation that surfaced this work

## Known divergences from spec-writing guide

- **Story count is 7, guide targets 3-5.** Documented in §Stories. Driven by the guide's hard rules: (a) AC-count ≤8 per story forces US-005a (wiring) and US-005b (gating verification) to be separate from US-005c (cleanup); (b) additive + destructive hard-split forces US-005c to be a deletion-only terminal-cleanup story. Underlying delivery is still 5 phases per ADR-023; the spec's 7 stories map to A, B, C, D, E-wire, E-verify, E-delete.

<!-- spec-writing: completed-through-phase-6 -->
<!-- spec-review: passed 2026-05-23 at bcfe96ad (phases 1-8, phase 9 deferred until --prd) -->

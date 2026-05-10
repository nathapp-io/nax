# SPEC: Enhanced Debate — Phase 1 (Plug-Point Framework + Manifest Foundation)

## Summary

Refactor the shared `DebateRunner` to dispatch through composable plug-points (`preDebatePhase`, `selector`, `postDebateVerifier`), and add the facts-manifest foundation needed for Phase 2's plan composition. This phase is **strictly behavior-preserving** for all current debate consumers (plan, semantic review, future stages) — existing tests must pass unchanged. New plug-point fields default off; existing call sites get explicit composition objects that reproduce today's behavior. The grounder operation and manifest schema are added as standalone units, ready for Phase 2 to wire into plan composition.

## Motivation

Plan-stage debate today produces PRDs that confidently transcribe spec hallucinations into stories — files that don't exist, APIs that don't match the codebase, schemas that have drifted. The root cause is that all debaters consume the spec as authoritative without verifying claims against actual repo state. Fixing this requires three new mechanics (grounder, citation discipline, mechanical verifier) that must compose with the existing debate runner without forking it. Phase 1 lands the framework — the shared dispatcher gains plug-points, existing logic moves into named strategies, and the grounder operation is built standalone. Phase 2 then wires these into a plan composition that catches hallucination at PRD-generation time.

The architectural constraint is non-negotiable: **`DebateRunner` must remain a single SSOT** consumed by every stage (currently plan + semantic review; future acceptance + rectification). Per-stage forks would regress the existing architecture documented in [docs/specs/2026-05-10-plan-enhanced-debate.md §3](./2026-05-10-plan-enhanced-debate.md#3-architectural-constraint--single-shared-runner-composable-plug-points).

## Design

### Top-level `grounder` block on `DebateConfig`

A new `grounder` block on `DebateConfig` (NOT per-stage) holds the grounder operation's model + timeout. **Why top-level rather than per-stage:**

1. **Matches dominant config-driven op pattern.** Existing ops (`planInteractiveOp`, `acceptanceGenerateOp`, `classifyRouteOp`, etc.) all use Pattern A — `model: (_input, ctx) => ctx.config.<slice>.model` — reading from a stable config path via their config selector. Putting `grounder.model` at the debate-config root makes `groundOp` structurally identical to those ops.
2. **Avoids op-stage coupling.** `groundOp` is generic across stages (any stage can opt into pre-phase grounding). If the model lived on per-stage `preDebatePhase`, the op would need to know its calling stage to read the right slice — bending the config-selector pattern that none of the existing ops bend.
3. **`ConfiguredModel` type used correctly.** Same `ConfiguredModel` ([schema-types.ts:36](../../src/config/schema-types.ts#L36)) used by every other configurable op in the codebase, with the same `ConfiguredModelSchema` Zod validator and `.default("fast")` semantics.
4. **Per-stage flexibility deferred.** Plan is the only consumer in Phase 2. If acceptance/rectification later need a different grounder model, add a per-stage override field then (e.g. `stages.<stage>.preDebatePhase.modelOverride?: ConfiguredModel`) — additive, non-breaking. Don't speculate-design today.

```typescript
// src/config/schemas-debate.ts (additive on DebateConfigSchema)
import { ConfiguredModelSchema } from "@/config";

const GrounderConfigSchema = z.object({
  model: ConfiguredModelSchema.default("fast"),
  timeoutSeconds: z.number().int().positive().default(300),
});

export const DebateConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agents: z.number().int().min(2).default(3),
  maxConcurrentDebaters: z.number().int().min(1).max(10).default(2),
  grounder: GrounderConfigSchema.default({}),    // NEW — used by groundOp via ctx.config.grounder
  stages: { ... },                               // existing
});
```

```typescript
// src/debate/types.ts (mirror TypeScript type — additive)
import type { ConfiguredModel } from "@/config/schema-types";

export interface GrounderConfig {
  model: ConfiguredModel;
  timeoutSeconds: number;
}

export interface DebateConfig {
  // ... existing fields
  grounder: GrounderConfig;        // NEW — defaulted by Zod, always present after parse
}
```

### Plug-point fields on `DebateStageConfig`

Three new optional fields added to [src/debate/types.ts](../../src/debate/types.ts) and [src/config/schemas-debate.ts](../../src/config/schemas-debate.ts). All default off; existing configs continue working unchanged.

```typescript
interface DebateStageConfig {
  // ... existing fields unchanged

  preDebatePhase?: {
    kind: "grounder" | "custom";
    // Note: model is NOT here — see top-level DebateConfig.grounder block below.
    // Per-stage `preDebatePhase` only chooses *which* pre-phase strategy to run;
    // *how* the grounder runs (model, timeout) is a single top-level block.
  };

  proposers?: {
    citationsRequired?: boolean;
    fileReadAccess?: boolean;
    fileReadBudget?: number;
  };

  selector?:
    | { kind: "synthesis" }
    | { kind: "majority-fail-closed" }
    | { kind: "majority-fail-open" }
    | { kind: "judge" }
    | { kind: "dialogue-verdict" };
  // Phase 1 union covers the 5 selector kinds extracted from today's resolveOutcome dispatch.
  // Phase 2 extends this union with `verifier-pick` (additive). When omitted, default behavior
  // is determined by pickSelectorKind() (see "Selector kind resolution" below) — typically
  // resolves to "synthesis" when no session is present, or "dialogue-verdict" when
  // reviewerSession + resolverContext are present.

  postDebateVerifier?: {
    kind: "plan-checklist" | "review-grounding-filter" | "custom";
  };
}
```

### Strategy contracts (3 new contract files)

```typescript
// src/debate/pre-phase/types.ts
export interface PreDebatePhaseContext {
  readonly ctx: CallContext;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly workdir: string;
  readonly featureName: string;
  readonly storyId: string;
  readonly specContent?: string;
}
export interface PreDebatePhaseResult {
  readonly manifestSection: string;       // pre-rendered text injected into proposer taskContext
  readonly costUsd: number;
}
export type PreDebatePhase = (ctx: PreDebatePhaseContext) => Promise<PreDebatePhaseResult>;
```

```typescript
// src/debate/selectors/types.ts
export interface SelectorContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateConfig;
  readonly proposals: SuccessfulProposal[];
  readonly critiques: string[];
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutMs: number;
  readonly agentManager: IAgentManager;
  readonly reviewerSession?: ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
  readonly promptSuffix?: string;
  readonly debaters: Debater[];
}
export interface SelectorResult {
  readonly outcome: "passed" | "failed" | "skipped";
  readonly output?: string;
  readonly resolverCostUsd: number;
}
export type Selector = (ctx: SelectorContext) => Promise<SelectorResult>;
```

```typescript
// src/debate/verifiers/types.ts
export interface PostDebateVerifierContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly selectorResult: SelectorResult;
  readonly workdir: string;
  readonly ctx: CallContext;
}
export interface PostDebateVerifierResult {
  readonly outcome: "passed" | "failed" | "skipped";
  readonly findings?: unknown[];          // strategy-specific; consumer interprets
  readonly output?: string;
  readonly costUsd: number;
}
export type PostDebateVerifier = (ctx: PostDebateVerifierContext) => Promise<PostDebateVerifierResult>;
```

### Static built-in registries (3 new files)

The selector registry must cover **all 5 selector kinds** to preserve today's `resolveOutcome()` dispatch:

| Kind | Wraps existing | Notes |
|:---|:---|:---|
| `synthesis` | `synthesisResolver` ([resolvers.ts:66](../../src/debate/resolvers.ts#L66)) | LLM merge |
| `majority-fail-closed` | `majorityResolver(proposals, false)` ([resolvers.ts:47](../../src/debate/resolvers.ts#L47)) | No LLM; JSON pass/fail vote |
| `majority-fail-open` | `majorityResolver(proposals, true)` ([resolvers.ts:47](../../src/debate/resolvers.ts#L47)) | No LLM; JSON pass/fail vote |
| `judge` | `judgeResolver` ([resolvers.ts:87](../../src/debate/resolvers.ts#L87)) | LLM judge; corresponds to old `resolver.type === "custom"` |
| `dialogue-verdict` | `reviewerSession.resolveDebate()` ([session-helpers.ts:244-260](../../src/debate/session-helpers.ts#L244)) | Tool-verified verdict path; today auto-wrapped onto any of the above when `reviewerSession + resolverContext` are present |

```typescript
// src/debate/selectors/registry.ts
import type { Selector } from "./types";
import { synthesisSelector } from "./synthesis";
import { majorityFailClosedSelector, majorityFailOpenSelector } from "./majority";
import { judgeSelector } from "./judge";
import { dialogueVerdictSelector } from "./dialogue-verdict";

const STRATEGIES: Record<string, Selector> = {
  "synthesis": synthesisSelector,
  "majority-fail-closed": majorityFailClosedSelector,
  "majority-fail-open": majorityFailOpenSelector,
  "judge": judgeSelector,
  "dialogue-verdict": dialogueVerdictSelector,
};

export function resolveSelector(kind: string): Selector {
  const strategy = STRATEGIES[kind];
  if (!strategy) {
    throw new NaxError(`Unknown selector kind: ${kind}`, "SELECTOR_UNKNOWN", { kind });
  }
  return strategy;
}
```

Same pattern for `pre-phase/registry.ts` (Phase 1 registers no strategies; Phase 2 adds `grounder`) and `verifiers/registry.ts` (Phase 1 registers `review-grounding-filter`; Phase 2 adds `plan-checklist`).

### Selector kind resolution (preserves today's dispatch)

Today's dispatcher in [session-helpers.ts:resolveOutcome](../../src/debate/session-helpers.ts#L183) makes two orthogonal decisions:

1. **Base selector** — chosen by `stageConfig.resolver.type` (4 existing types).
2. **Dialogue elevation** — if `reviewerSession + resolverContext` are both present, route through `dialogue-verdict` regardless of `resolver.type`, with majority-vote context pre-computed for majority types.

Phase 1 preserves both decisions via a `pickSelectorKind()` helper:

```typescript
// src/debate/selectors/pick.ts
export function pickSelectorKind(
  stageConfig: DebateStageConfig,
  ctx: { reviewerSession?: ReviewerSession; resolverContextInput?: ResolverContextInput },
): string {
  // 1. Explicit selector field wins
  if (stageConfig.selector) return stageConfig.selector.kind;

  // 2. Auto-elevate to dialogue-verdict when session+context present (today's behavior)
  if (ctx.reviewerSession && ctx.resolverContextInput) return "dialogue-verdict";

  // 3. Map existing resolver.type to selector kind (backward compat for current configs)
  // RESOLVER_TYPES is a closed enum of 4 values — exhaustive match.
  switch (stageConfig.resolver.type) {
    case "synthesis":            return "synthesis";
    case "majority-fail-closed": return "majority-fail-closed";
    case "majority-fail-open":   return "majority-fail-open";
    case "custom":               return "judge";
  }
}
```

The `dialogue-verdict` strategy internally invokes the appropriate base selector (per `resolver.type`) for context computation — so today's "compute majorityVote first, then call reviewerSession" logic stays preserved. Strategies receive `resolverConfig` via `SelectorContext.stageConfig.resolver` and can branch on it.

Result: with `stageConfig.selector` left unset and existing config (e.g. `resolver.type: "majority-fail-closed"`) + a `ReviewerSession`, dispatch ends up calling `dialogue-verdict` with majority context exactly as today. With `stageConfig.selector: { kind: "majority-fail-closed" }` explicitly set, the auto-elevation is bypassed and the bare majority resolver runs (new explicit-control surface for advanced users).

### Behavior-preserving extractions

| Extracted from | New location | Behavior |
|:---|:---|:---|
| `synthesisResolver` in [src/debate/resolvers.ts:66](../../src/debate/resolvers.ts#L66) | `src/debate/selectors/synthesis.ts` | Wrap as `Selector`. Source `resolvers.ts::synthesisResolver` retained as thin compat wrapper for external callers. |
| `majorityResolver` in [src/debate/resolvers.ts:47](../../src/debate/resolvers.ts#L47) (used by both `majority-fail-closed` and `majority-fail-open` types) | `src/debate/selectors/majority.ts` exporting two strategies (`majorityFailClosedSelector`, `majorityFailOpenSelector`) | Both strategies call the same `majorityResolver` with different `failOpen` values. Source `resolvers.ts::majorityResolver` retained as compat wrapper. |
| `judgeResolver` in [src/debate/resolvers.ts:87](../../src/debate/resolvers.ts#L87) (used when `resolver.type === "custom"`) | `src/debate/selectors/judge.ts` | Wrap as `Selector`. Source `resolvers.ts::judgeResolver` retained as compat wrapper. |
| Dialogue-path branch in [src/debate/session-helpers.ts:204-275](../../src/debate/session-helpers.ts#L204) (the `if (reviewerSession && resolverContext)` block, including `majorityVote` pre-computation, `diffContext` build, and `reviewerSession.resolveDebate()` / `reReviewDebate()` dispatch) | `src/debate/selectors/dialogue-verdict.ts` | Wrap as `Selector`. Strategy reads `reviewerSession` and `resolverContextInput` from `SelectorContext`; branches on `stageConfig.resolver.type` for the majority-vote pre-computation step. Today's `try/catch` fallback to stateless resolver is preserved by the dispatcher (it falls back to a non-dialogue selector kind on failure — see Failure Handling). |
| `filterByAcGroundingMinimal` + `sanitizeRefModeFindings` + `isBlockingSeverity` invocation pattern in [src/review/semantic-debate.ts:245-290](../../src/review/semantic-debate.ts#L245) | `src/debate/verifiers/review-grounding-filter.ts` | Wrap as `PostDebateVerifier`. Source helper functions in `src/review/` stay where they are; the strategy imports them. |

After all extractions, [src/debate/session-helpers.ts:resolveOutcome](../../src/debate/session-helpers.ts#L183) becomes a thin dispatcher that calls `pickSelectorKind()` then `resolveSelector(kind)(ctx)`. Total line count drops; existing behavior is byte-equivalent.

### Runner dispatch wiring (two paths)

`DebateRunner` exposes two entry points and **both must be wired**:

1. **`run()` → `runPanelOneShot/runStateful/runHybrid`** ([runner.ts:65](../../src/debate/runner.ts#L65)) — used by semantic review and most future stages.
2. **`runPlan()` → `runner-plan.ts`** ([runner.ts:88](../../src/debate/runner.ts#L88)) — used by `nax plan` debate path. Separate 273-line file.

Wiring rules:
- If `stageConfig.selector` is set → use `resolveSelector(stageConfig.selector.kind)` instead of the inlined `resolveOutcome()` synthesis call.
- If `stageConfig.preDebatePhase` is set → run via `resolvePreDebatePhase()` before parallel proposer fan-out; pre-pend `manifestSection` to `taskContext`.
- If `stageConfig.postDebateVerifier` is set → run via `resolvePostDebateVerifier()` after the selector emits its result.
- If any field is **unset**, dispatch follows current behavior (synthesis + no pre-phase + no post-verifier).

### Facts manifest schema

```typescript
// src/debate/facts-manifest.ts
import { z } from "zod";

export const FactsManifestSchema = z.object({
  repoFacts: z.array(z.object({
    id: z.string().regex(/^F-\d{3,}$/),
    kind: z.enum(["file", "symbol", "schema", "contract", "convention"]),
    evidence: z.string().min(1),         // e.g. "src/x.ts:42-89"
    summary: z.string().min(1),
  })).default([]),
  specClaims: z.array(z.object({
    id: z.string().regex(/^S-\d{3,}$/),
    specSpan: z.string().min(1),         // e.g. "lines 23-25"
    claim: z.string().min(1),
    kind: z.enum(["factual", "intent"]),
    verification: z.object({
      status: z.enum(["verified", "unverified", "partial", "contradicted"]),
      evidence: z.string().optional(),
      factId: z.string().regex(/^F-\d{3,}$/).optional(),
    }),
  })).default([]),
  gaps: z.array(z.object({
    id: z.string().regex(/^G-\d{3,}$/),
    kind: z.enum(["missing-context", "ignored-convention", "boundary-not-considered"]),
    note: z.string().min(1),
    evidence: z.string().optional(),
  })).default([]),
});
export type FactsManifest = z.infer<typeof FactsManifestSchema>;

export function parseFactsManifest(raw: unknown): { ok: true; manifest: FactsManifest } | { ok: false; error: string };
export function renderManifestSection(manifest: FactsManifest): string;
```

### `groundOp` operation

Pure Pattern A — config-driven model selection, identical structure to `planInteractiveOp` / `acceptanceGenerateOp` / `classifyRouteOp`. `GrounderInput` carries only the data the op consumes; the model lives on `ctx.config.grounder.model` per the rationale above.

```typescript
// src/operations/ground.ts
export interface GrounderInput {
  readonly specContent: string;
  readonly codebaseContext: string;
  readonly workdir: string;
  // Note: NO model field. The grounder model is config-driven via DebateConfig.grounder.model
  // (read inside groundOp via ctx.config.grounder.model). This matches the dominant
  // config-driven op pattern in the codebase — see "Top-level grounder block" rationale above.
}

export const groundOp: CompleteOperation<GrounderInput, FactsManifest, DebateConfig> = {
  kind: "complete",
  name: "ground",
  // stage is a static PipelineStage literal (cannot be a function) used by callOp /
  // SessionManager.openSession for permission resolution per resolvePermissions(config, stage).
  // We hardcode "plan" because:
  //   1. Plan is the only Phase 2 consumer.
  //   2. Mirrors precedent: debate-propose.ts hardcodes stage: "review" despite being
  //      consumed by both plan-stage and review-stage debate.
  //   3. Grounder is read-only file access; "plan" permissions are conservative enough
  //      to cover this safely for the current consumer.
  // Future acceptance/rectification debate stages adopting grounder should add a
  // separate op (e.g. groundAcceptanceOp with stage: "acceptance") rather than retro-
  // fitting this one — small duplication is cheaper than dynamic-stage refactor.
  stage: "plan",
  jsonMode: true,
  config: debateConfigSelector,
  // Pattern A: config-driven. Same shape as ctx.config.plan.model (plan op),
  // ctx.config.acceptance.model (acceptance ops), ctx.config.routing.llm?.model (classify-route).
  // ConfiguredModel union (tier string | { agent, model }) is resolved by callOp via
  // resolveConfiguredModel — same downstream resolution path as every other configurable op.
  model: (_input, ctx) => ctx.config.grounder.model,
  timeoutMs: (_input, ctx) => ctx.config.grounder.timeoutSeconds * 1000,
  build(input, _ctx) {
    return new GrounderPromptBuilder().build(input.specContent, input.codebaseContext, input.workdir);
  },
  parse(output, _input, _ctx) {
    const result = parseFactsManifest(output);
    if (!result.ok) {
      throw new NaxError(`Grounder output failed schema validation: ${result.error}`, "GROUNDER_PARSE_FAILED", {});
    }
    return result.manifest;
  },
};
```

The `grounder` pre-phase strategy (Phase 2) calls `callOp(ctx.ctx, groundOp, { specContent, codebaseContext, workdir })` — no model threading needed; `groundOp` reads its model from `ctx.config.grounder.model` directly.

**Multi-stage extension:** `groundOp.stage = "plan"` is hardcoded because `PipelineStage` is a static literal (not a function), and Phase 2's only consumer is plan-stage debate. The pattern matches [`debateProposeOp`](../../src/operations/debate-propose.ts) which hardcodes `stage: "review"` despite being consumed by both plan-stage and review-stage debate today. If acceptance/rectification debate stages later adopt grounder, the cleanest path is to add a sibling op per stage (e.g. `groundAcceptanceOp` with `stage: "acceptance"`) sharing the same `build`/`parse`/`model` logic via a shared helper — small code duplication is cheaper than a dynamic-stage refactor of the framework. Phase 1 doesn't preempt this; it's mentioned here so future contributors don't assume a single-op design must persist.

### Integration

- **Existing types to extend:** `DebateStageConfig` in [src/debate/types.ts](../../src/debate/types.ts); `DebateStageConfigSchema` in [src/config/schemas-debate.ts](../../src/config/schemas-debate.ts).
- **Integration points:** `DebateRunner.runPanelOneShot()` ([runner.ts:103](../../src/debate/runner.ts#L103)) and the dispatch flow in [runner-plan.ts](../../src/debate/runner-plan.ts).
- **Existing patterns to follow:** [planInteractiveOp](../../src/operations/plan.ts) and [acceptanceGenerateOp](../../src/operations/acceptance-generate.ts) for `groundOp` shape (Pattern A — config-driven `model: (_input, ctx) => ctx.config.<slice>.model`); [debateProposeOp](../../src/operations/debate-propose.ts) for the existing debate-stage op precedent (including the static-stage hardcode); [src/plugins/registry.ts](../../src/plugins/registry.ts) for static registry pattern; [src/debate/resolvers.ts](../../src/debate/resolvers.ts) for selector function signatures (the strategies wrap these).
- **Composition expressed at call sites:** `src/review/semantic-debate.ts` builds `DebateStageConfig` with `selector: { kind: "dialogue-verdict" }` + `postDebateVerifier: { kind: "review-grounding-filter" }` — replacing the force-override at lines 97-105 with explicit composition. `src/cli/plan.ts` continues passing through user config (no behavior change in Phase 1).

### Approach

This is an internal refactor + foundation: **no production LLM behavior change** for any existing user. New plug-point fields default off; when set to the strategies that wrap existing code (synthesis/majority/judge/dialogue-verdict/review-grounding-filter), output is byte-equivalent (modulo log messages). The only new LLM call surface added is `groundOp`, which Phase 1 builds and unit-tests in isolation but does NOT wire into any production code path — Phase 2 wires it via the plan composition gated by `evidenceMode = "asymmetric"`.

### Failure Handling

- **Selector resolution failure** (unknown `kind`) → throw `NaxError("SELECTOR_UNKNOWN", ...)` at composition build time. Same for `preDebatePhase` and `postDebateVerifier`. Caught at config validation, not runtime.
- **`groundOp` parse failure** → standard `callOp` retry strategy applies (3 attempts via `makeParseRetryStrategy`); on exhaustion the op throws and the caller decides policy. Phase 1 only tests this in isolation; Phase 2 wires the production failure-mode policy.
- **Behavior-preserving extractions failing tests** → revert; this is a behavior-preserving phase. Failing tests indicate the extraction is not byte-equivalent and must be fixed before merging.

## Stories

1. **US-001: Plug-point schema + contracts + registries** — extends `DebateStageConfig` Zod schema and TypeScript type with three optional plug-point fields (`preDebatePhase`, `proposers`, `selector`, `postDebateVerifier`); defines three strategy contracts in dedicated `types.ts` files; builds three static built-in registries with a `resolve*` function each. Phase 1 registers no strategies in `pre-phase/registry.ts` (Phase 2 adds `grounder`).
2. **US-002: Extract `synthesis`, `majority-fail-closed`, `majority-fail-open`, `judge` selector strategies** — extracts the four LLM-and-mechanical resolver bodies from `src/debate/resolvers.ts` into four selector strategies under `src/debate/selectors/` (`synthesis.ts`, `majority.ts` exporting two strategies, `judge.ts`); keeps the source `resolvers.ts` exports as thin compat wrappers; registers all four in the selector registry.
3. **US-003: Extract `dialogue-verdict` selector + `review-grounding-filter` verifier + `pickSelectorKind` dispatcher** — extracts the dialogue-path branch from `session-helpers.ts:204-275` into `selectors/dialogue-verdict.ts` (wrapping `reviewerSession.resolveDebate()` / `reReviewDebate()` and the `majorityVote` pre-computation logic, branching on `stageConfig.resolver.type`); extracts the `filterByAcGroundingMinimal`/`sanitizeRefModeFindings`/`isBlockingSeverity` block from `semantic-debate.ts:245-290` into `verifiers/review-grounding-filter.ts`; implements `src/debate/selectors/pick.ts::pickSelectorKind()` that maps explicit `stageConfig.selector` first, then auto-elevates to `dialogue-verdict` when `reviewerSession + resolverContext` are present, then falls back to `resolver.type` mapping for backward compat; updates `semantic-debate.ts` to build a `DebateStageConfig` with explicit composition (`selector: { kind: "dialogue-verdict" }` + `postDebateVerifier: { kind: "review-grounding-filter" }`), removing the force-override at lines 97-105.
4. **US-004: Wire selector dispatch in main runner and `runner-plan.ts`** — refactors `session-helpers.ts::resolveOutcome()` to delegate to `resolveSelector(pickSelectorKind(stageConfig, ctx))(ctx)` instead of the inlined per-type if/else; ensures `runner.ts::runPanelOneShot()`, `runner-plan.ts::runPlan()`, `runner-hybrid.ts`, and `runner-stateful.ts` all route their final selection call through this refactored `resolveOutcome` (or directly through `resolveSelector` where appropriate); adds pre-phase and post-verifier dispatch hooks that exit early when the corresponding plug-point fields are unset.
5. **US-005: Facts manifest schema + `groundOp` standalone** — adds `GrounderConfigSchema` (`{ model: ConfiguredModel, timeoutSeconds: number }`) to `DebateConfigSchema` as the top-level `grounder` block (defaults `model: "fast"`, `timeoutSeconds: 300`); implements `src/debate/facts-manifest.ts` with Zod schema, `parseFactsManifest`, and `renderManifestSection`; implements `src/operations/ground.ts` with `groundOp` as a `CompleteOperation` that reads model and timeout from `ctx.config.grounder` (Pattern A — config-driven, matching `planInteractiveOp`/`acceptanceGenerateOp` shape); implements `src/prompts/builders/grounder-builder.ts` with the `build()` method that produces the grounder prompt. Standalone — not wired into any runner path in Phase 1; Phase 2 wires it via the `grounder` pre-phase strategy.

### Dependencies

- US-001: no dependencies
- US-002: depends on US-001 (uses `Selector` contract and `selectors/registry.ts`)
- US-003: depends on US-001 (uses contracts and registries) and US-002 (`pickSelectorKind` returns base-selector kinds for fallback to majority/synthesis/judge strategies)
- US-004: depends on US-002, US-003 (registry must be populated and `pickSelectorKind` exists before `resolveOutcome` can delegate)
- US-005: no dependencies on US-001/2/3/4 (standalone — manifest infra)

### Context Files (per story)

**US-001:**
- `src/debate/types.ts` — `DebateStageConfig` (target type to extend)
- `src/config/schemas-debate.ts` — `DebateStageConfigSchema` (target Zod schema to extend)
- `src/plugins/registry.ts` — static registry pattern to replicate
- `src/agents/registry.ts` — alternate static registry for additional reference
- `src/errors.ts` — `NaxError` for unknown-kind throws

**US-002:**
- `src/debate/resolvers.ts` — full file: `majorityResolver` (line 47), `synthesisResolver` (line 66), `judgeResolver` (line 87) — all four source functions to extract (majority covers two strategies)
- `src/debate/selectors/types.ts` — `Selector` contract (created by US-001)
- `src/debate/selectors/registry.ts` — registry to populate with all four selector kinds (created by US-001)
- `src/debate/session-helpers.ts:285-385` — current dispatch logic that calls each resolver function, including the `resolverConfig.agent` / `resolverConfig.model` resolution helpers used by synthesis and judge
- `src/debate/types.ts` — `RESOLVER_TYPES` enum and `ResolverConfig` interface
- `test/unit/debate/resolvers.test.ts` — existing tests; must stay green

**US-003:**
- `src/debate/session-helpers.ts:204-275` — extraction target: the dialogue-path branch (`if (reviewerSession && resolverContext)` block including `majorityVote` pre-computation, `diffContext` build, and `reviewerSession.resolveDebate()` / `reReviewDebate()` dispatch)
- `src/review/semantic-debate.ts:97-105` — force-override block to replace with explicit composition
- `src/review/semantic-debate.ts:245-290` — extraction target for `review-grounding-filter` verifier
- `src/review/dialogue.ts` — `ReviewerSession.resolveDebate()` and `reReviewDebate()` consumed by the new dialogue-verdict strategy
- `src/debate/selectors/types.ts` and `src/debate/verifiers/types.ts` — contracts (created by US-001)
- `src/debate/selectors/registry.ts` and `src/debate/verifiers/registry.ts` — registries (created by US-001)
- `src/debate/selectors/pick.ts` — `pickSelectorKind` lives here (this story creates it)
- `test/integration/review/review.test.ts` — existing tests; must stay green
- `test/unit/review/` — additional review unit tests
- `test/unit/debate/session-helpers.test.ts` — covers `resolveOutcome` dispatch behavior; must stay green

**US-004:**
- `src/debate/session-helpers.ts:183-385` — `resolveOutcome` to refactor into a thin dispatcher
- `src/debate/runner.ts:103-274` — `runPanelOneShot` where `resolveOutcome` is called
- `src/debate/runner-plan.ts` — separate dispatch path for plan; calls `resolveOutcome`
- `src/debate/runner-hybrid.ts` — hybrid mode dispatch; calls `resolveOutcome`
- `src/debate/runner-stateful.ts` — stateful mode dispatch
- `src/debate/selectors/registry.ts` and `src/debate/selectors/pick.ts` — `resolveSelector` and `pickSelectorKind` (created by US-001 + US-003)
- `src/debate/pre-phase/registry.ts` and `src/debate/verifiers/registry.ts` — for early-exit hooks (created by US-001)
- `test/unit/debate/runner-mode-routing.test.ts`, `test/unit/debate/runner-rounds-and-cost.test.ts`, `test/unit/debate/runner-plan.test.ts`, `test/unit/debate/runner-hybrid.test.ts`, `test/unit/debate/runner-stateful.test.ts` — existing tests; must stay green

**US-005:**
- `src/operations/plan.ts` — Pattern A (`model: (_input, ctx) => ctx.config.plan.model`) — the config-driven op shape `groundOp` should mirror exactly
- `src/operations/acceptance-generate.ts` — another Pattern A example using `ConfiguredModel` from a config slice
- `src/operations/types.ts` — `CompleteOperation` interface
- `src/config/schemas-model.ts` — `ConfiguredModelSchema` Zod validator to use for the new `grounder.model` field
- `src/config/schema-types.ts:31-36` — `ConfiguredModel` and `ConfiguredModelObject` type definitions
- `src/config/schemas-debate.ts` — `DebateConfigSchema` to extend with the top-level `grounder` block
- `src/config/schemas-infra.ts:11-31` — examples of `ConfiguredModelSchema` usage on existing config slices (`PlanConfigSchema.model`, `AcceptanceConfigSchema.model`, `AcceptanceFixConfigSchema.diagnoseModel/fixModel`)
- `src/agents/retry/index.ts` — `makeParseRetryStrategy` for op retry policy
- `src/prompts/builders/plan-builder.ts` — existing prompt builder pattern
- `src/errors.ts` — `NaxError` for parse failures
- `src/config/selectors.ts` — `debateConfigSelector` referenced by `groundOp`
- `src/debate/types.ts` — `DebateConfig` TypeScript type to extend with `GrounderConfig` field

## Acceptance Criteria

### US-001: Plug-point schema + contracts + registries

- `DebateStageConfigSchema.parse({})` produces an object where the new optional fields (`preDebatePhase`, `proposers`, `selector`, `postDebateVerifier`) are all `undefined` and existing fields (`enabled`, `resolver`, `sessionMode`, `rounds`, `mode`, `timeoutSeconds`, `autoPersona`) retain their current defaults
- `DebateStageConfigSchema.parse({ selector: { kind: "synthesis" } })` returns an object where `result.selector.kind === "synthesis"`
- `DebateStageConfigSchema.parse({ selector: { kind: "majority-fail-closed" } })`, `{ kind: "majority-fail-open" }`, `{ kind: "judge" }`, and `{ kind: "dialogue-verdict" }` each return an object where `result.selector.kind` matches the input
- `DebateStageConfigSchema.parse({ selector: { kind: "verifier-pick" } })` throws a `ZodError` in Phase 1 (Phase 2 extends the union to include this kind)
- `DebateStageConfigSchema.parse({ selector: { kind: "unknown-kind" } })` throws a `ZodError`
- `DebateStageConfigSchema.parse({ proposers: { citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 } })` returns the proposers object with all three fields preserved
- `DebateStageConfigSchema.parse({ preDebatePhase: { kind: "grounder" } })` returns an object where `preDebatePhase.kind === "grounder"` (no `agent` or `model` fields on the per-stage config — those live on `DebateConfig.grounder`)
- `DebateStageConfigSchema.parse({ preDebatePhase: { kind: "grounder", model: "balanced" } })` throws a `ZodError` because `model` is not a valid field on per-stage `preDebatePhase` (model lives on top-level `DebateConfig.grounder.model`)
- `DebateConfigSchema.parse({})` returns an object where `grounder.model === "fast"` and `grounder.timeoutSeconds === 300` (defaults applied)
- `DebateConfigSchema.parse({ grounder: { model: "balanced" } })` returns an object where `grounder.model === "balanced"` (tier string — `ConfiguredModel` union accepts `ModelTier`)
- `DebateConfigSchema.parse({ grounder: { model: { agent: "claude", model: "claude-opus-4-7" } } })` returns an object where `grounder.model.agent === "claude"` and `grounder.model.model === "claude-opus-4-7"` (`ConfiguredModelObject` form — `ConfiguredModel` union accepts `{ agent, model }`)
- `DebateConfigSchema.parse({ grounder: { timeoutSeconds: 600 } })` returns an object where `grounder.timeoutSeconds === 600` and `grounder.model === "fast"` (partial override; default applied to omitted field)
- `resolveSelector("any-string")` throws `NaxError` with code `"SELECTOR_UNKNOWN"` when no strategy is registered for that kind (US-001 ships the registry function with empty internal map; US-002 and US-003 populate it). When called with a registered kind, returns the strategy function value
- `resolvePreDebatePhase("any-string")` throws `NaxError` with code `"PRE_DEBATE_PHASE_UNKNOWN"` (Phase 1 ships an empty pre-phase registry; Phase 2 registers `grounder`)
- `resolvePostDebateVerifier("any-string")` throws `NaxError` with code `"POST_DEBATE_VERIFIER_UNKNOWN"` when no strategy is registered (US-003 registers `review-grounding-filter`; Phase 2 adds `plan-checklist`)
- `src/debate/pre-phase/types.ts` exports `PreDebatePhaseContext`, `PreDebatePhaseResult`, and `PreDebatePhase` type
- `src/debate/selectors/types.ts` exports `SelectorContext`, `SelectorResult`, and `Selector` type
- `src/debate/verifiers/types.ts` exports `PostDebateVerifierContext`, `PostDebateVerifierResult`, and `PostDebateVerifier` type

### US-002: Extract `synthesis`, `majority-fail-closed`, `majority-fail-open`, `judge` selector strategies

- `synthesisSelector` exported from `src/debate/selectors/synthesis.ts` accepts a `SelectorContext` and returns a `Promise<SelectorResult>` where `outcome === "passed"` when the synthesizer produces non-empty output
- `synthesisSelector(ctx)` calls `agentManager.completeAs` exactly once with the prompt produced by `DebatePromptBuilder.resolverSynthesisPrompt(ctx.proposals.map(p => p.output), ctx.critiques, ctx.debaters)`
- `synthesisSelector` returns `SelectorResult` where `resolverCostUsd` equals the cost reported by `agentManager.completeAs`
- `majorityFailClosedSelector` exported from `src/debate/selectors/majority.ts` returns `SelectorResult` where `outcome === "passed"` when `majorityResolver(proposalOutputs, false) === "passed"` and `outcome === "failed"` otherwise; `resolverCostUsd === 0` always
- `majorityFailOpenSelector` exported from `src/debate/selectors/majority.ts` returns `SelectorResult` where `outcome === "passed"` when `majorityResolver(proposalOutputs, true) === "passed"` and `outcome === "failed"` otherwise; `resolverCostUsd === 0` always
- `judgeSelector` exported from `src/debate/selectors/judge.ts` calls `agentManager.completeAs` exactly once using the agent name from `ctx.stageConfig.resolver.agent` (or `RESOLVER_FALLBACK_AGENT` when unset) with the prompt produced by `DebatePromptBuilder.resolverJudgePrompt(ctx.proposals.map(p => p.output), ctx.critiques, ctx.debaters)`
- After registry registration, `resolveSelector("synthesis")`, `resolveSelector("majority-fail-closed")`, `resolveSelector("majority-fail-open")`, and `resolveSelector("judge")` each return their respective strategy functions
- The compat wrappers at `src/debate/resolvers.ts::synthesisResolver`, `majorityResolver`, and `judgeResolver` continue to exist with their current signatures and their bodies delegate to the new strategies
- All existing tests in `test/unit/debate/resolvers.test.ts` pass unchanged

### US-003: Extract `dialogue-verdict` selector + `review-grounding-filter` verifier + `pickSelectorKind` dispatcher

- `dialogueVerdictSelector` exported from `src/debate/selectors/dialogue-verdict.ts` invokes `ctx.reviewerSession.resolveDebate(...)` when `ctx.resolverContextInput.isReReview === false`, with arguments derived from `ctx.resolverContextInput` exactly as `session-helpers.ts:252-260` does today
- `dialogueVerdictSelector` invokes `ctx.reviewerSession.reReviewDebate(...)` when `ctx.resolverContextInput.isReReview === true`, matching `session-helpers.ts:244-250`
- When `ctx.stageConfig.resolver.type === "majority-fail-closed"` or `"majority-fail-open"`, `dialogueVerdictSelector` pre-computes `majorityVote` (using `tryParseLLMJson` for each proposal exactly as `session-helpers.ts:213-221` does) and passes it as `debateCtx.majorityVote` to `resolveDebate` / `reReviewDebate`
- `dialogueVerdictSelector` returns `SelectorResult` where `outcome === "passed"` when `dialogueResult.checkResult.success === true` and `outcome === "failed"` otherwise; `resolverCostUsd === dialogueResult.cost ?? 0`
- When `ctx.reviewerSession` or `ctx.resolverContextInput` is undefined, `dialogueVerdictSelector` falls back to invoking the base selector indicated by `ctx.stageConfig.resolver.type` via `resolveSelector(...)` and returns its result directly (preserves today's "fall through to stateless" behavior)
- `pickSelectorKind(stageConfig, ctx)` exported from `src/debate/selectors/pick.ts` returns `stageConfig.selector.kind` when `stageConfig.selector` is defined
- `pickSelectorKind` returns `"dialogue-verdict"` when `stageConfig.selector` is undefined AND both `ctx.reviewerSession` and `ctx.resolverContextInput` are defined
- `pickSelectorKind` returns `"synthesis"` when `stageConfig.resolver.type === "synthesis"` and no auto-elevation applies
- `pickSelectorKind` returns `"majority-fail-closed"` when `stageConfig.resolver.type === "majority-fail-closed"` and no auto-elevation applies
- `pickSelectorKind` returns `"majority-fail-open"` when `stageConfig.resolver.type === "majority-fail-open"` and no auto-elevation applies
- `pickSelectorKind` returns `"judge"` when `stageConfig.resolver.type === "custom"` and no auto-elevation applies
- `reviewGroundingFilterVerifier` exported from `src/debate/verifiers/review-grounding-filter.ts` invokes `filterByAcGroundingMinimal(ctx.selectorResult.findings, ...)` and returns a `PostDebateVerifierResult` whose `findings` are the filtered subset
- `reviewGroundingFilterVerifier` returns `outcome === "failed"` when any filtered finding has severity that `isBlockingSeverity` returns true for (using the configured `blockingThreshold` from `ctx.stageConfig`); otherwise `outcome === "passed"`
- `semantic-debate.ts` no longer contains the force-override block at lines 97-105; instead, its `runSemanticDebate()` builds a `DebateStageConfig` with `selector: { kind: "dialogue-verdict" }` and `postDebateVerifier: { kind: "review-grounding-filter" }` before instantiating `DebateRunner`
- All tests in `test/integration/review/review.test.ts`, `test/unit/review/`, and `test/unit/debate/session-helpers.test.ts` pass unchanged

### US-004: Wire selector dispatch in main runner and `runner-plan.ts`

- `session-helpers.ts::resolveOutcome()` body delegates to `resolveSelector(pickSelectorKind(stageConfig, { reviewerSession, resolverContextInput }))(selectorContext)` and returns its result, replacing the inlined per-type if/else dispatch at lines 285-385
- The `try/catch` fallback that today wraps the dialogue path (`session-helpers.ts:268-274`) is preserved at the dispatcher level: when `dialogueVerdictSelector` throws, `resolveOutcome` logs a warning and re-dispatches via `pickSelectorKind` with `reviewerSession: undefined` to force the stateless path
- `DebateRunner.runPanelOneShot()` continues calling `resolveOutcome(...)` (now refactored) — its call site is unchanged; behavior is byte-equivalent
- When `stageConfig.preDebatePhase` is set, `runPanelOneShot()` invokes `resolvePreDebatePhase(stageConfig.preDebatePhase.kind)(preDebateCtx)` before the parallel proposer fan-out and pre-pends `result.manifestSection` to the proposer prompt's `taskContext`
- When `stageConfig.preDebatePhase` is undefined, `runPanelOneShot()` does not invoke any pre-phase strategy and the proposer prompt is byte-equivalent to current behavior
- When `stageConfig.postDebateVerifier` is set, `runPanelOneShot()` invokes `resolvePostDebateVerifier(stageConfig.postDebateVerifier.kind)(verifierCtx)` after the selector emits its result, and returns the verifier's outcome (overrides selector outcome) along with merged cost
- When `stageConfig.postDebateVerifier` is undefined, `runPanelOneShot()` does not invoke any post-verifier strategy and returns the selector's outcome directly
- `runner-plan.ts::runPlan()`, `runner-hybrid.ts`, and `runner-stateful.ts` all continue calling `resolveOutcome(...)` (refactored); behavior is byte-equivalent
- All tests in `test/unit/debate/runner-mode-routing.test.ts`, `test/unit/debate/runner-rounds-and-cost.test.ts`, `test/unit/debate/runner-plan.test.ts`, `test/unit/debate/runner-hybrid.test.ts`, `test/unit/debate/runner-stateful.test.ts`, and `test/unit/debate/session-helpers.test.ts` pass unchanged
- A new unit test `test/unit/debate/runner-plug-point-dispatch.test.ts` asserts that when `stageConfig.selector = { kind: "synthesis" }`, `pickSelectorKind` returns `"synthesis"` and `resolveSelector("synthesis")` is invoked exactly once per debate; that when `stageConfig.selector` is unset and `reviewerSession + resolverContextInput` are present, `pickSelectorKind` returns `"dialogue-verdict"`; and that when neither applies, `pickSelectorKind` falls back to `resolver.type` mapping

### US-005: Facts manifest schema + `groundOp` standalone

- `parseFactsManifest({ repoFacts: [], specClaims: [], gaps: [] })` returns `{ ok: true, manifest }` with all three arrays empty
- `parseFactsManifest({ repoFacts: [{ id: "F-001", kind: "file", evidence: "src/x.ts:1-5", summary: "..." }], specClaims: [], gaps: [] })` returns `{ ok: true }` with one fact in `manifest.repoFacts`
- `parseFactsManifest({ repoFacts: [{ id: "X-001", kind: "file", evidence: "src/x.ts:1-5", summary: "..." }], specClaims: [], gaps: [] })` returns `{ ok: false, error }` because `id` does not match `/^F-\d{3,}$/`
- `parseFactsManifest({ repoFacts: [{ id: "F-001", kind: "file", evidence: "", summary: "..." }], specClaims: [], gaps: [] })` returns `{ ok: false }` because `evidence` is empty
- `renderManifestSection(manifest)` returns a non-empty string that contains every `repoFact.id`, `specClaim.id`, and `gap.id` present in the manifest
- `groundOp.kind === "complete"` and `groundOp.name === "ground"`
- `groundOp` does NOT define a `model` field on its `GrounderInput` interface (model is config-driven, not input-driven)
- `groundOp.parse(validJsonString)` returns a `FactsManifest` when given valid JSON output; throws `NaxError` with code `"GROUNDER_PARSE_FAILED"` when given invalid JSON or schema-violating input
- `groundOp.model(input, ctx)` returns `ctx.config.grounder.model` for any `input` (model resolution is config-driven; input is ignored for model selection)
- When `ctx.config.grounder.model === "balanced"`, `groundOp.model(input, ctx) === "balanced"` (tier-string `ConfiguredModel` form passes through unchanged)
- When `ctx.config.grounder.model === { agent: "claude", model: "claude-opus-4-7" }`, `groundOp.model(input, ctx)` returns the same `{ agent, model }` object reference (object `ConfiguredModel` form passes through unchanged for `resolveConfiguredModel` to handle in `callOp`)
- `groundOp.timeoutMs(input, ctx) === ctx.config.grounder.timeoutSeconds * 1000`
- A new unit test `test/unit/operations/ground.test.ts` asserts that `groundOp` is a valid `CompleteOperation`, round-trips through `parse` for a representative fixture, and `model` / `timeoutMs` resolve from `ctx.config.grounder` correctly

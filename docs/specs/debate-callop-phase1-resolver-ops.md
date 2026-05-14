# SPEC: Debate callOp Migration — Phase 1 (Resolver Ops)

> Phase 1 of 2. Phase 2 spec: `docs/specs/debate-callop-phase2-runners-cleanup.md`.

## Summary

Convert the two single-turn LLM resolvers in `src/debate/selectors/` (judge, synthesis) from direct `agentManager.completeAs` calls to `callOp(judgeOp / synthesisOp, …)`. Thread a `callContext: CallContext` field through `SelectorContext` and `resolveOutcome` so selectors can dispatch through `callOp`. Removes 2 of 8 `ctx.config.models` reads in `src/debate/` ([selectors/judge.ts:37](src/debate/selectors/judge.ts#L37), [selectors/synthesis.ts:39](src/debate/selectors/synthesis.ts#L39)) and brings resolver dispatch under the audit/cost middleware. Stateful, hybrid, and plan runners are not touched — Phase 2 handles those. Delivered as three stories: US-001a (threading), US-001b (judge op), US-002 (synthesis op).

## Motivation

Today's resolvers each duplicate the tier-label → `ModelDef` resolution pattern with hand-rolled `DEFAULT_CONFIG.models` fallbacks ([judge.ts:36-43](src/debate/selectors/judge.ts#L36-L43), [synthesis.ts:38-45](src/debate/selectors/synthesis.ts#L38-L45)). The resolved `modelDef` is then passed to `agentManager.completeAs`, which bypasses the `callOp` audit/cost/retry middleware path that every other LLM call in nax uses. Issue #855 tracks the migration away from this escape-hatch pattern; Phase 1 executes the smallest, lowest-risk slice.

Resolver ops are the natural Phase 1 because:

- Single-turn dispatch — fits `CompleteOperation` exactly.
- No cross-debater coordination — no async barriers needed.
- Dynamic agent name (`stageConfig.resolver.agent ?? "synthesis"`) is already supported by `CompleteOperation.model: (input) => ({ agent, model })`.
- Threading `callContext` is required here anyway and unblocks Phase 2.

## Design

### Threading change

`SelectorContext` in [src/debate/selectors/types.ts](src/debate/selectors/types.ts) gains a required field:

```typescript
import type { CallContext } from "@/operations";

export interface SelectorContext {
  // … existing fields …
  readonly callContext: CallContext;
}
```

The `agentManager: IAgentManager` field is **retained** on `SelectorContext` — the `pick` and `majority` selectors still call `agentManager.completeAs` directly and are not touched in Phase 1.

`resolveOutcome()` in [src/debate/session-helpers.ts:186](src/debate/session-helpers.ts#L186) gains a `callContext: CallContext` parameter (positioned with the other context fields, not at the end — see signature below). It places this on the constructed `SelectorContext`.

Updated signature:

```typescript
export async function resolveOutcome(
  proposalOutputs: string[],
  critiqueOutputs: string[],
  stageConfig: DebateStageConfig,
  config: DebateConfig,
  callContext: CallContext,                    // ← new, required
  storyId: string,
  timeoutMs: number,
  workdir: string | undefined,
  featureName: string | undefined,
  reviewerSession: ReviewerSession | undefined,
  resolverContext: ResolverContext | undefined,
  promptSuffix: string | undefined,
  debaters: Debater[] | undefined,
  agentManager: IAgentManager,
): Promise<ResolveOutcome>
```

Four call sites pass `callContext`:

| Caller | Source of `CallContext` |
|:---|:---|
| [src/debate/runner.ts:287](src/debate/runner.ts#L287) | `this.ctx` (already a `CallContext`) |
| [src/debate/runner-stateful.ts:301](src/debate/runner-stateful.ts#L301) | `ctx.callContext` (new field on `StatefulCtx`) |
| [src/debate/runner-hybrid.ts:329](src/debate/runner-hybrid.ts#L329) | `ctx.callContext` (new field on `HybridCtx`) |
| [src/debate/runner-plan.ts:295](src/debate/runner-plan.ts#L295) | `ctx.callContext` (already exists on `PlanCtx`) |

`StatefulCtx` and `HybridCtx` each gain `readonly callContext: CallContext`. `toStatefulCtx()` in `runner.ts:335` is updated to include `callContext: this.ctx`. Hybrid mode uses the same conversion (runner.ts:75 calls `runHybrid(this.toStatefulCtx(), …)`).

### Judge op

```typescript
// src/operations/debate-judge.ts
export interface DebateJudgeInput {
  readonly proposals: string[];
  readonly critiques: string[];
  readonly debaters?: Debater[];
  readonly resolverAgent: string;       // from stageConfig.resolver.agent ?? "synthesis"
  readonly resolverModel: string;       // from stageConfig.resolver.model ?? "fast"
}

export const judgeOp: CompleteOperation<DebateJudgeInput, string, DebateConfig> = {
  kind: "complete",
  name: "debate-judge",
  stage: "review",
  jsonMode: false,
  config: debateConfigSelector,
  model: (input) => ({ agent: input.resolverAgent, model: input.resolverModel }),
  build(input, _ctx) {
    return DebatePromptBuilder.resolverJudgePrompt(input.proposals, input.critiques, input.debaters);
  },
  parse(output, _input, _ctx) {
    return output;
  },
};
```

`ctx.agentName` is overridden by the `{ agent, model }` pin — `callOp` still passes it to `resolveConfiguredModel` ([call.ts:114](src/operations/call.ts#L114)) but `resolved.agent` becomes `input.resolverAgent`. The op code itself does not read `ctx.agentName` directly.

### Synthesis op

Same shape as `judgeOp` with a different prompt builder call. Prompt text must be byte-identical to the current `selectors/synthesis.ts` output to avoid behavior drift.

### Selector rewrites

```typescript
// src/debate/selectors/judge.ts
export const judgeSelector: Selector = async (ctx: SelectorContext): Promise<SelectorResult> => {
  const result = await callOp(ctx.callContext, judgeOp, {
    proposals: ctx.proposals.map((p) => p.output),
    critiques: ctx.critiques,
    debaters: ctx.debaters,
    resolverAgent: ctx.stageConfig.resolver.agent ?? RESOLVER_FALLBACK_AGENT,
    resolverModel: ctx.stageConfig.resolver.model ?? "fast",
  });
  return {
    outcome: result.trim() ? "passed" : "failed",
    output: result,
    resolverCostUsd: 0,  // cost flows through AgentManager middleware, not the parse return
  };
};
```

The `resolverCostUsd` decision: under `callOp`, cost is tracked by the manager-tier audit middleware and emitted via `outcome.result.estimatedCostUsd` inside `callOp`. The op's `parse` returns only the string output. Cost rollup at the runner level reads from a separate channel — out of scope for this phase, tracked in Phase 2 (US-003 ACs). For Phase 1, returning `resolverCostUsd: 0` is acceptable because the runner sums `totalCostUsd` from proposers/grounder/resolver separately and the resolver cost is currently captured at the wrapped `completeAs` boundary; preserving that exact rollup requires Phase 2's coordinator refactor. The interim impact is that `DebateResult.totalCostUsd` for the judge/synthesis turn is under-reported until Phase 2 lands — flagged explicitly here so it surfaces in PR review.

The **session role** decision: current selectors set `sessionRole: "judge"` / `"synthesis"` in their `CompleteOptions`, which feeds `SessionManager.nameFor`. Under `callOp`, `sessionRole` is only forwarded when `ctx.sessionOverride?.role` is set ([call.ts:120](src/operations/call.ts#L120)); Phase 1 does not thread a session override, so the effective role reverts to the `CallContext` default. This changes session naming for resolver turns. The impact is cosmetic (log correlation, no functional regression) and is accepted as an interim regression alongside `resolverCostUsd: 0`. Full session-role parity is deferred to Phase 2. `.claude/rules/adapter-wiring.md` must be updated as part of this phase — see § Implementation notes below.

### Approach

This phase introduces no new `callOp` features and no new abstraction layer. It is a pure dispatch-path migration for two existing selectors plus the threading change that unblocks Phase 2.

## Stories

### US-001a: `callContext` threading

Thread `callContext: CallContext` through `SelectorContext`, `resolveOutcome`, `StatefulCtx`, `HybridCtx`, and `toStatefulCtx()`. Update all 4 `resolveOutcome` call sites to pass their `CallContext`. Update `adapter-wiring.md` session role registry (move `synthesis`, `judge` from `agentManager.completeAs` row to `callOp` complete-kind row; update sanctioned-consumers prose to note #855 Phase 1 landing).

#### Context Files
- [src/debate/selectors/types.ts](src/debate/selectors/types.ts) — `SelectorContext`
- [src/debate/session-helpers.ts:186-305](src/debate/session-helpers.ts#L186-L305) — `resolveOutcome`
- [src/debate/runner.ts:287](src/debate/runner.ts#L287), [src/debate/runner-stateful.ts:301](src/debate/runner-stateful.ts#L301), [src/debate/runner-hybrid.ts:329](src/debate/runner-hybrid.ts#L329), [src/debate/runner-plan.ts:295](src/debate/runner-plan.ts#L295) — `resolveOutcome` call sites
- [src/debate/runner-stateful.ts:30](src/debate/runner-stateful.ts#L30) — `StatefulCtx`
- [src/debate/runner-hybrid.ts:36](src/debate/runner-hybrid.ts#L36) — `HybridCtx`
- [src/debate/runner.ts:335](src/debate/runner.ts#L335) — `toStatefulCtx()`
- [.claude/rules/adapter-wiring.md](.claude/rules/adapter-wiring.md) — session role registry to update

### US-001b: Judge resolver as CompleteOperation

Define `judgeOp` in `src/operations/debate-judge.ts`. Rewrite `judgeSelector` to call `callOp(ctx.callContext, judgeOp, …)`. Depends on US-001a (uses the threading change).

#### Context Files
- [src/operations/debate-propose.ts](src/operations/debate-propose.ts) — sibling debate `CompleteOperation` (model resolver shape, prompt builder usage)
- [src/operations/ground.ts](src/operations/ground.ts) — sibling debate op (selector wiring)
- [src/operations/call.ts:101-178](src/operations/call.ts#L101-L178) — `callOp` complete-kind path
- [src/debate/selectors/judge.ts](src/debate/selectors/judge.ts) — current implementation
- [src/prompts/builders/debate-builder.ts](src/prompts/builders/debate-builder.ts) — `DebatePromptBuilder.resolverJudgePrompt` (confirm method signature)
- US-001a threading in `SelectorContext` / `resolveOutcome`

### US-002: Synthesis resolver as CompleteOperation

Identical shape to US-001b for `synthesisSelector` → `synthesisOp` in `src/operations/debate-synthesis.ts`. Depends on US-001a and US-001b.

#### Context Files
- [src/debate/selectors/synthesis.ts](src/debate/selectors/synthesis.ts) — current implementation
- [src/operations/debate-judge.ts](src/operations/debate-judge.ts) — created in US-001b (reference shape)
- [src/prompts/builders/debate-builder.ts](src/prompts/builders/debate-builder.ts) — `DebatePromptBuilder.resolverSynthesisPrompt`
- US-001a threading in `SelectorContext` / `resolveOutcome`

### Dependencies

```
US-001a (callContext threading + adapter-wiring.md update)   — no dependencies
US-001b (judge op + selector rewrite)                        — depends on US-001a
US-002  (synthesis op + selector rewrite)                    — depends on US-001a, US-001b
```

## Acceptance Criteria

### US-001a: `callContext` threading

- `SelectorContext` in `src/debate/selectors/types.ts` declares a `readonly callContext: CallContext` field
- `resolveOutcome()` in `src/debate/session-helpers.ts` accepts a `callContext: CallContext` parameter and places it on the `SelectorContext` it constructs
- `StatefulCtx` in `src/debate/runner-stateful.ts` declares a `readonly callContext: CallContext` field
- `HybridCtx` in `src/debate/runner-hybrid.ts` declares a `readonly callContext: CallContext` field
- `DebateRunner.toStatefulCtx()` in `src/debate/runner.ts` includes `callContext: this.ctx` in its return object
- `src/debate/runner.ts:287`, `src/debate/runner-stateful.ts:301`, `src/debate/runner-hybrid.ts:329`, `src/debate/runner-plan.ts:295` each pass `callContext` to `resolveOutcome`
- `.claude/rules/adapter-wiring.md` session role registry: `synthesis` and `judge` are moved from the `agentManager.completeAs` row to the `callOp` complete-kind row
- `.claude/rules/adapter-wiring.md` sanctioned-consumers prose updated to reflect #855 Phase 1 landing

### US-001b: Judge resolver as CompleteOperation

- `judgeOp` is exported from `src/operations/index.ts` with `kind: "complete"`, `name: "debate-judge"`, `stage: "review"`, `config: debateConfigSelector`
- `judgeOp.model(input)` returns `{ agent: input.resolverAgent, model: input.resolverModel }` when both fields are non-empty strings
- `judgeOp.build(input, _ctx)` returns the same prompt text as `DebatePromptBuilder.resolverJudgePrompt(input.proposals, input.critiques, input.debaters)`
- `judgeOp.parse(output, _input, _ctx)` returns the `output` string unchanged
- `judgeSelector(ctx)` calls `callOp(ctx.callContext, judgeOp, …)` exactly once per invocation
- `judgeSelector(ctx)` returns `SelectorResult { outcome: "passed", output, resolverCostUsd: 0 }` when the op result is a non-empty trimmed string
- `judgeSelector(ctx)` returns `SelectorResult { outcome: "failed", output, resolverCostUsd: 0 }` when the op result is empty or whitespace-only
- `src/debate/selectors/judge.ts` contains no references to `resolveConfiguredModel`, `resolveDefaultAgent`, `DEFAULT_CONFIG.models`, or `ctx.config.models`
- `src/debate/selectors/judge.ts` does not call `completeAs` directly

### US-002: Synthesis resolver as CompleteOperation

- `synthesisOp` is exported from `src/operations/index.ts` with `kind: "complete"`, `name: "debate-synthesis"`, `stage: "review"`, `config: debateConfigSelector`
- `synthesisOp.model(input)` returns `{ agent: input.resolverAgent, model: input.resolverModel }`
- `synthesisOp.build(input, _ctx)` returns the same prompt text the current `synthesisSelector` builds
- `synthesisSelector(ctx)` calls `callOp(ctx.callContext, synthesisOp, …)` exactly once per invocation
- `synthesisSelector(ctx)` returns `SelectorResult { outcome: "passed", output, resolverCostUsd: 0 }` when the op result is a non-empty trimmed string
- `synthesisSelector(ctx)` returns `SelectorResult { outcome: "failed", output, resolverCostUsd: 0 }` when the op result is empty or whitespace-only
- `src/debate/selectors/synthesis.ts` contains no references to `resolveConfiguredModel`, `resolveDefaultAgent`, `DEFAULT_CONFIG.models`, or `ctx.config.models`
- `src/debate/selectors/synthesis.ts` does not call `completeAs` directly

## Failure Handling

- **Op-level adapter failures** — handled by `defaultRetryStrategy` at the manager tier (rate-limit only retries). No op-tier `retry` strategy needed; resolvers are single-shot.
- **`callOp` parse path** — `parse` returns the raw string and cannot fail. No `op.retry` or `op.recover` needed.
- **Resolver returns empty output** — `outcome: "failed"`, `resolverCostUsd: 0`. Differs from current behavior ([judge.ts:75](src/debate/selectors/judge.ts#L75) / [synthesis.ts:78](src/debate/selectors/synthesis.ts#L78)) where the actual cost is returned — accepted as part of the interim `resolverCostUsd: 0` regression acknowledged in Design.
- **Caller did not pass `callContext`** — type system rejects at compile time (field is required). No runtime fallback path needed.

## Out of Scope

- Stateful, hybrid, and plan runner dispatch conversion — Phase 2.
- `verifier-pick.ts` patch-step session continuity — Phase 2.
- Deleting `resolveDebaterModel`, `resolveModelDefForDebater`, `runComplete` from `session-helpers.ts` — Phase 2.
- Slimming `debateConfigSelector` from `pickSelector("debate", "debate", "models", "agent")` to `pickSelector("debate", "debate", "agent")` — Phase 2.
- AgentManager owning model resolution (a separate broader SSOT effort).
- Cost accounting parity for `resolverCostUsd` — interim under-reporting acknowledged in Design; full rollup deferred to Phase 2's coordinator refactor.

## Implementation notes

**US-001a must update `.claude/rules/adapter-wiring.md`** before any other story ships. The session role registry at [adapter-wiring.md:45](/.claude/rules/adapter-wiring.md#L45) currently lists `synthesis` and `judge` under `agentManager.completeAs`. After Phase 1, they dispatch through `callOp`. Required table update:

| Before | After |
|:---|:---|
| `\| synthesis, judge \| agentManager.completeAs \|` | Move both roles to the `callOp` complete-kind row |

Also update the sanctioned-consumers prose: remove the `src/debate/` carve-out for resolvers (fan-out remains; resolvers no longer qualify) and note #855 Phase 1 has landed.

## Notes

- Tests for new ops use the existing `fakeAgentManager` helper (`test/helpers/fake-agent-manager.ts`) per `.claude/rules/forbidden-patterns.md`.
- Every new `logger.*` call must place `storyId` as the first key in the data object per `.claude/rules/project-conventions.md`.
- Both op files target ~50–80 lines, well under the 600-line limit.
- After this phase, the remaining 6 `config.models` reads in `src/debate/` and the `agentManager.completeAs` / `runAsSession` usages in stateful/hybrid/plan/verifier-pick all remain. Phase 2 handles them.

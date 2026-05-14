# SPEC: Debate callOp Migration — Phase 2 (Runners + Cleanup)

> Phase 2 of 2. Depends on Phase 1 (`docs/specs/debate-callop-phase1-resolver-ops.md`) being merged. Phase 1 adds the `SelectorContext.callContext` threading that this phase consumes; without it, the coordinator refactors cannot dispatch via `callOp`.

## Summary

Convert the three stateful debate runners (`runStateful`, `runHybrid`, `runPlan`) to coordinator-over-`callOp` shape using `RunOperation.hopBody` for multi-turn-per-debater sessions. Migrate `verifier-pick.ts` patch-step session continuity via a coordinator-signaled `hopBody` (Option A from planning — preserves working-memory semantics). Delete `resolveDebaterModel`, `resolveModelDefForDebater`, and `runComplete` from `src/debate/session-helpers.ts`. Drop `"models"` from `debateConfigSelector` ([src/config/selectors.ts:44](src/config/selectors.ts#L44)) — final shape `pickSelector("debate", "debate", "agent")`. After this phase, all 8 `ctx.config.models` reads in `src/debate/` are gone, every dispatch goes through `callOp`, and `DebateConfig` is a two-key slice.

## Motivation

Phase 1 handled the single-turn resolvers. Phase 2 handles everything else:

- **Six remaining `ctx.config.models` readers** (Phase 1 removed 2). Each duplicates tier-label → `ModelDef` resolution; each can be deleted once dispatch goes through `callOp`.
- **Three runner files holding direct `sessionManager.openSession` + `agentManager.runAsSession` calls.** This is the Layer-3/2 escape hatch sanctioned only as a stopgap by `.claude/rules/adapter-wiring.md` Rule 3. Issue #855 tracks its removal.
- **`session-helpers.ts` carries three model-resolution functions** (`resolveDebaterModel`, `resolveModelDefForDebater`, `runComplete`) that exist solely to wrap the escape hatch.
- **`debateConfigSelector` still includes `"models"`** purely to satisfy `DebateConfig.models` readers in those three helpers — once they go, the slice can shrink.

## Design

### Coordinator-over-hopBody pattern

`RunOperation.hopBody` runs inside a single session opened by `callOp` ([build-hop-callback.ts:214-282](src/operations/build-hop-callback.ts#L214-L282)). The session opens before `hopBody` runs and closes in `finally` when the body returns or throws. Between `ctx.send(...)` turns, the body can `await` arbitrary promises (including cross-debater barriers) and the session stays warm.

The migration shape for stateful/hybrid/plan debate:

- **Runner = coordinator.** Owns the N parallel barriers; launches N parallel `callOp(callContext, debaterOp, …)` invocations; aggregates outputs and costs.
- **Op = per-debater state machine.** Each debater's `hopBody` does: send propose → resolve `proposalBarriers[i]` → `await Promise.all(proposalBarriers)` → send rebut. Stays inside one session for both turns.

Cross-debater coordination uses `Promise.withResolvers<string>()` per debater per round, shared via the op's `input`. Failure discipline: every barrier `await` is raced against `runtime.signal` rejection, so a single debater failure cannot deadlock peers.

```typescript
// Standard barrier-await pattern used by every coordinator hopBody await
const signalReject = new Promise<never>((_, rej) => {
  runtime.signal.addEventListener(
    "abort",
    () => rej(new NaxError(`[debate] aborted`, "CALL_OP_ABORTED", { storyId })),
    { once: true },
  );
});
const peers = await Promise.race([Promise.all(proposalBarriers.map((b) => b.promise)), signalReject]);
```

### Single-session, multi-turn semantics

`callOp`'s session lifecycle for a `RunOperation` with `hopBody`:

```
buildHopCallback → sessionManager.openSession(...)
  → ctx.send(promptA)  ← turn 1 in this session
  → await peerBarrier  ← session stays open
  → ctx.send(promptB)  ← turn 2 in same session (agent remembers turn 1)
  → return
finally → sessionManager.closeSession(handle)
```

This preserves the working-memory semantics that current stateful debate relies on — each debater sees their own prior turns when generating round 1.

### Stateful op shape

```typescript
// src/operations/debate-stateful.ts
export interface DebateStatefulInput {
  readonly debater: Debater;
  readonly index: number;
  readonly proposePrompt: string;
  readonly buildRebutPrompt: (peerProposals: string[]) => string;
  readonly proposalBarriers: PromiseWithResolvers<string>[];
  readonly signal: AbortSignal;
  readonly storyId: string;
}

export const statefulDebaterOp: RunOperation<DebateStatefulInput, DebateStatefulOutput, DebateConfig> = {
  kind: "run",
  name: "debate-stateful",
  stage: "review",
  session: { role: "debate-stateful" satisfies SessionRole, lifetime: "fresh" },
  config: debateConfigSelector,
  model: (input) => ({ agent: input.debater.agent, model: input.debater.model ?? "fast" }),
  hopBody: async (initial, ctx) => {
    const proposal = await ctx.send(initial);
    ctx.input.proposalBarriers[ctx.input.index].resolve(proposal.output);
    const peers = await raceAgainstAbort(
      Promise.all(ctx.input.proposalBarriers.map((b) => b.promise)),
      ctx.input.signal,
      ctx.input.storyId,
    );
    const rebut = await ctx.send(ctx.input.buildRebutPrompt(peers));
    return rebut;
  },
  build(input, _ctx) {
    return { role: { id: "role", content: "", overridable: false }, task: { id: "task", content: input.proposePrompt, overridable: false } };
  },
  parse(output, _input, _ctx) {
    return { proposal: "", rebut: output };  // shape TBD by US-003 — see ACs
  },
};
```

Note: `parse` receives only the final turn's output (per `callOp` semantics). The proposal text from round 0 must be captured separately — either by resolving it into the barrier and reading it back from the runner, or by extending the op output to include both via `hopBody` returning a synthesised value. US-003's ACs pin the precise shape.

### Hybrid op shape

`hybridDebaterOp` differs from `statefulDebaterOp` only in the rebut-round semantics: hybrid debate runs N rounds of rebuttals with per-round barriers, rather than a single rebut turn. The `hopBody` loop:

```typescript
for (let round = 1; round <= rounds; round++) {
  const peerRebuts = await raceAgainstAbort(/* peer barrier for this round */);
  const myRebut = await ctx.send(input.buildRebutPrompt(round, peerRebuts));
  input.rebutBarriers[round][input.index].resolve(myRebut.output);
}
```

### Plan op + verifier-pick signal

`planDebaterOp` extends the stateful pattern with a `selectionSignal: Promise<{ patchPrompt?: string }>` input. After the rebut turn the body awaits the signal. The coordinator (runner) resolves all signals after scoring: one with `{ patchPrompt }` for the winner, `{}` for losers. When `patchPrompt` is a non-empty string, the winner's `hopBody` sends one more turn (the patch turn) inside its still-open session — preserving the working memory of propose + rebut. When `patchPrompt` is undefined, the body returns immediately.

```typescript
// inside planDebaterOp.hopBody, after the rebut turn:
const decision = await raceAgainstAbort(input.selectionSignal, input.signal, input.storyId);
if (decision.patchPrompt) {
  const patched = await ctx.send(decision.patchPrompt);
  return patched;
}
return rebutResult;
```

[verifier-pick.ts:127-148](src/debate/selectors/verifier-pick.ts#L127-L148) `runPatchStep` is reduced to: build the patch prompt from `winner.proposal.output` + deltas, return it to the coordinator. The coordinator resolves the winner's signal with that prompt. The `handle?: SessionHandle` field on `SuccessfulProposal` is no longer needed and is removed.

### Cost rollup

`callOp` returns `outcome.result.estimatedCostUsd` from the `AgentManager.runWithFallback` envelope. The coordinator sums these across all parallel `callOp` invocations to populate `DebateResult.totalCostUsd`. This replaces the current hand-rolled `totalCostUsd += turnResult.estimatedCostUsd` in [runner-stateful.ts:55-63](src/debate/runner-stateful.ts#L55-L63) etc. Phase 1's interim under-reporting of resolver cost (US-001/US-002) is fully resolved here because the resolver `callOp` invocations also surface cost via the same channel — the coordinator sums all four sources: proposers, rebutters, resolver (judge/synthesis), and (when applicable) verifier-pick patch turn.

### Selector slim

Final selector ([src/config/selectors.ts:44](src/config/selectors.ts#L44)):

```typescript
// Before Phase 2
export const debateConfigSelector = pickSelector("debate", "debate", "models", "agent");

// After Phase 2
export const debateConfigSelector = pickSelector("debate", "debate", "agent");
```

`DebateConfig` shape becomes `{ debate: NaxConfig["debate"]; agent: NaxConfig["agent"] }`. No source consumer reads `.models` off this type after Phase 2.

### Session roles

`statefulDebaterOp`, `hybridDebaterOp`, `planDebaterOp` use role strings matching the existing template-literal pattern `` `debate-${string}` `` ([adapter-wiring.md](.claude/rules/adapter-wiring.md) session-role registry). Specifically: `"debate-stateful"`, `"debate-hybrid"`, `"debate-plan"`. These slot into the `agentManager.runAsSession` row of the registry, which is where they end up dispatched anyway (one layer down from `callOp`'s run-kind path).

### Failure handling

- **Single debater throws inside `hopBody`** — `buildHopCallback`'s catch path returns an `AdapterFailure`; coordinator's `Promise.allSettled` treats it as a missing slot (matches current behavior in [runner.ts:185-187](src/debate/runner.ts#L185-L187)).
- **Coordinator-level abort (`runtime.signal`)** — every barrier `await` uses `raceAgainstAbort(promise, signal, storyId)`; signal rejection propagates `NaxError("CALL_OP_ABORTED")` through `hopBody` and `callOp`'s try/catch closes the session in `finally`.
- **One debater fails before resolving its barrier** — peers' `Promise.all(proposalBarriers)` never resolves. Coordinator must reject all unresolved barriers when any `callOp` throws. Implementation: wrap the per-debater `callOp` in `.catch((err) => { proposalBarriers.forEach((b, i) => i !== myIndex && b.reject(err)); throw err; })`. This is explicit in US-003 ACs.
- **Verifier-pick patch turn fails** — winner's `hopBody` throws on the third `ctx.send`; coordinator treats it as no-patch-applied and returns the pre-patch winner output (no behavior regression vs. today's `try/catch` at [verifier-pick.ts:167-170](src/debate/selectors/verifier-pick.ts#L167-L170)).
- **No debater throws but `callOp` returns a failed `AdapterFailure`** — coordinator records the failure on the proposal slot; `Promise.allSettled` collects results; downstream logic treats failed slots the same as throws.

### Approach

No new `callOp` features. No new abstraction layer. Coordinator orchestration stays in `src/debate/runner-*.ts`; per-debater session lifetime moves into the new `*DebaterOp.hopBody`. `verifier-pick.ts` becomes prompt-shaping only — no dispatch. Helpers in `session-helpers.ts` that exist to wrap the Layer-3 escape hatch are deleted in the same PR as the runner conversion so the migration is atomic.

## Stories

### US-003: Stateful debater op

Define `statefulDebaterOp` in `src/operations/debate-stateful.ts`. Rewrite `runStateful` in `src/debate/runner-stateful.ts` as a coordinator: build per-debater inputs (including shared barriers and an abort-signal-rejection helper), launch N parallel `callOp(ctx.callContext, statefulDebaterOp, …)` invocations bounded by `maxConcurrentDebaters` (read from `ctx.callContext.runtime.configLoader.current().debate?.maxConcurrentDebaters`, not from the slice), aggregate proposals + rebuttals + cost. Delete `runStateful`'s direct `sessionManager.openSession` and `agentManager.runAsSession` calls. Delete `resolveModelDefForDebater` import from this file.

#### Context Files
- [src/debate/runner-stateful.ts](src/debate/runner-stateful.ts) — current coordinator (becomes the new coordinator after refactor)
- [src/operations/types.ts:145-184](src/operations/types.ts#L145-L184) — `HopBody` / `HopBodyContext` semantics
- [src/operations/build-hop-callback.ts:170-282](src/operations/build-hop-callback.ts#L170-L282) — session lifecycle, `send` closure
- [src/debate/concurrency.ts](src/debate/concurrency.ts) — `allSettledBounded` for bounded fan-out
- [src/debate/runner.ts:169-275](src/debate/runner.ts#L169-L275) — `runPanelOneShot` as a reference for coordinator shape (it already uses `callOp` for proposers/rebutters)
- [.claude/rules/retry-strategy.md](.claude/rules/retry-strategy.md) — `op.retry` + `op.hopBody` composition (this op uses `hopBody` only)
- [.claude/rules/forbidden-patterns.md](.claude/rules/forbidden-patterns.md) — `mock.module()` banned; use `fakeAgentManager` for tests

### US-004: Hybrid debater op

Define `hybridDebaterOp` in `src/operations/debate-hybrid.ts`. Same shape as `statefulDebaterOp` with an N-round rebuttal loop in `hopBody`. Rewrite `runHybrid` in `src/debate/runner-hybrid.ts` as a coordinator. Delete this file's direct `sessionManager.openSession` / `agentManager.runAsSession` / `resolveModelDefForDebater` references. Depends on US-003 (reuses the barrier-and-abort utilities introduced there).

#### Context Files
- [src/debate/runner-hybrid.ts](src/debate/runner-hybrid.ts) — current coordinator
- [src/operations/debate-stateful.ts](src/operations/debate-stateful.ts) — created in US-003
- US-003's coordinator pattern in `runner-stateful.ts`

### US-005: Plan debater op + verifier-pick patch via signal

Define `planDebaterOp` in `src/operations/debate-plan.ts` covering the plan-mode multi-round flow. Extend its `hopBody` input with `selectionSignal: Promise<{ patchPrompt?: string }>`; after the rebut turn await the signal and, when `patchPrompt` is non-empty, send one more turn. Rewrite `runPlan` in `src/debate/runner-plan.ts` and the helpers in `src/debate/runner-plan-helpers.ts` as a coordinator that constructs N `selectionSignal` promises, launches N parallel `callOp(ctx.callContext, planDebaterOp, …)` invocations, runs scoring after rebuttals settle, resolves the winner's signal with `{ patchPrompt }` when patch is enabled and runner-up overlap < threshold, resolves losers' signals with `{}`. Rewrite `runPatchStep` in [verifier-pick.ts:127-148](src/debate/selectors/verifier-pick.ts#L127-L148) to build the patch prompt and return it to the coordinator (or fold it into the coordinator inline). Remove the `handle?: SessionHandle` field from `SuccessfulProposal` and the `VERIFIER_PICK_NO_HANDLE` throw path. Depends on US-003.

#### Context Files
- [src/debate/runner-plan.ts](src/debate/runner-plan.ts) — current coordinator
- [src/debate/runner-plan-helpers.ts](src/debate/runner-plan-helpers.ts) — current helper functions
- [src/debate/selectors/verifier-pick.ts](src/debate/selectors/verifier-pick.ts) — patch-step continuation
- [src/operations/debate-stateful.ts](src/operations/debate-stateful.ts) — created in US-003 (signal pattern extends from this)

### US-006: Delete legacy helpers and slim selector

Depends on US-003, US-004, US-005 all landing. Delete `resolveDebaterModel` (lines 100-110), `resolveModelDefForDebater` (lines 165-183), and `runComplete` (lines 139-151) from [src/debate/session-helpers.ts](src/debate/session-helpers.ts). Delete unused imports (`resolveConfiguredModel`, `resolveModelForAgent`, `ModelsConfig`, `ModelDef`, `DEFAULT_CONFIG` if no other reader). Delete the `resolveDebaterModel` test block from [test/unit/debate/runner-events.test.ts](test/unit/debate/runner-events.test.ts). Change [src/config/selectors.ts:44](src/config/selectors.ts#L44) from `pickSelector("debate", "debate", "models", "agent")` to `pickSelector("debate", "debate", "agent")`. Update any tests that build a `DebateConfig` literal to drop the `models` field.

#### Context Files
- [src/debate/session-helpers.ts](src/debate/session-helpers.ts)
- [src/config/selectors.ts](src/config/selectors.ts)
- [test/unit/debate/runner-events.test.ts](test/unit/debate/runner-events.test.ts)
- [src/debate/index.ts](src/debate/index.ts) — barrel export to update

### Dependencies

```
US-003 (stateful op)            — no in-phase dependencies
US-004 (hybrid op)              — depends on US-003
US-005 (plan op + verifier)     — depends on US-003
US-006 (cleanup + slim)         — depends on US-003, US-004, US-005
```

US-004 and US-005 can run in parallel after US-003. US-006 must run last.

## Acceptance Criteria

### US-003: Stateful debater op

- `statefulDebaterOp` is exported from `src/operations/index.ts` with `kind: "run"`, `name: "debate-stateful"`, `stage: "review"`, `session: { role: "debate-stateful", lifetime: "fresh" }`, `config: debateConfigSelector`
- `statefulDebaterOp.model(input)` returns `{ agent: input.debater.agent, model: input.debater.model ?? "fast" }`
- `statefulDebaterOp.hopBody(initial, ctx)` calls `ctx.send` exactly twice in the round-0 + round-1 success path: once with `initial` (the propose prompt), once with the rebut prompt built from peer proposals
- `statefulDebaterOp.hopBody` resolves `ctx.input.proposalBarriers[ctx.input.index]` with the round-0 `TurnResult.output` before awaiting peer barriers
- `statefulDebaterOp.hopBody` awaits `Promise.all(proposalBarriers.map(b => b.promise))` raced against `runtime.signal` abort; when `runtime.signal.aborted === true`, it throws `NaxError` with code `CALL_OP_ABORTED` and does not send round 1
- `statefulDebaterOp.parse(output, input, _ctx)` returns an object containing the rebut output as `rebut` and the captured round-0 proposal as `proposal` (sourced either from a hopBody-synthesised return value or from the resolved barrier — implementer's choice, but both fields must be populated)
- `runStateful(ctx, prompt)` launches `N` parallel `callOp(ctx.callContext, statefulDebaterOp, …)` invocations where `N = resolvedDebaters.length`
- `runStateful(ctx, prompt)` bounds concurrent execution by `ctx.callContext.runtime.configLoader.current().debate?.maxConcurrentDebaters ?? 2` (read from full config, not the slice)
- When any single `callOp` invocation throws, `runStateful` rejects all peer `proposalBarriers` that have not yet resolved (preventing peer deadlock)
- `runStateful(ctx, prompt)` returns a `DebateResult` whose `proposals`, `rebuttals`, `debaters`, `outcome`, and `totalCostUsd` fields match the shape produced by the pre-refactor implementation for the same inputs (snapshot or property-based test)
- `src/debate/runner-stateful.ts` contains no references to `sessionManager.openSession`, `sessionManager.closeSession`, `agentManager.runAsSession`, `resolveModelDefForDebater`, or `ctx.config.models`
- `StatefulCtx` interface no longer references `DebateConfig.models` directly or transitively

### US-004: Hybrid debater op

- `hybridDebaterOp` is exported from `src/operations/index.ts` with `kind: "run"`, `name: "debate-hybrid"`, `stage: "review"`, `session: { role: "debate-hybrid", lifetime: "fresh" }`, `config: debateConfigSelector`
- `hybridDebaterOp.hopBody` performs the N-round rebuttal loop with one `ctx.send` per round and a per-round peer-barrier `await` between rounds
- `hybridDebaterOp.hopBody` resolves the current round's barrier with each turn's output before awaiting the next round's peer barriers
- `runHybrid(ctx, prompt)` launches `N` parallel `callOp(ctx.callContext, hybridDebaterOp, …)` invocations
- When any single `callOp` invocation throws, `runHybrid` rejects all unresolved peer barriers across all rounds
- `runHybrid(ctx, prompt)` returns a `DebateResult` whose shape matches the pre-refactor implementation
- `src/debate/runner-hybrid.ts` contains no references to `sessionManager.openSession`, `sessionManager.closeSession`, `agentManager.runAsSession`, `resolveModelDefForDebater`, or `ctx.config.models`

### US-005: Plan debater op + verifier-pick patch via signal

- `planDebaterOp` is exported from `src/operations/index.ts` with `kind: "run"`, `name: "debate-plan"`, `stage: "plan"`, `session: { role: "debate-plan", lifetime: "fresh" }`, `config: debateConfigSelector`
- `planDebaterOp.hopBody` accepts `selectionSignal: Promise<{ patchPrompt?: string }>` on `input`
- After sending the rebut turn, `planDebaterOp.hopBody` awaits `selectionSignal` raced against `runtime.signal` abort
- When `selectionSignal` resolves with `{ patchPrompt }` where `patchPrompt` is a non-empty string, `planDebaterOp.hopBody` calls `ctx.send(patchPrompt)` exactly once and returns that turn's `TurnResult`
- When `selectionSignal` resolves with `{}` or `{ patchPrompt: undefined }`, `planDebaterOp.hopBody` returns the rebut `TurnResult` without an extra send
- `runPlan(ctx, taskContext, outputFormat, opts)` constructs N `PromiseWithResolvers<{ patchPrompt?: string }>` and launches N parallel `callOp(ctx.callContext, planDebaterOp, …)` invocations
- After all `callOp` invocations resolve their proposal+rebut output, `runPlan` runs scoring (delegating to the existing `verifier-pick` scoring helpers) and:
  - When patch is enabled in `stageConfig.selector` (kind `"verifier-pick"`) and runner-up overlap < `overlapThreshold`, resolves the winner's signal with `{ patchPrompt }` and losers' signals with `{}`
  - When patch is disabled or overlap >= threshold, resolves all signals with `{}`
- `runPatchStep` in `verifier-pick.ts` does not call `agentManager.runAsSession`
- `SuccessfulProposal` interface in `src/debate/session-helpers.ts` no longer declares a `handle` field
- `verifier-pick.ts` does not throw `NaxError` with code `VERIFIER_PICK_NO_HANDLE`
- `src/debate/runner-plan.ts` and `src/debate/runner-plan-helpers.ts` contain no references to `sessionManager.openSession`, `sessionManager.closeSession`, `agentManager.runAsSession`, `resolveModelDefForDebater`, or `ctx.config.models`

### US-006: Delete legacy helpers and slim selector

- `src/debate/session-helpers.ts` no longer exports `resolveDebaterModel`
- `src/debate/session-helpers.ts` no longer exports `resolveModelDefForDebater`
- `src/debate/session-helpers.ts` no longer exports `runComplete`
- `src/debate/session-helpers.ts` does not import `resolveConfiguredModel` or `resolveModelForAgent`
- `src/debate/session-helpers.ts` contains no references to `ModelsConfig` or `ModelDef` types
- `src/debate/index.ts` no longer re-exports the deleted symbols
- `debateConfigSelector` in `src/config/selectors.ts` equals `pickSelector("debate", "debate", "agent")` (no `"models"` argument)
- `DebateConfig` derived type has exactly the keys `"debate" | "agent"` (verified at compile time via a type-assertion test)
- No file under `src/debate/` references `config.models`, `ctx.config.models`, or `DebateConfig["models"]`
- Test fixtures and helpers that previously constructed a `DebateConfig` literal with a `models` field are updated to drop that field
- `bun run typecheck` exits 0 across the repo
- Targeted test command `timeout 60 bun test test/unit/debate/ --timeout=15000` exits 0

## Failure Handling

- **Op-level adapter failures** — handled by `defaultRetryStrategy` at the manager tier (rate-limit only). No op-tier `retry` strategy needed; coordinator deadline + abort signal already bound the work.
- **Single debater throws inside `hopBody`** — coordinator catches via `Promise.allSettled` and rejects all peer barriers; `DebateResult` includes only successful proposals (matches current `runPanelOneShot` semantics at [runner.ts:185-187](src/debate/runner.ts#L185-L187)).
- **Coordinator-level abort (`runtime.signal`)** — every `hopBody` barrier `await` is raced against the signal; abort rejects all unresolved barriers and propagates `NaxError("CALL_OP_ABORTED")` up the stack.
- **Verifier-pick patch turn fails** — winner's `hopBody` throws on the patch turn; coordinator treats it as no-patch-applied and returns the rebut output (no behavior regression vs. today's `try/catch` at [verifier-pick.ts:167-170](src/debate/selectors/verifier-pick.ts#L167-L170)).
- **Type-system regression after selector slim** — any remaining `DebateConfig["models"]` reader fails `bun run typecheck`; this is the desired signal that we missed a site (Phase 2 design assumes the type system surfaces stragglers).

## Out of Scope

- AgentManager owning model resolution (a separate broader SSOT effort across all selectors).
- Dropping `"models"` from other selectors (`reviewConfigSelector`, `tddConfigSelector`, `llmRoutingConfigSelector`, `rectificationGateConfigSelector`). Each requires its own audit.
- Replacing `runPanelOneShot` — it already uses `callOp` and is the reference shape for this migration.
- Behavior changes to verifier-pick scoring (`extractManifestFromContext`, `computeScore`, `acOverlap`, `extractDistinctACs`) — those are pure functions unaffected by this migration.
- `debate.enabled` and other top-level config gates. Only the selector projection shape changes; the config schema is unchanged.

## Notes

- All new op files use the existing `fakeAgentManager` helper (`test/helpers/fake-agent-manager.ts`) for unit tests per `.claude/rules/forbidden-patterns.md`.
- Coordinator code must include a `timeout` test per story (e.g. "coordinator returns within 2 seconds when one debater rejects its barrier"). This is the early-warning signal against silent deadlocks; without it the rectification loop has no detector.
- Every `logger.*` call in coordinator + op code must place `storyId` as the first key in the data object per `.claude/rules/project-conventions.md`.
- New op files target ~80–150 lines each, well under the 600-line limit.
- Coordinator-level barrier promises use `Promise.withResolvers()` (Bun native).
- Closes issue #855 when US-006 lands.

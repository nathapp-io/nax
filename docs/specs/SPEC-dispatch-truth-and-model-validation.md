# SPEC: Dispatch Truth and Model Validation

## Summary

nax cannot currently distinguish *"the model answered and we could not use its answer"* from *"no model was ever reached."* Every consumer of a dispatch — the two review gates and the rectification fix cycle — collapses the second case into the first, and each one lands somewhere different by accident: semantic review passes the story, adversarial review throws a parse error, and the fix cycle reports completion and re-validates code nobody edited. This spec makes zero-dispatch a first-class outcome at the one layer that knows it (the agent manager), threads it through `callOp` as its own error code, and gives each consumer an explicit branch. It then closes the most common cause of never reaching a model: a configured model id that does not resolve, which precheck does not currently check.

Closes nax#1968, nax#1983, nax#1984.

## Motivation

Three issues, filed independently, are the same defect seen from three lanes.

**nax#1968 — a rectification pass with zero successful dispatches reports "completed".** Run `run-2026-09-09T13-58-46-234Z`: four dispatches, all 429, `Fallback swap declined reason=hop-cap-reached`, zero edits — then `Rectification strategy completed: autofix-implementer` followed by a full lint / typecheck / semantic / adversarial round against an untouched diff. Three complete cycles ran before the run was killed, and the third adversarial pass returned 2 findings where the first returned 1, on bytes that never changed. The cost is not the failed 429s (they bill nothing); it is ~4.5 minutes of live review re-reviewing identical code on healthy models, and three no-op iterations consuming the no-progress budget without ever testing the hypothesis that budget exists to test.

**nax#1983 — an unknown catalog model id surfaces as an adversarial-review parse error.** Run `run-2026-09-10T10-08-53-985Z` pinned `opencode-go/deepseek-flash[high]` at three sites. Precheck passed. Twenty-two minutes in, every review dispatch failed with `Unknown model "deepseek-flash" for provider "opencode-go"`; semantic review took the fail-open branch and adversarial threw `[adversarial-review] parse failed: invalid JSON shape`. **Both review gates were bypassed and the story reported failure for an unrelated reason.** Nothing in the story-orchestrator output named the model, the provider, or the config key — the only place the real cause appeared was a `warn`-level middleware line. The same broken id also sat on `models.native.powerful`, which is simultaneously the top rung of `autoMode.escalation.tierOrder` and the first rung of `agent.fallback.map.native`; both ladders were dead for the whole run and neither reported it.

**nax#1984 — `ModelDef.pricing` and `contextWindow` are dropped for literal pins.** The same model id, configured in the same file, bills at 0.22/1M through a literal `{agent, model}` pin and at the configured 99/1M through a tier name, and compacts against a window 31x larger than the one configured. `execution.costLimit` is enforced against a rate card the operator did not set, and the `contextWindow` lever that nax#1848 added specifically to force compaction silently does nothing.

### Why these three, together

The first two share a mechanism. `src/operations/call.ts` has **two** reachable exits when no dispatch produced a usable result, and which one fires is incidental to the consumer:

- `!rawOutput` (`call.ts:453`) — with no `retryFallback` captured and no `op.recover`, throws `CALL_OP_NO_OUTPUT`.
- `op.parse` throws (`call.ts:517`) — with no `retryFallback`, no `op.recover` and no `lastRetryTurn`, reaches `throw _parseErr` (`call.ts:562`) and the raw `ParseValidationError` escapes verbatim to the story-orchestrator.

Both trace to the same cause: `makeParseRetryStrategy.shouldRetry` (`src/agents/retry/parse-retry.ts:58`) opens with `if (!(failure instanceof ParseValidationError)) return { retry: false };`. An adapter error is not a `ParseValidationError`, so the strategy exits there and the op's declared `exhaustedFallback` is **never consulted** — on either path.

Where the fallback *is* consulted (`parse-retry.ts:96`, the empty-output branch), it is handed `""`. Both review ops route that to `reviewExhaustedFallback`, whose verdict is `/"passed"\s*:\s*false/.test("")` — no match, therefore **fail-open**. A heuristic built to inspect model output, deciding a story's fate from output that never existed.

`src/operations/_review-fallback.ts` already flags this in its own doc comment:

> *"The `looksLikeFail` regex decides block-vs-fail-open. It is a weak signal — 7 of 13 July-2026 give-ups fell through to fail-open, shipping the story with no story-level review — but changing that verdict needs evidence this preview is what collects."*

nax#1983 is that evidence: a run where it happened, with the cause named. This spec does not change the verdict for genuine unparseable model output — it stops the verdict being reached from an empty string.

The third issue is the same failure one layer up. nax#1983's own root-cause analysis calls its dispatch half *"the same conflation #1968 records for the rectification lane"*, and both nax#1983 and nax#1984 are resolved by one walk over the same configured-model-id surface.

### What changed since nax#1984 was filed

nax#1984 proposes two fix shapes and declines to pick. **Its Option 2 already shipped.** `ProviderCatalogOverrideSchema` (`src/config/schemas-model.ts:70`) carries this doc comment:

> *"Provider-scoped and config-global: keyed on (provider, model id), applied below the config surface in the nax-ai catalog, so every pin route (tier entry, literal `{agent, model}`, fallback rung) sees it."*

That is `agent.native.catalogOverrides`, merged as nax#1982 (`f0d6364b6`) **after** nax#1984 was written against `feat/recurrence-demotion-truth`. `toProviderOverrides` (`src/agents/native/models.ts:130`) carries `pricing`, `contextWindow`, `maxTokens`, `protocol` and `thinkingLevels` into the catalog nax-ai normalises, and `NativeAgentAdapter` builds its client from it at `adapter.ts:175` and `:236`. A literal pin already gets the correct pricing and window — via the catalog, not via `modelDef`.

So nax#1984's reproduction is still accurate and its remedy now exists; nothing surfaces either fact to the operator. What remains is **two mechanisms for one concept with nothing reporting which is live**:

| Mechanism | Honoured by | Routes covered |
|:---|:---|:---|
| `models[agent][tier].pricing` / `.contextWindow` (nax#1847 / nax#1848) | `buildRateCard`, `resolveContextWindow` | tier route only |
| `agent.native.catalogOverrides[].pricing` / `.contextWindow` (nax#1982) | nax-ai catalog, below config | every route |

This spec therefore closes nax#1984 by **detection**, changing no resolution precedence. Its Option 1 — resolving literal pins against the `models` map — is rejected: it would introduce a third precedence rule and silently re-price configs that work today.

The nax#1983 comment's caveat is also now stale. It warned that a precheck check resolving ids via `client.model()` would pass green for an id declared in `catalogOverrides` and still throw at dispatch, because the protocol layer re-resolved against `builtinModels()` — blocked on nax-ai#36. nax-ai#36 is closed, nax-ai is pinned at `0.1.11`, and `src/agents/native/client.ts:75` now passes `providerOverrides` into `protocols`. Precheck and dispatch share one override-aware catalog, so for the native path the check can assert dispatchability rather than mere catalog presence.

## Design

### Approach

The distinction is decided **once**, at the only layer that can observe it, and read everywhere else.

`AgentManager.runWithFallback` is the sole layer that knows how many hops actually returned a turn. `AgentRunOutcome` (`src/agents/manager-types.ts:51`) has no field expressing this, so it gains one. `callOp` reads that field and raises a dedicated error code **before** either of its existing no-result exits, so both close at once. Each consumer then branches on the code explicitly.

**The predicate is "no hop completed a turn", not "the output is empty".** These differ, and the difference is load-bearing. An agent that returns an empty string *did* dispatch: `sendWithFileOutput` synthesises a `fail-stale` `AdapterFailure` for that case, and `test/unit/operations/call-empty-output.test.ts` pins the resulting `CALL_OP_NO_OUTPUT` across eight assertions. A predicate of `adapterFailure !== undefined && !output` would flip every one of them, which is both wrong and a story deadlock. Only a dispatch that never produced a turn — rate-limit exhaustion, an unresolvable model, a declined fallback swap — is zero-dispatch.

**No new retry behaviour.** `.nax/rules/retry-strategy.md` states: *"Manager-tier concerns: `fail-rate-limit`, `fail-stale`, and `fail-service-down` are universal infrastructure concerns handled by `defaultRetryStrategy` at the manager tier. Op-tier strategies MUST NOT handle these."* This spec adds no op-tier retry and re-dispatches nothing; it only reports an outcome the manager already reached. `makeParseRetryStrategy` is left untouched — the fix sits above it in `callOp`, which is why one edit closes both exits rather than one patch per strategy.

### Integration

Symbols this feature **reads** (verified against `034005bbb`):

- `makeParseRetryStrategy` — `src/agents/retry/parse-retry.ts:50`; its `shouldRetry` early-exits at `:58` on any non-`ParseValidationError`. Read only; this spec does not modify it.
- `reviewExhaustedFallback<T>(lastOutput: string, failOpen: T): T` — `src/operations/_review-fallback.ts`. Declared by `semantic-review.ts:346` and `adversarial-review.ts:141`. Read only.
- `resolveConfiguredModel(models, preferredAgent, selection, defaultAgent): ResolvedConfiguredModel` — `src/config/schema-types.ts:212`. Its literal-pin branch ends `return { agent: selection.agent, modelDef: resolveModel(selection.model) }` (`:261`), and `resolveModel`'s string branch (`:296`) infers a provider by prefix and sets no `pricing`, `contextWindow` or `env`. Read only — **precedence is not changed**.
- `getNativeClient(catalogOverrides): Promise<Client>` — `src/agents/native/client.ts:94`; cached per override set.
- `toProviderOverrides(overrides)` — `src/agents/native/models.ts:130`.
- `Check { name, tier, passed, message }` and `CheckTier = "blocker" | "warning"` — `src/precheck/types.ts`. **Note:** nax#1983 proposes `tier: "blocking"`; that value does not exist. The blocker tier is spelled `"blocker"`.
- `normalizeChecks(result: Check | Check[]): Check[]` — `src/precheck/index.ts:190`; a check function may return an array, so one function can emit a blocker and a warning together.
- `getLateEnvironmentBlockers(config, workdir): CheckFn[]` — `src/precheck/index.ts:139`; tier-1 blockers run fail-fast and `break` on first failure.
- `runFixCycle`'s group-gave-up exit — `src/findings/cycle.ts`, which already skip-validates and returns `exitReason: "agent-gave-up"` on the reasoning *"nothing was attempted that could have changed the tree, so revalidating would burn a full suite run to learn nothing."*
- `dispatchStrategy(...)` — `src/findings/cycle-dispatch.ts:39`; records spend, then rethrows the dispatch error unchanged.

Symbols this feature **changes**. The baseline exists only to locate the code; the target is the interface to implement.

**`AgentRunOutcome`** — `src/agents/manager-types.ts:51`

- *Baseline:* `{ result, fallbacks, didSwap?, finalBundle?, finalPrompt?, finalAgent?, finalTarget?, finalDepth? }` — no field expresses whether any hop completed a turn.
- *Target:* the same shape plus a required non-negative `dispatchesCompleted: number` — the count of hops that returned a turn, successful or not, across every retry and fallback attempt of this operation. `runWithFallback` is its only writer — the outcome literals are built in `src/agents/manager-run-fallback.ts` (six return sites), which `manager.ts:183` delegates to. Making the field **required** rather than optional is deliberate: the typecheck gate then enumerates every construction site, where an optional field would let a missed site silently report `undefined`. A value of `0` means no hop reached a model.

**`callOp`** — `src/operations/call.ts`

- *Baseline:* after `normalizeRunOutcome`, falls through to the `!rawOutput` guard (`:453`) and then the `op.parse` try (`:507`), reaching `CALL_OP_NO_OUTPUT` (`:494`) or `throw _parseErr` (`:562`).
- *Target:* immediately after `recordDispatchOutcome` / `recordAdapterFailure`, when `outcome.dispatchesCompleted === 0`, throws `NaxError` with code `"CALL_OP_NO_DISPATCH"` whose context carries `stage`, `storyId` and `agentName`. This runs **before** `op.parse` and before the `exhaustedFallback` and `op.recover` escape hatches, so neither is consulted. Every other path is unchanged.

**`CheckResult`** — `src/review/types.ts:157`

- *Baseline:* carries `failOpen?: boolean`, documented as *"the LLM reviewer could not parse its response and fell back to success:true."*
- *Target:* the same shape plus `noDispatch?: boolean`, meaning no dispatch reached a model, so the check produced no verdict. `noDispatch: true` always accompanies `success: false` and never `failOpen: true` — they are mutually exclusive, because one is a degraded pass and the other is the absence of a review.

**`precheckConfigSelector`** — `src/config/selectors.ts`

- *Baseline:* `pickSelector("precheck", "precheck", "quality", "execution", "prompts", "review", "project", "agent")`.
- *Target:* the same selector widened with the slices the model-id walk reads — `models`, `plan`, `acceptance`, `autoMode`, `tdd`, `routing` — so the check reads its inputs from the precheck slice rather than the full config. Per `.nax/rules/config-patterns.md`, the derived type alias stays co-located in `src/config/selectors.ts` and consumers import the value from the barrel and the type from the leaf path.

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| Zero dispatches on a review op | The check result carries `noDispatch: true` and `success: false`. Fail-closed: the story does not pass on a review that never ran. Not counted toward `RunResult.reviewsFailedOpen`, which counts degraded passes. |
| Zero dispatches on a rectification pass | The fix cycle skips validation for that iteration and exits with a distinct terminal reason. The iteration does not count toward `consecutiveNoProgressToBail`. |
| Model id does not resolve, native agent | Precheck `blocker`. The message names the config key, the provider and the id. |
| Model id does not resolve, acp agent | Precheck `warning`, never a blocker. acpx validates the model against the live agent's advertised set and blocks internally, so a static catalog check here would duplicate a live downstream gate and reject ids that are legitimately newer than the bundled snapshot. |
| Catalog cannot be loaded at precheck | `warning`, not a blocker. A catalog that fails to load is an infrastructure fault, not a config error, and must not block a run whose ids may be fine. |
| Literal pin drops a configured `pricing` / `contextWindow` | Precheck `warning`. The run proceeds; the message names the config key and the id and points at `agent.native.catalogOverrides`. |

## Out of Scope

- Changing model-resolution precedence. `resolveConfiguredModel`'s literal-pin branch keeps returning `resolveModel(selection.model)`; literal pins are not resolved against the `models` map. This is nax#1984's Option 1, rejected because it introduces a third precedence rule and silently re-prices configurations that work today.
- Building a new provider-scoped catalog layer. This is nax#1984's Option 2; it shipped as `agent.native.catalogOverrides` in nax#1982 and is not rebuilt here.
- Threading `providerOverrides` into the cost-side catalog at `src/agents/catalog/index.ts`. `catalogOverrides` is scoped to the native agent by its position under `agent.native`, which is the intended design, and ACP prices through `resolveRateCard(modelDef.model)` from a bare model id that never carried `modelDef.pricing` on any route.
- Changing the `looksLikeFail` fail-open verdict for genuine unparseable model output. `_review-fallback.ts` documents that 7 of 13 July-2026 give-ups fell through to fail-open; revisiting that verdict needs its own evidence and its own spec. This spec only prevents the verdict being reached from an empty string.
- Adding op-tier retry for `fail-rate-limit`, `fail-stale` or `fail-service-down`. `.nax/rules/retry-strategy.md` reserves these for `defaultRetryStrategy` at the manager tier.
- Modifying `makeParseRetryStrategy` or its `shouldRetry` early exit at `parse-retry.ts:58`. The fix sits above it in `callOp`.
- Validating model ids for agents other than native and acp, and probing model availability over the network. The precheck check is a local catalog lookup only.

## Stories

**US-001 — `callOp` raises zero-dispatch as its own terminal outcome**
Foundation for US-002 and US-003. The agent manager counts completed dispatches onto `AgentRunOutcome`; `callOp` raises `CALL_OP_NO_DISPATCH` when that count is zero, ahead of both existing no-result exits.
Dependencies: none.
Context Files: `src/agents/manager-types.ts`, `src/agents/manager-run-fallback.ts`, `src/operations/call.ts`, `src/operations/call-resolvers.ts`, `test/unit/operations/call-empty-output.test.ts`
Creates: none

**US-002 — neither review gate produces a verdict from a dispatch that never happened**
Semantic and adversarial review report zero-dispatch as its own state instead of fail-open and a parse error respectively.
Dependencies: US-001.
Context Files: `src/review/types.ts`, `src/execution/story-orchestrator/review-decision.ts`, `src/operations/semantic-review.ts`, `src/operations/adversarial-review.ts`, `src/execution/post-run-review-summary.ts`
Creates: none

**US-003 — a rectification pass with zero dispatches skips validation**
The fix cycle routes zero-dispatch into its existing skip-validate exit rather than reporting completion and re-validating untouched code, and the rectification phase stops charging the iteration to the no-progress budget. The two live in different components: the skip-validate exit is `src/findings/cycle.ts`, while `abortOnNoProgress` / `consecutiveNoProgressToBail` are consumed at `src/execution/story-orchestrator/rectification.ts:358-359` — `cycle.ts` does not read them.
Dependencies: US-001.
Context Files: `src/findings/cycle.ts`, `src/findings/cycle-dispatch.ts`, `src/findings/cycle-types.ts`, `src/execution/story-orchestrator/rectification.ts`, `src/execution/story-orchestrator-logging.ts`
Creates: none

**US-004 — precheck resolves every configured model id and reports dropped overrides**
One walk over the configured-model-id surface, emitting a blocker for an unresolvable native id, a warning for an unresolvable acp id, and a warning for a literal pin whose configured `pricing` / `contextWindow` the literal route discards.
Dependencies: none.
Context Files: `src/precheck/index.ts`, `src/precheck/types.ts`, `src/config/selectors.ts`, `src/config/schema-types.ts`, `src/agents/native/client.ts`
Creates: `src/precheck/checks-models.ts`, `src/agents/native/model-resolution.ts`

### Modifies

**US-001**
- `test/unit/operations/call-empty-output.test.ts` — its fixtures build run outcomes without `dispatchesCompleted`, which is now required on `AgentRunOutcome`. Each fixture must set the count that matches what it simulates: an empty-or-whitespace turn that was actually returned by an adapter completed a dispatch, so these fixtures set `dispatchesCompleted: 1` and keep asserting `CALL_OP_NO_OUTPUT`. The invariant that replaces the bare fixture is that `CALL_OP_NO_OUTPUT` covers a completed dispatch with unusable output, and `CALL_OP_NO_DISPATCH` covers no completed dispatch at all.
- `test/unit/agents/manager-types-phase5.test.ts` — it builds an `AgentRunOutcome` object literal with only `result`, `fallbacks`, `finalBundle` and `finalPrompt`, which stops compiling the moment `dispatchesCompleted` becomes required. The invariant that replaces it is that an `AgentRunOutcome` literal carries a `dispatchesCompleted` count alongside `finalBundle` and `finalPrompt`.

**US-002**
- `test/unit/operations/semantic-review.test.ts` — its empty-dispatch case asserts the fail-open shape that this story replaces for the zero-dispatch path. The invariant that replaces it is that an empty output from a *completed* dispatch still fails open, while no completed dispatch yields `noDispatch: true` with `success: false`.

**US-004**
- `test/unit/precheck/precheck-checks-tier1-blockers.test.ts` — it pins the tier-1 blocker set by its exact membership, which this story extends with the model-resolution check. The invariant that replaces the fixed membership is that the model-resolution blocker is present in the tier-1 set and runs after `checkAgentCLI`.

### Seams

- **US-001 → US-002.** `CALL_OP_NO_DISPATCH` is raised by `callOp` and consumed by the review phase. US-002 carries a seam AC entering at the review phase's own entry point with the dispatch stubbed to raise the code.
- **US-001 → US-003.** The same code is consumed by `runFixCycle` through `dispatchStrategy`'s rethrow. US-003 carries a seam AC entering at `runFixCycle` with the strategy dispatch stubbed to raise it.
- **US-004 internal.** `src/agents/native/model-resolution.ts` exports the catalog resolver; `src/precheck/checks-models.ts` is its only consumer. The seam AC enters at `runPrecheck` with the resolver stubbed, proving the check is registered and reached rather than merely defined. The resolver lives under `src/agents/native/` because `scripts/check-nax-ai-imports.ts` permits `@nathapp/nax-ai` imports only under `src/agents/native/` and `src/agents/catalog/`; precheck must not import nax-ai directly.

## Acceptance Criteria

### US-001 — `callOp` raises zero-dispatch as its own terminal outcome

1. `[unit]` `AgentManager.runWithFallback` returns an `AgentRunOutcome` whose `dispatchesCompleted` equals the number of hops that returned a turn: a single successful hop yields `1`.
2. `[unit]` When every hop of `runWithFallback` ends in an adapter failure with no turn returned, the returned outcome's `dispatchesCompleted` equals `0`.
3. `[unit]` Calling `callOp` with a run-kind operation whose dispatch outcome reports `dispatchesCompleted` of `0` throws an error whose `code` equals `"CALL_OP_NO_DISPATCH"`.
4. `[unit]` The error thrown for `dispatchesCompleted` of `0` carries `stage`, `storyId` and `agentName` in its context, with `agentName` equal to the agent the operation dispatched to.
5. `[unit]` Calling `callOp` with a run-kind operation whose dispatch outcome reports `dispatchesCompleted` of `0` does not invoke the operation's `parse` function.
6. `[unit]` Calling `callOp` with a run-kind operation whose retry strategy declares an `exhaustedFallback` and whose outcome reports `dispatchesCompleted` of `0` does not invoke that `exhaustedFallback`, and does not invoke the operation's `recover` function.
7. `[unit]` Calling `callOp` with a run-kind operation whose outcome reports `dispatchesCompleted` of `1` and an empty output string still throws an error whose `code` equals `"CALL_OP_NO_OUTPUT"`.
8. `[unit]` Calling `callOp` with a complete-kind operation whose outcome reports `dispatchesCompleted` of `0` throws an error whose `code` equals `"CALL_OP_NO_DISPATCH"`.
9. `[unit]` Calling `callOp` with a run-kind operation whose outcome reports `dispatchesCompleted` of `0` and carries an `adapterFailure` still records that failure against the story on the runtime's per-story adapter-failure store, and still records the outcome's fallback records for the story, before the error is thrown.

### US-002 — neither review gate produces a verdict from a dispatch that never happened

1. `[integration]` Stub the review dispatch to raise an error whose `code` equals `"CALL_OP_NO_DISPATCH"`; run the semantic review phase for a story; the resulting check result has `noDispatch` equal to `true` and `success` equal to `false`.
2. `[integration]` Under the same stub, the semantic review check result has `failOpen` not equal to `true`.
3. `[integration]` Stub the review dispatch to raise an error whose `code` equals `"CALL_OP_NO_DISPATCH"`; run the adversarial review phase for a story; it returns a check result with `noDispatch` equal to `true` rather than propagating a parse error to the caller.
4. `[unit]` A semantic review dispatch that completes and returns an unparseable non-empty string still yields a check result with `failOpen` equal to `true` and `noDispatch` not equal to `true`.
5. `[unit]` A check result with `noDispatch` equal to `true` does not increment the fail-open tally that `RunResult.reviewsFailedOpen` reports.
6. `[integration]` Under the zero-dispatch stub, the story does not pass story-level review: the review decision for that story is not a pass.

### US-003 — a rectification pass with zero dispatches skips validation

1. `[integration]` Stub the strategy dispatch to raise an error whose `code` equals `"CALL_OP_NO_DISPATCH"`; run the fix cycle; the cycle's `validate` function is not invoked for that iteration.
2. `[integration]` Under the same stub, the fix cycle returns a result whose `exitReason` names the zero-dispatch condition and is distinct from the existing `FixCycleExitReason` members `"agent-gave-up"` and `"validate-short-circuit"`.
3. `[integration]` Run the rectification phase with `abortOnNoProgress` enabled and `consecutiveNoProgressToBail` of `3`, with the strategy dispatch stubbed to raise an error whose `code` equals `"CALL_OP_NO_DISPATCH"`; three consecutive zero-dispatch iterations do not reach the no-progress bail.
4. `[integration]` A strategy dispatch that completes, applies no edits and does not signal UNRESOLVED still runs `validate` for that iteration, so the existing no-edit path is unchanged. (A completed dispatch that *does* signal UNRESOLVED keeps taking the existing `"agent-gave-up"` exit, which already skips validation.)
5. `[unit]` The zero-dispatch exit records the iteration's accumulated cost on the returned result, so the failed dispatch's spend is still reported.

### US-004 — precheck resolves every configured model id and reports dropped overrides

1. `[unit]` Given a config whose `models.native.powerful` names a provider-qualified id absent from the resolved catalog, the model-resolution check returns a check with `tier` equal to `"blocker"` and `passed` equal to `false`.
2. `[unit]` The blocker's `message` contains the configuration key path, the provider and the model id that failed to resolve.
3. `[unit]` Given a config whose `review.adversarial` is a literal `{agent, model}` pin naming an unresolvable id on an acp agent, the check returns a check with `tier` equal to `"warning"` and `passed` equal to `false`, and returns no check with `tier` equal to `"blocker"` for that id.
4. `[unit]` Given a config whose id is absent from the bundled catalog but declared under `agent.native.catalogOverrides`, the check returns no failing check for that id.
5. `[unit]` The check walks literal `{agent, model}` pins under `review.semantic`, `review.adversarial`, `plan`, `acceptance`, `tdd.sessionTiers` and `routing.llm.model`, and every rung of `autoMode.escalation.tierOrder` and `agent.fallback.map`: a config with an unresolvable id at each of those sites yields one failing check naming each site.
6. `[unit]` When the catalog resolver rejects, the check returns a check with `tier` equal to `"warning"` and does not return a check with `tier` equal to `"blocker"`.
7. `[unit]` Given a config declaring `pricing` and `contextWindow` on a `models` entry, and a literal `{agent, model}` pin naming that same resolvable model id, the check returns a check with `tier` equal to `"warning"` whose `message` names the pin's configuration key, the model id, and `agent.native.catalogOverrides`.
8. `[unit]` Given the same `models` entry selected by its tier name rather than by a literal pin, the check returns no warning about dropped overrides.
9. `[unit]` Constructing the precheck config slice from a config that sets `models`, `plan`, `acceptance`, `autoMode`, `tdd` and `routing` yields a slice on which each of those keys is defined.
10. `[integration]` Stub the native catalog resolver to report every id unresolvable; run `runPrecheck` with a config naming a native model id; the stubbed resolver is invoked and the returned result's `blockers` includes the model-resolution check.
11. `[integration]` Run `runPrecheck` with a config whose every configured model id resolves; the returned result's `blockers` contains no model-resolution check.

**Out of scope:** network probing of model availability (local catalog lookup only); validating ids for agents other than native and acp.

<!-- spec-writing: completed-through-phase-6 -->

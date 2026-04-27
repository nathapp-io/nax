# Design Note: `callOp` Run-Path Realignment with ADR-019

**Date:** 2026-04-27
**Status:** Pre-implementation — settles open questions before PR work begins
**Scope:** Resolves Findings 1–9 from [docs/findings/2026-04-27-adr-018-019-runtime-layering-review-synthesis.md](../findings/2026-04-27-adr-018-019-runtime-layering-review-synthesis.md)
**ADRs:** [ADR-018](../adr/ADR-018-runtime-layering-with-session-runners.md), [ADR-019](../adr/ADR-019-adapter-primitives-and-session-ownership.md)
**Issues touched:** #688, #689, #690, #691, #692, #693, #706

---

## 1. Problem statement

`callOp()` for `kind:"run"` operations currently calls `sessionManager.runInSession(name, prompt, opts)` directly ([src/operations/call.ts:48](../../src/operations/call.ts#L48)). This diverges from ADR-019 §5, which specifies the path `callOp → agentManager.runWithFallback({ executeHop }) → buildHopCallback`. Three observable consequences flow from this single divergence:

- **No cross-agent fallback** — `runInSession` does not iterate the fallback chain. Every `kind:"run"` op silently runs single-agent.
- **Middleware bypassed** — the chain (`audit`, `cost`, `cancellation`, `logging`) is wired into `AgentManager` only ([src/runtime/index.ts:83-107](../../src/runtime/index.ts#L83-L107)). `runInSession`'s prompt overload calls `sessionManager.sendPrompt → adapter.sendTurn` directly with zero hops through `AgentManager`. CostAggregator and PromptAuditor never see these calls.
- **`noFallback` flag is dead** — declared on [RunOperation](../../src/operations/types.ts#L54), never read.

Secondarily, `buildHopCallback` itself flattens every error into `availability/fail-adapter-error` instead of preserving the `SessionFailureError`-bearing classification that `session-run-hop.ts` produces today. Once `callOp` routes through `buildHopCallback`, this regression becomes user-visible.

This design note settles the open architectural questions and locks down the scope of the three follow-up PRs.

---

## 2. Decisions

### 2.1 Cross-agent fallback semantics

**Decision:** Cross-agent fallback stays for review and rectification flows. ACP sessions are not shared across agents (each agent gets a fresh session under its own adapter) — but the *user-facing* "if Claude rate-limits, retry on Codex" behavior is preserved.

**Rationale:** Two independent levels:

- *Within one hop* — multi-turn behavior (e.g. semantic-review's same-session JSON parse retry) needs the agent's conversation state and is therefore single-agent by construction.
- *Between hops* — `runWithFallback` swaps agents when one hop returns availability failure. The next agent gets a fresh session and a context bundle rebuilt for it via `ContextEngine.rebuildForAgent`.

These levels compose. The mistake in the synthesis review's first draft was conflating them and proposing to drop fallback for review. Walked back here.

### 2.2 Multi-prompt orchestration shape

**Decision:** Multi-prompt logic lives inside the hop callback, parameterized per operation. `RunOperation` optionally declares a `hopBody` that performs N prompts within a single hop's session. Default behavior (single prompt) is unchanged.

**New surface:**

```typescript
// src/operations/types.ts
export interface RunOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "run";
  readonly session: { readonly role: SessionRole; readonly lifetime: "fresh" | "warm" };
  readonly noFallback?: boolean;
  /**
   * Optional multi-prompt body executed within a single hop's session.
   * When omitted, the default body is "send one prompt and return".
   * The body owns retry-in-session logic (e.g. JSON parse retries).
   * It does NOT own openSession / closeSession — that's the caller's job.
   */
  readonly hopBody?: (
    handle: SessionHandle,
    initialPrompt: string,
    ctx: HopBodyContext<I>,
  ) => Promise<TurnResult>;
}
```

**Per-op orchestration today:**

| Op | Hop body |
|:---|:---|
| `acceptance-fix`, `acceptance-fix-tests`, `acceptance-diagnose` | default (single prompt) |
| `semantic-review`, `adversarial-review` | `runAsSession(initialPrompt)` → if JSON parse fails or output looks truncated, `runAsSession(retryPrompt)` in same handle → return |
| `rectify` | default (single prompt). Attempt loop stays *outside* `callOp` — each attempt is one `callOp` invocation. |
| TDD `write-test` / `implement` / `verify` | default, with `noFallback: true` |

**Why this factoring wins:**

- The rebuild + open + close + handoff scaffolding stays in `buildHopCallback` — one place.
- Only the body varies per op. Review ops can collapse the keepOpen pattern from semantic.ts/adversarial.ts directly into the op definition. No more raw `agentManager.run({ keepOpen: true })` call sites.
- Cross-agent fallback works automatically. If the hop returns `adapterFailure`, `runWithFallback` swaps; the new agent's hop runs the hop body fresh.

**Why not "each attempt is its own session, rectification owns the loop":** rectification *could* live inside the hop body (intra-hop attempt loop, all attempts in one session). We'll keep the attempt loop external for PR 1, because:

- It matches today's behavior — agent sees prior edits via the working tree, not via session memory.
- It keeps the hop body shape simple (single multi-prompt pattern, no nested attempt loops).
- The fresh-session-per-attempt cost is small (open is cheap; rebuild only fires on agent swap).

If a follow-up shows session continuity matters for rectification quality, the hop body shape supports moving the loop in later — backwards compatible.

### 2.3 `noFallback` flag

**Decision:** Keep `noFallback` as a flag on `RunOperation`. `callOp` branches on it.

```typescript
// src/operations/call.ts (kind:"run" branch)
const manager = op.noFallback
  ? wrapAdapterAsManager(ctx.runtime.agentManager.getAgent(ctx.agentName))
  : ctx.runtime.agentManager;
const outcome = await manager.runWithFallback({ executeHop, ... });
```

This matches the ADR-018 §5.2 sketch for what `SingleSessionRunner.run()` was supposed to do. TDD ops set `noFallback: true` to preserve their `fallbacks: []` invariant.

### 2.4 `runInSession` removal from `callOp` path

**Decision:** `callOp` no longer calls `runInSession`. The Phase B prompt-form overload of `runInSession` ([src/session/manager.ts:558-595](../../src/session/manager.ts#L558-L595)) is left in place for legacy callers but expected to have near-zero usage after PR 1. A grep audit at the end of PR 1 will determine whether to delete the overload or keep it as a thin convenience.

The hop callback uses the three Phase-B primitives directly:

```
sessionManager.openSession(name, opts)        // Phase B primitive
agentManager.runAsSession(handle, prompt)     // fires middleware
sessionManager.closeSession(handle)           // Phase B primitive
```

This is what ADR-019 §5 specifies; getting middleware coverage and fallback iteration "by construction" is the win.

### 2.5 Test strategy

**Decision:** Two new tests land with PR 1.

1. **Middleware-coverage integration test** at `test/integration/operations/middleware-coverage.test.ts`. For each `kind:"run"` op in the registry, dispatch via `callOp` against a runtime where `auditMiddleware` and `costMiddleware` are observable. Assert exactly one audit entry and one cost entry per call. Asserts both Findings 1 and 5 cannot recur.

2. **`buildHopCallback` failure-classification unit test** at `test/unit/operations/build-hop-callback-failures.test.ts`. Inject `SessionFailureError(adapterFailure: { outcome: "fail-rate-limit" })` from a stubbed `runAsSession`. Assert the returned `result.adapterFailure.outcome === "fail-rate-limit"` and `result.rateLimited === true`. Inject a non-`SessionFailureError` exception. Assert it still produces `availability/fail-adapter-error` (current generic branch). Asserts Finding 3 cannot recur.

Skipping lint rules — they give noisier failure messages than tests for this kind of structural invariant.

---

## 3. Implementation shape

### 3.1 New / changed surface

| File | Change |
|:---|:---|
| `src/operations/types.ts` | Add optional `hopBody` field on `RunOperation`. Define `HopBodyContext<I>`. |
| `src/operations/build-hop-callback.ts` | Mirror `session-run-hop.ts` failure handling: catch `SessionFailureError` and surface `adapterFailure`. Default hop body sends single prompt; if `op.hopBody` is supplied, invoke it instead. |
| `src/operations/call.ts` | `kind:"run"` branch: build `executeHop` via `buildHopCallback(ctx, op, input, prompt)`, dispatch through `agentManager.runWithFallback({ executeHop, ... })`. Branch on `op.noFallback`. Remove direct `sessionManager.runInSession` call. |
| `src/operations/semantic-review.ts` | Add `hopBody` performing the JSON-retry-in-same-session logic currently in [src/review/semantic.ts:541-604](../../src/review/semantic.ts#L541-L604). |
| `src/operations/adversarial-review.ts` | Same shape as semantic. |
| `src/review/semantic.ts`, `src/review/adversarial.ts` | Replace direct `agentManager.run({ keepOpen })` calls with `callOp(...)`. Drop `closePhysicalSession` calls (handled by `closeSession(handle)` in the callback). |
| TDD ops (`src/operations/write-test.ts`, `implement.ts`, `verify.ts`) | Set `noFallback: true`. |
| `test/integration/operations/middleware-coverage.test.ts` | New (per §2.5). |
| `test/unit/operations/build-hop-callback-failures.test.ts` | New (per §2.5). |

### 3.2 What does not change

- `runWithFallback` itself — no changes. The chain iteration, rate-limit retry, and signal-aware backoff stay as-is.
- `agentManager.runAsSession` — no changes. Already fires middleware correctly.
- `SessionManager.openSession` / `closeSession` / `sendPrompt` — no changes.
- TDD orchestrator (`runThreeSessionTdd`) — no changes; the three sub-ops simply gain `noFallback: true`.
- `dialogue.ts`, `debate/runner-stateful.ts`, `debate/runner-hybrid.ts` — already on the new shape, untouched.

### 3.3 Wave-2 invariant restoration

After PR 1:

- "CostAggregator.snapshot() reflects all calls including nested and session-internal calls" — true by construction. Every dispatch goes through `agentManager.runAsSession` or `agentManager.completeAs`, both of which fire the middleware chain.
- "PromptAuditor flushes to `.nax/audit/<runId>.jsonl`" — true; audit middleware sees every call.
- The Wave-2 phase-completion docs no longer overstate.

---

## 4. PR sequencing

```
PR 1: Foundation (Findings 1 + 3 + 5 + 6)
  - Fix buildHopCallback failure classification (Finding 3)
  - Add hopBody field to RunOperation (§2.2)
  - Refactor callOp run-path to use runWithFallback + buildHopCallback (Findings 1, 5)
  - Branch on noFallback (Finding 6)
  - Add middleware-coverage and failure-classification tests (§2.5)
  - Migrate semantic-review and adversarial-review ops to use hopBody
  - Set noFallback:true on TDD ops
  - Grep runInSession; delete prompt-form overload if unused

PR 2: keepOpen retirement (Finding 2)
  - Migrate src/review/semantic.ts and adversarial.ts to call callOp(...) instead of agentManager.run({ keepOpen })
  - Migrate src/verification/rectification-loop.ts (decide intra-hop vs external attempt loop — see §2.2)
  - Migrate src/tdd/rectification-gate.ts and src/tdd/session-runner.ts
  - Migrate src/pipeline/stages/autofix.ts and autofix-adversarial.ts
  - Update phase-e tracking doc to reflect what actually shipped
  - Optional: delete keepOpen field from AgentRunOptions if no callers remain

PR 3: Cleanup (Findings 4 + 7 + 8 + 9)
  - Restrict review-stage debate config to oneshot/panel, OR thread real runtime (Finding 4)
  - Delete adapter.closePhysicalSession and deriveSessionName (Finding 7)
  - Decide cross-imports posture (Finding 8) — neutralize types or amend exit criterion
  - Migrate src/cli/plan.ts off _deps.createManager OR amend Wave-3.5 exit criterion (Finding 9)
```

PR 1 is the one that matters. PR 2 follows naturally once PR 1 lands. PR 3 is a paperwork-vs-code call best made after PR 2.

---

## 5. Risks

- **Behavior change risk (low–medium):** PR 1 enables fallback for review and rectification flows that today silently run single-agent. Users on a single-agent setup see no change. Users with a multi-agent fallback chain may see Codex/Gemini fire on review failures where they previously did not. Document in CHANGELOG.
- **Test-suite duration risk (low):** middleware-coverage integration test runs every `kind:"run"` op; mocked dispatch should keep this under one second. Confirm during implementation.
- **Hop body API risk (low):** introducing `hopBody` is a small interface change. Default behavior preserves today's single-prompt shape, so unaware ops keep working. The only ops that need to opt in for PR 1 are the two review ops.
- **`runInSession` removal risk (low):** prompt-form overload may have non-callOp callers in tests. Grep before delete; replace with explicit `openSession + sendPrompt + closeSession` if any. Tracked-session form (the `SessionRunClient` overload) is independent and stays.
- **Audit/cost backfill (cosmetic):** historical `.nax/audit/<runId>.jsonl` and `.nax/cost/<runId>.jsonl` files written before PR 1 will be missing entries for `kind:"run"` callOp ops. Note this in CHANGELOG; no migration needed.

---

## 6. Out of scope

- Reorganizing `SessionDescriptor` / `ProtocolIds` / `SessionHandle` into a neutral types package to satisfy the strict reading of "zero cross-imports" (Finding 8). Punt to PR 3 or beyond.
- Reworking the rectification attempt loop into intra-hop iteration (§2.2 keeps it external for PR 1; revisit if quality data shows session continuity matters).
- Deleting `keepOpen` from `AgentRunOptions` itself. Optional cleanup at the end of PR 2; not required for the migration to be complete.
- Migrating `nax plan` CLI to construct via `createRuntime()`. Tracked under Finding 9.

---

## 7. Decisions log

| # | Question | Decision | Rationale |
|:--|:---|:---|:---|
| 1 | Drop fallback for review/rectification? | No — fallback stays at hop boundary | ACP sessions are per-agent, but cross-agent retry on availability failure is a user-facing feature worth preserving |
| 2 | How to model multi-prompt-per-session? | Per-op `hopBody` field on `RunOperation` | Single factoring covers review's JSON retry, rectification's optional intra-hop loop, and stays default-compatible for single-prompt ops |
| 3 | Keep `noFallback` flag? | Yes; `callOp` branches on it | Mirrors ADR-018 §5.2; TDD ops opt in |
| 4 | Structural test choice | Middleware-coverage integration test + buildHopCallback failure-classification unit test | Catches the exact drift modes Findings 1, 3, 5 represent |
| 5 | `runInSession` on `callOp` path? | Removed; `callOp` uses `openSession` / `runAsSession` / `closeSession` directly via `buildHopCallback` | Matches ADR-019 §5 specification verbatim |

# Context-Engine v2 + Session-Manager — Verification Review

**Date:** 2026-04-18
**Reviewer:** superpowers:code-reviewer (dispatched)
**Branch:** `fix/context-engine-review-followups-2026-04-17`
**Base:** `f7f41d42cda59ed4466081e851c43d650b26d2c5^` (parent of first commit)
**Head:** `88f22c1dfe6672d8c8467819e35f6999ec26b9b1`
**Main merge-base:** `b4888122ee276e996f4f0585274e56642e32770e` (main is behind by 10 commits)

**Scope:** 39 commits · 164 files · ~21,753 insertions / 2,530 deletions (80 src + 54 test files).

**Specs reviewed:**

- `docs/specs/SPEC-context-engine-v2.md`
- `docs/specs/SPEC-context-engine-v2-amendments.md`
- `docs/specs/SPEC-context-engine-v2-compilation.md`
- `docs/specs/SPEC-context-engine-agent-fallback.md`
- `docs/specs/SPEC-context-engine-canonical-rules.md`
- `docs/specs/SPEC-session-manager-integration.md`

**Prior reviews considered:**

- `docs/reviews/context-engine-v2-branch-review.md`
- `docs/reviews/context-engine-v2-architecture-review.md`
- `docs/reviews/context-engine-v2-final-review-2026-04-17.md`
- `docs/reviews/context-engine-v2-findings-2-and-5-proposal.md`
- `docs/reviews/context-engine-review-followups-2026-04-17.md`
- `docs/reviews/today-commits-code-review-2026-04-17.md`

---

## Verdict: **needs-followups**

Near-ready. The branch is extensively wired and the majority of prior-review findings are genuinely closed. However, one follow-up commit (`88f22c1d`) introduces a test regression that blocks merge, and the full `bun test` run crashes Bun mid-suite, which masks further potential regressions.

---

## Acceptance Criteria Summary

| Spec | ✅ Met + wired | ⚠️ Partial | ❌ Missing / unwired | Total |
|:-----|:-------------:|:----------:|:-------------------:|:-----:|
| SPEC-context-engine-v2 (AC-1..43) | 40 | 3 | 0 | 43 |
| Amendments A / B / C | 18 | 1 | 0 | 19 |
| Agent fallback | 16 | 2 | 0 | 18 |
| Canonical rules | 17 | 2 | 1 | 20 |
| Session-manager additions (AC-79..83) | 2 | 2 | 1 | 5 |

AC numbering in `context-engine-v2-final-review-2026-04-17.md` is authoritative for v2 + amendments; fallback and canonical-rules use each spec's own local numbering.

---

## CRITICAL Issues (block merge)

### CRIT-1. AC-16 strict validation regresses 26+ existing tests

**File:** `src/context/engine/orchestrator.ts:237-255`

Commit `88f22c1d` added the fail-fast check:

```typescript
const unknownProviderIds = allowedIds.filter((id) => !registeredIds.has(id));
if (unknownProviderIds.length > 0) { throw new NaxError(...) }
```

This correctly implements M12. But the existing test fixture in `test/unit/context/engine/orchestrator.test.ts:26` uses
`providerIds: ["p1", "p2", "test-provider", "timeout-sim", "good"]` as a *"bypass stage filter"* override, and many tests only register `p1` or a single `test-provider`. Every such test now throws.

**Impact (confirmed by running the suites):**

- `test/unit/context/engine/orchestrator.test.ts`: 17 fail / 20 pass
- `test/unit/context/engine/orchestrator-factory.test.ts`: 3 fail (#507 scope tests)
- `test/unit/context/engine/providers/feature-context.test.ts`: several fail
- `test/unit/context/engine/pull-tools.test.ts`: 3 fail (`handleQueryFeatureContext`)

**Fix options:**

1. Filter `BASE_REQUEST.providerIds` inside test fixtures to only include registered IDs (tests are wrong).
2. **Preferred:** Limit the strict check to config-derived `stageConfig.providerIds`, not `request.providerIds` test overrides — the latter is documented as a test-only override and aligns with the fixture comments and the spec's user-facing purpose (catch bogus plugin IDs in config).

### CRIT-2. Full `bun test` segfaults

`timeout 600 bun test` core-dumps partway (Bun 1.3.8 instability). This masks the regression gate. Either split the suite or isolate the offending file before merge.

---

## HIGH / Important (should fix before merge)

### H-1. Session-manager AC-83 (force-terminate on close) not implemented

**File:** `src/execution/session-manager-runtime.ts:4-15`

`closePhysicalSession(handle, workdir)` is called with two positional args; the spec requires `options.force: boolean` for hard termination of errored sessions. No call site passes `force`, and `src/agents/types.ts` does not declare it. `closeAllRunSessions` on SIGTERM shutdown would benefit from `force: true`.

### H-2. Session state model divergence from spec

Spec names states `created/active/suspended/failed/handed-off/completed/orphaned`. Implementation (`src/session/types.ts:26-34`) uses `CREATED/RUNNING/PAUSED/RESUMING/CLOSING/COMPLETED/FAILED`. `handoff()` updates the `agent` field but does not transition to a `HANDED_OFF` state — auditing whether a session was handed off vs normally completed requires reading `agentFallbacks[]` externally. Semantically equivalent but the spec should be amended or a `HANDED_OFF`/`ORPHANED` state added for trace clarity.

### H-3. Canonical rules AC-19 dogfood migration not in this branch

Spec AC-19: *"The nax project itself completes the migration: its own rules live in `.nax/rules/`…"* — the repo still has `.claude/rules/*.md` and no `.nax/rules/` directory. This is a process AC (not code) and the spec lists it as the final deprecation step. Flag for tracking.

### H-4. Test coverage gap: agent-swap multi-hop exhaustion

`test/integration/execution/agent-swap.test.ts` covers single-hop success/fail. No test asserts that when every candidate in `fallback.map[primary]` fails, the loop exits with a terminal outcome (fallback AC-5: "all-agents-unavailable"). The loop in `pipeline/stages/execution.ts:263-401` exits when the hop cap or candidate list is exhausted, but the terminal `outcome` is only logged — no `StoryMetrics.fallback.exhausted` flag or distinct escalation reason.

### H-5. Integration risk: idempotency of `closeAllRunSessions`

`src/execution/session-manager-runtime.ts:66-92` — `storyIds` is a `Set`, but `closeStorySessions` internally calls `sessionManager.closeStory(storyId)` which may miss late-binding sessions. The second pass iterates `activeSessions` to catch storyless sessions, but any descriptor whose state already changed to `COMPLETED` via the first pass would no longer be in `activeSessions` (good). Logic is OK but fragile — add a unit test asserting idempotency.

---

## MINOR

- `src/context/engine/orchestrator-factory.ts:53` uses `config.context.v2.providers` without optional chaining (regression class of M7). Tests bypassing Zod defaults will crash. Add `?.providers`.
- `src/context/rules/canonical-loader.ts` uses bare `logger.warn` without `storyId`. Canonical rules are genuinely story-less — acceptable but project-conventions says `storyId` must be first key. Document the exception or introduce a convention for story-less logs.
- `src/session/scratch-writer.ts:18` imports `node:fs/promises` `appendFile` — correct for atomic `O_APPEND` but project rule forbids Node.js APIs. Document this as an intentional exception at the call site (same pattern as the `setTimeout`-for-cancellation exception).
- `nax context inspect` CLI (AC-19) is wired at `bin/nax.ts` but has no integration test verifying end-to-end output. Nice-to-have.
- `docs/reviews/context-engine-review-followups-2026-04-17.md:110-112` claims *"full run-level centralized SessionManager ownership … is still larger-scope work"* — that work has since landed in `85de63ee`, `a5adc21d`, `15620b9b`. Update the doc.

---

## Prior-review spot-check confirmations (verified resolved)

| Finding | Resolved? | Evidence |
|:--------|:---------:|:---------|
| C1 path-traversal in `contextFiles` | ✅ | `src/prd/schema.ts:200-212` rejects absolute + `..` |
| H1 AC-24 determinism not threaded | ✅ | `src/context/engine/stage-assembler.ts:195` |
| H2 AC-51 planDigestBoost not threaded | ✅ | `src/context/engine/stage-assembler.ts:198` |
| H3 AC-41 fallback observability missing | ✅ | `src/metrics/tracker.ts:172` surfaces `fallback.hops`; `pipeline/stages/execution.ts:308-318` records hops with structured metadata |
| H4 effectiveness swallowed errors silently | ✅ | `src/context/engine/effectiveness.ts:208-213` logs `logger.warn` |
| H5 scope options not config-driven | ✅ | `src/config/schemas.ts:592-606` + `orchestrator-factory.ts:53-59` threads them |
| H6 only 2 of 5 agent profiles | ✅ | `src/context/engine/agent-profiles.ts:88-144` — all 5 (claude, codex, gemini, cursor, local) |
| M3 AC-28 default `allowLegacyClaudeMd: true` | ✅ | `src/config/schemas.ts:496` flipped to `false` |
| M4 AC-35 pre-flight warning missing | ✅ | `src/execution/lifecycle/run-setup.ts:51-73,123` |
| M5 AC-39 rebuild manifest missing | ✅ | `src/context/engine/manifest-store.ts:53,86`; `writeRebuildManifest` wired from `pipeline/stages/execution.ts:287` |
| M6 whole-chunk staleness | ✅ | `src/context/engine/providers/feature-context.ts:110-123` per-entry |
| M7 missing optional chain on `allowLegacyClaudeMd` | ✅ | `orchestrator-factory.ts:41` |
| M8 scratch append race | ✅ | `src/session/scratch-writer.ts:85` uses `fsAppendFile` (atomic `O_APPEND`) |
| today-commits finding 1: rebuild not delivered to swap | ✅ | `pipeline/stages/execution.ts:333-370` uses `buildSwapPrompt(basePrompt, workingBundle.pushMarkdown)` |
| today-commits finding 2: single-hop only | ✅ | `while` loop at `pipeline/stages/execution.ts:263-401` walks candidates |
| today-commits finding 3: session-manager not central | ✅ | `runner.ts:149` creates once in setup; threaded via `runExecutionPhase` (`runner-execution.ts:160`) and `runCompletionPhase`; `closeAllRunSessions` called on SIGTERM (`run-setup.ts:177`) and completion (`run-completion.ts:206`) |
| today-commits finding 5: free-text adapter classification | ✅ | `src/agents/acp/parse-agent-error.ts` classifies only from structured fields (verified by rewritten tests) |

---

## Wiring verification

All new modules have call paths — **no dead exports found**:

| Module | Call site |
|:-------|:----------|
| `src/context/engine/stage-assembler.ts` | imported by `pipeline/stages/context.ts` and every stage that needs a per-stage bundle |
| `src/context/engine/manifest-store.ts` | imported by `stage-assembler.ts` (`writeContextManifest`) and `pipeline/stages/execution.ts` (`writeRebuildManifest`) |
| `src/context/engine/orchestrator-factory.ts` | used as default factory in `stage-assembler.ts:47` |
| `src/context/engine/providers/*` | registered in `orchestrator-factory.ts:43-60` + plugin loader |
| `src/context/rules/canonical-loader.ts` | imported by `StaticRulesProvider`, `cli/rules.ts` |
| `src/execution/escalation/agent-swap.ts` | called from `pipeline/stages/execution.ts:263-287` with hop loop |
| `src/execution/session-manager-runtime.ts` | `closeStorySessions` called from `unified-executor.ts:40,260,264,402`; `closeAllRunSessions` from `run-setup.ts:178` (SIGTERM) and `run-completion.ts:207` |
| `src/session/manager.ts` | instantiated once in `run-setup.ts:155`, threaded everywhere |

---

## Files with load-bearing findings

- `src/context/engine/orchestrator.ts` — **CRIT-1**
- `test/unit/context/engine/orchestrator.test.ts` — CRIT-1 fixture
- `test/unit/context/engine/orchestrator-factory.test.ts` — CRIT-1
- `test/unit/context/engine/pull-tools.test.ts` — CRIT-1
- `test/unit/context/engine/providers/feature-context.test.ts` — CRIT-1
- `src/execution/session-manager-runtime.ts` — H-1 force arg; H-5 idempotency
- `src/session/types.ts` — H-2 state naming
- `src/agents/types.ts` — H-1 `closePhysicalSession` needs `force`
- `src/context/engine/orchestrator-factory.ts:53` — MINOR optional chain
- `docs/reviews/context-engine-review-followups-2026-04-17.md` — outdated claim

---

## Recommended next steps

1. **Fix CRIT-1** — restrict the unknown-provider-IDs check to stage-config-provided IDs, or normalize `request.providerIds` test overrides. One small PR.
2. **Address H-1 (force-terminate)** — add optional `force` param to `closePhysicalSession` in `AgentAdapter` interface + adapter impl; call with `force: true` on crash-handler shutdown path.
3. **Add regression tests** for `closeAllRunSessions` idempotency and for fallback exhaustion.
4. **Split the test suite** or isolate the Bun-crashing file — full `bun test` must exit cleanly before merge.
5. After those, the branch is ready. All ACs flagged as ❌ / ⚠️ in prior reviews are now ✅ with the exceptions noted above (AC-83 force, AC-19 dogfood, AC-16 regression).

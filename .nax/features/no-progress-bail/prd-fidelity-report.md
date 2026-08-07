# Spec Review — Phase 9 (PRD Fidelity)

**Spec:** `docs/specs/SPEC-no-progress-bail.md`
**PRD:** `.nax/features/no-progress-bail/prd.json`
**Reviewed against:** nax repo at `a7ae938a` (branch `feat/no-progress-bail`)
**Planner:** `nax plan --profile cross-agent`, nax v0.77.1, exit 0
**Date:** 2026-08-07
**Verdict:** ⚠️ ready with one major — 0 blockers, 1 major, 1 minor

## Summary

| Check | Result |
|:---|:---|
| 1. Spec AC → PRD AC mapping | ✅ 16/16 spec ACs map; 24 PRD ACs, all traceable |
| 2. Behavioural fidelity + signature reality | ✅ no degradation; no arity contradiction |
| 3. Orphan PRD ACs | ✅ none |
| 4. File-role delta | ✅ a/b/c/d all clean |
| 5. Meta-AC / correction survival | ⚠️ 1 minor (static-gate note) |
| 5c. PRD-AC satisfiability | ⚠️ **1 major** (AC-2.9 / AC-2.10 preconditions) |
| 6. Out-of-scope preservation | ✅ 8/8, none inverted, none contradicted |
| 7. Terminal-cleanup story | n/a — spec has no removals |

## Check 1 — Spec AC → PRD AC mapping

All 16 spec ACs survive. `nax plan` atomically split 8 compound ACs into 24 PRD ACs.

| Spec AC | → PRD (US-001) | Spec AC | → PRD (US-002) |
|:---|:---|:---|:---|
| AC-1.1 | 1 | AC-2.1 | 1 |
| AC-1.2 | 2 | AC-2.2 | 2 |
| AC-1.3 | 3, 4, 5, 6 | AC-2.3 | 3, 4 |
| AC-1.4 | 7, 8 | AC-2.4 | 5 |
| AC-1.5 | 9 | AC-2.5 | 6, 7 |
| | | AC-2.6 | 8 |
| | | AC-2.7 | 9 |
| | | AC-2.8 | 10, 11 |
| | | AC-2.9 | 12, 13 |
| | | AC-2.10 | 14 |
| | | AC-2.11 | 15 |

Counts: US-001 = 9, US-002 = 15, both under `precheck.storySizeGate.maxAcCount: 16`.
Dependencies: US-002 → US-001, matching the spec. No cycles.

## Check 2 — Behavioural fidelity & signature reality

No AC was rewritten into a file-content / grep assertion, vaguened, or stripped of its
asserted arguments. Every PRD AC remains a runtime test. Locus tokens survived:
`withNoProgressBail` ×4, `abortOnNoProgress` ×7, `consecutiveNoProgressToBail` ×9,
`rectificationExhausted`, `runRectification` ×3, `NaxConfigSchema` ×7,
`withIncreasingFailuresBail`, `bailWhen` ×11.

Signature reality — calls named against **existing** symbols, diffed against real code:

| Asserted call | Real signature | Verdict |
|:---|:---|:---|
| `NaxConfigSchema.parse({})` | Zod schema, 1 arg | ✅ |
| `bailWhen(priorIterations)` | `(priorIterations: Iteration<F>[]) => string \| null` (`cycle-types.ts:183`) | ✅ |
| `RectificationResult.rectificationExhausted` | `rectificationExhausted?: boolean` (`types.ts:256`) | ✅ |
| `runRectification` | `(ctx, state, phaseCosts, phaseOutputs, overrides?)` (`rectification.ts:211`) — ACs describe config, not arity | ✅ |

`withNoProgressBail` and the two new `RectificationPhaseOptions` fields are forward
references this spec creates; no existing signature to contradict.

## Check 4 — File-role delta

- **a. `Creates` → `expectedFiles`.** `src/execution/story-orchestrator/no-progress-bail.ts`
  is in US-002 `expectedFiles`, absent from its `contextFiles`. ✅
- **b. `Context Files` → `contextFiles`.** All 10 spec entries present (5 per story) and all
  10 exist on disk. ✅
- **c. Cross-story produced files.** None — the spec lists no upstream-produced file under a
  consumer's `Context Files`. n/a
- **d. Helpful additions.** None; the planner added no extra context files. ✅

## Check 5 — Meta-AC & correction survival

The two spec-review corrections applied during spec-writing (the `bailDetail` field name, and
re-anchoring AC-2.9/2.10 on fix-op dispatch count rather than the unexposed `exitReason`) both
reach `acceptanceCriteria` — not `analysis` only. ✅

### Minor — static-gate verification note dropped

**Spec reference:** Acceptance Criteria, closing "Verification note (both stories)" —
"type-level correctness of the new config fields and the new export is enforced by the
repository's static gate, `bun run typecheck`, not by an acceptance criterion."
**PRD reality:** absent from both `description` fields and from all ACs.
**Assessment:** graded **minor**, not a blocker. This note documents *why no AC exists* rather
than asserting an architectural invariant, and the gate it names runs unconditionally — nax's
pipeline executes lint/typecheck/tests automatically (project `CLAUDE.md`, "Commands"). Nothing
is left unenforced by its loss.
**Recommended fix:** none required.

## Check 5c — PRD-AC satisfiability (Class B trace)

Two PRD ACs are invocation-shaped with **both endpoints already existing** — US-002 ACs 12–14,
asserting that `runRectification` dispatches the rectification strategy's fix operation N times.
Tracing the real path: `runRectification` → builds `FixCycle` (line ~288) → `runFixCycle` →
dispatches `strategy.fixOp` via `wrappedCallOp`. The path is real and reaches the named
operation. ✅ No blocker.

### Major — the guard on the traced path is only half-established by the spec

**Spec reference:** AC-2.9 / AC-2.10 (`docs/specs/SPEC-no-progress-bail.md`, Acceptance Criteria)
**Codebase reality:** `runRectification` returns `{}` immediately unless **two** preconditions
hold (`src/execution/story-orchestrator/rectification.ts:218-224`):

```typescript
const baseValidationPhases = collectRectificationPhases(state);
...
if (!rectification || validationPhases.length === 0) return {};
```

1. `state.rectification` truthy — set only when `execution.rectification.enabled === true`
   (`plan-inputs.ts:422`). **Established** by the spec: US-001 AC-1.4 pins a config with
   `enabled: true`, and that survives into PRD US-001 ACs 7-8.
2. `collectRectificationPhases(state).length > 0`. **Not established anywhere in the spec.**

An implementer building the AC-2.9 fixture from the AC text alone gets an early `{}` return:
`rectificationExhausted` undefined and **0** dispatches, not 3. The AC then fails for a reason
the AC never names, and nax's acceptance diagnosis has no verdict meaning "the criterion is
incomplete" — it would blame the implementation and burn `maxAttemptsTotal` (12) attempts plus
tier escalation.

Graded **major** rather than blocker for two reasons: the enabling flag itself *is* established
(precondition 1), and US-002's `contextFiles` includes
`src/execution/story-orchestrator/rectification.ts`, so the implementer reads the guard directly.
The spec also cites `test/unit/execution/rectification-overrides.test.ts` as the driving harness,
which necessarily sets both preconditions up.

**Recommended fix:** add the precondition to AC-2.9/AC-2.10 — "…with at least one rectification
validation phase collected" — or state it once in US-002's description. Requires a re-plan.

## Check 6 — Out-of-scope preservation

- **a.** All 8 spec `## Out of Scope` bullets present in `prd.outOfScope`, in spec order, none
  dropped or merged. Well under `MAX_OUT_OF_SCOPE_ITEMS` (25). ✅
- **b.** Field present with real exclusions; no sentinel body. ✅
- **c.** No exclusion inverted into an AC — probed all 8 subjects (R1 budget, R4 oscillation, R2
  prompt experiment, `verification/rectification.ts`, `withIncreasingFailuresBail`,
  `classifyOutcome`, reviewer prompts, retroactive measurement): 0 hits across every story's
  `acceptanceCriteria`. ✅
- **d.** No story's scope declaration contradicts a feature-level exclusion. The spec declares no
  per-story `**Out of scope:**` block, so the `US-00N only:` prefix rule is n/a. ✅
- **e.** No orphan exclusions — every `prd.outOfScope` entry traces to a spec bullet. ✅

## Check 7 — Terminal-cleanup story

n/a. The spec contains no removal keywords in a code-deletion sense and declares no
terminal-cleanup story; the work is purely additive.

## Recommendations

1. **(Major)** Pin the second `runRectification` precondition — at least one collected
   rectification validation phase — in AC-2.9/AC-2.10 or in US-002's description, then re-plan.
   This is the one finding that could cost a full rectification cycle at run time.
2. **(Optional)** US-002 sits at 15 ACs against a cap of 16. If AC-2.9/2.10 are expanded per
   recommendation 1, verify the split does not breach the cap — consider moving the two
   integration ACs into a third story.
3. **(None required)** The dropped static-gate note needs no action; the gate runs regardless.

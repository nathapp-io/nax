# Spec Review — Phase 9 (PRD Fidelity)

**Spec:** `docs/specs/SPEC-rectification-oscillation-circuit-breaker.md`
**PRD:** `.nax/features/rectification-oscillation-circuit-breaker/prd.json`
**Reviewed against:** nax repo @ `d3527aa3` · **Date:** 2026-07-17
**Planner:** `nax plan --profile cross-agent`
**Verdict:** ✅ ready — no blockers, no majors

## Summary

- Phases 1–8: passed in the pre-PRD run (spec unchanged since).
- Phase 9: **0 blockers, 0 majors, 2 minors.** All 16 spec ACs map to ≥1 PRD AC; the AC-count growth (16 → 23) is entirely legitimate atomic splitting of compound spec ACs plus one failure-handling materialization. No orphan scope-bleed, no grep/file-content degradation, no hallucinated signatures, file roles correct.

## Spec AC → PRD AC mapping

### US-001 (spec 8 → PRD 11)

| Spec AC | PRD AC(s) | Note |
|---|---|---|
| 1 import+usable | 1 | 1:1 |
| 2 unseen → 0 | 2 | 1:1 |
| 3 record→2, get→2 | 3 + 4 | **split** into return-value and get-value (atomic — improvement) |
| 4 cumulative → 3 | 5 | 1:1 |
| 5 interleave A=3, B=5 | 6 + 7 | **split** per-story assertion (atomic — improvement) |
| 6 runtime field is empty Map | 8 | 1:1 |
| 7 config default enabled+max | 9 + 10 | **split** per field (atomic — improvement) |
| 8 config override → 4 | 11 | 1:1 |

### US-002 (spec 8 → PRD 12)

| Spec AC | PRD AC(s) | Note |
|---|---|---|
| 1 counter helper 2 / 0 | 1 + 2 | **split** (atomic — improvement) |
| 2 increment seam (+1) | 3 | seam preserved (`getOscillations` from rectification path) |
| 3 exhausted+count2 → pause | 4 | seam preserved (`decideStageAction` + config gate) |
| 4 reason has count + "oscillat" | 5 + 6 | **split** (atomic — improvement) |
| 5 count1 < max → escalate | 7 | regression guard preserved |
| 6 enabled=false → escalate | 8 | preserved |
| 7 normal count0 → escalate | 10 | preserved |
| 8 notify sent; throw→still pause | 11 + 12 | **split** (atomic — improvement) |
| *(Failure Handling prose)* | 9 | **materialized:** runtime-counter-absent → escalate (fail-open). Traces to spec § Failure Handling, not net-new scope. |

## Findings

### Minor — `ctx.storyId` vs `ctx.story.id` (US-002 PRD AC3)
**PRD:** AC3 references `getOscillations(ctx.runtime.rectificationOscillations, ctx.storyId)`.
**Spec:** Integration block used `ctx.story.id`.
**Reality:** both are real, idiomatic accessors — `ctx.storyId` is used 15× in `run-phase.ts` (the sibling `adversarialIterations` site), `ctx.story.id` 29× in `post-run.ts`. Not a hallucination; the increment site (`rectification.ts`/story-orchestrator) idiomatically uses `ctx.storyId`, the halt site (`post-run.ts`) uses `ctx.story.id`. **Fix:** none required — implementer uses whichever the local `ctx` exposes.

### Minor — US-002 PRD AC9 has no 1:1 spec AC
AC9 (runtime counter absent → escalate) originates from the spec's § Failure Handling "fail-open on missing config/runtime" rather than a numbered spec AC. This is a **positive** materialization (a failure-handling requirement becomes a testable runtime AC), not scope-bleed. Recorded for traceability; no action.

## File-role delta (contextFiles vs expectedFiles)

- **US-001 `expectedFiles`** = `oscillation-store.ts` + its test — files US-001 authors. ✅ Correct (not in `contextFiles`).
- **US-001 `contextFiles`** = `runtime/index.ts`, `schemas-review.ts`, `execution/index.ts` (all modified-in-place existing files), `adversarial-iteration-store.ts` (pattern to mirror), `runtime.test.ts`. ✅ All exist on disk; correct as reads.
- **US-002 `contextFiles`** includes `src/execution/oscillation-store.ts` — created by **US-001** (upstream dependency). ✅ Correctly kept in the consumer's `contextFiles` (exists at US-002's runtime because deps run first) — the dependency-aware `normalizeCreatedContextFiles` handled it right. **Not a finding.**
- **US-002 `expectedFiles`** = only the new test file; `rectification.ts`/`post-run.ts` are modified-in-place → correctly in `contextFiles`. ✅

## Checks that passed clean
- Behavioural fidelity: every PRD AC remains a runtime `[unit]`/`[integration]` test; none degraded into file-content/grep assertions.
- Signature reality: `recordOscillations(store,id,delta)` (3-arg), `getOscillations(store,id)` (2-arg), `decideStageAction` return-`action` checks — all match the spec-defined / existing signatures. No arity hallucination.
- Orphan ACs: none introducing new enums/status codes/config keys beyond the spec.
- Meta-AC survival: spec had no pure meta-ACs; Out-of-scope declarations correctly not encoded as ACs.
- Terminal-cleanup: n/a (no removal keywords).

## Verdict

**✅ Ready for implementation.** The spec→PRD transformation preserved every load-bearing assertion and improved AC atomicity. Proceed to US-001.

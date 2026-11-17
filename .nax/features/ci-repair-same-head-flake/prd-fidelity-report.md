# Spec Review (PRD fidelity) - ci-repair-same-head-flake
**Spec:** .nax/features/ci-repair-same-head-flake/spec.md
**PRD:** .nax/features/ci-repair-same-head-flake/prd.json
**Reviewed against:** /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax at 8e77f6692
**Date:** 2026-11-17
**Phases run:** 1 of 9 (--phase 9: phases 1-8 skipped by request)
**Verdict:** faithful (0 blockers, 0 majors, 2 minors)

## Summary
- Phase 9: 64 spec ACs matched to 64 PRD ACs (US-001 17/17, US-002 19/19, US-003 17/17, US-004 11/11) plus 5 PRD-only ACs; 4 stories' dependency sets; 9 out-of-scope bullets; 3 modifiedFiles paths (4 spec bullets); 2 Creates and 17 Context Files entries; 4 workdirs; 12 forward-reference symbols re-swept; 4 invocation-shaped ACs given a satisfiability check - 0 blockers, 0 majors, 2 minors.

## AC survival
- Every spec AC appears at the same ordinal in its own story, with its numbers, literals and argv intact. These all match: `jobId: "501"`, the `scope[]=success&per_page=100` path, the 77/81/82/83/84 sibling lists, `CI_ERROR_POLL_LIMIT`, `MAX_FAILED_CHECKS`, the five-poll lag case, the ledger note, the log line with `storyId: "_run"` first, the exact facts-paragraph strings, and the gh and glab argv strings.
- Wording changes are cosmetic ("For that GitLab fixture, readFailedChecks runs ..."). The one real rewording is US-004 AC7, which says "exactly equal to `CI check e2e failed:\n` followed by markdownFence("boom")". That is the spec's "fenced excerpt and nothing after it", made more precise. `markdownFence` exists in `src/workflow/ci-repair-steps.ts:16`.
- No AC became a grep or file-content assertion. No meta-AC was lost.
- PRD-only ACs, all derived from spec prose or the Failure Handling table, none contradicting the spec:
  - US-001 AC18: unparseable or non-array sibling reply.
  - US-001 AC19: sibling without an id does not count toward the three.
  - US-002 AC20: `rerun` throws for the second check.
  - US-002 AC21: `rerun` throws for the first check.
  - US-003 AC18: `run` throws.

## Constants and constraints
- `CI_SAME_HEAD_SETTLE_POLLS = 3`, `CI_SAME_HEAD_SIBLING_PIPELINES = 3` (constant in `src/forge/ci-failures.ts`) and the `MAX_FAILED_CHECKS` cap rule are all in the descriptions.
- The `CI_REPAIR_NON_REPRODUCIBLE_OUTCOME` text is verbatim.
- The ledger note, the log line, the three facts sentences and the 600/578 line-limit constraints are verbatim.

## Dependencies and order
- US-001 has `[]`, US-002 has [US-001], US-003 has [US-001, US-002], US-004 has [US-001, US-003]. These match the spec, with no invented edges.
- Story order is the same as the spec's.

## Files
- **workdir:** `packages/nax` on all four stories, `workdirSource: "stated"`.
- **expectedFiles:**
  - US-002: `ci-wait-same-head.ts` and its test.
  - US-003: `ci-same-head.ts` and its test.
  - US-001 and US-004: none.
  - No self-created file is in `contextFiles`.
- **contextFiles:** every spec entry is present. The planner added three existing files, which is a helpful addition and not a finding:
  - `src/forge/index.ts` (US-001)
  - `src/forge/ci-failures.ts` (US-002)
  - `src/prompts/index.ts` (US-004)
- **modifiedFiles:**
  - US-003 has both paths, with reasons verbatim.
  - US-001 has `ci-failures-gitlab.test.ts` with the first reason verbatim.
  - US-002 and US-004 are empty, as the spec says ("None").

## Out of scope
All 9 spec bullets are present in `outOfScope`, verbatim and in order. None became an AC. Story "Scope - Out" text does not contradict any of them. The spec has no story-scoped deferrals, so the `US-00N only:` rule does not apply.

## Findings

### BLOCKER
None.

### MAJOR
None.

### MINOR

1. **US-001 `modifiedFiles` - the second spec bullet has no entry of its own.**
   - **Spec:** `### Modifies` under US-001 has two bullets for the same path `ci-failures-gitlab.test.ts`. The second is the "US-002 AC-11 preserves unavailable Actions logs ..." bullet, whose invariant is `jobId: "991"` with every other field unchanged.
   - **PRD:** `userStories[0].modifiedFiles` has one entry, carrying the first reason only. The AC-11 content survives only as paraphrase in the description's "Test implementation" paragraph (`{ name: "build", excerpt: "(log unavailable: boom)", logUnavailable: true, jobId: "991" }`). It is not verbatim in a reason.
   - **Impact:** low. The path is authorised and the instruction reaches the implementer through `description`.
   - **Fix:** edit the spec if exact fidelity is wanted. Fold both reasons into one bullet, since the extractor appears to key by path. Otherwise accept as is. Do not hand-edit the PRD.

2. **US-002 description reconciles an internal spec inconsistency (informational).**
   - **Spec:** the state sentence says the per-wait state tracks "whether any poll since the re-run was not `failed`". Step 3 and AC18 say only `green` or `waiting` mark progress, and an `error` poll does not.
   - **PRD:** says `green` or `waiting` (an `error` poll does not mark progress). This matches AC18 and Step 3, so the PRD is the safer reading.
   - **Fix:** edit the spec so the state sentence reads "was `green` or `waiting`". Keep the PRD as is. It needs no re-plan.

## Checks run
- **Signature reality:**
  - `ciRepairPlan(env, rec, out, head)` as stated in the US-004 description matches `src/workflow/ci-repair-steps.ts:113`.
  - `waitForCi(fc, forge)` at `finalize.ts:411` is the baseline for the new third parameter.
  - `CI_ERROR_POLL_LIMIT` exists at `ci-wait.ts:50`.
- **PRD-AC satisfiability:** the invocation ACs are US-003 AC8-12 (enter at `publish(fc, input)` and reach the `waitForChecks` stub). They are the same as the spec's and add no new endpoints, so no re-trace is needed.
- **Forward-reference drift:** `sameHeadRerunFor`, `SameHeadRerun`, `sameHeadRerun`, `sameHeadReruns`, `ciReruns`, `passedOnSameHead`, `jobId`, `CI_SAME_HEAD_SETTLE_POLLS`, `CI_SAME_HEAD_SIBLING_PIPELINES`, `_ciSameHeadDeps`, `CI_REPAIR_NON_REPRODUCIBLE_OUTCOME` and `ci-wait-same-head.ts` are spelled identically across all PRD ACs and descriptions. No drift.
- **analysis-only corrections:** none found. All key content is in `description` or `acceptanceCriteria`.

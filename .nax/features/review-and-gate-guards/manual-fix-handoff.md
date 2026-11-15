# Manual spec-fix handoff: review-and-gate-guards

## Status and scope

The spec bundles GitHub #2924 and #2923. The approved approach remains unchanged: clarify inconsistent branch-review verdicts without synthetic fix findings; hold unresolved inconsistencies as explicit draft-readiness reasons; detect repeated gate output with default threshold 100; keep silence detection opt-in and disabled by default.

**Current status: NOT READY for planning.** Two automated spec-fix rounds have been used. This document is a handoff for human edits, not an applied patch or another spec-fix round. Neither the spec nor product code was changed to create this document.

> **Round-3 status annotation (added after this handoff was written).** The "two rounds" figure above is a **default budget, not a hard maximum**: the user explicitly approved an additional fix/review round, and round 3 has been applied directly to `spec.md`. All seven findings below were addressed in that round — B1 by naming the `branch-review` `produces` addition and authorizing `feature-graph.test.ts` under US-009; B2 and D1 by moving every delivered-value assertion to US-013 and re-atomizing US-012 to 23 assertions and US-013 to 13, both under the 24 cap; D2 by adding `_branchReviewRetryDeps` and `_approvalDeps` seams with captured production-use anchors for all three exports; M1 by defining a strict `isPlainRecord` predicate for the opt-in handoff only, with accepted and rejected classes; M2 by a derived-arm criterion captured at command execution through a new `_scopedLintDeps.runQualityCommand` entry; M3 by naming the existing runtime contracts and `test/unit/workflow/branch-review-sliced.test.ts` as the outer deadline/abort preservation anchor. The approved single #2924/#2923 bundle, the repeated-line default of 100 and opt-in silence of 0 are unchanged. `nax spec lint` reports 0 blocking, 0 errors, 1 advisory (13 stories over the 7-story target). This annotation records status only; the findings text below was not rewritten, and no review report was edited.

Source of findings: `spec-review-revalidation.md` in this directory. That review confirmed four blockers and three major findings; none was withdrawn. Its spec baseline SHA-256 is `207e8275bf45c7bf6be8c7d7ce0c03b624d1a4bd11fd49827c3ca5f912b82811`. Line references below refer to that baseline and will shift after editing.

Edit `spec.md`, addressing all seven items below. The snippets are proposed wording for a human to apply and reconcile, not reviewed final specification text.

## 1. B1 — Authorize the branch graph output change

**Owner:** US-009. **Spec references:** lines 377–387, 598–602, 787–803.

The step graph rejects both setting and clearing `reviewMismatch` unless the branch-review node declares that output. Adding the declaration also changes an exact-set test.

- [ ] Name `reviewMismatch` as an additional `branch-review` output in the Design integration contract for `packages/nax/src/workflow/feature-graph.ts`.
- [ ] Add this entry under the existing **US-009** group in `### Modifies`:

```markdown
- `packages/nax/test/unit/workflow/feature-graph.test.ts` — extend the exact expected `branch-review` produces set with `reviewMismatch`, authorizing both persistence and explicit clearing through the graph; preserve all existing outputs, node kinds, exits and transitions.
```

Do not bypass graph validation or mutate the record outside the declared patch path.

## 2. B2 — Move fallback delivery to its implementing story

**Owners:** US-012 and US-013. **Spec references:** lines 413, 425–427, 627, 839–841.

US-012 can record a last-parseable fallback in the retry decision, but real `callOp` does not deliver it after a null parse until US-013 implements the opt-in handoff.

- [ ] Keep the strategy-level fallback-recording assertion in US-012.
- [ ] Move the integration assertion for retaining a verdict after malformed clarification and exhausted shape repair from US-012 to US-013.
- [ ] Assign the corresponding real-`callOp` seam and branch-operation test authorization to US-013. If a test file is touched by both stories, describe each story's separate permission precisely.
- [ ] Preserve `US-013 depends on US-012`; do not introduce a reverse dependency.

Suggested US-013 criterion:

```markdown
- [integration] Through real `callOp(workflowBranchReviewOp)`, a parseable inconsistent verdict followed by malformed clarification and exhausted malformed shape repair returns the last parseable verdict through the opt-in null-parse fallback handoff.
```

Use the existing controlled agent/reply harness, not live provider calls.

## 3. D1 — Recount US-012 as atomic assertions

**Spec references:** lines 255, 270–272, 415, 834–852. **Hard cap:** 24 assertions per story.

The baseline has 19 AC bullets but at least 25 independently falsifiable assertions. The revalidation identified these extra assertions:

| Baseline line | Separate outcomes currently combined |
| --- | --- |
| 834 | Clarification is sent; the same session handle is reused. |
| 835 | Prompt requests a defect or corrected verdict; it requests a complete branch-review object. |
| 843 | Coverage allowance is preserved; diff-part references are retained. |
| 844 | Only coverage responses determine progress; other turns do not spend the counter. |
| 845 | Active allowance is not reset; stopped coverage is not reopened. |
| 852 | No parseable reply yields null; the outer wrapper reports skipped review. |

- [ ] Separate these outcomes for counting, even if tests share fixtures.
- [ ] After moving B2's delivery assertion, allocate outer-wrapper and handoff assertions to the story that can implement them independently.
- [ ] Account for new seam assertions from D2 and fallback-domain assertions from M1 before claiming headroom.
- [ ] Recount every changed story; aim below 24 rather than exactly at the cap.
- [ ] Update the sizing table, story text, AC ownership, Seams, Context Files, Modifies and dependency references consistently.

Do not fix sizing by hiding multiple assertions in a longer bullet or silently dropping required behavior. The 13-story advisory is not a hard seven-story cap. Generated PRD description size cannot be verified before planning.

## 4. D2 — Add production-use anchors for three exports

The direct behavior and final-value tests currently allow duplicated inline logic while the new exports remain unused.

- [ ] For `makeMismatchClarificationStrategy`, add an injected captured-call assertion showing that real `callOp(workflowBranchReviewOp)` reaches the factory through the production retry resolver with the intended options.
- [ ] For `buildWorkflowBranchVerdictMismatchRetry`, trigger a mismatch through the same production entry and capture the builder invocation used to obtain the clarification prompt.
- [ ] For `branchMismatchReasons`, trigger the production feature review/publish path and capture use of the shared formatter with the persisted mismatch kinds.
- [ ] Retain each export's direct behavioral anchor; production-use assertions are additional anchors, not replacements.
- [ ] Update `### Seams` and the owning stories' ACs and assertion budgets. Use injected dependency seams consistent with repository conventions, not module mocks or source-text searches.

The existing `createGateStallMonitor` and `resolveStallDetection` anchors were accepted in this revalidation; do not redesign them merely to address these three gaps.

## 5. M1 — Specify fallback validation accurately

**Owner:** US-013. **Spec references:** lines 214–218, 425, 856.

The existing throwing-path fallback guard rejects null and non-objects but accepts arrays and class instances. It is not a strict plain-object guard despite its comments.

Recommended narrow choice:

- [ ] Define a strict plain-object predicate for the new opt-in null-parse handoff only. State whether objects with `Object.prototype` and null prototypes are accepted; reject arrays and class instances.
- [ ] Replace the inaccurate statement that this is the same plain-object guard used by the existing throwing path.
- [ ] Add real-`callOp` coverage for accepted and rejected fallback classes, specifying the rejected-value outcome explicitly.
- [ ] Preserve legacy non-opt-in fallback behavior and verify/recover ordering; do not broaden this into a global dispatch refactor.

Alternatively, deliberately retain the broader object contract and remove every claim of strict plain-object validation. Choose one contract consistently throughout Design and ACs; do not leave both alternatives in the final spec.

## 6. M2 — Cover the derived scoped-lint arm

**Owner:** US-008. **Spec references:** lines 183 and 770.

The Design names degraded, template, derived and full-lint forwarding. The criterion names only template, full and degraded. The supported derived-command/no-template path is distinct.

- [ ] Add a supported derived-command/no-template fixture to the existing policy-forwarding parameterization.
- [ ] Establish the non-degraded branch guards, so the test actually reaches the derived path.
- [ ] Capture policy beyond `_scopedLintDeps.runLintCommand`, demonstrating that the derived call forwards it to command execution.

This can be another fixture for the existing behavior rather than an unrelated new story. Preserve the scoped-lint test-edit authorization already added.

## 7. M3 — Anchor review timeout and abort preservation

**Spec reference:** failure-handling row around line 245; US-012 criteria around 834–852.

Existing timeout and abort protections **and tests exist**. The finding is that the normative failure-handling row lacks an explicit acceptance/preservation anchor, not that the implementation has no protection.

Choose a specific preservation route:

- [ ] Name `packages/nax/test/unit/workflow/branch-review-sliced.test.ts` as the existing runtime anchor for package failure, abort propagation and review timeout overriding a returned parseable verdict.
- [ ] Explicitly connect that anchor to the failure-handling row and owning story's verification contract; state that the new retry composition must not extend or bypass the outer deadline/abort behavior.
- [ ] If new retry interleavings need additional scenarios, place them at the outer branch-review entry point and count their independent assertions in the correct story.

A generic instruction to run the suite or a 21-send inner-loop bound does not establish the outer deadline contract. Do not pack several new assertions into an already-full US-012 bullet.

## Human completion checklist

- [ ] All four blockers and three major findings addressed in `spec.md`.
- [ ] No change to the approved bundle, default repetition threshold or opt-in silence policy.
- [ ] Each story can pass its own gates before dependent stories run.
- [ ] Each changed story has at most 24 independently testable assertions.
- [ ] New callable exports have direct behavior and captured production-use anchors.
- [ ] Every required change to an existing exact assertion has a narrowly scoped Modifies entry.
- [ ] Dependencies, story IDs, file-role groups, Seams and sizing prose agree.
- [ ] Run deterministic lint from `repos/nax`:

```sh
nax spec lint .nax/features/review-and-gate-guards/spec.md
```

A clean lint result is not review clearance. The previous review halted at Phase 2, with Phase 4 completed as an exception; later applicable phases still need review after the blockers are corrected.

Once human edits are complete, request review of the updated spec. Planning remains conditional on review clearance; the requested plan profile is `native-codex-dsm`. Do not start `nax run` without its separate explicit approval. No plan or run was launched by creation of this handoff.

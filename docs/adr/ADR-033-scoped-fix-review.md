# ADR-033: Scoped Fix Review

**Status:** Proposed, 2026-09-26
**Amends:** ADR-024 §3 ("Deterministic-only re-validation — never re-run the LLM reviews")
**Builds on:** ADR-021 (Finding Type SSOT), ADR-022 (Fix Strategy + Cycle), ADR-024 (Non-Blocking Adversarial Fix)
**Related:** #2229 (NBF edits source after review with no spec re-check), #1359 (closed 2026-09-26: no blocking gate on out-of-scope findings)
**Implementation:** `.nax/features/fix-review/spec.md`

---

## Context

A fix pass edits code after the reviewers have looked at it. Two fix paths do so with no check
that the edit still agrees with the story's acceptance criteria:

| Fix path | Re-checked against the ACs today |
|---|---|
| `autofix-implementer`, `full-suite-rectify`, `repo-scoped-test-fix` | yes: full `semantic-review` + `adversarial-review` re-run |
| `autofix-test-writer` (blocking cycle) | no: `adversarial-review` only |
| non-blocking fix (NBF, ADR-024) | no: deterministic gates only |

ADR-024 §3 stripped both LLM reviews from NBF deliberately: a review red on near-identical code may
be reviewer variance, and re-running a finding-producing critic re-seeds and loops. Its
Consequences section named the residual: "Kept fixes ship un-reviewed ... the residual is real."

#2229 is that residual observed. On canary.19 (`approvals-cli`, 6 stories) NBF was kept in 5 of 6
stories. On US-002 it acted on two adversarial advisories and committed:

- `mkdir(dirname(path), { recursive: true })` in `removeApprovals`, which directly contradicts the
  spec's removal rule 4 ("no write, no file or directory created"); and
- a change to `withPathFileLock` in `src/utils/path-file-lock.ts`, a shared primitive outside the
  feature's declared scope that affects every lock caller.

Every gate stayed green because the tests pin the ACs, not every rule. A manual review after the run
reverted both. Other NBF passes in the same run were genuine improvements, so the defect is not NBF
itself but that good and bad kept passes are indistinguishable.

Two ways of closing the gap were rejected:

- **Re-run `semantic-review` as-is (the fix #2229 proposed).** On `main`, a revalidation review is
  re-pointed at the story start ref at dispatch (`refreshReviewInputForDispatch`), so it re-reviews
  the whole story on every kept pass. It produces open-ended findings, so a variance red on code the
  fix never touched discards a good fix, and on the blocking path it seeds new work unrelated to the
  fix.
- **Re-run `adversarial-review`.** Its remit is to find what is missing, which is exactly the
  re-seeding loop ADR-024 §3 exists to prevent.

## Decision

Introduce a **scoped fix review** that judges only what a fix pass changed, in two ordered parts:

1. **Deterministic scope check.** A non-test file the fix changed must be one of: a file the story
   had already changed before the fix, a file the story declares (`contextFiles`, `expectedFiles`,
   `modifiedFiles`), or a file named by a finding that seeded the fix. Any other non-test file is
   out of scope. No LLM call is made when the scope check fails.
2. **Verdict-only LLM check.** A fresh `reviewer-fix` session receives the fix diff (embedded), the
   story's acceptance criteria, its `description` and `outOfScope`, and the findings that seeded the
   fix, and returns one verdict: pass, or fail with a reason and, when the contradicted rule is an
   AC, its index. It cannot return a list of new findings, so it cannot re-seed the cycle. The
   `description` is required: in #2229 the contradicted rule ("neither the data file nor its parent
   directory is created") existed only in the spec's Design prose, and the ACs pinned only that no
   file is created, which the `mkdir` fix still satisfied.

Wiring:

- **NBF:** runs after the `sourceDiffCap` check on a pass that would otherwise be kept. Anything but
  a pass (scope fail, contradiction, dispatch or parse error) restores the adversarial-passed
  snapshot. It never fails the story. This amends ADR-024 §3: NBF's re-validation is no longer
  deterministic-only, but the floor ADR-024 §5 guarantees ("worst case is nothing changed") holds,
  because a fix-review failure can only restore, never demote.
- **`autofix-test-writer` in the blocking cycle:** runs after each dispatch of that strategy. Only a
  contradiction that names an acceptance criterion becomes a finding, targeted at the test writer, in
  the next iteration. A scope violation, a contradiction of description or `outOfScope` prose only,
  and a dispatch or parse error are logged and add no finding. This follows the #1359 ruling
  (2026-09-26): out-of-scope signals get no blocking gate, a scope exclusion can forbid the only
  fixing edit, and invariants that must hold belong in ACs, where blocking is already grounded.
- `review.fixReview.enabled` defaults to `true`. `review.fixReview.model` is optional and falls back
  to `review.semantic.model`, then `"balanced"`: the check needs the same judgement as the semantic
  reviewer, and both of its error directions are costly (a false pass ships the #2229 defect, a false
  fail discards a good fix).

The full semantic and adversarial re-runs on `autofix-implementer` and `full-suite-rectify` are
unchanged.

## Consequences

- **Variance now has a cost on NBF: a lost good fix.** ADR-024 §3 traded that away for zero LLM
  involvement; this ADR accepts it because the alternative, silently shipping spec contradictions,
  was observed. The cost is bounded to one fresh session per pass that would otherwise be kept.
- **Variance on the blocking path costs one extra test-writer iteration**, counted against the
  existing per-strategy and total attempt caps, so it cannot loop unboundedly. Its finding carries a
  stable rule (`fix-review:AC-<n>`), so recurrence and oscillation accounting see it like any other
  finding.
- **The scope check is not a story-scope policy.** It only restores NBF passes (never blocks) and
  only warns on the blocking path. #1359 ruled out a blocking gate on out-of-scope edits in a
  story's own implementation, and this ADR does not reopen it.
- **New audit reviewer kind `fix`.** Every LLM verdict is recorded in review-audit, so a kept NBF
  pass is always followed by a `fix` record.
- **Fix-review findings reuse `source: "semantic-review"`** (category `fix-review`) instead of a new
  `FindingSource`, so they reach the test-writer prompt through the existing source-to-check mapping.

## Alternatives considered

- **Status quo (ADR-024 §3 unchanged).** Rejected on the #2229 evidence.
- **Whole-story `semantic-review` on NBF.** Rejected: see Context.
- **Replace the full re-review on `autofix-implementer` with the scoped review.** Cheaper, but those
  paths fix blocking findings. Deferred until fix-review's variance is measured on real runs.

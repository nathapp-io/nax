# ADR-022 Phase 7 Post-Verification — TDD Verifier Boundary

**Date:** 2026-05-03
**Status:** Companion verification note for in-progress ADR-022 phase 7
**Scope:** `quality.autofix.cycleV2` migration, specifically `tdd-verifier` findings and verdict handling
**Parent plan:** [2026-05-02-adr-022-implementation-plan.md §9](./2026-05-02-adr-022-implementation-plan.md#9-phase-7--autofix-migration)

---

## 1. Background

During phase 7 migration, the TDD verifier prompt/audit surfaced semantic-review-style critical findings:

- Missing Prisma schema models
- Acceptance criteria not met
- Hash comparison correctness issues
- Broad role-enforcement and code-quality concerns

The same run log reported:

- `Isolation maintained with warnings`
- `Three-session TDD complete`
- `success: true`
- `verdictAvailable: false`

This mismatch exposed a role-boundary bug: the verifier was being prompted and categorized like a semantic reviewer while the orchestrator log still treated the role as TDD isolation/integrity verification.

## 2. Root Cause

Two issues caused the overlap:

1. **Prompt role drift**

   The verifier prompt asked the agent to verify acceptance criteria, broad code quality, and implementation correctness. Those responsibilities belong to semantic/adversarial review, not the third TDD session.

2. **Context leak**

   `runTddSessionOp()` set `includeContext = false` for the verifier, but still passed `constitution` and v2 `ContextBundle` through to `runTddSession()`. This allowed the verifier to receive broad feature/constitution context even though the role was intended to be narrow.

## 3. Correct Verifier Scope

For ADR-022 phase 7, `tdd-verifier` findings must be limited to TDD integrity:

- story-scoped tests fail
- implementer loosened, deleted, or bypassed test assertions
- implementer made illegitimate test-file modifications
- isolation or handoff integrity failed

The verifier must not be a blocking source for:

- acceptance criteria completeness
- implementation architecture
- general code quality
- security concerns unless they are directly expressed as test tampering or scoped-test failure

Those findings belong to semantic/adversarial review producers and their phase 7 autofix strategy routing.

## 4. Phase 7 Migration Checks

Before merging phase 7, verify these invariants:

- `tdd-verifier` strategy selectors only match TDD integrity findings.
- `tdd-verifier` does not route AC/quality advisory fields into blocking autofix findings.
- `approved: false` verifier verdicts block only when tests fail or test modifications are illegitimate.
- AC/quality fields in `.nax-verifier-verdict.json` are treated as advisory or ignored for TDD failure categorization.
- Verifier prompt inputs exclude `constitution`, legacy feature context, and v2 push/pull context.
- Verifier may write `.nax-verifier-verdict.json`; it must not apply source/test fixes.
- Shadow-mode reports distinguish `tdd-verifier` integrity findings from semantic/adversarial findings.

## 5. Recommended Tests

Add or keep regression coverage for:

- verifier prompt input boundary: no `constitution`, no legacy feature context, no v2 `ContextBundle`
- verifier prompt wording: TDD handoff integrity, not semantic acceptance review
- verdict categorization:
  - failing tests -> `tests-failing`
  - illegitimate test modifications -> `verifier-rejected`
  - AC not met only -> advisory success
  - poor quality only -> advisory success
- phase 7 strategy routing:
  - `tdd-verifier` integrity finding routes to verifier/autofix handling
  - semantic AC finding routes through semantic/adversarial autofix handling, not verifier

## 6. Post-Migration Audit

After phase 7 lands, inspect prompt audit and cycle shadow output for at least one three-session TDD story:

- prompt audit file matching `*-verifier-run-*.txt`
- `.nax-verifier-verdict.json` before cleanup, when available
- `.nax/cycle-shadow/<storyId>/<timestamp>.json`
- TDD logs around `Isolation maintained`, `Verifier verdict`, and `Three-session TDD complete`

Expected outcome:

- verifier prompt is narrow and does not include constitution or broad feature context
- verifier verdict cannot reject solely on semantic AC/quality findings
- cycle shadow uses fresh validator findings and does not replay stale verifier output
- semantic/adversarial findings remain the source of broad correctness and quality fixes

## 7. Rollback Guidance

If phase 7 produces verifier/semantic overlap again:

1. Keep `quality.autofix.cycleV2` default off.
2. Preserve legacy autofix behavior.
3. Compare shadow reports for `tdd-verifier` versus semantic/adversarial routing.
4. Fix the finding-source mapping before enabling the flag.

Do not widen verifier context or restore AC/quality blocking in verdict categorization as a rollback shortcut.

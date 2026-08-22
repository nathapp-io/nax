# Code Review: `fix/fail-open-gates` branch (P0+P1 fixes)

**Date:** 2026-08-22
**Reviewer:** Claude (self-review of own implementation work)
**Scope:** `git diff main...HEAD` — 10 commits implementing the P0 and P1 findings from
`docs/20260821-review-full-codebase.md`
**Baseline:** `bun run typecheck` clean, `bun run lint` clean, full suite green
(13,942 unit + 1,135 integration + 38 UI tests, 0 failures)

---

## Overall Grade: A- (91/100)

| Dimension | Score | Rationale |
|:---|:---|:---|
| Security | 19/20 | Every fail-open hole named in the source review is closed at its actual root (parse boundary, schema, switch default) rather than patched at a symptom site. No new injection/traversal surface introduced. |
| Reliability | 19/20 | Each fix traces to a concrete failure scenario and includes a regression test that fails on the pre-fix code. One genuine test-fixture regression (TDD mock agent) was caught by the full suite and fixed in the same branch. |
| API Design | 18/20 | New surface (`loadJsonFileStrict`, `applyReviewsFailedOpen`, `validateProfileName` export) is minimal and mirrors existing conventions (`_deps`-free, `NaxError` + cause chaining, options-object-free where arity stayed ≤3). |
| Code Quality | 18/20 | Comments consistently explain *why*, not *what*; two duplicate `normalizeSeverity` implementations were consolidated to one. One file (`post-run.ts`) required a same-commit extraction to stay under the 600-line limit — handled cleanly via a new sibling file rather than padding comments to fit. |
| Best Practices | 17/20 | Followed the review's own decision register (D-1…D-24) faithfully, including catching and correcting one landmine the register itself didn't account for (see BUG-6 below). One design choice (whole-string `NOT` negation check) took the broader of two sanctioned options without documenting the narrower alternative was available. |

**Summary.** This is a tightly-scoped, well-tested implementation of 12 findings (9 from
the priority table plus BUG-40, which the SEC-5 fix's own ordering made unavoidable to
also fix). Every fix is traceable to the specific line(s) the source review cited, every
fix has a dedicated regression test asserting the pre-fix behavior would have failed, and
the one place an author-introduced landmine could have shipped silently (BUG-6 below) was
caught by running the full suite before considering the branch done. No CRITICAL or HIGH
findings. Two LOW findings are documented below for the record; neither blocks merge.

---

## Findings

### 🟢 LOW

#### STYLE-1: Whole-string `NOT` negation check is broader than necessary
**File:** `src/tdd/verdict-reader.ts:98`

```ts
const isNegated = /\bNOT\b/.test(verdictStr);
const approved =
  ...
  (verdictStr.includes("ALL ACCEPTANCE CRITERIA MET") && !isNegated) ||
  ...
```

The source review's BUG-1 fix offered two options: bail on `/\bNOT\b/.test(verdictStr)`
(checked anywhere in the string), or match `"ALL ACCEPTANCE CRITERIA MET"` only when not
immediately preceded by `"NOT "`. This implementation took the first (broader) option. A
verdict string containing an unrelated standalone "NOT" elsewhere (e.g. `"VERIFIED — did
NOT need to touch config, ALL ACCEPTANCE CRITERIA MET"`) would be denied approval via this
disjunct even though the criteria phrase itself isn't negated.

**Risk:** Low — this only affects the `includes("ALL ACCEPTANCE CRITERIA MET")` disjunct;
the `startsWith("VERIFIED")`, exact `"PASS"/"PASSED"/"APPROVED"`, and `obj.approved===true`
paths are unaffected. The failure direction is also the safe one (an edge case could
wrongly withhold approval, never wrongly grant it) — consistent with BUG-1's fail-closed
intent.

**Fix (optional, not blocking):** Narrow to a proximity check, e.g.
`/\bNOT\s+ALL ACCEPTANCE CRITERIA MET\b/.test(verdictStr)`, if false-negative reports
surface in practice.

#### STYLE-2: Metrics quarantine treats any load failure as "corrupt," not only parse failures
**File:** `src/metrics/tracker.ts` (`loadExistingMetricsOrQuarantine`)

`loadJsonFileStrict` can throw for reasons other than a JSON syntax error (e.g. a
transient permissions error, or the file being deleted between the `existsSync` check and
the read). `loadExistingMetricsOrQuarantine`'s `catch` treats every such throw as
"corrupt" and attempts to rename the file aside.

**Risk:** Low — the fallback for a failed rename already degrades gracefully (log +
continue with empty history, per the existing `renameErr` branch), and a permissions
error recurring on `saveJsonFile`'s own write immediately after would surface on its own.
No data loss beyond what BUG-10 already accepted as the tradeoff (telemetry, not
correctness).

**Not fixing:** distinguishing "parse failure" from "other I/O failure" would require
`loadJsonFileStrict` to expose a typed error subclass, which is more surface than this
fix's scope justifies for a telemetry path.

---

## Notable positive: BUG-6 (self-caught, not in the source review)

While validating BUG-1's fix against the full suite (not just the targeted unit file),
four integration tests in `test/integration/tdd/story-orchestrator-{core,lite}.test.ts`
began failing. Root cause: the shared `createMockAgent` test helper
(`test/integration/tdd/_tdd-test-helpers.ts`) synthesized a verifier response containing
only `{success, filesChanged, approved}` — no `tests` evidence — relying on the pre-fix
behavior where `allPassing` was seeded from `approved`. BUG-1's fix correctly stopped
accepting that shorthand.

This was **not called out in the source review** (which reasons from production code
paths, not test fixtures) and would have been an easy regression to ship if `bun run test`
hadn't been run before considering the branch complete. Fixed in the same branch by adding
real `tests: {allPassing, passCount, failCount}` evidence to the shared fixture. Flagged
here as a positive process note, not a finding — the discipline of running the full suite
(not just the file under test) before each commit is what caught it.

---

## Verification Methodology

Manual line-by-line diff review (`git diff main...HEAD`) across all 41 changed files,
grouped by commit/finding. Each fix cross-checked against:
1. The specific decision (D-1…D-24) and evidence cited in
   `docs/20260821-review-full-codebase.md`.
2. Whether the accompanying regression test would actually have failed on the pre-fix
   code (verified during implementation, not re-derived here).
3. Downstream consumers of changed types/schemas (e.g. `InteractionConfig`'s
   `defaults.fallback` becoming optional was traced through every read site:
   `triggers.ts`, `init.ts`, and the CLI logger call).
4. Full-suite pass (`bun run test`), not just the targeted test files, to catch fixture
   regressions like BUG-6 above.

No findings required a fix as part of this review — both LOW items are documented for
awareness and left as-is per their own risk assessment.

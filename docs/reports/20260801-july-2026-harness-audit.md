# July 2026 Harness Audit — Token Cost & Quality Analysis

**Date:** 2026-08-01
**Data sources:** `~/.nax/global/curator/rollup.jsonl` (653k July events), per-project `prompt-audit/` (4,900 transcripts), `review-audit/` (1,378 reviewer verdicts), `cost/*.jsonl` across nax, rs-stock, koda, nathapp-nestjs, iot-system.
**Scope:** 2026-07-01 → 2026-07-31. 595 story verdicts, $1,873 total spend, 9.7% story failure rate.
**Goal:** identify harness improvements for spec-writing, spec-review, `nax plan`/prd.json, role prompts, context, and rules — optimizing for token savings (more accurate specs, fewer turns) and quality assurance.

---

## 1. Cost structure — rectification is the dominant spend

| Stage | Cost | Share | Calls | Tokens |
|:------|-----:|------:|------:|-------:|
| rectification | $626.83 | **43.6%** | 909 | 296.8M |
| run (implementer) | $365.33 | 25.4% | 735 | 340.1M |
| acceptance | $266.33 | 18.5% | 1,155 | 255.9M |
| review | $109.31 | 7.6% | 1,423 | 90.6M |
| verify | $55.46 | 3.9% | 339 | 216.0M |
| plan | $15.54 | 1.1% | 236 | 20.0M |

- Fixing first drafts costs **1.7×** producing them. Rectification prompts (759) outnumber initial implementer runs (538).
- Story cost distribution: p50 $1.87, p90 $6.75, p99 $21.34, max $49.85.
- Plan is nearly free (1.1%) — under-investing in spec/plan accuracy is false economy when downstream rework is 43.6%.

### Fix-cycle efficiency

1,176 fix iterations across 513 stories (p50 2, p90 4, max 8 per story). Outcomes:

| Outcome | Count | Share |
|:--------|------:|------:|
| resolved | 799 | 67.9% |
| regressed | 154 | 13.1% |
| regressed-different-source | 144 | 12.2% |
| unchanged | 73 | 6.2% |
| partial | 6 | 0.5% |

**31.5% of all fix iterations produced no progress** (~$200/mo waste at rectification's per-call average). Exit reasons include 58 `agent-gave-up`. Escalations: 70 (43 → powerful, 27 → balanced).

## 2. Review outcomes — test-gap dominates everything

- First-round pass rate: **semantic 82%** (411 stories), **adversarial 69%** (405 stories).
- Rounds/story tail: 67 stories needed ≥3 semantic rounds; worst story took 20 combined rounds (koda w1-observability-pages US-003: 11 semantic + 9 adversarial).
- Adversarial blocking-finding categories: **test-gap 263 (~67% of categorized)**, assumption 40, error-path 38, input 30, abandonment 15, convention 5, bug 1.
- Semantic blocking findings carry **no category** (269 × `None`) — invisible to recurrence-demotion, curator aggregation, and telemetry.
- The dominant failure pattern (verified in transcripts, e.g. koda w1-observability-pages US-004): test-writer/implementer writes **source-inspection tests** (assert a pattern exists in a file) instead of runtime-behavior tests → adversarial blocks with test-gap → a full rectification round rewrites the tests. The adversarial reviewer's own "Test Audit Gap" heuristic describes exactly what it will reject — but the test-authoring prompts never see it. The harness pays a review round + a rectification round per story to teach knowledge it already had.

### Sub-threshold verdict bug — RESOLVED (verified during this audit)

28 July verdicts were `passed:false` with every finding below `blockingThreshold`. All adversarial hits trace to nax ≤0.75.0/0.74.0/0.73.x; the semantic side was fixed by #1347 and the adversarial side by **#1378 (`aa34bd71`), shipped in v0.75.2** — the July 0.75.0 occurrences (otel-telemetry-expansion US-003 ×4) predate that release. The exact observed shape (model `passed:false`, `severity:error` finding demoted to `unverifiable` by evidence substantiation, no AC drops → review passes) is covered by `test/unit/review/adversarial-verifiedby.test.ts` ("downgrades blocking finding when verifiedBy.observed is not in source"). No further code change needed; recommendation #2 closes as verified-fixed.

## 3. Spec / plan / PRD defects visible downstream

Curator evidence shows spec defects surviving into implementation and causing repeated review rounds:

- **Grep ACs fail structurally** — a shell-grep AC could not match multiline code (`ac4-pattern-3-grep-ac-fails`); the code was correct, the AC unsatisfiable.
- **Stale verbatim constants** — AC specified `constituents-dow.csv`; reality is `constituents-dowjones.csv`. Implementation right, AC wrong, test mocked the wrong URL → reviewer oscillation.
- **Hand-written fixture claims** — AC required "only t* is True"; the generated fixture had 17 Trues → unsatisfiable, 4+ blocking rounds.
- **Story-ID copy-paste** — 598 convention findings, largely `test_us009_*` names inside US-004 (sibling-pattern copying, prompt never pins the story ID).
- The worst review-round stories (20, 17, 15 rounds) all match the known unsatisfiable-spec pattern, not implementation failure.

## 4. Acceptance stage

1,155 acceptance calls for 132 story verdicts (gen 301, test-fix 132, diagnose 102, source-fix 37 transcripts). The retry tail is **always US-001**: alerts-tool 15, kv-cache 14, agent-tools-multi-ticker 13 — the first story pays acceptance-harness bootstrap; later stories retry ~0 (p50 = p90 = 0).

## 5. Context engine & rules

- **231k chunks included vs 1,054 excluded** (all reason=budget) — the budget almost never binds; context assembly is concatenation, not selection.
- `chunk-included` events record `tokens: 0` — chunk token accounting is broken, so the budget cannot be tuned empirically.
- `provider-empty` dominates: feature-context 68k, git-history 67k, session-scratch 66k, code-neighbor 62k, test-coverage 55k empties; static-rules is essentially always present.

## 6. Curator

Proposals are generated per run but are raw-count aggregates ("test-gap fired 792×" → HIGH) with no rule-file-ready text, "prior finding addressed" acks are counted as findings, and no July proposal checkbox was ever consumed. The feedback loop is open.

---

## 7. Recommendations (ranked by expected savings)

| # | Change | Area | Expected effect | Status |
|--:|:-------|:-----|:----------------|:-------|
| 1 | Feed adversarial audit lenses forward into test-authoring prompts (test-gap pre-brief: runtime-behavior tests, no source-inspection/placeholder tests, per-AC coverage) | prompts (test-writer, single-session, tdd-simple, batch, implementer-lite) | test-gap = 67% of adversarial blocks; halving it cuts ~15–20% of rectification spend + one review round per affected story | **implemented — this branch** |
| 2 | Fix adversarial sub-threshold verdict | review verdict | kills ~28 phantom fail rounds/mo | **already fixed in v0.75.2 (#1378); coverage verified** |
| 3 | Generic fix-cycle circuit-breaker with full-reveal revalidation (#1335 rescope) — run all reviewers once before counting regressed-different-source; bail after 2 consecutive non-productive iterations | fix-cycle | 31.5% of iterations are non-productive; caps the 15–20-round tail | open |
| 4 | Spec-review "verbatim reality check": verify every literal constant/URL/filename in an AC against the codebase or live source; fixture-shape claims must be derivable from the generation procedure; reject shell-grep ACs | spec-review skill | targets the most expensive deadlock stories | open |
| 5 | Pin story ID in implementer/test-writer prompts ("test names must use this story's ID") | prompts | ~598 convention findings | folded into #1 |
| 6 | Give the semantic reviewer a category taxonomy (reuse adversarial's) | prompts (semantic) | unlocks demotion/curator/telemetry for 53% of review rounds | open |
| 7 | Stop emitting "prior finding addressed" acks as findings — move to an `acks` array | review schema | cleans finding telemetry; curator stops proposing rules from acks | open |
| 8 | Bootstrap the acceptance harness at plan time (or copy US-001's resolved harness config to siblings) | acceptance | removes the 13–15-retry US-001 tail (~$30–50/mo) | open |
| 9 | Fix chunk token accounting; then drop providers empty >90% of the time per project from the default chain | context | prerequisite for budget tuning | open |
| 10 | Close the curator loop: emit rule-file-ready diffs against `.nax/rules/`, threshold on cross-feature recurrence, surface at `nax finish` for accept/reject | curator | converts dead telemetry into a compounding improvement loop | open |

**Estimated impact of #1–#3:** July's $1,873 → roughly $1,450–1,550 at equal throughput, with the 15–20-round failure tail largely eliminated.

**Strategic observation:** the harness detects known failure modes post-hoc (adversarial review) instead of preventing them pre-hoc (test-writer/spec prompts). Every recommendation is a form of moving knowledge one stage earlier in the pipeline.

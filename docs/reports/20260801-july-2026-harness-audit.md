# July 2026 Harness Audit — Token Cost & Quality Analysis

**Date:** 2026-08-01
**Data sources:** `~/.nax/global/curator/rollup.jsonl` (653k July events), per-project `prompt-audit/` (4,900 transcripts), `review-audit/` (1,378 reviewer verdicts), `cost/*.jsonl` across nax, rs-stock, koda, nathapp-nestjs, iot-system.
**Scope:** 2026-07-01 → 2026-07-31. 595 story verdicts, $1,873 total spend, 9.7% story failure rate.
**Goal:** identify harness improvements for spec-writing, spec-review, `nax plan`/prd.json, role prompts, context, and rules — optimizing for token savings (more accurate specs, fewer turns) and quality assurance.

---

## 1. Cost structure — rectification is the dominant spend

Stage-attributed cost from `cost/*.jsonl` totals $1,438.80 (the $1,873 headline sums story verdicts, which include spend the stage ledger does not attribute). Shares below are of the stage-ledger total.

| Stage | Cost | Share of stage cost | Calls | Tokens |
|:------|-----:|------:|------:|-------:|
| rectification | $626.83 | **43.6%** | 909 | 296.8M |
| run (implementer) | $365.33 | 25.4% | 735 | 340.1M |
| acceptance | $266.33 | 18.5% | 1,155 | 255.9M |
| review | $109.31 | 7.6% | 1,423 | 90.6M |
| verify | $55.46 | 3.9% | 339 | 216.0M |
| plan | $15.54 | 1.1% | 236 | 20.0M |

- Fixing first drafts costs **1.7×** producing them. Rectification outnumbers initial implementation on both ledgers: 909 vs 735 LLM calls (cost ledger above) and 759 vs 538 session transcripts (`prompt-audit/`).
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

Proposals are generated per run but are raw-count aggregates ("test-gap fired 792×" → HIGH) with no rule-file-ready text, and "prior finding addressed" acks are counted as findings.

**Correction (2026-08-01):** this section originally added "no July proposal checkbox was ever consumed — the feedback loop is open". That framing is wrong. nax has **no accept/reject process** for curator proposals, so an unticked checkbox is a vestigial UI element, not a loop that broke. Whether proposals should be consumed at all — and by what — is an open product question, not a defect.

---

## 7. Recommendations (ranked by expected savings)

| # | Change | Area | Expected effect | Status |
|--:|:-------|:-----|:----------------|:-------|
| 1 | Feed adversarial audit lenses forward into test-authoring prompts (test-gap pre-brief: runtime-behavior tests, no source-inspection/placeholder tests, per-AC coverage) | prompts (test-writer, single-session, tdd-simple, batch, implementer-lite) | test-gap = 67% of adversarial blocks; halving it cuts ~15–20% of rectification spend + one review round per affected story | **merged — [#1419](https://github.com/nathapp-io/nax/pull/1419)** |
| 2 | Fix adversarial sub-threshold verdict | review verdict | kills ~28 phantom fail rounds/mo | **already fixed in v0.75.2 (#1378); coverage verified** |
| 3 | Generic fix-cycle circuit-breaker (#1335 rescope) — ping-pong-only oscillation counting | fix-cycle | caps the 15–20-round tail | **done** (`countOscillationOutcomes`, #1355) |
| 3b | ~~Bail after 2 consecutive non-productive iterations~~ | fix-cycle | ~~31.5% of iterations are non-productive~~ | **withdrawn — refuted by the data, see §10** |
| 4 | Spec-review data-literal + fixture-derivability check (the shell-grep-AC half already shipped as Phase 7) | spec-review skill | targets the most expensive deadlock stories | [spec-kit#18](https://github.com/nathapp-io/nax-spec-kit-skills/issues/18) |
| 5 | Pin story ID in implementer/test-writer prompts ("test names must use this story's ID") | prompts | ~598 convention findings | folded into #1 |
| 6 | Give the semantic reviewer a category taxonomy (**semantic-specific**, not adversarial's — see §9) | prompts (semantic), review read-path | unlocks demotion/curator/telemetry for 53% of review rounds | **merged — [#1420](https://github.com/nathapp-io/nax/pull/1420)** |
| 7 | Stop emitting "prior finding addressed" acks as findings — move to an `acks` array | review schema | 2.2% of findings, info-only; cleans curator evidence | **in review — [#1426](https://github.com/nathapp-io/nax/pull/1426)** |
| 8 | Diagnose the 8 features burning 5–15 acceptance retries (the US-001 bootstrap premise is refuted — see §10) | acceptance | ~$30–50/mo | [#1424](https://github.com/nathapp-io/nax/issues/1424) |
| 9 | Fix chunk token accounting | context | prerequisite for budget tuning | **in review — [#1426](https://github.com/nathapp-io/nax/pull/1426)** |
| 9b | Then drop providers empty >90% of the time per project from the default chain | context | needs ≥1 month of real token data from #1426 first | blocked on 9 |
| 10 | Make curator counts mean something: cross-feature recurrence threshold + run-scoped counts (the "surface at `nax finish` for accept/reject" half is withdrawn — see §6 correction) | curator | proposals stop restating the category histogram | **in review — [#1427](https://github.com/nathapp-io/nax/pull/1427)** |

**Estimated impact of #1–#2:** the 15–20-round failure tail is addressed by #1 (prevention) and the shipped oscillation breaker. The original "$1,873 → $1,450–1,550" figure leaned on #3b's non-productive-iteration savings, which §10 withdraws — treat the remaining savings estimate as unquantified until August data lands.

## 8. Implementation status — #1 test-gap pre-brief (merged, [#1419](https://github.com/nathapp-io/nax/pull/1419))

**#1 — Test-gap pre-brief: shipped.**
- `src/prompts/sections/test-quality.ts` — new `buildTestQualitySection(role, variant?, storyId?)`: a compact (<1,600 chars) "Review-Proof Tests" section distilling the adversarial Test Audit Gap rejection criteria — runtime-behavior tests only, explicit ban on source-inspection and placeholder/tautological tests, per-AC and per-exported-symbol coverage, boundary/error-path lenses, mount-and-interact for UI-level ACs.
- Recommendation #5 folded in: when a story ID is available, the section pins it for test names (the 598 sibling-copy convention findings).
- Wired into `TddPromptBuilder.build()` as section 6.8 for the roles that author tests: `test-writer`, `single-session`, `tdd-simple`, `batch`, and `implementer` (lite variant only). `verifier`, `no-test`, and standard `implementer` prompts are unchanged.
- Tests: `test/unit/prompts/sections/test-quality.test.ts` (19 tests incl. a size-budget guard) + wiring assertions in `test/unit/prompts/builder.test.ts`. Full suite, typecheck, and lint green.
- **Measurement plan:** compare August's adversarial first-round pass rate (July baseline: 69%) and test-gap share of blocking findings (July baseline: 263, ~67%) from `review-audit/`; compare rectification share of stage cost (July baseline: 43.6%) from `cost/*.jsonl`.

**#2 — Adversarial sub-threshold verdict: closed as verified-fixed** (§2 above). #1378 shipped in v0.75.2; the July hits were pre-fix versions; regression coverage exists in `test/unit/review/adversarial-verifiedby.test.ts`. No code change needed.

**Code review:** independent review found no critical/high issues; three mediums were fixed — heading level (`##` → `#` so the section is not a markdown child of Behavioral Guardrails), the exported-symbol bullet scoped to AC-dependent exports (was contradicting the guardrails "tests cover ACs only" rule), and implementer-lite's isolation section relaxed ("MAY add tests for uncovered ACs; do NOT weaken existing tests") so it no longer contradicts the role-task and pre-brief sections. The source-inspection ban was also added to the adversarial reviewer's own Test Audit Gap catalogue so the pre-brief's attribution is accurate on both sides.

## 9. Implementation status — #6 semantic category taxonomy (merged, [#1420](https://github.com/nathapp-io/nax/pull/1420))

**Implemented.** Semantic findings no longer emit `category: ""` (the 269 × `None` in §2).

- `src/review/semantic-categories.ts` (new) — SSOT: the closed list, `normalizeSemanticCategory()`, and `SEMANTIC_CATEGORY_ENUM_LINE`. The reviewer prompt's union is *rendered from* the same constant, so prompt and read-path validator cannot drift.
- `src/prompts/builders/review-builder.ts` — the semantic instructions define each axis and require exactly one per finding; the output schema and the truncation-retry schema interpolate the enum line.
- `src/review/semantic-helpers.ts` — `LLMFinding.category?: string`, and `validateLLMShape` normalizes at the **parse boundary**. That placement is load-bearing: most consumers (`llmFindingsToReviewFindings`, which derives `ruleId` and feeds `review-audit/` and the curator; `classifyRecurrence`) read the accepted `LLMFinding[]` directly, not the converted `Finding[]`. Normalizing only in the converter would have left the feature's primary consumers on raw model output — caught in code review.

**Deviation from the recommendation as written:** the taxonomy is *not* a reuse of adversarial's. Semantic's own role prompt puts test coverage and conventions out of scope, and a semantic finding labelled `test-gap` would wrongly trip the adversarial test-gap carve-out in `recurrence-demotion.ts`. The six axes instead mirror, one-for-one, the conditions the semantic prompt already tells the reviewer to flag: `unimplemented`, `partial`, `contradiction`, `dead-path`, `unwired`, `other`. Disjoint vocabularies also keep the two reviewers distinguishable in curator aggregation. A test pins the disjointness.

**Blast radius:** fix routing is unchanged (semantic's lane is the constant `"source"`, never category-derived); unknown categories collapse to `other` so an invented value cannot fragment recurrence fingerprints or curator buckets; a missing category stays absent, kept distinct from `other` so telemetry can separate "model ignored the field" from "model chose none of the axes". `ruleId` for semantic findings changes from `review:<slug>` to `<category>:<slug>` (`finding-projection.ts` `deriveRuleId`) — no consumer keys on the old prefix, and curator H1 buckets get sharper as a result. Because normalization happens at the parse boundary, a stray `test-gap` from the model becomes `other` before `classifyRecurrence` sees it, so the adversarial test-gap carve-out stays unreachable from semantic — verified against the real function: raw `test-gap` yields `blocking:1, demoted:0` (deadlock), normalized yields `blocking:0, demoted:1`.

**Known limitation (parity with adversarial):** recurrence fingerprints include the category, so a genuine *axis* flip between rounds on the same issue (`partial` → `unimplemented`) still defeats demotion matching. Case/whitespace variants no longer do. Not otherwise mitigated here.

**Measurement plan:** August `review-audit/` should show semantic blocking findings with a non-empty category (July baseline: 0 of 269); then check whether semantic recurrence-demotion (wired opt-in by #1414) actually fires, and whether curator H1 proposals from semantic findings become category-specific rather than one `review-*` blob.

## 10. Verification pass on the open recommendations (2026-08-01)

Each remaining recommendation was re-checked against the current code and the July run artifacts before being filed as an issue. Three did not survive as written.

### #3b — "bail after 2 consecutive non-productive iterations": **withdrawn**

The 31.5% non-productive share is real (re-measured: 34.1% across 1,277 July iterations — resolved 65.9%, regressed 14.3%, regressed-different-source 12.9%, unchanged 6.2%). The inference that it is recoverable waste is not.

A bail already exists — `withIncreasingFailuresBail` in `src/execution/story-orchestrator/run-phase.ts`, on by default (`abortOnIncreasingFailures`, `consecutiveIncreasesToBail: 2`). It fires only when the finding **count** strictly increases, and the dominant real pattern is count-flat churn (1→1, 2→2), so it catches 7 of the 114 stories that hit ≥2 consecutive non-productive iterations.

Widening it to count non-productive outcomes fails on its own numbers:

| threshold | fires on | would abort stories that later resolved | trailing iterations saved |
|:--|--:|--:|--:|
| 2 consecutive | 114 (20.6%) | 64 (**56% false-positive**) | 36 |
| 3 consecutive | 30 (5.4%) | 15 (50%) | 21 |
| 4 consecutive | 15 (2.7%) | 4 (27%) | 9 |
| 2 consecutive `unchanged` only | 22 | 8 | 2 |

At every threshold it aborts more stories that were converging than it saves iterations — 9–36 iterations out of 1,277 for the month. Non-productive iterations are mostly normal convergence steps, and the genuinely terminal cases are already caught by `validate-short-circuit` (53), `agent-gave-up` (31), and `max-attempts-*` (18). Not filed.

### #8 — acceptance US-001 tail: **mechanism refuted, tail re-scoped** → [#1424](https://github.com/nathapp-io/nax/issues/1424)

"The first story pays acceptance-harness bootstrap; later stories retry ~0" is an artifact. `acceptance-setup.ts` generates one test file per package group and attributes it to `group.stories[0].id` — later stories never run acceptance at all, so there is nothing to inherit a resolved config. The real shape: 103 of 132 features need 0 retries; 8 features need 5–15.

### #4 — spec-review verbatim check: **half already shipped** → [nax-spec-kit-skills#18](https://github.com/nathapp-io/nax-spec-kit-skills/issues/18)

Phase 7 of the spec-review skill already bans `[grep]`/`[file]`/`[verbatim]` ACs as blockers. The residual gap is real: Phase 1 verifies code symbols but not data literals (the `constituents-dow.csv` case) or fixture-shape derivability (the "only t* is True" case).

### Confirmed as written

- **#9** → [#1421](https://github.com/nathapp-io/nax/issues/1421). All 269,355 `chunk-included` events carry `tokens: 0` — 100%, not a sample. Exclusions are 1,299 of 270,654 (0.5%).
- **#10** → [#1422](https://github.com/nathapp-io/nax/issues/1422). Two of three sub-claims confirmed and sharper than stated: proposals group on the bare category ("test-gap appeared 1008x"), and counts accumulate over the project's whole audit history (723→888 within one project, monotonic, so a HIGH can never clear). The third — **0 of 263 proposal files** has a ticked checkbox — is a real number but was misread as a broken feedback loop; see the §6 correction.
- **#7** → [#1423](https://github.com/nathapp-io/nax/issues/1423). Real but smaller than implied: 81 of 3,685 July findings (2.2%), all `info`, all adversarial — telemetry pollution, not deadlock. Its concrete harm is visible in curator proposal evidence, where the quoted examples are carry-forward bookkeeping rather than findings.

**Method note:** every number above was re-derived from `~/.nax/global/curator/rollup.jsonl`, `~/.nax/*/review-audit/`, and the `curator-proposals.md` artifacts, not carried over from the audit body. Three of six recommendations changed materially on contact with the data.

## 11. Where we are (2026-08-01, end of day)

| # | Recommendation | State |
|--:|:---|:---|
| 1 | Test-gap pre-brief | **shipped** — [#1419](https://github.com/nathapp-io/nax/pull/1419) |
| 2 | Adversarial sub-threshold verdict | **shipped before the audit** — #1378 / v0.75.2, coverage verified |
| 3 | Oscillation circuit-breaker | **shipped before the audit** — ping-pong-only counting (#1355) |
| 6 | Semantic category taxonomy | **shipped** — [#1420](https://github.com/nathapp-io/nax/pull/1420) |
| 7 | Reviewer `acks` channel | **in review** — [#1426](https://github.com/nathapp-io/nax/pull/1426) |
| 9 | Chunk token accounting | **in review** — [#1426](https://github.com/nathapp-io/nax/pull/1426) |
| 4 | Spec-review data-literal check | open — [spec-kit#18](https://github.com/nathapp-io/nax-spec-kit-skills/issues/18) |
| 8 | Acceptance retry tail | open, diagnostic — [#1424](https://github.com/nathapp-io/nax/issues/1424) |
| 10 | Curator loop | open, largest remaining — [#1422](https://github.com/nathapp-io/nax/issues/1422) |
| 3b | Non-productive-iteration bail | **withdrawn** — §10 |

Four of the ten shipped or in review; two were already fixed before the audit was written; one is withdrawn.

### What is actually left

**#10 (curator) — counts fixed in [#1427](https://github.com/nathapp-io/nax/pull/1427); consumption is an open question, not a defect.** Two shipped changes depended on the counts being fixed:

- #1420 makes semantic findings carry categories, which the curator folds into its counts — the same counts that accumulated over each project's whole audit history and could never clear. Without the fix, the new taxonomy would have inherited the defect that made the adversarial counts useless.
- #1426 stops *new* acknowledgement pollution, but historical acks remained in the cumulative totals until collection was run-scoped.

The count-scoping half was the prerequisite: until counts mean "this run", no threshold choice is meaningful. What remains is **not** a third defect. The original recommendation assumed proposals should be surfaced for accept/reject at `nax finish`; nax has no accept/reject process and `nax finish` ships features rather than curating rules (§6 correction). Whether anything should consume proposals — and what — is undecided, and should not be built on the strength of this audit alone.

**#8 produces a question, not a patch.** Someone has to read the `alerts-tool` / `kv-cache` / `agent-tools-multi-ticker` transcripts and find the shared cause; all three are tool-shaped features in one project, which points at a per-project harness problem rather than anything intrinsic to acceptance.

### Measurement debt

Nothing shipped this month can be evaluated yet — August data does not exist on 1 August. Three baselines to compare against once it does:

| Metric | July baseline | Changed by |
|:---|---:|:---|
| Adversarial first-round pass rate | 69% | #1419 |
| test-gap share of adversarial blocking findings | 263 (~67%) | #1419 |
| Rectification share of stage cost | 43.6% | #1419 |
| Semantic findings carrying a category | 0 of 269 | #1420 |
| Acknowledgements counted as findings | 81 (2.2%) | #1426 |
| `chunk-included` events with a real token count | 0 of 269,355 | #1426 |

The last three are correctness checks — they should go to ~100%, ~0, and ~100% immediately, and if they do not, the change did not take effect. The first three are the ones that actually cost money, and they need a month of runs before the comparison means anything.

**Strategic observation:** the harness detects known failure modes post-hoc (adversarial review) instead of preventing them pre-hoc (test-writer/spec prompts). Every recommendation is a form of moving knowledge one stage earlier in the pipeline.

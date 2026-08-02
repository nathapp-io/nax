# July 2026 Harness Audit — Token Cost & Quality Analysis

**Date:** 2026-08-01
**Data sources:** `~/.nax/global/curator/rollup.jsonl` (653k July events), per-project `prompt-audit/` (4,900 transcripts), `review-audit/` (1,378 reviewer verdicts), `cost/*.jsonl` across nax and five other projects driven by nax.

Projects other than nax are anonymised as **Project A**, **Project B**, … in order of review-finding volume, and their feature identifiers are elided. The labels are stable across this document.
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
- Rounds/story tail: 67 stories needed ≥3 semantic rounds; worst story took 20 combined rounds (Project C, US-003: 11 semantic + 9 adversarial).
- Adversarial blocking-finding categories: **test-gap 263 (~67% of categorized)**, assumption 40, error-path 38, input 30, abandonment 15, convention 5, bug 1.
- Semantic blocking findings carry **no category** (269 × `None`) — invisible to recurrence-demotion, curator aggregation, and telemetry.
- The dominant failure pattern (verified in transcripts, e.g. Project C, US-004): test-writer/implementer writes **source-inspection tests** (assert a pattern exists in a file) instead of runtime-behavior tests → adversarial blocks with test-gap → a full rectification round rewrites the tests. The adversarial reviewer's own "Test Audit Gap" heuristic describes exactly what it will reject — but the test-authoring prompts never see it. The harness pays a review round + a rectification round per story to teach knowledge it already had.

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

1,155 acceptance calls for 132 story verdicts (gen 301, test-fix 132, diagnose 102, source-fix 37 transcripts). The retry tail is **always US-001**: three tool-shaped features in one project took 15, 14 and 13 retries — the first story pays acceptance-harness bootstrap; later stories retry ~0 (p50 = p90 = 0).

> **Correction (2026-08-02, twice over):** every claim in the paragraph above is wrong.
> §10 already refuted the bootstrap *mechanism*. The retry *numbers* are also not
> retry counts — `verdict.retries` was emitting the hardening pass's promoted-AC
> count. Real July retries never exceed 2. See **§14**.

## 5. Context engine & rules

- **231k chunks included vs 1,054 excluded** (all reason=budget) — the budget almost never binds; context assembly is concatenation, not selection.
- `chunk-included` events record `tokens: 0` — chunk token accounting is broken, so the budget cannot be tuned empirically.
- `provider-empty` dominates: feature-context 68k, git-history 67k, session-scratch 66k, code-neighbor 62k, test-coverage 55k empties; static-rules is essentially always present.

## 6. Curator

Proposals are generated per run but are raw-count aggregates ("test-gap fired 792×" → HIGH) with no rule-file-ready text, and "prior finding addressed" acks are counted as findings.

**Correction (2026-08-01, twice):** this section originally read "no July proposal checkbox was ever consumed — the feedback loop is open", and recommendation #10 proposed surfacing proposals at `nax finish` for accept/reject.

1. `nax finish` is wrong: it ships a feature, it does not curate rules.
2. A first correction then over-swung to "nax has no accept/reject process". That is also false. **`nax curator commit` is the accept/reject process** — `parseCheckedProposals` (`src/commands/curator.ts`) reads `- [x]` boxes out of `curator-proposals.md`, applies the adds/drops to the target rule files, and opens them in `$EDITOR`. It is wired in `bin/nax.ts`.

So the checkbox is the accept token of a shipped workflow, and "0 of 263 ticked" is not evidence that no consumer exists. Given that one does, the honest reading is the original one: **the proposals were never worth ticking** — which is exactly what per-category counts over cumulative history would produce. That is the defect [#1427](https://github.com/nathapp-io/nax/pull/1427) fixes.

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
| 10 | Make curator counts mean something: cross-feature recurrence threshold + run-scoped counts. (The accept surface already exists — it is `nax curator commit`, not `nax finish`; see §6 correction.) | curator | proposals become worth ticking | **in review — [#1427](https://github.com/nathapp-io/nax/pull/1427)** |

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

> **Correction (2026-08-02):** the re-scoped tail ("8 features need 5–15") is itself
> an artifact of the same field. The metric was never a retry count. See **§14**.

### #4 — spec-review verbatim check: **half already shipped** → [nax-spec-kit-skills#18](https://github.com/nathapp-io/nax-spec-kit-skills/issues/18)

Phase 7 of the spec-review skill already bans `[grep]`/`[file]`/`[verbatim]` ACs as blockers. The residual gap is real: Phase 1 verifies code symbols but not data literals (the `constituents-dow.csv` case) or fixture-shape derivability (the "only t* is True" case).

### Confirmed as written

- **#9** → [#1421](https://github.com/nathapp-io/nax/issues/1421). All 269,355 `chunk-included` events carry `tokens: 0` — 100%, not a sample. Exclusions are 1,299 of 270,654 (0.5%).
- **#10** → [#1422](https://github.com/nathapp-io/nax/issues/1422). Two of three sub-claims confirmed and sharper than stated: proposals group on the bare category ("test-gap appeared 1008x"), and counts accumulate over the project's whole audit history (723→888 within one project, monotonic, so a HIGH can never clear). The third — **0 of 263 proposal files** has a ticked checkbox — is a real number, twice misread: first as a broken feedback loop, then as evidence no consumer exists. `nax curator commit` consumes ticked boxes; nobody ticked them because the proposals restated a histogram. See the §6 correction.
- **#7** → [#1423](https://github.com/nathapp-io/nax/issues/1423). Real but smaller than implied: 81 of 3,685 July findings (2.2%), all `info`, all adversarial — telemetry pollution, not deadlock. Its concrete harm is visible in curator proposal evidence, where the quoted examples are carry-forward bookkeeping rather than findings.

**Method note:** every number above was re-derived from `~/.nax/global/curator/rollup.jsonl`, `~/.nax/*/review-audit/`, and the `curator-proposals.md` artifacts, not carried over from the audit body. Three of six recommendations changed materially on contact with the data.

## 11. Where we are (2026-08-01, end of day)

| # | Recommendation | State |
|--:|:---|:---|
| 1 | Test-gap pre-brief | **shipped** — [#1419](https://github.com/nathapp-io/nax/pull/1419) |
| 2 | Adversarial sub-threshold verdict | **shipped before the audit** — #1378 / v0.75.2, coverage verified |
| 3 | Oscillation circuit-breaker | **shipped before the audit** — ping-pong-only counting (#1355) |
| 6 | Semantic category taxonomy | **shipped** — [#1420](https://github.com/nathapp-io/nax/pull/1420) |
| 7 | Reviewer `acks` channel | **shipped** — [#1426](https://github.com/nathapp-io/nax/pull/1426) |
| 9 | Chunk token accounting | **shipped** — [#1426](https://github.com/nathapp-io/nax/pull/1426) |
| 4 | Spec-review data-literal check | open — [spec-kit#18](https://github.com/nathapp-io/nax-spec-kit-skills/issues/18) |
| 8 | Acceptance retry tail | **dissolved** — the metric was not a retry count; [#1424](https://github.com/nathapp-io/nax/issues/1424) closed, see §14 |
| 10 | Curator loop | counts **shipped** ([#1427](https://github.com/nathapp-io/nax/pull/1427) + [#1428](https://github.com/nathapp-io/nax/pull/1428)); recall re-scoped — [#1422](https://github.com/nathapp-io/nax/issues/1422), §12 |
| 3b | Non-productive-iteration bail | **withdrawn** — §10 |

Six of the ten shipped; two were already fixed before the audit was written; one is withdrawn.

### What is actually left

**#10 (curator) — counts fixed in [#1427](https://github.com/nathapp-io/nax/pull/1427) / [#1428](https://github.com/nathapp-io/nax/pull/1428), then replayed against real data; see §12 for the outcome.** Two shipped changes depended on the counts being fixed:

- #1420 makes semantic findings carry categories, which the curator folds into its counts — the same counts that accumulated over each project's whole audit history and could never clear. Without the fix, the new taxonomy would have inherited the defect that made the adversarial counts useless.
- #1426 stops *new* acknowledgement pollution, but historical acks remained in the cumulative totals until collection was run-scoped.

The count-scoping half was the prerequisite: until counts mean "this run", no threshold choice is meaningful. The consumer already exists — `nax curator commit` — so the remaining question is not "what should read proposals" but whether, once they are accurate, anyone finds them worth accepting. That is answerable with August data rather than more code.

**#8 produces a question, not a patch.** Someone has to read those three features' transcripts (§4) and find the shared cause; all three are tool-shaped features in one project, which points at a per-project harness problem rather than anything intrinsic to acceptance.

> **Resolved (2026-08-02).** Reading them was the right instinct and it dissolved the
> question: there is no shared cause because there is no tail. See **§14**.

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

## 12. Curator replay against real July artifacts (2026-08-01)

§11 said the curator's remaining question was "answerable with August data rather than more code". It was answerable sooner: the shipped pipeline can be replayed over July's own artifacts. Criteria were fixed before looking at any result.

**Method.** Real `collectObservations` → `appendToRollup` → `readHeuristicWindow(20)` → `runHeuristics`, shipped default thresholds, no reimplementation of the pipeline. Audit files were staged into a scratchpad mirror incrementally so run N never saw run N+1's artifacts — the collector has no upper time bound, and in production the future does not exist yet. `~/.nax` was read-only. Only the `review-audit` source was replayed, so H2–H6 could not fire; H1 is what #1427 / #1428 changed.

**Result: 2 distinct proposals from 419 runs and 8,070 findings.**

| | |
|:--|--:|
| runs replayed | 419 |
| review findings in corpus | 8,070 |
| runs producing ≥1 proposal | 34 |
| distinct proposals | 2 |
| max proposals in any single run | 1 |

The per-category spam is gone — median 0 proposals per run, no bare-category description, no single-feature proposal — and both survivors are real defects (an untested error-redaction branch shared by two sibling adapters in one project; a module-level constant defined but never referenced). But two proposals from 8,070 findings is effectively zero recall.

**The binding constraint is the identity key, not the threshold.** `crossFeatureKey` is `category | normalizeIssueText(message)[0:48]`, and two reviewers describing the same defect in different features almost never agree on their first 48 normalized characters. At the shipped threshold of 2 there are only 3 qualifying groups in the entire corpus, so lowering the threshold cannot help. Cross-feature groups (≥2 features), ack-leak prose excluded:

| project | findings | shipped (48) | 32 | 24 |
|:---|---:|---:|---:|---:|
| Project A | 4,740 | 3 | 17 | 34 |
| Project B | 1,414 | 0 | 6 | 10 |
| nax | 1,013 | 0 | 1 | 3 |
| Project C | 375 | 0 | 0 | 0 |

Category-only keys yield 7–9 groups but with up to 180 features in one — the collapse §6 identified in the first place. The useful range lies between, and nothing currently measures where.

Two side effects worth recording. A 24-character prefix would have surfaced rule-shaped recurrences the 48-character key missed (dead test constants across 4 features; imports from private underscore modules across 3; changed test files failing the Ruff gate across 3). And 4 of its top 8 groups are carry-forward verdict prose grouping on its boilerplate opener — the #1423 leak that #1426 already fixed, 4.1% of the July corpus and ~0 going forward.

**Two defects found in the process,** neither covered by tests because every curator test builds its own rollup in a temp dir:

- [#1429](https://github.com/nathapp-io/nax/issues/1429) — the rollup is one global file shared by every project, so a run's heuristic window can be filled by another repo's runs and H1's distinct-feature count can mix projects. The 8 MB tail cap also binds before `windowRuns`: on the real rollup the "20-run" window contains 2 runs. **Fixed in [#1432](https://github.com/nathapp-io/nax/pull/1432)** — see §13.
- [#1430](https://github.com/nathapp-io/nax/issues/1430) — `nax curator gc` is never invoked automatically and loads the whole rollup into memory. The file is 618 MB / 1.13M rows on a live machine, which the prune command cannot itself process.

**Caveats.** July semantic findings carry no category (778 `(none)` in Project A, 246 in nax) — the gap #1420 closed — so August grouping will differ. The replay shows what would be *proposed*, never whether a resulting rule prevents anything. It also used per-project rollups, which is more favourable than production's shared file (#1429); real recall is likely lower still.

## 13. Rollup scoping fixed ([#1432](https://github.com/nathapp-io/nax/pull/1432), 2026-08-01)

§12's replay found two defects the replay itself had papered over — it built one rollup per project, while production shares a single global file. Both are now fixed.

**The window was not the project's.** `~/.nax/global/curator/rollup.jsonl` is one file for every project on the machine, and nothing in a row identified its origin: `featureId` and `storyId` are project-local names that collide freely across repos. Reproduced through the real plugin — five interleaved runs across two projects, and the proposal written into the first project's run directory read:

```
Recurring across 5 features — feat-a, beta-x, feat-b, beta-y, feat-c
Files: src/a.ts, src/x.ts, src/b.ts, src/y.ts
```

Three of those features and two of those files belong to the other repo, while the proposal targets the first project's `.nax/rules/`. The same root cause let `nax curator gc --keep 50` prune by global recency, so a busy project evicts a quiet one's entire history.

Observations now carry `projectKey` (schemaVersion 3) and readers filter on it. Rows predating this carry no `projectKey` and no way to recover one, so they are dropped from windows and preserved by `gc` — claiming them would reintroduce the contamination, and deleting them on one project's behalf is not that project's decision.

**The byte cap was acting as the window policy.** `MAX_WINDOW_TAIL_BYTES` bound before `windowRuns`: on the real rollup an 8 MB tail held 2 runs where 20 were configured, and nothing reported it, so proposals rested on less history than configured while appearing not to. Reads now grow from the tail until enough of this project's runs are found, the file is exhausted, or a 64 MB ceiling is hit; exhausting the file is explicitly *not* truncation, and a real shortfall is logged.

**Consequence worth stating plainly:** this does not shrink an existing rollup. Almost all 648 MB of it is unattributable pre-#1429 rows, now deliberately preserved. Measured against the real file, a window read escalates to the ceiling and returns 0 runs in 229 ms — correct, bounded, and empty until a project accumulates new history. Reclaiming that space needs the retention decision and the streaming rewrite in #1430.

**Method note.** Both defects were invisible to a test file written specifically to cover this seam (`curator-seam.test.ts`, added for the #1428 regression), because every test built a small single-project rollup in a temp dir. Neither a shared multi-project file nor a file larger than the tail read existed anywhere in the suite. That is the third time this month the same shape has appeared — the type was wired, the producer was not, and the tests sat on one side of the seam. Self-review of the fix then found three more defects in the new code, including a zero-length tail read that spun forever; they are recorded in the PR.

## 14. The acceptance retry tail was a mislabelled field (2026-08-02)

#1424 asked what the 8 features burning 5–15 acceptance retries had in common. Nothing: none of them retried more than twice. `verdict.retries` never carried a retry count.

**`src/pipeline/stages/acceptance.ts`, before this fix:**

```ts
hardeningRetries = result.promoted.length;   // ACs promoted by the hardening pass
...
retries: hardeningRetries,                   // emitted as the verdict's retry count
```

The variable took the number of acceptance criteria the non-blocking hardening pass promoted and emitted it as `retries`. Nothing in `src/` read the field and no test asserted on it, so it was write-only telemetry — visible only to whoever later mined the logs, which is how it reached an audit and two issue re-scopes unchallenged.

**The worst offender, F3, passed acceptance on its first attempt with zero failed ACs:**

```
Running acceptance command
Package acceptance tests passed              <- first attempt, nothing failed
Starting hardening pass  {storiesProcessed:3, totalSuggestedACs:5}
Hardening pass complete  {promoted:13, discarded:0}
verdict passed=true retries=13               <- == promoted
```

F1 and F2 have the same shape (one real retry each; `promoted` 15 and 14). Across all 493 July verdicts / 136 features:

| | reported (`verdict.retries`) | real (`Acceptance retry N/M` events) |
|:--|--:|--:|
| max | 15 | **2** |
| distribution | `{0:106, 1:6, 2:11, 3:4, 4:1, 5:3, 6:1, 7:1, 13:1, 14:1, 15:1}` | `{0:19, 1:115, 2:2}` |

116 of 136 features reported a number that was not their retry count. Two further consequences fell out of the same wiring:

- All **192 fail-path verdicts reported `retries:0`**, structurally — hardening only runs inside the all-passed branch, so the one case where a retry count carries information was guaranteed to read zero.
- The field peaked exactly when acceptance was *least* troubled, since it tracked suggested-criteria volume.

The real ceiling of 2 is not a coincidence: `runAcceptanceLoop` returns after one fix-cycle pass rather than re-entering the `while`, so a run reaches a third attempt only via the stub-guard `continue`.

**Fixed.** `retries` now reports the loop's true attempt index, threaded from `runAcceptanceLoop` (which owns the counter) through `AcceptanceLoopContext.acceptanceRetries` onto a per-attempt context copy; re-validations inside a fix cycle inherit their attempt's index rather than inflating it. Hardening promotions moved to their own `hardeningPromoted` key. The fail path now reports its index.

**Method note.** The stage's three existing `acceptance verdict logger emit` tests asserted only that execution did not throw — the verdict payload they are named for was never captured. One of them asserted on `ctx.packageDir`, a property `PipelineContext` does not define, which `tsconfig.json` could not catch because it excludes `test/`. They now capture the emitted payloads through a logger sink and assert the fields. This is the fourth instance this month of the same shape recorded in §13: the producer was wired, the consumer was not, and the tests sat on the wrong side of the seam.

**Standing implication for this report.** Three of its quantitative claims have now failed on contact with the artifacts (#3b, #8's mechanism, #8's tail). The common factor is not arithmetic — it is trusting a telemetry field's *name*. Any metric here that no production code consumes should be re-derived from a second, independent signal before it is used to justify work.

## Where to pick up (2026-08-02)

> Deliberately unnumbered so it stays the report's tail as sections are appended above it.

Written so a fresh session can resume without re-deriving anything. Read this first — three of the report's quantitative claims have now failed on contact with the artifacts, and the common cause is the same: trusting a telemetry field's name.

The most recent of those is §14 — §4's acceptance retry tail does not exist, because `verdict.retries` was reporting the hardening pass's promoted-AC count.

### Ranked next steps

| # | Work | Why it is ranked here | State |
|--:|:---|:---|:---|
| 1 | **Cost-ledger attribution** — [#1433](https://github.com/nathapp-io/nax/issues/1433) | Prerequisite for every other cost question, including this report's own August measurement plan. `model` was `"unknown"` on 100% of July spend and `sessionRole` absent on all of it, across all six stages. | **shipped** — [#1434](https://github.com/nathapp-io/nax/pull/1434) |
| 2 | Acceptance generation: cache economics | cacheWrite is the largest slice of generation spend, because `acceptanceGenerateOp` is `session: { lifetime: "fresh" }` and every package group rebuilds cache from scratch. **The 32% / 19.31M-token figure is contaminated by hardening — re-derive from August `sessionRole` data before acting.** | number needs re-deriving |
| 3 | Re-derive rectification's breakdown from `sessionRole` | At 44.7% of stage cost it is the only stage where a 10% win outweighs all of acceptance — and it is currently 100% unattributable below the stage level. | unblocked by #1434; needs August data |
| — | ~~Acceptance generation: 34% excess calls~~ | **Answered.** The 409-vs-271 gap is the hardening pass, which dispatches through the `acceptance-gen` role and was counted as generation. Not regeneration and not multi-turn sessions. | **closed** — see "Hardening repeats" below |
| 5 | Curator gc — [#1430](https://github.com/nathapp-io/nax/issues/1430) | Unblocked by #1432 but needs a retention decision first (auto-prune vs documented bound; what happens to ~648 MB of unattributable pre-#1429 rows). | awaiting decision |

Also open, unchanged: [spec-kit#18](https://github.com/nathapp-io/nax-spec-kit-skills/issues/18) (spec-review data-literal check) and [#1422](https://github.com/nathapp-io/nax/issues/1422) (curator H1 identity-key recall, needs August data).

**Note for whoever picks this up:** with the excess-calls question answered and both remaining acceptance items gated on August `sessionRole` data, spec-kit#18 is the only ranked item actionable today without waiting for data.

[#1424](https://github.com/nathapp-io/nax/issues/1424) is **closed as dissolved** — see §14.

### What acceptance spend actually is

Derived by joining cost rows to `prompt-audit/` transcripts on `runId` + nearest timestamp, because `sessionRole` is not on the row (#1433):

| sub-activity | cost | share | calls | output tok/call |
|:---|---:|---:|---:|---:|
| generation | $231.40 | **71.3%** | 324 | 18,112 |
| diagnose | $49.54 | 15.3% | 312 | 2,153 |
| source-fix | $14.65 | 4.5% | 24 | 7,917 |
| hardening | $13.39 | 4.1% | 53 | 4,674 |
| other | $11.80 | 3.6% | 36 | 2,022 |
| ac-refine | $3.70 | 1.1% | 709 | 1,289 |

Acceptance is output-bound one-shot generation, not a retry loop. §4's framing had it backwards.

> **Correction (2026-08-02): the generation and hardening rows above are wrong.**
> The hardening pass dispatches through the `acceptance-gen` session role with a
> generation-shaped prompt, so a classifier keyed on prompt text cannot separate
> it from initial generation. Re-measuring by hardening *window* — the interval
> between `Starting hardening pass` and `Hardening pass complete` in the feature
> run log — moves roughly $32:
>
> | | prompt-classifier (above) | window-based |
> |:---|---:|---:|
> | hardening | $13.39 (4.1%) | **$45.51 (14.0%)** |
> | generation | $231.40 (71.3%) | **~$199 (~61%)** |
>
> Generation is still the dominant line and the qualitative conclusion holds. But
> **the cacheWrite figure in ranked item 2 was derived from the contaminated
> generation bucket and must be re-derived before that item is actioned.**
>
> This is the third name-based inference in this report to fail on contact with
> the artifacts, after `verdict.retries` (§14) and the `acceptance.model` tier
> reading. Same shape each time: identity inferred from what something is called
> rather than from what it does. Once `sessionRole` reaches cost rows (#1433,
> shipped in #1434), this particular join stops being necessary — August data
> can be grouped directly.

### Hardening repeats — investigated and closed, not a defect (2026-08-02)

The window analysis above surfaced that `acceptanceStage.execute` runs the
hardening pass inside its all-passed branch, while `runAcceptanceLoop` executes
that stage several times per run (initial attempt, each fix-cycle re-validation,
final pass). July: 81 passes across 46 feature-runs, 35 of them repeats, of which
31 promoted nothing — $15.50 and 1.9 hours of wall clock.

That reads like deterministic waste and it is not. Two findings closed it:

1. **The frequency has collapsed.** Zero hardening passes from 2026-07-20 to
   2026-07-31 across 68 acceptance runs, following spec-writing / spec-review /
   `nax plan` changes that stopped emitting `suggestedCriteria`. One feature has
   run it since.
2. **The repeats are load-bearing.** That one recent run is the counter-example:
   its first pass discarded the suggested criterion, and the *repeat* — after a
   fix cycle had changed the source — promoted 5 ACs. Re-running against changed
   code is the mechanism working, not misfiring. A run-once guard would have
   turned 5 promoted ACs into 0.

The July "31 of 35 repeats promoted nothing" number is real but describes
usually-unproductive, not redundant. No change made.

### Two traps for whoever picks this up

**Run profiles are invisible in run artifacts.** `~/.nax/profiles/*.json` repoint agent and model per stage, and nothing in `cost/`, `prompt-audit/` or the feature run logs records which profile was active. Acceptance generation reconciles to Sonnet pricing while `acceptance.model` resolves to `"fast"` → haiku; that is not a bug, it is `cc-acceptance.json` pinning `generateModel: { agent: "claude", model: "balanced" }` deliberately. Check the profiles before concluding a stage uses the wrong model. Recording the active profile is item 5 of #1433's proposal list.

**Two stages are majority-estimated.** `review` is 60% estimate-derived and `plan` is 63%, concentrated in the one agent that never returns a wire-exact cost. The estimator runs 0.4x aggregate and up to 21x off per row, so those two rows of §1's table — including "plan is nearly free" — are not reliable in either direction. The acceptance figures above are ~100% wire-exact and safe.

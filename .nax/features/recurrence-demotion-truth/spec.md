# SPEC: Recurrence-demotion truth — advisory retirement and self-describing verdicts

## Summary

Give recurrence-demotion a terminal state for carried sub-threshold findings, and make a
passing review-audit record explain itself when it carries a demoted blocking-severity
finding. `classifyRecurrence` gains a `retired` bucket and stamps every finding with the
disposition that produced it; the stamp is allowlisted through both finding mappers so it
survives into `Finding.meta`; and the prior-iterations prompt renders retired findings in an
acknowledgement block that forbids re-flagging, instead of the verdict list that mandates it.
Closes nax#1927 and nax#1928.

## Motivation

**nax#1927 — carried sub-threshold findings have no exit.** In `acp-catalog-pricing`
(v0.82.0-canary.5), 11 of 17 adversarial findings were verbatim re-emissions of a prior
round — a 65% repeat rate; 43% in `dispatch-accounting-integrity`. Every link behaves as
designed and the composition has no terminal state:

1. `run-phase.ts:265-269` records `[...normalizedFindings, ...advisoryFindings]` into the
   iteration store — blocking *and* sub-threshold.
2. `prior-iterations-builder.ts:115` then *requires* the reviewer to re-flag anything
   unfixed "with the IDENTICAL `file`, `line`, `category`, and substantively the same
   `message` wording". The prompt is being obeyed exactly.
3. Nothing routes advisories to a fixer: `normalizedFindings` carries `blocking` only.
4. `classifyRecurrence` cannot retire them, because the severity gate at
   `recurrence-demotion.ts:199-202` returns before `lookupPriorAppearance` at `:204` — a
   sub-threshold finding never reaches a recurrence count.

**nax#1928 — a passing record can carry an `error` finding with no explanation.** Of 22
review-audit records across three runs, 10 carry `passed: true` beside a non-empty
`findings` array, including `error` severities. `adversarial-review.ts:512` computes
`passed` from `blocking`, while `:528` persists `findings: accepted` — the superset.
`classifyRecurrence` partitions references *out of* `accepted` without marking them, so an
`error` demoted past `maxBlockingRounds` sits in a passing record indistinguishable from a
miscomputed verdict.

Both defects are the same missing fact: **the disposition a finding received is computed and
then thrown away.**

## Design

### Approach — why retirement happens in the prompt, not in the seed

The obvious mechanism — a terminal bucket excluded from the iteration-store seed — does not
work, and the reason is load-bearing enough to state.

`buildPriorIterationsBlock` (`prior-iterations-builder.ts:47-50`) maps over **every**
iteration it is given, and `run-phase.ts:191` passes the store's full history (capped at 10
by `MAX_ITERATIONS_PER_STORY`). Dropping a finding from *future* seeds therefore does nothing
about the round in which it was already stored: that round keeps rendering, and `:115` keeps
demanding a verbatim re-flag. A finding seeded in round 1 and retired in round 2 is still
rendered in round 3, re-emitted, and re-retired — every round, indefinitely.

Nor does retiring on first sighting help. A finding that is never seeded leaves the reviewer
with no record of it, so the reviewer re-discovers it and files it again as new. **The only
way to stop a reviewer re-raising a true finding is to keep telling it about the finding.**
Suppression and carry cost are the same lever.

So retirement is a **rendering** change: the finding stays in the store and stays in the
prompt, but moves out of the verdict list — which requires a per-item classification and
mandates identical re-flagging — into an acknowledgement block that states it is closed and
must not be re-flagged. The reviewer keeps the memory; the prompt stops asking for the
re-emission.

### Approach — why the stamp needs an allowlist entry

`classifyRecurrence` operates on LLM findings (`AdversarialLLMFinding`, semantic
`LLMFinding`), not on `Finding`. Both mappers **rebuild `meta` from scratch** over a closed
allowlist: `toAdversarialReviewFindings` (`adversarial-helpers.ts:141-151`) and
`llmFindingToFinding` (`semantic-helpers.ts:189-196`). Neither copies an incoming `meta`, and
neither LLM finding type declares one. The codebase already documents the trap at
`semantic-review.ts:434-435` — *"llmFindingToFinding rebuilds `meta` from scratch, so a
coverageGap tag applied to the LLMFinding would be silently dropped"* — which is why
`tagCoverageGap` is applied **after** conversion.

A stamp applied before conversion is therefore dropped. Both LLM finding types gain an
optional `meta`, and both mappers gain one allowlist line forwarding `recurrence`.

The `result.findings` lane needs no mapper at all: per `semantic-helpers.ts:61-62` and #1861,
the review audit persists the **raw op shape**, so a stamp on the LLM finding reaches
`ReviewAuditEntry.result.findings` directly through `review-decision.ts:92`. That is the
nax#1928 evidence surface, and it comes free.

### Integration

Read-only, verified at `72a24fbf1`:

- `isBlockingSeverity(severity, threshold)` — `src/review/adversarial-helpers.ts`.
- `lookupPriorAppearance(priorCounts, f)` returns `{ count: number; lastSeverity: string } | undefined`
  — `src/review/recurrence-demotion.ts:84`.
- `countPriorAppearances` keys on `fingerprintFor`, which uses `file + acIndex` when an
  `acIndex` is present and falls back to `file + category + issue` prefix otherwise
  (`recurrence-demotion.ts:40-58`).
- `tagCoverageGap` (`recurrence-demotion.ts:133`) — applied after conversion; unchanged.
- `recordReviewIteration` — `src/review/review-iteration-store.ts:36`; the seeds at
  `run-phase.ts:265-269` and `:272-276` are unchanged by this feature.
- `review-decision.ts:92` — `result: { passed: record.passed, findings: record.findings }`.

Changed symbols — the baseline exists only to locate the code and is never the interface to
implement:

**`RecurrenceConfig`** (`src/review/recurrence-demotion.ts:137`)

Baseline: `{ enabled: boolean; maxBlockingRounds: number }`
Target: `{ enabled: boolean; maxBlockingRounds: number; maxAdvisoryRounds?: number }`.
The field is **optional in the type**, defaulted to `2` inside `classifyRecurrence`. Making
it required would break 25 construction sites across `src/` and `test/` — including
`adversarial-review.ts:479` and `semantic-review.ts:425`, which US-001 does not own. The
config schema still declares it with its own default, so configuration remains the source of
the value.

The same optional field is added to the inline shapes at `src/review/types.ts:132` and
`:258`.

**`RecurrenceCandidate`** (`src/review/recurrence-demotion.ts:152-158`)

Baseline: `{ severity; file; issue; category?; acIndex? }`
Target: gains `meta?: Record<string, unknown>`, matching the bound `tagCoverageGap` already
uses at `:133`, so `classifyRecurrence` can write the stamp.

**`RecurrenceResult`** (`src/review/recurrence-demotion.ts:138-142`)

Baseline: `{ blocking: T[]; advisory: T[]; demoted: T[] }`
Target: `{ blocking: T[]; advisory: T[]; demoted: T[]; retired: T[]; classified: T[] }`,
where `classified` holds every input finding, stamped, in input order.

**`classifyRecurrence`** (`src/review/recurrence-demotion.ts:172`)

Baseline: partitions into three buckets; the severity gate returns before the recurrence
count is computed, so a sub-threshold finding never receives one.
Target: same parameter list, generic bound widened per `RecurrenceCandidate` above,
returning the five-field `RecurrenceResult`. The recurrence count is computed for every
finding; the severity gate then selects which cap applies.

**`AdversarialLLMFinding`** (`src/review/adversarial-helpers.ts:19-108`) and the semantic
`LLMFinding` — each gains `meta?: Record<string, unknown>`.

**`toAdversarialReviewFindings`** (`src/review/adversarial-helpers.ts:136`) and
**`llmFindingToFinding`** (`src/review/semantic-helpers.ts:188`) — each gains one allowlist
line forwarding `f.meta?.recurrence` into `metaExtras`, alongside the existing `evidence`
line.

**`AdversarialReviewConfigSchema.recurrenceDemotion`** (`src/config/schemas-review.ts:135-140`)

Baseline: `{ enabled: default(true), maxBlockingRounds: default(2) }`
Target: adds `maxAdvisoryRounds: z.number().int().min(1).default(2)`. The semantic schema at
`:77-82` takes the same field, with its `enabled` default left at `false`.

**`buildPriorIterationsBlock`** (`src/prompts/builders/prior-iterations-builder.ts:47`)

Baseline: renders every finding of every iteration into one verdict-required list.
Target: partitions each iteration's findings by `meta.recurrence.disposition`. Entries
stamped `retired` render in a separate acknowledgement section stating they are closed and
must not be re-flagged; every other entry renders as today. The verdict template counts only
the non-retired entries.

**`actionableAdvisoryFindings`** (`src/execution/non-blocking-fix.ts:54`)

Baseline: filters `actionRequired !== false` and `acDropped !== true`.
Target: additionally drops entries stamped `meta.recurrence.disposition === "retired"`. This
is a seeding-site filter, matching that function's own documented convention. Without it a
retired finding buys an agent session — the system would pay to fix what it just declared
closed.

### Disposition stamp

`meta.recurrence` is written by `classifyRecurrence` on every finding it returns:

```
{
  disposition: "blocking" | "advisory" | "demoted" | "retired",
  rounds: number,          // this finding's appearance count including this round
  wasBlocking: boolean     // severity was at or above the blocking threshold
}
```

`disposition: "demoted"` with `wasBlocking: true` is what makes a `passed: true` record
self-describing for nax#1928.

### File size

Against the 600-line source limit and the 800-line test limit enforced by
`bun run check:file-sizes`: `adversarial-review.ts` is 541 and `semantic-review.ts` 546, with
roughly 55 lines of headroom each — split by concern before growing either. Test targets:
`recurrence-demotion.test.ts` is 389 and `non-blocking-fix.test.ts` 741, both of which need a
new sibling file rather than growth (see each story's Creates).

### Failure Handling

| Condition | Behaviour |
|:---|:---|
| `cfg.enabled` is `false` | No stamp, no `retired` entries. Findings partition into `blocking`/`advisory` by severity exactly as today, and `classified` is the input array unchanged. |
| `cfg.maxAdvisoryRounds` is absent | `classifyRecurrence` uses `2`. |
| `priorIterations` is empty | Every finding has `rounds: 1`, so neither cap is reached and `retired` and `demoted` are empty. |
| A finding carries no `acIndex` | Fingerprinting falls back to file + category + issue prefix, as today. Disposition and stamping are unaffected. |
| An iteration entry carries no `meta.recurrence` | Rendered in the verdict list exactly as today, so rounds recorded before this feature keep their current behaviour. |

## Out of Scope

- The nax#1910 step-3 analyzer over `review-audit/*.json` — measured 2026-09-10 at 11.1% `unmatched` on 27 sub-threshold findings from a single feature, too small a sample to justify building it.
- Retiring a finding on `meta.evidence.status === "unmatched"`. All three `unmatched` findings in the measured corpus were substantive defects, so evidence status measures quote hygiene rather than finding validity and must not gate retirement.
- Seeding the non-blocking-fix lane from semantic-review's advisory bucket, tracked as nax#1957 and gated on the nax#1801 ruling.
- Changing how `passed` is computed at `adversarial-review.ts:512`. A record carrying `passed: true` beside a demoted `error` keeps that verdict and explains it.
- Enabling `recurrenceDemotion` for semantic-review. The schema field is wired, the default stays `false`, and flipping it is a separate decision needing its own baseline.
- The "whack-a-mole within a file" failure where each round yields genuinely new findings, tracked as nax#1157.
- Excluding `acDropped` findings from the non-blocking-fix seed. That filter at `non-blocking-fix.ts:54-60` is an existing hold on nax#1801 and is left exactly as it stands.
- Changing the `still-blocking` instruction at `prior-iterations-builder.ts:115`. Retirement works by moving a finding out of the verdict list, not by softening the instruction that governs the list.
- Similarity-clustering or otherwise changing `fingerprintFor`. Retirement inherits whatever recurrence identity that function already provides.
- Dropping retired findings from the iteration store or from `advisoryFindings`. They remain stored and remain reported; only their prompt rendering and their fix-lane eligibility change.

## Stories

### US-001 — Recurrence classification returns a terminal bucket and stamps its verdict

Depends on: nothing.

Move the recurrence count above the severity gate in `classifyRecurrence`, add the `retired`
terminal bucket governed by an optional `maxAdvisoryRounds` cap, widen the generic bound so
findings can carry `meta`, and stamp every returned finding with `meta.recurrence`. Return
`classified` so callers can persist the stamped set.

#### Context Files
- `src/review/recurrence-demotion.ts` — the function, its fingerprinting helpers, and `tagCoverageGap`
- `src/review/types.ts` — the inline `recurrenceDemotion` shapes at `:132` and `:258`
- `src/review/adversarial-helpers.ts` — `isBlockingSeverity` and the `RecurrenceCandidate` bound `tagCoverageGap` already uses

#### Creates
- `test/unit/review/recurrence-demotion-retirement.test.ts` — retirement and stamping tests; a sibling rather than growth, because `recurrence-demotion.test.ts` is already at the 400-line describe-split guidance in `.nax/rules/test-architecture.md`

#### Modifies

None. `recurrence-demotion.test.ts` keeps compiling because `maxAdvisoryRounds` is optional on `RecurrenceConfig`, and every sub-threshold fixture in it passes empty or blocking-severity priors, so no finding reaches the advisory cap.

### US-002 — The advisory cap is a configured value

Depends on: nothing. Runs in parallel with US-001.

Declare `maxAdvisoryRounds` on both `recurrenceDemotion` schema blocks so the cap is
configuration rather than a literal. Split from US-001 because that story reaches the
project's 24-AC cap without it.

#### Context Files
- `src/config/schemas-review.ts` — the two `recurrenceDemotion` schema blocks at `:77-82` and `:135-140`
- `test/unit/config/schemas-review.test.ts` — the exact-object default assertions
- `test/unit/config/semantic-review.test.ts` — the exact-object default assertions

#### Modifies

**US-002**
- `test/unit/config/schemas-review.test.ts` — the test at `:6-9` asserts `expect(parsed.recurrenceDemotion).toEqual({ enabled: true, maxBlockingRounds: 2 })`, and `:10-15` makes the same exact-object assertion for the override case. `toEqual` is exact, so the schema's new `maxAdvisoryRounds` default fails both against a correct implementation. US-002 owns updating them to the new invariant: the parsed object also carries `maxAdvisoryRounds: 2`.
- `test/unit/config/semantic-review.test.ts` — the assertion at `:113` pins `result.data.review.semantic` with `toEqual`, including a nested `recurrenceDemotion: { enabled: false, maxBlockingRounds: 2 }`. The new schema default breaks it against a correct implementation. US-002 owns updating it to the new invariant: the nested object also carries `maxAdvisoryRounds: 2`.
- `test/unit/config/semantic-review.test.ts` — the assertion at `:258` makes the same exact-object claim over `DEFAULT_CONFIG.review.semantic`. Same break, same replacing invariant. Listed separately from `:113` because a repeated path under one story is deduplicated by `nax plan`, so this bullet exists to keep the second assertion's reason on the record even though only one entry survives.

### US-003 — The stamp survives both mappers and reaches the audit record

Depends on: US-001, US-002.

Give both LLM finding types an optional `meta`, forward `recurrence` through both mappers'
allowlists, and have the review operations persist `classified` as `findings` and fold
`retired` into `advisoryFindings`. This is what makes the disposition visible to the audit
record (nax#1928) and to the prompt builder (US-003).

#### Context Files
- `src/review/adversarial-helpers.ts` — `AdversarialLLMFinding` at `:19-108` and the `metaExtras` allowlist at `:141-151`
- `src/review/semantic-helpers.ts` — `llmFindingToFinding` at `:188-196` and the raw-shape note at `:61-62`
- `src/operations/adversarial-review.ts` — the config fallback at `:479`, the classify call at `:484`, the demotion log at `:491-499`, and the verdict return at `:526-539`
- `src/operations/semantic-review.ts` — the config fallback at `:425` and the mirror bucket at `:446-449`
- `src/execution/story-orchestrator/review-decision.ts` — the `result.findings` passthrough at `:92`

#### Modifies

None. The existing verify() tests survive: `adversarial-advisory-findings.test.ts:42-43` and
`adversarial-review-verify-ac-dropped.test.ts:160` are closed-world assertions over
`advisoryFindings`, but every fixture in them passes empty prior iterations, so no finding
reaches the advisory cap and no `retired` entry is produced. `adversarial-review.test.ts`
asserts on `findings` by length and `issue` only, which additive stamping does not disturb.

### US-004 — Retirement takes effect in the prompt and in the fix lane

Depends on: US-003.

Render retired findings in an acknowledgement block that forbids re-flagging rather than in
the verdict list that mandates it, and stop seeding them into the non-blocking-fix lane.

#### Context Files
- `src/prompts/builders/prior-iterations-builder.ts` — `buildPriorIterationsBlock` at `:47`, `renderIteration` at `:86`, `renderFinding` at `:95`, `renderVerdictTemplate` at `:105`, and the `still-blocking` instruction at `:115`
- `src/execution/non-blocking-fix.ts` — `actionableAdvisoryFindings` at `:54-60`
- `src/review/recurrence-demotion.ts` — the `meta.recurrence` stamp shape, created by US-001 and read by every filter in this story

#### Creates
- `test/unit/execution/non-blocking-fix-retirement.test.ts` — seed-filter tests; a sibling rather than growth, because `non-blocking-fix.test.ts` is 741 lines against the 800-line test limit

#### Modifies

**US-003**
- `test/unit/prompts/builders/prior-iterations-builder.test.ts` — assertions over the rendered block's finding count and its verdict template. Under AC 1 and AC 5 a retired entry leaves the verdict list and the template count drops accordingly, so any count-based expectation over a fixture containing a stamped entry fails against a correct implementation. US-003 owns updating them to the new invariant: the verdict list and its template count only entries not stamped `disposition: "retired"`, and retired entries appear once in the acknowledgement section.

## Acceptance Criteria

### US-001

1. `[unit]` `classifyRecurrence` returns an object carrying a `retired` array and a `classified` array in addition to `blocking`, `advisory` and `demoted`.
2. `[unit]` Given a sub-threshold finding (severity `warning`, threshold `error`) whose fingerprint appears in `priorIterations` fewer times than `maxAdvisoryRounds`, `classifyRecurrence` places it in `advisory` and not in `retired`.
3. `[unit]` Given a sub-threshold finding whose appearance count including the current round is at or above `maxAdvisoryRounds`, `classifyRecurrence` places it in `retired` and not in `advisory`.
4. `[unit]` Given an `error`-severity finding whose appearance count including the current round is at or above `maxBlockingRounds + 1`, `classifyRecurrence` places it in `demoted` and not in `retired`.
5. `[unit]` `classifyRecurrence` called with a `cfg` omitting `maxAdvisoryRounds` retires a sub-threshold finding whose appearance count including the current round is 2, applying the documented default.
6. `[unit]` Every finding returned in `classified` carries `meta.recurrence.disposition` equal to the name of the bucket it was placed in, one of `blocking`, `advisory`, `demoted` or `retired`.
7. `[unit]` A finding placed in `demoted` carries `meta.recurrence.wasBlocking` equal to `true`.
8. `[unit]` A finding placed in `retired` carries `meta.recurrence.wasBlocking` equal to `false`.
9. `[unit]` Every finding returned in `classified` carries `meta.recurrence.rounds` equal to its prior appearance count plus one.
10. `[unit]` `classified` contains one entry per input finding, in input order.
11. `[unit]` `classifyRecurrence` does not mutate the findings passed to it: an input finding whose `meta` was absent still has `meta` absent after the call.
12. `[unit]` A finding that already carries an unrelated `meta` key retains that key alongside `meta.recurrence` in `classified`.
13. `[unit]` When `cfg.enabled` is `false`, `classifyRecurrence` returns an empty `retired` array.
14. `[unit]` When `cfg.enabled` is `false`, no finding returned by `classifyRecurrence` carries `meta.recurrence`.
15. `[unit]` When `cfg.enabled` is `false`, `classifyRecurrence` partitions findings into `blocking` and `advisory` by severity alone, matching its behaviour before this feature.
16. `[unit]` Given a finding carrying no `acIndex`, `classifyRecurrence` counts its prior appearances using the existing file, category and issue-prefix fingerprint fallback, and its disposition is unaffected by the absence of `acIndex`.
15. `[unit]` When `priorIterations` is empty, `classifyRecurrence` returns an empty `retired` array.
16. `[unit]` When `priorIterations` is empty, every entry of `classified` carries `meta.recurrence.rounds` equal to 1.
17. `[unit]` A finding whose `category` is `test-gap`, whose file matches the test-file predicate, and whose severity is at or above the blocking threshold is placed in `blocking` regardless of its appearance count.
18. `[unit]` A finding whose `category` is `test-gap` and whose file matches the test-file predicate but whose severity is below the blocking threshold is not placed in `blocking`.
19. `[unit]` `tagCoverageGap` applied to a finding already carrying `meta.recurrence` returns a finding carrying both `meta.recurrence` and `meta.coverageGap` equal to `true`.

**Out of scope:** the wording of the reviewer prompt; the `meta.coverageGap` tag's own semantics, which are unchanged.

### US-002

1. `[unit]` Constructing the adversarial review config with `recurrenceDemotion.maxAdvisoryRounds` unset yields a resolved value of `2`.
2. `[unit]` Constructing the semantic review config with `recurrenceDemotion.maxAdvisoryRounds` unset yields a resolved value of `2`.
3. `[unit]` Constructing the semantic review config with `recurrenceDemotion.enabled` unset yields a resolved value of `false`.
4. `[unit]` Constructing either review config with `recurrenceDemotion.maxAdvisoryRounds` set to `0` is rejected by schema validation.
5. `[unit]` Constructing the adversarial review config with `recurrenceDemotion.maxAdvisoryRounds` set to `5` yields a resolved value of `5`, so the cap is configuration rather than a literal.

**Out of scope:** the runtime default `classifyRecurrence` applies when the field is absent from a caller-supplied config object, which US-001 owns.

### US-003

1. `[unit]` `toAdversarialReviewFindings` applied to an LLM finding carrying `meta.recurrence` returns a `Finding` whose `meta.recurrence` holds the same `disposition`, `rounds` and `wasBlocking` values.
2. `[unit]` `toAdversarialReviewFindings` applied to an LLM finding carrying no `meta` returns a `Finding` whose `meta` does not include a `recurrence` key.
3. `[unit]` `toAdversarialReviewFindings` applied to an LLM finding carrying both `meta.recurrence` and `verifiedBy` returns a `Finding` carrying both `meta.recurrence` and `meta.verifiedBy`.
4. `[unit]` `llmFindingToFinding` applied to a semantic LLM finding carrying `meta.recurrence` returns a `Finding` whose `meta.recurrence` holds the same values.
5. `[unit]` `adversarialReviewOp.verify()` returns `findings` containing one entry per accepted finding, each carrying `meta.recurrence.disposition`.
6. `[unit]` `adversarialReviewOp.verify()` returns `advisoryFindings` containing every entry classified `retired`, in addition to the advisory, demoted and AC-dropped entries it already carries.
7. `[unit]` `adversarialReviewOp.verify()` returns `normalizedFindings` containing only entries classified `blocking`, so a retired finding is never routable to the rectification cycle.
8. `[unit]` Driving `adversarialReviewOp.verify()` with a `warning`-severity finding and a `priorAdversarialIterations` array carrying the same fingerprint enough times to reach `maxAdvisoryRounds` returns that finding inside `advisoryFindings` stamped `meta.recurrence.disposition` equal to `retired`.
9. `[unit]` When `classifyRecurrence` returns a non-empty `retired` array, `adversarialReviewOp.verify()` emits one log record per retired finding at info level on the `review` channel with `event` equal to `review.adversarial.recurrence_retired`, carrying the finding's `file` and `category`.
10. `[unit]` The existing demotion log with `event` equal to `review.adversarial.recurrence_demoted` is still emitted once per demoted finding.
11. `[unit]` `semanticReviewOp.verify()` returns `findings` containing one entry per accepted finding, each carrying `meta.recurrence.disposition`, when its `recurrenceDemotion.enabled` is `true`.
12. `[unit]` With `recurrenceDemotion.enabled` left at its `false` default, `semanticReviewOp.verify()` returns an `advisoryFindings` array whose entries carry no `meta.recurrence`.
13. `[integration]` The review-audit entry built from an adversarial verify output whose `findings` carry `meta.recurrence` exposes those values under `result.findings`, so a reader of a `passed: true` record can tell a demoted `error` from a miscomputed verdict without replaying demotion state.
14. `[unit]` `adversarialReviewOp.verify()` returns `passed` equal to `true` when an `error`-severity finding was classified `demoted` and `blocking` is empty, so the verdict rule at `adversarial-review.ts:512` is unchanged by this feature.

**Out of scope:** the computation of `passed`; enabling `recurrenceDemotion` for semantic-review, whose default stays `false`.

### US-004

1. `[unit]` `buildPriorIterationsBlock` given an iteration whose findings include one stamped `meta.recurrence.disposition` equal to `retired` returns a block whose verdict-required list omits that finding.
2. `[unit]` `buildPriorIterationsBlock` given that same iteration returns a block containing an acknowledgement section naming that finding's file and category.
3. `[unit]` The acknowledgement section states that the listed findings are closed and must not be re-flagged, so the `still-blocking` instruction at `prior-iterations-builder.ts:115` does not apply to them.
4. `[unit]` `buildPriorIterationsBlock` given an iteration whose findings carry no `meta.recurrence` returns a block identical to the one it returns today, so rounds recorded before this feature render unchanged.
5. `[unit]` The verdict template returned by `buildPriorIterationsBlock` counts only findings not stamped `retired`.
6. `[unit]` `buildPriorIterationsBlock` given an iteration whose findings are all stamped `retired` returns a block containing no verdict-required list.
7. `[integration]` Given three consecutive review rounds where a `warning`-severity finding is emitted in round 1 and reaches `maxAdvisoryRounds` in round 2, the prior-iterations block built for round 3 lists that finding only in the acknowledgement section.
8. `[unit]` `actionableAdvisoryFindings` given a finding stamped `meta.recurrence.disposition` equal to `retired` returns a list omitting it.
9. `[unit]` `actionableAdvisoryFindings` given a finding stamped `meta.recurrence.disposition` equal to `advisory` returns a list containing it.
10. `[unit]` `actionableAdvisoryFindings` continues to omit findings whose `actionRequired` is `false` and findings whose `acDropped` is `true`.
11. `[unit]` `shouldRunNonBlockingFix` receives an advisory count that excludes retired findings, so a round whose only advisory findings are retired dispatches no fix pass.

**Out of scope:** the run-end advisory report surface, which continues to read `advisoryFindings` and therefore still lists retired findings.

<!-- spec-writing: completed-through-phase-6 -->

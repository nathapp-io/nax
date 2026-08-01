# nax review-pipeline gap analysis — 2026-08-01

**Scope:** semantic + adversarial review behaviour during July 2026, with an emphasis on runs
where the reviewer agent gave up (unparseable output) or failed to converge.

**Evidence base:** 1,857 review-audit records dated `2026-07-01` or later, read from
`~/.nax/<project>/review-audit/**/*.json` across `nax`, `rs-stock`, `nathapp-nestjs`,
`nathapp-nestjs-platform`, `nathapp-nestjs-starter`, `nathapp-nestjs-outbox-providers`
(plus `koda` and `iot-system`, which share the schema).

**Code base:** `repos/nax` @ `c8f74c5f` (v0.75.5). Cross-checked against
`repos/nax-spec-kit-skills` @ `c82da98` (v0.2.9).

All line references below were read at those commits.

---

## 0. Corrections to the first-pass analysis

Recorded so the retracted claims do not get re-cited from an earlier draft.

| Claim (first pass) | Verdict | Why |
|:---|:---|:---|
| "ACP tail-truncates agent output at 5,000 chars, so truncation systematically eats the leading `"passed"` key" | **Retracted** | `MAX_AGENT_OUTPUT_CHARS = 5000` (`src/agents/acp/adapter.ts:70`) is exported but never applied. Its only consumers are two truncation *detectors* (`src/review/truncation.ts:24`, `src/agents/retry/tiered-parse-retry.ts:40`). The adapter's only `.slice()` calls are on error messages. July records confirm it: parsed `result` payloads reach 11,750 bytes. The docstring in `truncation.ts` asserting adapter-side tail truncation is stale. |
| "Reviewer file paths are unanchored, so evidence substantiation breaks in monorepos" | **Retracted as stated** | `checkFindingEvidence` (`src/review/semantic-evidence.ts:81`) already tries `repoRoot` then `workdir` as a dual-root fallback. Findings are not wrongly downgraded by prefix drift. The path instability is real but lands on fingerprinting instead — see F1. |
| "Reviewers report one finding at a time; they should enumerate" | **Retracted** | Round-by-round read of the worst case shows 9 findings in round 1 and 4 in round 9. The reviewer does enumerate; it enumerates a *different subset* each round. See F4. |

Everything else below survived verification unchanged.

---

## Findings

### F1 — Convergence control is inert; this is the dominant cost

**Severity: high. This is the largest item in the data.**

Review rounds per `(feature, story, reviewer)` in July:

| | pairs | mean | p50 | ≥5 rounds | ≥8 rounds | max |
|:---|---:|---:|---:|---:|---:|---:|
| adversarial | 519 | 1.73 | 1 | 28 | 5 | 17 |
| semantic | 525 | 1.83 | 1 | 35 | 10 | 15 |
| **total** | **1044** | **1.78** | **1** | **63** | **15** | **17** |

Worst offenders:

```
17  auth-security-hardening US-004  adversarial
15  notif-dlq-hardening US-001      semantic
13  oauth-idempotency US-002        semantic
12  backtest-sweep US-004           semantic
11  w1-observability-pages US-003   semantic
11  backtest-robustness US-005      semantic
```

Reading all 17 rounds of `auth-security-hardening US-004` end to end, the story never converges:

```
errors per round: 3 1 2 1 1 2 2 2 1 1 1 0 1 3 3 1 1
```

Round 12 **passed** (0 errors), round 13 failed again, and rounds 14–15 carried *more* errors
than round 2. Four defects recur from round 1 through round 9+ — expired rows never checked,
replay-key format mismatch, non-atomic window expiry, nullable `tenantId` — and none is ever
fixed.

Recurrence-demotion was enabled for this run and **never fired**. Root cause is the fingerprint
at `src/review/recurrence-demotion.ts:29`:

```ts
fingerprintFor(file, category, text)
  => `${file.replace(/\\/g,"/")}|${category ?? ""}|${normalizeIssueText(text).slice(0,48)}`
```

All three components are reviewer-controlled and unstable:

1. **`category` churns.** One defect — "expired replay rows are never removed" — is filed as
   `assumption` (r3), `error-path` (r4), `input` (r5), `error-path` (r6, r8).
2. **The 48-char issue prefix churns.** The function's own comment claims the truncation
   survives "a tail rephrase." The reviewer does not rephrase the tail — it rewrites the
   **opening clause** every round:
   - r3 `"the stored expiresat is never consulted and expired…"`
   - r5 `"ttl is only written to expiresat; existing rows are…"`
   - r6 `"expired replay rows are never removed or ignored. a…"`
   - r8 `"the stored expiresat is never consulted and replay …"`
3. **`file` churns in monorepos.** In `backtest-sweep US-004` the same file is cited as
   `components/SweepForm.tsx`, `apps/web/components/SweepForm.tsx`, and
   `../../apps/api/src/stock_api/dto.py` across rounds. `fingerprintFor` only does a
   backslash replace — no resolution against `repoRoot`.

Consequence: `countPriorAppearances` never reaches 2, nothing is demoted, and the suppressor
no-ops on exactly the stories that need it. **This also means the `coverageGap` tag is never
applied**, so the telemetry F3 restores would still read empty until F1 is fixed.

Secondary, same theme: recurrence-demotion is **adversarial-only**
(`src/operations/adversarial-review.ts:545`; `countPriorAppearances` skips any finding where
`f.source !== "adversarial-review"`). Semantic review has no suppression at all and carries 2×
the ≥8-round stories (10 vs 5). Extending it is worthless until the fingerprint is stable.

---

### F2 — Give-ups are undiagnosable; 7 stories shipped unreviewed

**Severity: medium-high. 13 occurrences / 1,857 (0.7%).**

`parsed: false` means the reviewer's output could not be parsed after the retry budget was spent.

| reviewer | total | parsed=false | fail-**open** (silently green) | fail-closed |
|:---|---:|---:|---:|---:|
| adversarial | 896 | 5 | 3 | 2 |
| semantic | 961 | 8 | 4 | 4 |

The 13, oldest first:

```
07-08  secrets-at-rest-encryption US-003   adversarial  OPEN    codex
07-09  nestjs-storage-modernization US-002 adversarial  OPEN    opencode
07-12  w1-observability-pages US-006       semantic     OPEN    —
07-12  notify-delivery-tracking US-001     semantic     OPEN    —
07-16  notif-dlq-hardening US-001          semantic     closed  codex
07-16  notif-dlq-hardening US-001          adversarial  closed  codex
07-16  auth-security-hardening US-003      semantic     OPEN    codex
07-19  position-reconcile US-002           semantic     closed  opencode
07-21  backtest-sweep US-004               semantic     closed  codex
07-23  oauth-idempotency US-002            adversarial  closed  codex
07-23  oauth-idempotency US-002            semantic     closed  codex
07-26  redis-seams-inline US-002           semantic     OPEN    —
07-29  portfolio-strategy-mandate US-003   adversarial  OPEN    codex
```

6 of the 13 occurred on **round 1**, so this is not purely an artifact of long loops.

**Mechanism.** `maxAttempts: 2` (`src/operations/semantic-review.ts:308`,
`adversarial-review.ts:249`) combined with `attempt >= maxAttempts - 1`
(`src/agents/retry/parse-retry.ts:86`) yields exactly **one** retry. On exhaustion
(`semantic-review.ts:313`):

```ts
exhaustedFallback: (lastOutput) =>
  /"passed"\s*:\s*false/.test(lastOutput)
    ? { passed: false, ..., looksLikeFail: true }   // blocks
    : FAIL_OPEN,                                    // story passes, unreviewed
```

7 of 13 resolved to `FAIL_OPEN`. `logUnifiedReviewPhaseResult` emits a `warn`, nothing gates on
it, and the run summary reads as a clean pass.

**Why the fix is blocked on evidence.** `makeParseRetryStrategy` accepts `outputPreviewBytes`,
which logs the unparseable text. It is set by exactly one op — `src/operations/verify.ts:169`
(600 bytes). **Neither review op sets it.** `~/.nax/<project>/prompt-audit/` stores prompts
only, never responses. So for all 13 July give-ups the only surviving record is
`originalByteSize`; the content is gone. There is no basis on which to choose between "retry
harder", "reprompt differently", and "treat exhaustion as blocking".

**Related, lower impact.** `looksLikeTruncatedJson` (`src/review/truncation.ts:24`) returns true
for any output ≥ 4,900 chars. Since nothing truncates, that is simply "any long review". July
`result` payloads are p50 959 / p90 4,340 / p99 7,640 bytes, with 164 records over 4,500 — so a
meaningful share of *complete*, finding-rich reviews get routed to the condensed retry prompt on
any parse hiccup and told "Your previous response was truncated", which is false. Blast radius
is small because `ReviewPromptBuilder.jsonRetryCondensed` is well-built (it preserves **all**
blocking findings and caps only advisories at 3), but the detector should key on actual JSON
incompleteness rather than length.

---

### F3 — Four review-audit fields are dead in 100% of records

**Severity: medium. Cheapest item to fix.**

Across all 1,857 July records, these are `null` in **every single one**:

- `advisoryFindings`
- `diffAvailable`
- `adversarialDropAnalysis`
- `adversarialAcceptAnalysis`

`acDropped` never reaches the audit file at all.

**Cause — an unreconciled fork.** `src/review/adversarial.ts:372-453` computes the full
issue-#986 counterfactual analysis and emits it via `adversarial-audit-event.ts`. That path is
dead: `runAdversarialReview` / `runSemanticReview` have no live callers (the only surviving
references are comments at `src/execution/plan-inputs.ts:312`). Live reviews go through
`story-orchestrator/run-phase.ts:202 → review-decision.ts:51`, whose `emitReviewDecision` builds
the event from `toReviewDecisionPayload` and forwards **none** of the above — not even
`acDropped`, which it computes at `review-decision.ts:23` and then drops at the emit call.

`ReviewDecisionEvent` declares all of these fields (`src/runtime/dispatch-events.ts:104-112`)
and the middleware forwards them faithfully
(`src/runtime/middleware/review-audit.ts:53-61`). The break is solely in the emitter.

**Consequences:**

- `filterByAcGroundingMinimal` drops any finding whose `acIndex` is missing or out of range
  (`src/review/ac-quote-validator.ts:215`). A genuine wiring bug the adversarial reviewer found
  but could not pin to an AC is deleted with **no record anywhere**.
- The `nax-coverage-gap` skill reads `advisoryFindings[].meta.coverageGap`
  (`nax-toolkit-skills/.../nax-coverage-gap/SKILL.md:59`). It reports empty on every run and
  reads as "recurrence-demotion is not dropping anything" when the truth is unknown.
  **Note the ordering dependency: fixing F3 alone does not make this skill meaningful, because
  F1 means nothing is ever tagged `coverageGap`.**

---

### F4 — Fixes are not landing; investigate the rectification lane

**Severity: unknown — needs its own read-through. Do not prescribe yet.**

The enumeration hypothesis is dead (see §0). The reviewer returns 9 findings in round 1 and 4 in
round 9; it is enumerating. What it is doing is sampling a *different* subset of a large space of
true defects each round, while the same four defects survive all 17 rounds unfixed.

That points at the fix lane, not the review prompt. The equivalent artifact read-through
(rectifier sessions, `non-blocking-fix`, autofix strategies) has not been done, and no fix should
be proposed for this until it has. Prompt-tweaking the reviewer here would not address it.

---

### F5 — spec-kit: already covers the July failure shapes, one narrow gap

**Severity: low.**

The July oscillations were dominated by wiring and cross-package contract defects. spec-kit
v0.2.9 already encodes those lessons — the two-anchor seam rule, seam-altitude ("name the entry
point, not 'the production path'"), guarded-seam re-trigger ACs, and the data-availability seam
(`spec-writing/SKILL.md:195-205`, `spec-review/checklists/phase-8-seam-deletion-audit.md:91`).
The monorepo guide's worked example is literally the `backtest-sweep` shape
(`spec-writing/reference/spec-writing-guide.md:301`). The specs that oscillated predate those
rules. **No re-open warranted.**

One direction remains uncovered. Phase 8's data-availability seam checks *consumer reads fields
the producer emits*. `backtest-sweep`'s single most-repeated finding was the reverse — the
consumer **sends** `param_grid` as an array of `{key, values}` rows where the producer declares
`param_grid: dict[str, list[Any]]`. Phase 2's shape audit covers response and event payloads,
not request bodies crossing a package boundary.

`nax plan` was checked on the same axes and found clean: it preserves every spec AC (never
drops), rewrites deprecated `[grep]` / `[file]` / `[verbatim]` tags into behavioural assertions
(`plan-builder.ts:196,204,263`), and restores `outOfScope` verbatim (`plan-builder.ts:233`).

---

## Suggested fix order

The ordering is driven by two hard dependencies, not by severity alone:

- **F3 → F1 for telemetry:** F3 restores the field, F1 makes the field non-empty. Either alone
  leaves `nax-coverage-gap` useless.
- **F2-preview → F2-semantics:** the verdict-on-exhaustion decision cannot be made without
  evidence about what the give-ups actually emitted.

| # | Item | Why here | Size |
|:--|:---|:---|:---|
| **1** | **F2a — set `outputPreviewBytes` on both review ops; persist the preview into the review-audit record alongside `parsed: false`** | Two lines. Unblocks every downstream decision about give-up handling, and starts accumulating evidence immediately while later items are in flight. Do this first purely for the lead time. | XS |
| **2** | **F3 — forward `advisoryFindings`, `acDropped`, `diffAvailable`, and the drop/accept counterfactuals from `emitReviewDecision`** | Self-contained; the event type and middleware already support it. Immediately un-blinds AC-grounding drops (independent of F1). Delete or reconcile the dead `src/review/adversarial.ts` emit path in the same change — two emitters where one is unreachable is how this drifted. | S |
| **3** | **F1a — stabilise `fingerprintFor`: resolve `file` against `repoRoot`, drop `category` from the key, replace the 48-char prefix with a token-set signature** | The dominant cost driver, and a prerequisite for the F3 telemetry being meaningful. Ship with a regression test that feeds the r3/r5/r6/r8 issue strings from F1 and asserts a single fingerprint. | M |
| **4** | **F2b — decide give-up semantics from the evidence item 1 collects** | Needs ~a month of previews, or a handful of reproductions. Safe interim if you want it sooner: make exhaustion block regardless of the regex — 7 unreviewed stories/month is a worse failure than a few spurious blocks. Also re-key `looksLikeTruncatedJson` on JSON completeness rather than length. | S–M |
| **5** | **F1b — extend recurrence-demotion to semantic review** | Worthless before item 3. Semantic carries 2× the ≥8-round stories, so this is where the remaining oscillation cost sits once the fingerprint is stable. | M |
| **6** | **F4 — read the rectification-lane artifacts the way the review lane was read here** | Fresh investigation, no fix proposed. Likely the deepest remaining issue but currently unevidenced. | L |
| **7** | **F5 — extend spec-review Phase 8 to request-direction cross-package contracts** | Independent of everything above; fold in whenever spec-kit is next touched. | S |

Items 1 and 2 are independent of each other and of everything else — they can go in parallel or
in one PR. Items 3 and 5 are strictly sequential. Item 6 can start at any time since it is
read-only.

---

## Reproduction

```bash
# July give-ups
cd ~/.nax && jq -s -r '
  map(select(.timestamp >= "2026-07-01" and (.parsed==false or .failOpen==true)))
  | sort_by(.timestamp) | .[]
  | [.timestamp, .featureName, .storyId, .reviewer,
     "failOpen=\(.failOpen)", "agent=\(.agentName)"] | @tsv
' */review-audit/*/*.json

# rounds per story/reviewer
cd ~/.nax && jq -s -r '
  map(select(.timestamp>="2026-07-01"))
  | group_by(.featureName+"|"+(.storyId//"?")+"|"+.reviewer)
  | map({k:(.[0].featureName+" "+(.[0].storyId//"?")+" "+.[0].reviewer), n:length})
  | sort_by(.n) | reverse | .[0:18] | .[] | "\(.n)\t\(.k)"
' */review-audit/*/*.json

# dead fields
cd ~/.nax && jq -s -r '
  map(select(.timestamp>="2026-07-01"))
  | {total:length,
     advisory:(map(select(.advisoryFindings!=null))|length),
     dropAn:(map(select(.adversarialDropAnalysis!=null))|length),
     acceptAn:(map(select(.adversarialAcceptAnalysis!=null))|length),
     diffAvail:(map(select(.diffAvailable!=null))|length)}
' */review-audit/*/*.json

# the 17-round non-convergence
cd ~/.nax/nathapp-nestjs-platform/review-audit/auth-security-hardening && jq -s -r '
  map(select(.storyId=="US-004" and .reviewer=="adversarial"))
  | sort_by(.timestamp) | .[]
  | "\(.timestamp[5:16])\tpassed=\(.passed)\tn=\((.result.findings//[])|length)\terrors=\((.result.findings//[])|map(select(.severity=="error"))|length)"
' *.json
```

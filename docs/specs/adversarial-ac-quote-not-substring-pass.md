# Fix Spec: Flip to Pass When All Blocking Findings Dropped as `ac_quote_not_substring`

**Issue:** [#1031](https://github.com/nathapp-io/nax/issues/1031)  
**Observed in run:** `2026-05-14T02-46-16.jsonl` — US-003, lines 956–988  
**Status:** Ready to implement

---

## Background

When the adversarial reviewer emits `passed: false` but every blocking finding fails the `acQuote` validator with code `ac_quote_not_substring`, the system currently fails-closed. This causes:

1. A ghost finding (`"adversarial in unknown"`) to propagate into the autofix cycle
2. The autofix implementer burns its full attempt budget on content-free instructions
3. The story escalates to the powerful tier unnecessarily

`ac_quote_not_substring` means the model wrote an `acQuote` string that is **not a verbatim substring of any AC text**. The model fabricated evidence it could not find. This is qualitatively different from the other two drop codes:

| Drop code | What it means | Finding reliability |
|---|---|---|
| `ac_quote_not_substring` | Model's quoted text does not exist in any AC | Quote fabricated — no AC grounding exists |
| `ac_quote_does_not_constrain_locus` | Quote exists in AC but doesn't mention the flagged symbol | Finding may be real; AC misattributed |
| `missing_ac_quote` | No quote provided at all | Finding may be real; just un-cited |

Failing-closed for `ac_quote_not_substring` treats fabricated evidence as load-bearing. The appropriate response is to pass — while preserving the finding as a demoted advisory `warning` so it remains visible.

### Evidence from the triggering run

**US-003, iteration 2** (`1778733681432-review-adversarial-US-003.json`):

- Model found a real bug: `total_success += 1` on line 89 of `data.py` is unconditional — a failed `_refresh_one_universe` call is still counted as success, producing exit 0 when exit 1 is required
- No AC explicitly covers `--universe`/`--all` exit code behavior on failure
- Model cited `acIndex: 11` (the `--ohlcv` all-fail AC) but wrote a quote that does not appear in AC#11
- Validator dropped the finding as `ac_quote_not_substring`
- 3 autofix implementer sessions ran on the ghost finding; cap reached; story escalated
- Powerful tier re-implemented from scratch and fixed the bug as part of a clean run

The finding was **real**. The AC grounding was **hallucinated**. Failing-closed had zero quality benefit and cost one full escalation cycle.

---

## Normalization is not the fix

The issue's investigation checklist asks whether `normalizeWs`/`stripMarkdownInline` could bridge the gap. It cannot. AC#11 is plain ASCII with no unusual whitespace or markdown. The model's `acQuote` referenced `--universe`/`--all` semantics that do not appear in AC#11 in any form. This is fabrication, not a normalization artifact.

---

## Decision

Split the existing fail-closed branch into two cases based on the drop codes:

| Case | Condition | Action |
|---|---|---|
| A — all hallucinated | Every entry in `acDropped` has `code === "ac_quote_not_substring"` | **Pass** — demote each dropped finding to `warning`, include in advisory list |
| B — any un-cited or misattributed | Any entry has `code === "missing_ac_quote"` or `"ac_quote_does_not_constrain_locus"` | **Fail-closed** — no change to existing behavior |

---

## Files

| File | Change |
|---|---|
| `src/review/adversarial.ts` | Split fail-closed branch; build demoted advisory findings; return pass with `passReason` |
| `src/review/types.ts` | Add optional `passReason` field to `ReviewCheckResult` |
| `test/unit/review/adversarial.test.ts` | Add 5 new test cases (see below) |

---

## Detailed Changes

### `src/review/types.ts`

Add one optional field to `ReviewCheckResult`:

```typescript
/**
 * Set when the adversarial check passed because all blocking findings were
 * discarded as hallucinated AC quotes (ac_quote_not_substring). Consumers
 * in a retry context should treat this as a weaker pass signal than a genuine
 * adversarial pass.
 */
passReason?: "ac_quote_not_substring_demoted";
```

### `src/review/adversarial.ts` — fail-closed block (~line 560)

Replace the existing unified `if (acDropped.length > 0)` branch with:

```typescript
if (acDropped.length > 0) {
  const allHallucinated = acDropped.every((d) => d.code === "ac_quote_not_substring");

  if (allHallucinated) {
    // Case A: every blocking finding cited a quote that does not exist in any AC.
    // The model fabricated its grounding. Treat as pass — but demote each dropped
    // finding to "warning" and surface it as advisory so it remains auditable.
    const demotedFindings = llmFindingsToReviewFindings(
      acDropped.map((d) => ({ ...d.finding, severity: "warning" as const, acQuote: undefined, acIndex: undefined })),
      { source: "adversarial-review" },
    );
    const allAdvisory = [...(advisoryFindings.length > 0
      ? llmFindingsToReviewFindings(advisoryFindings, { source: "adversarial-review" })
      : []), ...demotedFindings];

    const durationMs = Date.now() - startTime;
    logger?.warn(
      "review",
      "Adversarial review passed: all blocking findings discarded as hallucinated AC quotes",
      {
        storyId: story.id,
        durationMs,
        droppedCount: acDropped.length,
        drops: acDropped.map((d) => ({ file: d.finding.file, issue: d.finding.issue })),
      },
    );
    recordAdversarialAudit({
      runtime,
      workdir,
      projectDir,
      storyId: story.id,
      featureName,
      parsed: true,
      failOpen: false,
      passed: true,
      passReason: "ac_quote_not_substring_demoted",
      blockingThreshold: threshold,
      result: { passed: true, findings: [] },
      advisoryFindings: allAdvisory.length > 0 ? allAdvisory : undefined,
      diffAvailable,
      adversarialDropAnalysis,
      adversarialAcceptAnalysis: [],
    });
    return {
      check: "adversarial",
      success: true,
      passReason: "ac_quote_not_substring_demoted",
      command: "",
      exitCode: 0,
      output: "",
      durationMs,
      advisoryFindings: allAdvisory.length > 0 ? allAdvisory : undefined,
      cost: llmCost,
    };
  }

  // Case B: mix includes missing_ac_quote or ac_quote_does_not_constrain_locus —
  // fail-closed (existing behavior unchanged).
  const durationMs = Date.now() - startTime;
  logger?.warn("review", "Adversarial review fail-closed: blocking findings dropped as ungrounded", {
    storyId: story.id,
    durationMs,
    droppedCount: acDropped.length,
    dropCodes: acDropped.map((d) => d.code),
  });
  // ... (rest of existing fail-closed return unchanged)
}
```

> **Note on `recordAdversarialAudit`:** the `passReason` field needs to be threaded through to the audit schema. Check whether the audit record type already accepts arbitrary extra fields or needs a typed extension.

---

## Acceptance Criteria

1. `runAdversarialReview` returns `{ success: true, passReason: "ac_quote_not_substring_demoted" }` when the LLM emits `passed: false` and **every** entry in `acDropped` has `code === "ac_quote_not_substring"`
2. The returned `advisoryFindings` includes each demoted finding at severity `"warning"`, without `acQuote`/`acIndex`, merged with any pre-existing advisory findings from the same response
3. A `warn` log is emitted with `droppedCount` and per-finding `file`+`issue` before returning pass
4. The written audit record has `passed: true` and includes `passReason: "ac_quote_not_substring_demoted"`
5. When **any** drop has code `missing_ac_quote` or `ac_quote_does_not_constrain_locus`, the existing fail-closed path is used — no change
6. When drops are a mix (some `ac_quote_not_substring`, some other), fail-closed path is used
7. No regression on stories where acDropped is empty — the outer `if (acDropped.length > 0)` check is preserved

---

## Test Cases

File: `test/unit/review/adversarial.test.ts`

### Case 1 — all drops `ac_quote_not_substring` → pass with demoted advisory

```
Setup:  LLM response: passed: false, findings: [{ severity: "error", acQuote: "fabricated text", acIndex: 1 }]
        AC text: "something else entirely"  (quote is not a substring)
Expect: success: true
        passReason: "ac_quote_not_substring_demoted"
        advisoryFindings: [{ severity: "warning", file: ..., issue: ... }]  (demoted, no acQuote)
```

### Case 2 — mix: one `ac_quote_not_substring` + one `missing_ac_quote` → fail-closed

```
Setup:  Two error findings: first has fabricated acQuote; second has no acQuote
Expect: success: false
        passReason: undefined
```

### Case 3 — all drops `missing_ac_quote` → fail-closed (no regression)

```
Setup:  LLM response: passed: false, findings: [{ severity: "error" }]  (no acQuote at all)
Expect: success: false
        passReason: undefined
```

### Case 4 — all drops `ac_quote_does_not_constrain_locus` → fail-closed (no regression)

```
Setup:  Error finding with valid acQuote substring but no locus keyword match
Expect: success: false
        passReason: undefined
```

### Case 5 — all drops `ac_quote_not_substring` + pre-existing advisory findings → advisory merged

```
Setup:  LLM response: passed: false
        findings: [{ severity: "error", acQuote: "fabricated" }]  (dropped)
        + [{ severity: "warning", issue: "some advisory issue" }]  (below threshold, passes through)
Expect: success: true
        advisoryFindings.length === 2  (demoted error + original advisory)
        advisoryFindings includes the original warning finding
        advisoryFindings includes the demoted finding at severity "warning"
```

---

## Out of Scope

- **`ac_quote_does_not_constrain_locus`** — the US-004 instance in this run recovered on the next adversarial iteration without escalation; lower urgency; deferred
- **Normalization changes** — confirmed not relevant; the fabrication is not a whitespace artifact
- **Prompt changes** — tracked separately; see Quality Analysis note below

---

## Related Quality Observation (not a blocker for this fix)

The 22% drop rate on `error` findings across this run (2 of 9 adversarial reviews triggered drops, both with `wouldSurviveStructural: true`) suggests the adversarial model follows the "downgrade if no AC names the symbol" rule inconsistently when it has high confidence in a finding. The prompt currently says:

> *"If you cannot find an AC that names the specific symbol in your finding, downgrade to `info` or `warning`."*

A stronger prohibition would help:

> *"Do NOT write an `acQuote` that does not appear verbatim in the listed AC text. If you cannot find an exact verbatim match, set severity to `warning` — never approximate, paraphrase, or synthesise a quote."*

Additionally, the `adversarialDropAnalysis.counterfactual.wouldSurviveStructural: true` flag on a drop is a signal that the AC list has a coverage gap for that scenario (the reviewer found a real issue but no AC constrained it). This could be tracked as a metric to feed back into AC quality.

# SPEC: Op-internal review filtering + adversarial same-session requote

**Issues:** #1093 (adversarial requote), #1100 (orchestrator/wrapper filter parity)
**Status:** Draft (post spec-review v1 — 9 fixes applied)
**Stage:** Spec → review → implement
**Depends on:** PR A (#1092 — `callOp` empty-output `exhaustedFallback`); not strictly blocking but logically prior
**Size:** ~3 op files + 1 new filter-primitives module + 2 wrapper edits + 1 schema/config edit + 1 prompt builder method + test updates
**Slice plan:** 3 stories (see Story decomposition hint), 16 ACs total, each story ≤ 8 ACs (Phase 8 strict cap)

## Problem

Two adjacent gaps in the semantic/adversarial review surface:

1. **Orchestrator-direct path skips wrapper filters (#1100).** `story-orchestrator.ts:265-275` dispatches `semanticReviewOp` / `adversarialReviewOp` directly and stashes their parsed output into `phaseOutputs` for rectification. The wrappers (`runSemanticReview`, `runAdversarialReview`) apply evidence substantiation and AC-grounding before findings are acted on; the orchestrator-direct path applies none of that. Rectification can fire on findings the wrappers would have dropped. The divergence is silent.

2. **Adversarial has no same-session requote recovery (#1093).** Semantic's `hopBody` attempts a bounded same-session requote when a blocking finding's `verifiedBy.observed` does not match the referenced file. Adversarial does not — it validates evidence once and immediately downgrades on mismatch. Legitimate findings with formatting mistakes (paraphrased evidence, valid quote nested inside a full-review JSON, numeric line emitted as a string) are lost.

Both issues land naturally in the same op surface: the post-parse layer of `semanticReviewOp` / `adversarialReviewOp`.

## Design

### Layering — SSOT for review post-processing moves into the op

`callOp`'s post-parse pipeline is `parse → hopBody → verify → return O`. Reviews use all three:

```
                                ┌─────────────────────────────────────┐
                                │ semanticReviewOp                    │
parse() — graceful FAIL_OPEN ───┤                                     │
                                │ hopBody — semantic requote (existing)│
                                │                                     │
                                │ verify — sanitizeRefMode             │
                                │        + substantiateSemanticEvidence│
                                │        + filterByAcGroundingMinimal  │
                                │        + blocking/advisory split    │
                                └─────────────────────────────────────┘

                                ┌─────────────────────────────────────┐
                                │ adversarialReviewOp                 │
parse() — strict + exhausted ───┤                                     │
                                │ hopBody — adversarial requote (NEW) │
                                │                                     │
                                │ verify — substantiate (per-finding) │
                                │        + filterByAcQuote             │
                                │        + blocking/advisory split    │
                                │        + populate acDropped         │
                                └─────────────────────────────────────┘
```

Wrappers (`src/review/semantic.ts`, `src/review/adversarial.ts`) become orchestration shells: invoke the op, then handle iteration tracking, prior-iteration carry-forward, audit recording, formatting, and (adversarial only) counterfactual telemetry. **Wrappers do not double-filter** — the op is the SSOT.

#### `op.verify` contract stretch — acknowledged and documented

`op.verify(parsed, input, verifyCtx)` (`src/operations/types.ts:80-89`, ADR-020 §D4) is currently documented as *"validate parsed output against on-disk artifacts. Use when the agent's contract is 'stdout has the answer, but disk has the canonical artifact' (e.g. ACP test-writer)."* Review filtering does consult disk (HEAD source files for evidence substantiation), but extends the hook's documented intent to "post-parse filter pipeline that may consult disk." This PR therefore includes a one-line docstring update on `RunOperation.verify` admitting this use explicitly. The review ops' `verify` implementations never return `null` — they always return an `O` value (filtered findings) and never want the `recover` fall-through; this is intentional and documented per-op.

### New module — `src/review/finding-filters.ts`

Primitives library. Holds the small wrapper functions used by both op `verify()` implementations. Not a one-size-fits-all pipeline.

```typescript
// Re-exports of existing primitives with a shared barrel surface.
export { sanitizeRefModeFindings } from "./semantic-helpers";
export { substantiateSemanticEvidence } from "./semantic-evidence";
export { checkFindingEvidence, downgradeUnsubstantiatedFinding } from "./semantic-evidence";
export { filterByAcGroundingMinimal, filterByAcQuote } from "./ac-quote-validator";

// New: per-finding substantiation helper used by adversarial's verify().
// Extracted verbatim from `src/review/adversarial.ts:393-409`.
export async function substantiateAdversarialFindings(opts: {
  findings: AdversarialLLMFinding[];
  workdir: string;
  storyId: string;
  blockingThreshold: "error" | "warning" | "info";
}): Promise<AdversarialLLMFinding[]> { /* ... */ }
```

This module is the only place where `src/operations/*-review.ts` imports filter logic from `src/review/`. Keeps the dependency direction one-way: `operations/ → review/finding-filters.ts → review/{semantic-evidence, ac-quote-validator, semantic-helpers}`.

### Semantic op changes — `src/operations/semantic-review.ts`

**`parse()` (line 113):** unchanged. Still graceful (returns FAIL_OPEN on invalid shape). The advisory split inside `parse()` (lines 117-126) is **removed** — that work moves to `verify()`.

**`hopBody`:** unchanged. Existing requote loop already handles semantic blocking findings in ref mode.

**`verify()` (new):**

```typescript
async verify(parsed, input, verifyCtx) {
  if (parsed.failOpen || parsed.looksLikeFail) return parsed;
  if (parsed.findings.length === 0) return parsed;

  const threshold = input.blockingThreshold ?? "error";
  const findings = parsed.findings as LLMFinding[];

  // 1. Downgrade ref-mode blocking findings with unverified evidence to
  //    severity "unverifiable". This does NOT drop — downgraded findings
  //    fall below `threshold` and get routed into the advisory split at
  //    step 4. See src/review/semantic-helpers.ts:88-97.
  const sanitized = sanitizeRefModeFindings(findings, input.mode, threshold);

  // 2. Substantiate evidence against HEAD.
  const substantiated = await substantiateSemanticEvidence(
    sanitized,
    input.mode,
    input.workdir,
    input.story.id,
    threshold,
  );

  // 3. Drop error findings without valid acIndex.
  const { accepted } = filterByAcGroundingMinimal(substantiated, input.story.acceptanceCriteria);

  // 4. Split blocking vs advisory; normalizedFindings ⊂ blocking.
  const blocking = accepted.filter((f) => isBlockingSeverity(f.severity, threshold));
  const passed = parsed.passed && blocking.length === 0;
  return {
    ...parsed,
    passed,
    findings: accepted,
    normalizedFindings: toReviewFindings(blocking),
  };
}
```

`SemanticReviewInput` already carries `workdir`, `mode`, `story`, `blockingThreshold` — no new threading. `verifyCtx` is unused here (filters use `workdir` directly via `_deps`-style mocking already in `semantic-evidence.ts`).

### Adversarial op changes — `src/operations/adversarial-review.ts`

**`parse()` (line 106):** unchanged. Strict; `exhaustedFallback` (lines 66-69) still owns the empty/invalid path.

**`AdversarialReviewConfig`** (`src/review/types.ts:167`): add `substantiation?: { requote: boolean; maxRequotes: number }` field mirroring `SemanticReviewConfig.substantiation` at `src/review/types.ts:64-69`. Default `{ requote: true, maxRequotes: 5 }` in `src/config/schemas.ts` (mirror line 227-229).

**`AdversarialReviewInput`:** add `workdir: string` field. (Currently the wrapper passes it; the op now needs it directly.)

**`AdversarialReviewOutput`:** add `acDropped?: AcQuoteFilterResult<AdversarialLLMFinding>["dropped"]` field. Optional; populated by `verify()` so the wrapper can compute counterfactual telemetry. Type sourced from `src/review/ac-quote-validator.ts:149-154` — structurally `{ finding: AdversarialLLMFinding; code: AcQuoteRejectionCode }[]`. No new type alias introduced.

**`hopBody` (new, mirrors semantic):**

Extract a shared parser. `src/review/requote-response.ts` already exports `parseRequoteResponse` used by semantic. Reuse it directly — no new file. The *prompt construction* and *finding shape* differ per op; semantic uses `ReviewPromptBuilder.requoteVerbatim({ finding })` (`src/prompts/builders/review-builder.ts:197`), and adversarial will add a mirror method `AdversarialReviewPromptBuilder.requoteVerbatim({ finding })`. Build prompts in each op's hopBody body:

```typescript
const adversarialReviewHopBody = async (initialPrompt, ctx) => {
  const turn = await ctx.sendWithParseRetry(initialPrompt);
  const parsed = validateAdversarialShape(tryParseLLMJson<Record<string, unknown>>(turn.output));
  if (!parsed) return turn;
  if (ctx.input.mode !== "ref") return turn;  // requote scoped to ref mode

  const requoted = await requoteBlockingAdversarialFindings(parsed.findings, ctx);
  if (!requoted.changed) return turn;

  const passed = !requoted.findings.some((f) =>
    isBlockingSeverity(f.severity, ctx.input.blockingThreshold ?? "error"),
  );
  return {
    ...turn,
    output: JSON.stringify({ passed, findings: requoted.findings }),
    estimatedCostUsd: (turn.estimatedCostUsd ?? 0) + requoted.extraCostUsd,
  };
};
```

`requoteBlockingAdversarialFindings` lives in `src/operations/adversarial-review.ts` (op-local helper). It mirrors `requoteBlockingFindings` from `semantic-review.ts:136` but operates on `AdversarialLLMFinding[]` and uses `AdversarialReviewPromptBuilder.requoteVerbatim({ finding })` for prompt construction. The shared response parser is `parseRequoteResponse` from `src/review/requote-response.ts`.

Requote scope (matches semantic):
- Ref mode only
- Blocking-severity findings only
- Bounded by `AdversarialReviewConfig.substantiation.maxRequotes` (default 5; matches the semantic knob path `SemanticReviewConfig.substantiation.maxRequotes`)
- Disabled entirely when `AdversarialReviewConfig.substantiation.requote === false`
- One bounded recovery attempt per finding
- Canonical quote-object accepted
- Full-review JSON with exactly one finding accepted as fallback
- Multi-finding review JSON rejected as ambiguous

**`verify()` (new):**

```typescript
async verify(parsed, input, verifyCtx) {
  if (parsed.failOpen || parsed.looksLikeFail) return parsed;
  if (parsed.findings.length === 0) return parsed;

  const threshold = input.blockingThreshold ?? "error";
  const findings = parsed.findings as AdversarialLLMFinding[];

  // 1. Substantiate evidence (blocking findings only — matches today).
  const substantiated = await substantiateAdversarialFindings({
    findings,
    workdir: input.workdir,
    storyId: input.story.id,
    blockingThreshold: threshold,
  });

  // 2. AC-quote validation (stricter than semantic's acIndex-only check).
  const { accepted, dropped } = filterByAcQuote(substantiated, input.story.acceptanceCriteria);

  // 3. Split blocking/advisory.
  const blocking = accepted.filter((f) => isBlockingSeverity(f.severity, threshold));
  const passed = parsed.passed && blocking.length === 0;

  return {
    ...parsed,
    passed,
    findings: accepted,
    normalizedFindings: toAdversarialReviewFindings(blocking),
    acDropped: dropped,  // AcQuoteFilterResult<AdversarialLLMFinding>["dropped"] — wrapper consumes for counterfactual telemetry
  };
}
```

### Wrapper changes

**`src/review/semantic.ts` — surgical edits:**
- **Delete** lines 419-431 (the `substantiateSemanticEvidence` call wrapping `sanitizeRefModeFindings`, plus the `filterByAcGroundingMinimal` call and its drop-warn log).
- **Delete** lines 442-444 (the local blocking/advisory split — the op now returns these pre-split).
- **Replace** with: source `findings` (= union of blocking + advisory accepted), `normalizedFindings`, `passed`, `failOpen`, `looksLikeFail` from the op output. Recompute the local `blockingFindings` / `advisoryFindings` lists by filtering `findings` if downstream code (logs at lines 446-455, 458-473) still needs them.
- **Keep**: audit recording, iteration tracking, prior-iteration carry-forward, formatting helpers (`formatFindings`, `recordSemanticAudit`).

**`src/review/adversarial.ts` — surgical edits:**
- **Delete** lines 393-409 (the per-finding substantiation `Promise.all` block — the op now substantiates internally).
- **Delete** lines 431-441 (the `filterByAcQuote` call and its drop-warn log).
- **Keep lines 411-429** verbatim. `diffFiles` construction via `extractDiffFiles` or `collectDiffFileList` is still required by `analyzeStructuralCounterfactual` at lines 455-458 and lines 478-481.
- **Replace** the deleted blocks with: read `acDropped` from the op output and pass it to `analyzeStructuralCounterfactual`'s drop-loop (lines 444-460). The accept-loop (lines 468-483) sources its findings from the op's now-filtered `findings`.
- **Keep**: `collectDiffFileList`, `extractDiffFiles`, counterfactual analysis, audit recording, iteration tracking.

> Counterfactual telemetry stays in the wrapper — it's reporting, not filtering. The op's `acDropped` field is the bridge that lets the wrapper see the drops it used to compute itself.

### Story orchestrator — `src/execution/story-orchestrator.ts:265-275`

No code change required. The orchestrator already consumes `op.normalizedFindings` for `extractPhaseFindings` routing. Once the op filters internally, those normalized findings are automatically pre-filtered. **This is the SSOT win** — one code path defines "blocking finding," both sites observe it.

## Acceptance Criteria

> Tag legend: `[verbatim]` = wording fixed for `nax plan` fidelity; `[grep]` = executable grep assertion; `[unit]`/`[integration]` = pinned to a named test file.

1. **AC1 [verbatim] [grep]** One code path defines "a blocking semantic finding" and "a blocking adversarial finding": each op's `verify()`. Pinned by:
   - `grep -nE "verify\s*\(" src/operations/semantic-review.ts` ≥ 1 match
   - `grep -nE "verify\s*\(" src/operations/adversarial-review.ts` ≥ 1 match

2. **AC2 [verbatim] [integration]** Both the wrapper and orchestrator-direct call sites produce identical findings for identical LLM outputs. Pinned by `test/unit/review/orchestrator-wrapper-parity.test.ts` — one paired test per op asserts `normalizedFindings` deep-equal between op-direct and wrapper invocation.

3. **AC3 [verbatim] [integration]** Existing wrapper tests pass: `timeout 60 bun test test/unit/review/semantic.test.ts test/unit/review/adversarial.test.ts --timeout=5000` exits 0.

4. **AC4 [verbatim] [unit]** Blocking adversarial findings with mismatched `verifiedBy.observed` get one bounded same-session requote attempt in ref mode. Pinned by `test/unit/operations/adversarial-review-requote.test.ts` → test "blocking finding triggers one requote turn in ref mode".

5. **AC5 [verbatim] [unit]** Canonical requote object is accepted. Pinned by same test file → "accepts canonical requote object".

6. **AC6 [verbatim] [unit]** Full-review JSON with exactly one finding can be salvaged for quote extraction. Pinned by same test file → "salvages single-finding full-review JSON".

7. **AC7 [verbatim] [unit]** Multi-finding review JSON is rejected as ambiguous. Pinned by same test file → "rejects multi-finding review JSON as ambiguous".

8. **AC8 [verbatim] [unit]** Adversarial requote is bounded by `AdversarialReviewConfig.substantiation.maxRequotes` (default 5; matches the semantic knob). Pinned by adversarial-review-requote.test.ts → "respects maxRequotes budget".

9. **AC9 [verbatim] [unit]** Adversarial requote runs in ref mode only — embedded mode skips the requote loop. Pinned by adversarial-review-requote.test.ts → "embedded mode skips requote".

10. **AC10 [verbatim] [unit]** Post-`verify()` evidence substantiation is preserved — requote repairs the payload, but unsubstantiated findings after requote are still downgraded. Pinned by `test/unit/operations/adversarial-review-verify.test.ts` → "requoted finding that still fails substantiation is downgraded".

11. **AC11 [verbatim] [grep] [unit]** `AdversarialReviewOutput.acDropped` is populated when `filterByAcQuote` drops findings, and `runAdversarialReview` consumes it for `analyzeStructuralCounterfactual`. Pinned by:
    - `grep -n "acDropped" src/operations/adversarial-review.ts src/review/adversarial.ts` ≥ 3 matches (declaration + assignment + consumer)
    - `test/unit/review/adversarial.test.ts` → "counterfactual telemetry consumes acDropped from op output" — asserts telemetry output byte-identical to today's snapshot.

12. **AC12 [verbatim] [integration]** Orchestrator-direct path behavior change is bounded: for both ops, the set of findings reaching `extractPhaseFindings` is exactly `wrapper_filtered_set`, where `wrapper_filtered_set` is what the v0.67.9 wrapper would have produced for the same LLM output. Pinned by parity test (AC2) — identical sets, no new drop reasons.

13. **AC13 [verbatim] [unit]** `FAIL_OPEN` / `looksLikeFail` short-circuit `verify()` — no filter work runs when the op already short-circuited at parse time. Pinned by `test/unit/operations/{semantic,adversarial}-review-verify.test.ts` → "FAIL_OPEN short-circuits verify" + "looksLikeFail short-circuits verify".

14. **AC14 [verbatim] [grep]** Wrappers do not double-filter, and ops import filter primitives only from the new barrel. Pinned by four greps in one verifier run:
    - `! grep -nE "substantiateSemanticEvidence|filterByAcGroundingMinimal|sanitizeRefModeFindings" src/review/semantic.ts` — zero matches.
    - `! grep -nE "filterByAcQuote|checkFindingEvidence|downgradeUnsubstantiatedFinding" src/review/adversarial.ts` — zero matches.
    - `grep -n "from \"../review/finding-filters\"" src/operations/semantic-review.ts src/operations/adversarial-review.ts` ≥ 2 matches.
    - `! grep -nE "from \"\.\./review/(semantic-evidence|ac-quote-validator|semantic-helpers)\"" src/operations/semantic-review.ts src/operations/adversarial-review.ts` — zero matches.

15. **AC15 [verbatim] [grep]** Adversarial requote method is added:
    - `grep -n "static requoteVerbatim" src/prompts/builders/adversarial-review-builder.ts` ≥ 1 match.

16. **AC16 [verbatim] [grep]** Adversarial config gains substantiation block:
    - `grep -n "substantiation" src/review/types.ts` ≥ 2 matches (one for semantic at line 64, one new for adversarial).
    - `grep -nE "substantiation:\s*\{" src/config/schemas.ts` ≥ 2 matches (one existing semantic default, one new adversarial default).

## Verification

### New unit tests

| File | Tests |
|:---|:---|
| `test/unit/operations/semantic-review-verify.test.ts` (new) | `verify()` runs full filter pipeline; FAIL_OPEN short-circuits; empty findings short-circuits; substantiation drops findings; AC-grounding drops findings; blocking/advisory split correct |
| `test/unit/operations/adversarial-review-verify.test.ts` (new) | All of the above for adversarial, plus: `acDropped` populated correctly; substantiation downgrades only blocking findings |
| `test/unit/operations/adversarial-review-requote.test.ts` (new) | Canonical requote object accepted; single-finding full-review JSON salvaged; multi-finding JSON rejected; ref-mode-only scope; budget bounded by `requote.maxRequotes`; embedded mode skips requote |
| `test/unit/review/orchestrator-wrapper-parity.test.ts` (new) | AC2 verification — identical LLM output → identical `normalizedFindings` from op-direct and wrapper. One test per op. |

### Existing tests — expected updates

| File | Change |
|:---|:---|
| `test/unit/operations/semantic-review.test.ts` | Update parse-tests to assert advisory split now happens in `verify`, not `parse` |
| `test/unit/operations/adversarial-review.test.ts` | Same as above; add `workdir` to input fixtures |
| `test/unit/review/semantic.test.ts` | Update wrapper tests — wrapper no longer applies filters directly |
| `test/unit/review/adversarial.test.ts` | Same; counterfactual telemetry tests still pass (input now flows via `acDropped`) |

### Test commands

```bash
timeout 30 bun test test/unit/operations/semantic-review-verify.test.ts --timeout=5000
timeout 30 bun test test/unit/operations/adversarial-review-verify.test.ts --timeout=5000
timeout 30 bun test test/unit/operations/adversarial-review-requote.test.ts --timeout=5000
timeout 30 bun test test/unit/review/orchestrator-wrapper-parity.test.ts --timeout=5000
timeout 60 bun run test:bail
```

## Risk / behavior change

| Risk | Mitigation |
|:---|:---|
| Orchestrator-direct path becomes stricter (drops more findings than today) | Documented in AC12; regression tests pin the new stricter set per op |
| Wrapper output changes due to filter relocation | Wrapper tests updated; AC14 asserts no double-filtering |
| Adversarial requote loop introduces new flake surface | Bounded by `maxRequotes` config; ref-mode-only; falls through cleanly when requote produces no change (matches semantic pattern) |
| `op.verify` is currently lightly used — heavier use here may surface bugs in `runPostParse` error handling | Existing test for `_runPostParseForTest` in `call.ts` covers the surface; AC10 + AC13 explicitly probe short-circuit paths |
| Counterfactual telemetry depends on `acDropped` shape stability | `acDropped` typed as `AcQuoteFilterResult<AdversarialLLMFinding>["dropped"]` (existing type from `src/review/ac-quote-validator.ts:149-154`); shape change requires both op and wrapper edit — caught at compile time |
| Dependency direction: `operations/ → review/finding-filters.ts` | Enforced by review during code review. Import cycle risk: `review/finding-filters.ts` only re-exports leaf modules — no back-edge to `operations/`. |

## Story decomposition hint (for `nax plan`)

16 ACs exceeds the per-story cap of 10 (`config.precheck.storySizeGate.maxAcCount`) and the Phase 8 strict cap of 8. Slice into three stories preserving AC verbatim wording:

| Story | ACs | Count | Theme |
|:---|:---|:---:|:---|
| **US-001 — Semantic op-internal filtering** | AC1 (semantic half), AC2 (semantic half), AC3 (semantic half), AC12 (semantic half), AC13 (semantic half), AC14 (semantic half — wrapper imports + barrel discipline for semantic) | 6 | Move `sanitizeRefModeFindings` + `substantiateSemanticEvidence` + `filterByAcGroundingMinimal` into `semanticReviewOp.verify`; shrink `runSemanticReview` |
| **US-002 — Adversarial op-internal filtering + acDropped wiring + config** | AC1 (adversarial half), AC2 (adversarial half), AC3 (adversarial half), AC11, AC12 (adversarial half), AC13 (adversarial half), AC14 (adversarial half — wrapper imports + barrel discipline for adversarial), AC16 | 8 | Move `substantiateAdversarialFindings` + `filterByAcQuote` into `adversarialReviewOp.verify`; add `workdir` to input; add `acDropped` to output; wire wrapper to consume `acDropped`; add `substantiation` config block |
| **US-003 — Adversarial same-session requote** | AC4, AC5, AC6, AC7, AC8, AC9, AC10, AC15 | 8 | Add `hopBody` requote loop + `requoteBlockingAdversarialFindings` helper + `AdversarialReviewPromptBuilder.requoteVerbatim` |

Dependency DAG: US-002 depends on US-001 (proves the verify-hook pattern in lower-risk graceful-parse op first); US-003 depends on US-002 (requote loop assumes adversarial op already has workdir + verify).

Every story is at or under the Phase 8 strict 8-AC cap.

**Note on mixed additive + destructive ACs:** US-001 and US-002 each carry their half of AC14 (a `! grep` zero-match assertion against deleted wrapper imports) alongside additive work. This is intentional, not a splittable concern. The deletion in AC14 is the **load-bearing verification gate** for AC2 / AC12 — without the zero-match assertion landing in the same story, the additive code could land while the wrapper retains its filter calls, producing silent double-filtering. Splitting into a terminal-cleanup story would create a regression window. The mix is therefore documented and accepted per the spec-writing terminal-cleanup-story-rule's "deletion-as-success-criterion" carve-out.

## Out of scope

- Counterfactual analysis moving into the op (Decision C2 rejected — wrapper-only telemetry stays put).
- New filter primitives.
- Changing `filterByAcGroundingMinimal` / `filterByAcQuote` thresholds or semantics.
- Changes to `extractPhaseFindings` or rectification strategy routing in `src/findings/cycle.ts`.
- Removing the orchestrator-direct path or routing through wrappers (Option 3 rejected).
- Adversarial-specific `sanitizeRefModeFindings` (intentionally asymmetric per Finding B).

## File touch list

| File | Change |
|:---|:---|
| `src/operations/semantic-review.ts` | Add `verify()`; trim advisory-split from `parse()` |
| `src/operations/adversarial-review.ts` | Add `verify()`; add `hopBody` requote loop + local `requoteBlockingAdversarialFindings`; add `workdir` to input; add `acDropped` to output |
| `src/review/types.ts` | Add `substantiation?: { requote: boolean; maxRequotes: number }` to `AdversarialReviewConfig` |
| `src/config/schemas.ts` | Add default `substantiation: { requote: true, maxRequotes: 5 }` for adversarial (mirror line 227-229) |
| `src/review/finding-filters.ts` | NEW — barrel + `substantiateAdversarialFindings` helper |
| `src/operations/types.ts` | One-line docstring update on `RunOperation.verify` (lines 80-89) admitting "post-parse filter pipeline that may consult disk" as a sanctioned use |
| `src/review/semantic.ts` | Delete lines 419-444 (filter block); read filtered output from op |
| `src/review/adversarial.ts` | Delete lines 393-441 (filter block); read `acDropped` from op for counterfactual telemetry |
| `src/prompts/builders/adversarial-review-builder.ts` | Add static method `AdversarialReviewPromptBuilder.requoteVerbatim({ finding })` (mirrors `ReviewPromptBuilder.requoteVerbatim` at `src/prompts/builders/review-builder.ts:197`) |
| `test/unit/operations/semantic-review-verify.test.ts` | NEW |
| `test/unit/operations/adversarial-review-verify.test.ts` | NEW |
| `test/unit/operations/adversarial-review-requote.test.ts` | NEW |
| `test/unit/review/orchestrator-wrapper-parity.test.ts` | NEW |
| `test/unit/operations/semantic-review.test.ts` | Update for parse/verify split |
| `test/unit/operations/adversarial-review.test.ts` | Update; add `workdir` fixtures |
| `test/unit/review/semantic.test.ts` | Update wrapper tests |
| `test/unit/review/adversarial.test.ts` | Update wrapper tests; verify counterfactual telemetry still passes |

No changes to: `src/execution/story-orchestrator.ts`, `src/findings/cycle.ts`, any pipeline stage, `src/operations/call.ts`, `src/review/requote-response.ts`.

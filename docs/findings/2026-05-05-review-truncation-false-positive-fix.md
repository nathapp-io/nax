# Patch Plan — Bug 4 + Rectifier Filter Enhancement

> Single PR delivering: (a) the Bug 4 fix that stops false-positive truncation retries from silently downgrading review errors, and (b) the companion enhancement that ensures only blocking-threshold findings reach the rectifier prompt.

**Linked**: [2026-05-05-context-curator-v0-dogfood-findings.md](./2026-05-05-context-curator-v0-dogfood-findings.md) → Bug 4

---

## Why one PR

Bug 4's primary fix restores severity accuracy in review output. Without the rectifier filter enhancement, that restoration causes the rectifier prompt to grow ~3× (warnings/info no longer silently demoted). The enhancement is the load-bearing other half: it keeps the fix surface lean. Shipping them together avoids a regression window between "severity accurate" and "rectifier prompt manageable".

---

## Scope

### In

- `src/operations/semantic-review.ts` — drop length-veto, parse-first
- `src/operations/adversarial-review.ts` — same change, identical pattern
- `src/operations/_review-retry.ts` *(new)* — shared `makeReviewRetryHopBody` helper
- `src/prompts/builders/review-builder.ts` — restore `verifiedBy` in `jsonRetryCondensed` schema
- `src/prompts/builders/rectifier-builder.ts` — defensive blocking-only filter, accept `blockingThreshold`
- `src/operations/rectify.ts`, `src/operations/autofix-implementer.ts`, `src/operations/autofix-test-writer.ts`, `src/pipeline/stages/autofix-test-writer.ts` — thread `blockingThreshold` into `RectifierPromptBuilder.reviewRectification`
- `src/review/severity.ts` — promote `isBlockingSeverity` to SSOT here
- `src/review/semantic-helpers.ts`, `src/review/adversarial-helpers.ts` — re-export from `severity.ts`, drop local copies
- Tests: see [Test plan](#test-plan)

### Out (separate PRs)

- `MAX_AGENT_OUTPUT_CHARS` cleanup (remove or re-enforce in adapter) — separate PR after we observe the new behavior
- E3 brand types `BlockingFinding` / `AdvisoryFinding` — separate PR; structural change with ripple effects
- E4 cross-iteration severity-change log line — separate small PR
- Bugs 1, 2, 3, 5, 6, 7 from dogfood-findings.md — separate PRs

---

## Change set

### 1. New shared retry helper

**File**: `src/operations/_review-retry.ts` *(new)*

```ts
import type { TurnResult } from "../agents/types";
import { getSafeLogger } from "../logger";
import { ReviewPromptBuilder } from "../prompts";
import { looksLikeTruncatedJson } from "../review/truncation";
import { tryParseLLMJson } from "../utils/llm-json";
import type { HopBody, HopContext } from "./types";

interface RetryInput {
  story: { id: string };
  blockingThreshold?: "error" | "warning" | "info";
}

/**
 * Same-session JSON-parse retry, parser-first.
 *
 * Trust the parser as the oracle: if `tryParseLLMJson` + `validate` both succeed,
 * return the original response regardless of length. Length is a hint used only
 * to choose between retry-prompt variants when parsing actually failed.
 *
 * Replaces the previous "length-veto" logic that retried valid responses purely
 * because their length was near MAX_AGENT_OUTPUT_CHARS, which then triggered a
 * condensed-retry schema that stripped `verifiedBy` and silently downgraded
 * `error` findings to `unverifiable`.
 */
export function makeReviewRetryHopBody<I extends RetryInput>(
  validate: (parsed: unknown) => boolean,
  reviewerKind: "semantic" | "adversarial",
): HopBody<I> {
  return async (initialPrompt, ctx: HopContext<I>) => {
    const first = await ctx.send(initialPrompt);
    const parsed = tryParseLLMJson<Record<string, unknown>>(first.output);

    // Parser is the oracle. If it accepts and the shape validates, return.
    if (parsed && validate(parsed)) return first;

    // Genuine retry needed. Use length only to pick the prompt variant.
    const isTruncated = !parsed && looksLikeTruncatedJson(first.output);
    const retryPrompt = isTruncated
      ? ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: ctx.input.blockingThreshold })
      : ReviewPromptBuilder.jsonRetry();

    if (isTruncated) {
      getSafeLogger()?.warn(reviewerKind, "JSON parse retry — likely truncated", {
        storyId: ctx.input.story.id,
        originalByteSize: first.output.length,
        blockingThreshold: ctx.input.blockingThreshold ?? "error",
      });
    } else {
      getSafeLogger()?.warn(reviewerKind, "JSON parse retry — invalid shape", {
        storyId: ctx.input.story.id,
        originalByteSize: first.output.length,
      });
    }

    const retry: TurnResult = await ctx.send(retryPrompt);
    return {
      ...retry,
      estimatedCostUsd: (first.estimatedCostUsd ?? 0) + (retry.estimatedCostUsd ?? 0),
    };
  };
}
```

### 2. `src/operations/semantic-review.ts`

Replace the inline `semanticReviewHopBody` with the shared helper:

```diff
-import { tryParseLLMJson } from "../utils/llm-json";
-import { looksLikeTruncatedJson } from "../review/truncation";
-import type { TurnResult } from "../agents/types";
-import { getSafeLogger } from "../logger";
-import { ReviewPromptBuilder } from "../prompts";
+import { makeReviewRetryHopBody } from "./_review-retry";

-const semanticReviewHopBody: HopBody<SemanticReviewInput> = async (initialPrompt, ctx) => {
-  const first = await ctx.send(initialPrompt);
-  const isTruncated = looksLikeTruncatedJson(first.output);
-  const parsed = tryParseLLMJson<Record<string, unknown>>(first.output);
-  if (!isTruncated && parsed && validateLLMShape(parsed)) return first;
-
-  const retryPrompt = isTruncated
-    ? ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: ctx.input.blockingThreshold })
-    : ReviewPromptBuilder.jsonRetry();
-  if (isTruncated) {
-    getSafeLogger()?.warn("semantic", "JSON parse retry — original response truncated", {
-      storyId: ctx.input.story.id,
-      originalByteSize: first.output.length,
-      blockingThreshold: ctx.input.blockingThreshold ?? "error",
-    });
-  }
-  const retry: TurnResult = await ctx.send(retryPrompt);
-  return {
-    ...retry,
-    estimatedCostUsd: (first.estimatedCostUsd ?? 0) + (retry.estimatedCostUsd ?? 0),
-  };
-};
+const semanticReviewHopBody = makeReviewRetryHopBody<SemanticReviewInput>(
+  (parsed) => validateLLMShape(parsed) !== null,
+  "semantic",
+);
```

The op-spec definition (`semanticReviewOp`) stays the same; only the hopBody value changes. `parse()` is unchanged.

### 3. `src/operations/adversarial-review.ts`

Same pattern:

```diff
-import { looksLikeTruncatedJson } from "../review/truncation";
-import { tryParseLLMJson } from "../utils/llm-json";
-import type { TurnResult } from "../agents/types";
-import { getSafeLogger } from "../logger";
-import { ReviewPromptBuilder } from "../prompts";
+import { makeReviewRetryHopBody } from "./_review-retry";

-const adversarialReviewHopBody: HopBody<AdversarialReviewInput> = async (initialPrompt, ctx) => {
-  const first = await ctx.send(initialPrompt);
-  const isTruncated = looksLikeTruncatedJson(first.output);
-  const parsed = tryParseLLMJson<Record<string, unknown>>(first.output);
-  if (!isTruncated && parsed && validateAdversarialShape(parsed)) return first;
-  // … (identical rest)
-};
+const adversarialReviewHopBody = makeReviewRetryHopBody<AdversarialReviewInput>(
+  (parsed) => validateAdversarialShape(parsed) !== null,
+  "adversarial",
+);
```

### 4. `src/prompts/builders/review-builder.ts`

Restore `verifiedBy` in the condensed-retry schema:

```diff
   static jsonRetryCondensed(opts?: {
     blockingThreshold?: "error" | "warning" | "info";
     advisoryCap?: number;
   }): string {
     // … threshold + clauses unchanged …
-    return `Your previous response was truncated and could not be parsed as valid JSON.\nRespond with a condensed summary:\n- ${blockingClause}\n- ${advisoryClause}\nOutput ONLY a complete, valid JSON object. It must start with { and end with }.\nSchema: {"passed": boolean, "findings": [{"severity": string, "category": string, "file": string, "line": number, "issue": string, "suggestion": string}]}`;
+    return `Your previous response was truncated and could not be parsed as valid JSON.
+Respond with a condensed summary:
+- ${blockingClause}
+- ${advisoryClause}
+- Keep \`verifiedBy\` for every finding. If \`verifiedBy.observed\` is long, abbreviate it to one line — never drop the field.
+Output ONLY a complete, valid JSON object. It must start with { and end with }.
+Schema: {"passed": boolean, "findings": [{"severity": string, "category": string, "file": string, "line": number, "issue": string, "suggestion": string, "verifiedBy": {"command": string, "file": string, "line": number, "observed": string}}]}`;
   }
```

### 5. `src/review/severity.ts` — promote SSOT

```diff
 export const SEVERITY_RANK: Record<string, number> = {
   info: 0,
   unverifiable: 0,
   low: 1,
   warning: 1,
   error: 2,
   critical: 3,
 };
+
+export function isBlockingSeverity(
+  sev: string,
+  threshold: "error" | "warning" | "info" = "error",
+): boolean {
+  return (SEVERITY_RANK[sev] ?? 0) >= (SEVERITY_RANK[threshold] ?? 2);
+}
```

### 6. `src/review/semantic-helpers.ts` and `src/review/adversarial-helpers.ts` — re-export

```diff
-import { SEVERITY_RANK } from "./severity";
+import { SEVERITY_RANK, isBlockingSeverity } from "./severity";
+export { isBlockingSeverity };

-export function isBlockingSeverity(sev: string, threshold: "error" | "warning" | "info" = "error"): boolean {
-  return (SEVERITY_RANK[sev] ?? 0) >= (SEVERITY_RANK[threshold] ?? 2);
-}
```

(Keep `SEVERITY_RANK` re-exports if any consumer imports it from these helpers.)

### 7. `src/prompts/builders/rectifier-builder.ts` — defensive filter + threshold parameter

```diff
+import { isBlockingSeverity } from "../../review/severity";
+
+interface RectifierRenderOpts {
+  blockingThreshold?: "error" | "warning" | "info";
+}
+
-function renderCheckBlock(check: ReviewCheckResult): string {
+function renderCheckBlock(check: ReviewCheckResult, opts: RectifierRenderOpts): string {
   const parts: string[] = [];
   parts.push(`### ${check.check} (exit ${check.exitCode})\n`);
   const truncated = check.output.length > 4000;
   const output = truncated
     ? `${check.output.slice(0, 4000)}\n... (truncated — ${check.output.length} chars total)`
     : check.output;
   parts.push(`\`\`\`\n${output}\n\`\`\`\n`);

-  if (check.findings?.length) {
+  // Defensive filter — only blocking-severity findings drive the fix prompt,
+  // even if the caller populated `findings` with mixed severities.
+  const threshold = opts.blockingThreshold ?? "error";
+  const blocking = (check.findings ?? []).filter((f) =>
+    isBlockingSeverity(f.severity, threshold),
+  );
+  if (blocking.length > 0) {
     parts.push("Structured findings:\n");
-    for (const f of check.findings) {
+    for (const f of blocking) {
       parts.push(`- [${f.severity}] ${f.file}:${f.line} — ${f.message}\n`);
     }
   }

   return parts.join("\n");
 }
```

Apply the same filter in the second use-site (`rectifier-builder.ts:368`) and at the AC-rectification path (`rectifier-builder.ts:296`).

Update `RectifierPromptBuilder.reviewRectification` and `RectifierPromptBuilder.testWriterRectification` signatures:

```diff
-static reviewRectification(failedChecks: Readonly<ReviewCheckResult[]>, story: UserStory): string {
+static reviewRectification(
+  failedChecks: Readonly<ReviewCheckResult[]>,
+  story: UserStory,
+  opts: { blockingThreshold?: "error" | "warning" | "info" } = {},
+): string {
```

Threading `opts` through `renderPrioritizedFailures` and `renderCheckBlock`.

### 8. Op consumers — pass `blockingThreshold`

`src/operations/rectify.ts`:
```diff
-const prompt = RectifierPromptBuilder.reviewRectification(input.failedChecks, input.story);
+const prompt = RectifierPromptBuilder.reviewRectification(input.failedChecks, input.story, {
+  blockingThreshold: input.blockingThreshold,
+});
```

Same change in `src/operations/autofix-implementer.ts`, `src/operations/autofix-test-writer.ts`, `src/pipeline/stages/autofix-test-writer.ts`.

Add `blockingThreshold?: "error" | "warning" | "info"` to each op's input interface. Source it from `ReviewConfig.blockingThreshold` at the call site.

---

## Test plan

### Regression tests for Bug 4 (the actual fix)

**`test/unit/review/semantic-retry-truncation.test.ts`** — extend with:

```ts
test("parseable response near the cap is NOT retried (Bug 4 regression)", async () => {
  // Simulate a 5300-char response that parses cleanly with valid shape.
  const validNearCap = JSON.stringify({
    passed: false,
    findings: Array.from({ length: 7 }, (_, i) => ({
      severity: "error",
      file: `src/file${i}.ts`,
      line: 10 + i,
      issue: "x".repeat(500),
      suggestion: "y".repeat(150),
      verifiedBy: { command: "read", file: `src/file${i}.ts`, line: 10 + i, observed: "..." },
    })),
  });
  expect(validNearCap.length).toBeGreaterThanOrEqual(4900);

  const sendMock = mock(async () => ({ output: validNearCap, estimatedCostUsd: 0.01 }));
  // … wire through callOp / agentManager
  const result = await runSemanticReview(/* … */);

  expect(sendMock).toHaveBeenCalledTimes(1);                 // no retry
  expect(result.passed).toBe(false);
  expect(result.findings).toHaveLength(7);
  expect((result.findings as any[])[0].severity).toBe("error");  // not downgraded
});

test("unparseable response near the cap triggers condensed retry", async () => {
  const garbage = "x".repeat(4950);
  const validRetry = JSON.stringify({ passed: true, findings: [] });
  // … assert retry prompt = jsonRetryCondensed and final result is the retry's
});

test("parseable response with invalid shape triggers standard retry", async () => {
  const wrongShape = JSON.stringify({ passed: true });  // missing findings
  // … assert retry prompt = jsonRetry (NOT condensed)
});
```

### `verifiedBy` preserved in condensed retry

**`test/unit/prompts/builders/review-builder.test.ts`** — new test:
```ts
test("jsonRetryCondensed schema includes verifiedBy", () => {
  const prompt = ReviewPromptBuilder.jsonRetryCondensed();
  expect(prompt).toContain('"verifiedBy"');
  expect(prompt).toContain('"observed"');
});
```

### Adversarial parity

**`test/unit/review/adversarial-retry-truncation.test.ts`** *(new)* — same suite as semantic, but with `validateAdversarialShape`. Confirm `makeReviewRetryHopBody` is shape-agnostic.

### Rectifier defensive filter

**`test/unit/prompts/builders/rectifier-builder.test.ts`** — new tests:
```ts
test("reviewRectification drops advisory findings even if caller leaks them", () => {
  const checks: ReviewCheckResult[] = [{
    check: "semantic",
    success: false,
    command: "",
    exitCode: 1,
    output: "Semantic review failed",
    durationMs: 100,
    findings: [
      { severity: "error",   file: "a.ts", line: 1, message: "real issue", ruleId: "X1" },
      { severity: "warning", file: "b.ts", line: 2, message: "advisory",   ruleId: "X2" },
      { severity: "info",    file: "c.ts", line: 3, message: "fyi",        ruleId: "X3" },
    ],
  }];
  const prompt = RectifierPromptBuilder.reviewRectification(checks, makeStory(), { blockingThreshold: "error" });
  expect(prompt).toContain("a.ts:1 — real issue");
  expect(prompt).not.toContain("b.ts:2");
  expect(prompt).not.toContain("c.ts:3");
});

test("blockingThreshold='warning' includes warnings in fix prompt", () => {
  // Same checks; threshold=warning → both error AND warning should appear, info still excluded
  const prompt = RectifierPromptBuilder.reviewRectification(checks, makeStory(), { blockingThreshold: "warning" });
  expect(prompt).toContain("a.ts:1");
  expect(prompt).toContain("b.ts:2");
  expect(prompt).not.toContain("c.ts:3");
});

test("absent blockingThreshold defaults to error", () => {
  // Same as first test but no opts passed
});
```

### Severity helper SSOT

**`test/unit/review/severity.test.ts`** *(new)*:
```ts
test("isBlockingSeverity respects threshold", () => {
  expect(isBlockingSeverity("error")).toBe(true);
  expect(isBlockingSeverity("warning")).toBe(false);
  expect(isBlockingSeverity("warning", "warning")).toBe(true);
  expect(isBlockingSeverity("unverifiable")).toBe(false);
  expect(isBlockingSeverity("critical")).toBe(true);
  expect(isBlockingSeverity("unknown")).toBe(false);  // unknown → 0 → not blocking
});
```

### End-to-end integration

**`test/integration/review/semantic-bug4-integration.test.ts`** *(new)*:
- Mock an agent that returns a near-cap, parseable, 3-error response with `verifiedBy`.
- Run the full `runSemanticReview` flow.
- Assert: 1 LLM call (no retry), 3 errors propagated to `ReviewCheckResult.findings` with severity `error`, `Semantic review failed: 3 blocking findings` in audit JSON.

### Tests to update

- `test/unit/review/semantic-retry-truncation.test.ts:38-40` — comment explaining `AT_CAP_UNPARSEABLE` should be updated; the fixture is still valid (unparseable → still triggers retry).
- Any test asserting "near-cap parseable response triggers retry" — that's the bug, delete those assertions.

---

## Migration / rollout

### Backwards compatibility

- **Op-spec public API**: signatures unchanged for `semanticReviewOp` / `adversarialReviewOp`. Internal hopBody is replaced.
- **`RectifierPromptBuilder.reviewRectification`**: new optional `opts` parameter. Existing callers without `opts` get `blockingThreshold: "error"` (the existing default), which matches today's behavior.
- **`MAX_AGENT_OUTPUT_CHARS`**: still exported as a no-op constant for now. Removal in a follow-up PR.
- **No config schema changes.**
- **No breaking changes to plugins** (rectifier prompt builder is an internal API).

### Telemetry / observability

Add a counter-style metric to validate the fix:

In `src/operations/_review-retry.ts`, the warn logs already differentiate `"likely truncated"` (parse failed + near-cap) vs `"invalid shape"` (parse succeeded but shape wrong). After the fix, the count of `JSON parse retry — likely truncated` should drop dramatically — pre-fix every parseable near-cap response was logged. Track this in run-level metrics if not already.

Consider adding a `semantic.review.retry_count` field per story to the run JSONL. After one merge cycle, query it: if retry_count > 0 with `kind: "likely truncated"` AND the original response would've been parseable, that's still a false positive — investigate.

### Risk assessment

| Change | Risk | Mitigation |
|---|---|---|
| Trust parser, drop length veto | A truncated-but-parseable response could pass through with partial findings | Shape validation (`validateLLMShape`) catches missing required fields. The remaining edge is when JSON happens to be parseable mid-stream — vanishingly rare; would manifest as fewer findings, not silently-passing reviews |
| Keep `verifiedBy` in condensed retry | Retry response could exceed length and re-fail | Today's retry rarely re-fails; condensation comes from "ALL errors + top-3 advisory" which already limits count, plus the new "abbreviate observed to one line" instruction |
| Extract shared helper | A bug in the helper hits both reviewers | Covered by per-reviewer tests + integration test |
| Defensive filter in rectifier | A caller relying on advisory findings reaching the fixer would see them dropped | No such caller exists today (verified by grep — `check.advisoryFindings` is never read by `rectifier-builder.ts`); contract change is documented |
| Threading `blockingThreshold` | Callers might pass wrong threshold | Default to `"error"` matches existing behavior; type system enforces the union |

---

## Acceptance checklist

- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun run test` clean (full suite)
- [ ] New regression test for Bug 4: parseable near-cap response is not retried
- [ ] New test: `verifiedBy` present in `jsonRetryCondensed` output
- [ ] New test: rectifier filters advisory findings even when caller leaks them
- [ ] New test: `blockingThreshold="warning"` includes warnings in fix prompt
- [ ] New SSOT test for `isBlockingSeverity`
- [ ] Integration test: 3-error near-cap response propagates as 3 blocking errors
- [ ] Removed: tests asserting "near-cap parseable response triggers retry" (those encoded the bug)
- [ ] Manual verification on a re-run of `context-curator-v0`: `JSON parse retry — likely truncated` count is 0 if all responses are parseable, and US-004 review surfaces blocking errors

---

## Commit plan

Suggested split into atomic commits within the PR:

1. `refactor(review): promote isBlockingSeverity to severity.ts SSOT`
2. `feat(operations): add _review-retry shared helper`
3. `fix(operations/semantic-review): trust parser, length is a hint not a veto`
4. `fix(operations/adversarial-review): trust parser, share retry helper`
5. `fix(prompts/review): preserve verifiedBy in condensed retry schema`
6. `feat(prompts/rectifier): blocking-only filter + blockingThreshold parameter`
7. `feat(operations): thread blockingThreshold into rectifier prompt builders`
8. `test(review): regression tests for parseable near-cap and verifiedBy preservation`

PR title: `fix(review): trust parser for truncation detection + enforce blocking-only rectifier prompts`

---

## Follow-ups (separate PRs)

- **F1** — Remove `MAX_AGENT_OUTPUT_CHARS` constant if telemetry confirms no real-world truncation behavior is missed; or re-enforce in adapter at a higher cap (e.g. 50_000) with proper `output.slice` and a clear "TRUNCATED" sentinel.
- **F2** — Brand `BlockingFinding` / `AdvisoryFinding` (E3 from dogfood-findings.md).
- **F3** — Cross-iteration severity-change log line (E4).
- **F4** — Bug 2 (US-007 stuck-loop) — separate orchestration fix.

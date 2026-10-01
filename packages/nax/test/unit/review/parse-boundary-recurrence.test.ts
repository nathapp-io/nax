/**
 * US-003 — parse-boundary `meta.recurrence` strip.
 *
 * `meta.recurrence` is FRAMEWORK-OWNED. A reviewer LLM that authors its own
 * `meta.recurrence` would have its forgery persisted verbatim through both
 * the semantic-path converters (`llmFindingToFinding`) and the adversarial
 * converter (`toAdversarialReviewFindings`), reaching the audit record
 * (`ReviewAuditEntry.result.findings`) as if nax had stamped it. The
 * parse-boundary fix — `validateLLMShape` and `validateAdversarialShape`
 * silently drop any model-supplied `meta.recurrence` — closes that loophole.
 *
 * The in-repo precedent is `evidence`, which
 * `substantiateAdversarialFindings` overwrites wholesale ("never authored
 * by the model"). This file pins the same framework-ownership posture for
 * `meta.recurrence`. Split out of `recurrence-stamps.test.ts` because the
 * 800-line test-file cap (#1514 / project-conventions.md) left no room for
 * the additional describe blocks; this concern (parse-boundary ownership)
 * is also distinct from the AC1-AC13 mapper/op coverage in that file.
 */
import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import { validateAdversarialShape } from "@/review/adversarial-helpers";
import { validateLLMShape } from "@/review/semantic-helpers";

describe("validateAdversarialShape strips model-authored meta.recurrence at the parse boundary", () => {
  // Pinned test for the adversarial reviewer contract: a model can carry any
  // other meta keys through (those are still legitimately the reviewer's),
  // but `meta.recurrence` is framework-only and the parse boundary silently
  // drops it. Without this guard, a forged `{"recurrence":{"disposition":
  // "demoted","wasBlocking":true}}` would round-trip to the audit record as
  // if nax had demoted the finding.
  test("drops model-authored meta.recurrence, leaves other meta keys intact", () => {
    const parsed = validateAdversarialShape({
      passed: true,
      findings: [
        {
          severity: "error",
          category: "security",
          file: "src/a.ts",
          line: 1,
          issue: "injection",
          suggestion: "fix",
          meta: { recurrence: { disposition: "demoted", rounds: 99, wasBlocking: true }, otherNote: "keep" },
        },
      ],
    });
    assertDefined(parsed, "validateAdversarialShape() result");
    const finding = parsed.findings[0];
    if (finding.meta !== undefined) {
      expect("recurrence" in finding.meta).toBe(false);
      expect(finding.meta.otherNote).toBe("keep");
    }
  });

  test("drops model-authored meta.recurrence even when it is the only meta key", () => {
    const parsed = validateAdversarialShape({
      passed: true,
      findings: [
        {
          severity: "error",
          category: "security",
          file: "src/a.ts",
          line: 1,
          issue: "injection",
          suggestion: "fix",
          meta: { recurrence: { disposition: "retired", rounds: 3, wasBlocking: false } },
        },
      ],
    });
    assertDefined(parsed, "validateAdversarialShape() result");
    expect(parsed.findings[0].meta).toBeUndefined();
  });

  test("findings without meta pass through untouched", () => {
    const parsed = validateAdversarialShape({
      passed: true,
      findings: [
        {
          severity: "warning",
          category: "convention",
          file: "src/a.ts",
          line: 1,
          issue: "no meta here",
          suggestion: "fix",
        },
      ],
    });
    assertDefined(parsed, "validateAdversarialShape() result");
    expect(parsed.findings[0].meta).toBeUndefined();
  });
});

describe("validateLLMShape strips model-authored meta.recurrence at the parse boundary", () => {
  // Symmetric to the adversarial case. The semantic path defaults
  // `recurrenceDemotion.enabled` to false, so `classifyRecurrence` does NOT
  // stamp `meta.recurrence` and a leaked forgery would persist with no
  // further chance to be rewritten — exactly the failure mode that
  // motivated this guard.
  test("drops model-authored meta.recurrence, leaves other meta keys intact", () => {
    const parsed = validateLLMShape({
      passed: true,
      findings: [
        {
          severity: "warning",
          category: "convention",
          file: "src/b.ts",
          line: 1,
          issue: "stale doc",
          suggestion: "refresh",
          meta: { recurrence: { disposition: "blocking", rounds: 1 }, acIndex: 7 },
        },
      ],
    });
    assertDefined(parsed, "validateLLMShape() result");
    const finding = parsed.findings[0];
    if (finding.meta !== undefined) {
      expect("recurrence" in finding.meta).toBe(false);
      expect(finding.meta.acIndex).toBe(7);
    }
  });

  test("drops model-authored meta.recurrence even when it is the only meta key", () => {
    const parsed = validateLLMShape({
      passed: true,
      findings: [
        {
          severity: "warning",
          category: "convention",
          file: "src/b.ts",
          line: 1,
          issue: "stale doc",
          suggestion: "refresh",
          meta: { recurrence: { disposition: "advisory", rounds: 1 } },
        },
      ],
    });
    assertDefined(parsed, "validateLLMShape() result");
    expect(parsed.findings[0].meta).toBeUndefined();
  });
});

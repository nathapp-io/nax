// test/unit/prompts/builders/prior-iterations-builder-token-guard.test.ts
//
// The MAX_BLOCK_CHARS token guard in `buildPriorIterationsBlock`: which rounds
// collapse to one-liners, what those one-liners must preserve, and what the
// verdict template counts once rounds are collapsed.
//
// Split out of `prior-iterations-builder.test.ts` (by describe block) when that
// file crossed the 800-line hard limit for test files.
import { describe, expect, test } from "bun:test";
import type { Finding, Iteration } from "@/findings";
import { buildPriorIterationsBlock } from "@/prompts/builders/prior-iterations-builder";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Local rather than `@test/helpers`: every assertion in this file is about the
// RENDERED SIZE of the block relative to MAX_BLOCK_CHARS, so the fixture's
// defaults (severity `error`, category `stdout-capture`) are part of the
// contract — the shared factory's shorter defaults move the four tests below
// under the collapse threshold and silently disable them.

function makeFinding(overrides: Partial<Finding> & Pick<Finding, "source" | "message">): Finding {
  return {
    severity: "error",
    category: overrides.category ?? "stdout-capture",
    ...overrides,
  };
}

function makeIteration(
  overrides: Partial<Iteration<Finding>> & Pick<Iteration<Finding>, "iterationNum" | "outcome">,
): Iteration<Finding> {
  return {
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

describe("buildPriorIterationsBlock — token guard", () => {
  test("collapses oldest rounds to one-liners when content exceeds MAX_BLOCK_CHARS", () => {
    // 4 findings × 5 iterations ≈ 6600 chars → exceeds 6000-char budget
    const verboseMessage = "X".repeat(300);
    const perRoundFindings = Array.from({ length: 4 }, (_, j) =>
      makeFinding({ source: "adversarial-review", message: `${verboseMessage}-${j}`, file: "src/big.ts", line: j + 1 }),
    );
    const iterations = Array.from({ length: 5 }, (_, i) =>
      makeIteration({ iterationNum: i + 1, outcome: "unchanged", findingsBefore: [], findingsAfter: perRoundFindings }),
    );

    const output = buildPriorIterationsBlock(iterations);

    // Oldest rounds (1, 2, 3) collapsed to one-liners
    expect(output).toContain("Round 1 — outcome: unchanged (4 findings, omitted for brevity)");
    expect(output).toContain("Round 2 — outcome: unchanged (4 findings, omitted for brevity)");
    expect(output).toContain("Round 3 — outcome: unchanged (4 findings, omitted for brevity)");
    // Most recent 2 rounds (4, 5) rendered verbatim
    expect(output).toContain("### Round 4 — outcome: unchanged");
    expect(output).toContain("### Round 5 — outcome: unchanged");
    expect(output).toContain("Message:");
  });

  test("never collapses when 2 or fewer iterations even if large", () => {
    const verboseMessage = "Y".repeat(1000);
    const f1 = makeFinding({ source: "adversarial-review", message: verboseMessage });
    const f2 = makeFinding({ source: "adversarial-review", message: verboseMessage });
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [f1] });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsAfter: [f2] });

    const output = buildPriorIterationsBlock([iter1, iter2]);

    // Both rounds rendered verbatim even though content is large
    expect(output).toContain("### Round 1 — outcome: partial");
    expect(output).toContain("### Round 2 — outcome: unchanged");
    expect(output).not.toContain("omitted for brevity");
  });

  test("verdict count uses only visible rounds after collapse", () => {
    // iter1 (7) + iter2 (6) → collapsed; iter3 (3) + iter4 (3) → visible → total = 6
    const verboseMessage = "Z".repeat(300);
    const makeFindings = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeFinding({ source: "adversarial-review", message: `${verboseMessage}-${i}`, file: "src/big.ts", line: i }),
      );
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: makeFindings(7) });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsAfter: makeFindings(6) });
    const iter3 = makeIteration({ iterationNum: 3, outcome: "unchanged", findingsAfter: makeFindings(3) });
    const iter4 = makeIteration({ iterationNum: 4, outcome: "unchanged", findingsAfter: makeFindings(3) });

    const output = buildPriorIterationsBlock([iter1, iter2, iter3, iter4]);

    // Only rounds 3 and 4 are visible (last 2), each with 3 findings → total = 6
    expect(output).toContain("classify each of the 6 prior finding(s) above");
  });

  test("FALSIFIED note absent when only collapsed rounds have outcome=unchanged", () => {
    // Rounds 1–2 are "unchanged" (will be collapsed); rounds 3–4 are "partial" (visible).
    // verdictTemplate must NOT show the FALSIFIED note because no visible round is unchanged.
    const verboseMessage = "W".repeat(300);
    const makeFindings = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        makeFinding({ source: "adversarial-review", message: `${verboseMessage}-${i}`, file: "src/big.ts", line: i }),
      );
    const iter1 = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: makeFindings(5) });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsAfter: makeFindings(5) });
    const iter3 = makeIteration({ iterationNum: 3, outcome: "partial", findingsAfter: makeFindings(5) });
    const iter4 = makeIteration({ iterationNum: 4, outcome: "partial", findingsAfter: makeFindings(5) });

    const output = buildPriorIterationsBlock([iter1, iter2, iter3, iter4]);

    // Collapsed rounds are not shown verbatim, so FALSIFIED note must not appear
    expect(output).toContain("omitted for brevity");
    expect(output).not.toContain("FALSIFIED");
  });

  // Adversarial review #4 — the collapsed ("omitted for brevity") line must
  // report the retired count from the SAME predicate the verdict list filters
  // on. A stamp-only count reads 0 for a round whose only finding is the
  // unstamped twin of a defect retired later, so the collapsed line would claim
  // nothing happened in a round that actually closed a finding.
  test("collapsed line counts a suppressed unstamped twin as retired, not zero", () => {
    const leading = "warning text about the session cache never being cleared";
    const verbose = "V".repeat(300);
    const twin = (meta?: Record<string, unknown>): Finding =>
      makeFinding({
        source: "adversarial-review",
        message: leading,
        file: "src/lib/twin.ts",
        line: 3,
        category: "input",
        severity: "warning",
        ...(meta ? { meta } : {}),
      });
    // 16 × ~240-char rendered messages per round is what pushes the block past
    // MAX_BLOCK_CHARS, leaving rounds 3-4 verbatim and rounds 1-2 collapsed.
    const bulk = (i: number): Finding[] =>
      Array.from({ length: 16 }, (_, j) =>
        makeFinding({ source: "adversarial-review", message: `${verbose}-${i}-${j}`, file: "src/big.ts", line: j }),
      );

    const round1 = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: [twin()] });
    const round2 = makeIteration({
      iterationNum: 2,
      outcome: "unchanged",
      findingsAfter: [twin({ recurrence: { disposition: "retired", rounds: 2, wasBlocking: false } })],
    });
    const round3 = makeIteration({ iterationNum: 3, outcome: "unchanged", findingsAfter: bulk(3) });
    const round4 = makeIteration({ iterationNum: 4, outcome: "unchanged", findingsAfter: bulk(4) });

    const output = buildPriorIterationsBlock([round1, round2, round3, round4]);

    // Round 1 holds no live finding, but it is not "0 findings" — its one
    // finding was closed as retired (the stamp lives on its round-2 twin).
    expect(output).toContain("### Round 1 — outcome: unchanged (0 findings, 1 retired, omitted for brevity)");
  });
});

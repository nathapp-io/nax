import { describe, expect, test } from "bun:test";
import type { Iteration, Finding } from "../../../../src/findings";
import { buildPriorIterationsBlock } from "../../../../src/prompts/builders/prior-iterations-builder";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> & Pick<Finding, "source" | "message">): Finding {
  return {
    severity: "error",
    category: overrides.category ?? "stdout-capture",
    ...overrides,
  };
}

function makeIteration(overrides: Partial<Iteration<Finding>> & Pick<Iteration<Finding>, "iterationNum" | "outcome">): Iteration<Finding> {
  return {
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

// ─── Empty input ──────────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — empty", () => {
  test("returns empty string for empty iterations array", () => {
    expect(buildPriorIterationsBlock([])).toBe("");
  });
});

// ─── Single iteration with findings ─────────────────────────────────────────

describe("buildPriorIterationsBlock — single round with findings", () => {
  test("renders Round header and finding text fields", () => {
    const finding = makeFinding({
      source: "adversarial-review",
      message: "Missing test for null input path",
      suggestion: "Add a test asserting the function throws on null",
      file: "src/foo.ts",
      line: 42,
      category: "test-gap",
      severity: "error",
    });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "regressed",
      findingsBefore: [],
      findingsAfter: [finding],
    });

    const output = buildPriorIterationsBlock([iter]);

    expect(output).toContain("## Prior Iterations — verdict required before new analysis");
    expect(output).toContain("### Round 1 — outcome: regressed (0 → 1)");
    expect(output).toContain("Findings flagged previously:");
    expect(output).toContain("src/foo.ts:42");
    expect(output).toContain("[error / test-gap]");
    expect(output).toContain("Message: Missing test for null input path");
    expect(output).toContain("Suggestion: Add a test asserting the function throws on null");
  });

  test("shows (workdir-global) when finding has no file", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "missing script" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsAfter: [finding],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("(workdir-global)");
  });

  test("shows file without line when line is absent", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x", file: "src/bar.ts" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "partial",
      findingsAfter: [finding],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("src/bar.ts");
    expect(output).not.toContain("src/bar.ts:");
  });

  test("renders _All prior findings cleared_ when findingsAfter is empty", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "resolved",
      findingsBefore: [finding],
      findingsAfter: [],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("### Round 1 — outcome: resolved (1 → 0)");
    expect(output).toContain("_All prior findings cleared._");
    expect(output).not.toContain("Findings flagged previously:");
  });
});

// ─── acQuote field ────────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — acQuote", () => {
  test("renders acQuote line when meta.acQuote is a string", () => {
    const finding = makeFinding({
      source: "adversarial-review",
      message: "AC not covered",
      meta: { acQuote: "AC3: error path is covered" },
    });
    const iter = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain('acQuote: "AC3: error path is covered"');
  });

  test("omits acQuote line when meta is absent", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x" });
    const iter = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).not.toContain("acQuote:");
  });

  test("omits acQuote line when meta.acQuote is not a string", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x", meta: { acQuote: 42 } });
    const iter = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).not.toContain("acQuote:");
  });
});

// ─── Truncation ───────────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — truncation", () => {
  test("truncates message longer than 240 chars", () => {
    const longMessage = "A".repeat(300);
    const finding = makeFinding({ source: "adversarial-review", message: longMessage });
    const iter = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("…");
    // The full 300-char message should not appear verbatim
    expect(output).not.toContain("A".repeat(300));
  });

  test("does not truncate message at or under 240 chars", () => {
    const exactMessage = "B".repeat(240);
    const finding = makeFinding({ source: "adversarial-review", message: exactMessage });
    const iter = makeIteration({ iterationNum: 1, outcome: "unchanged", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("B".repeat(240));
  });
});

// ─── Verdict template ─────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — verdict template", () => {
  test("includes verdict template with correct total count", () => {
    const f1 = makeFinding({ source: "adversarial-review", message: "a" });
    const f2 = makeFinding({ source: "adversarial-review", message: "b" });
    const iter = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [f1, f2] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("classify each of the 2 prior finding(s) above");
    expect(output).toContain("`addressed`");
    expect(output).toContain("`still-blocking`");
    expect(output).toContain("`never-an-issue`");
  });

  test("sums findingsAfter across multiple iterations for total count", () => {
    const f1 = makeFinding({ source: "adversarial-review", message: "x" });
    const f2 = makeFinding({ source: "adversarial-review", message: "y" });
    const f3 = makeFinding({ source: "adversarial-review", message: "z" });
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsBefore: [], findingsAfter: [f1] });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsBefore: [f1], findingsAfter: [f2, f3] });

    const output = buildPriorIterationsBlock([iter1, iter2]);
    expect(output).toContain("classify each of the 3 prior finding(s) above");
  });

  test("routes addressed / never-an-issue verdicts to `acks`, not to findings (#1423)", () => {
    // An acknowledgement is not a defect. Emitting it as a finding inflates
    // finding telemetry and pollutes curator proposal evidence.
    const finding = makeFinding({ source: "adversarial-review", message: "a" });
    const output = buildPriorIterationsBlock([
      makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [finding] }),
    ]);

    expect(output).toContain("`acks`");
    // The two non-blocking verdicts must be explicitly directed away from findings.
    expect(output).toMatch(/`addressed`[^\n]*acks/i);
    expect(output).toMatch(/`never-an-issue`[^\n]*acks/i);
    // still-blocking remains a real finding — it is a defect the implementer left.
    expect(output).toMatch(/`still-blocking`[^\n]*re-flag/i);
    expect(output).toContain("Do NOT emit an acknowledgement as a finding");
  });

  test("does NOT include FALSIFIED note when no unchanged iterations", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x" });
    const iter = makeIteration({ iterationNum: 1, outcome: "resolved", findingsAfter: [finding] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).not.toContain("FALSIFIED");
  });
});

// ─── Unchanged outcome ────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — unchanged outcome", () => {
  test("includes falsified-hypothesis note when any iteration is unchanged", () => {
    const finding = makeFinding({ source: "adversarial-review", message: "x", category: "test-gap" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsBefore: [finding],
      findingsAfter: [finding],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain('outcome is "unchanged", the prior hypothesis is FALSIFIED');
    expect(output).toContain("Do NOT repeat fixes listed above.");
  });

  test("includes FALSIFIED note even when only one of multiple iterations is unchanged", () => {
    const f = makeFinding({ source: "adversarial-review", message: "x" });
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsBefore: [], findingsAfter: [f] });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsBefore: [f], findingsAfter: [f] });

    const output = buildPriorIterationsBlock([iter1, iter2]);
    expect(output).toContain("FALSIFIED");
  });
});

// ─── Multiple iterations ──────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — multiple iterations", () => {
  test("renders all rounds in order with correct headers", () => {
    const f = makeFinding({ source: "adversarial-review", message: "finding" });
    const iter1 = makeIteration({ iterationNum: 1, outcome: "partial", findingsBefore: [], findingsAfter: [f] });
    const iter2 = makeIteration({ iterationNum: 2, outcome: "unchanged", findingsBefore: [f], findingsAfter: [f] });
    const iter3 = makeIteration({ iterationNum: 3, outcome: "resolved", findingsBefore: [f], findingsAfter: [] });

    const output = buildPriorIterationsBlock([iter1, iter2, iter3]);

    expect(output).toContain("### Round 1 — outcome: partial");
    expect(output).toContain("### Round 2 — outcome: unchanged");
    expect(output).toContain("### Round 3 — outcome: resolved");
    // Rounds appear in order
    const r1Pos = output.indexOf("### Round 1");
    const r2Pos = output.indexOf("### Round 2");
    const r3Pos = output.indexOf("### Round 3");
    expect(r1Pos).toBeLessThan(r2Pos);
    expect(r2Pos).toBeLessThan(r3Pos);
  });

  test("numbers findings within a round starting at 1", () => {
    const f1 = makeFinding({ source: "adversarial-review", message: "first" });
    const f2 = makeFinding({ source: "adversarial-review", message: "second" });
    const iter = makeIteration({ iterationNum: 1, outcome: "partial", findingsAfter: [f1, f2] });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("1. [");
    expect(output).toContain("2. [");
  });
});

// ─── Token guard ──────────────────────────────────────────────────────────────

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
});

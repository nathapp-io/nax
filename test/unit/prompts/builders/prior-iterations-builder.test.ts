import { describe, expect, test } from "bun:test";
import { buildPriorIterationsBlock } from "../../../../src/prompts/builders/prior-iterations-builder";
import type { Iteration } from "../../../../src/findings/cycle-types";
import type { Finding } from "../../../../src/findings/types";

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

const acceptanceTestFix = {
  strategyName: "acceptance-test-fix",
  op: "acceptance-fix-test-op",
  targetFiles: [".nax-acceptance.test.ts"],
  summary: "adjusted stdout capture assertion",
};

// ─── Empty input ──────────────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — empty", () => {
  test("returns empty string for empty iterations array", () => {
    expect(buildPriorIterationsBlock([])).toBe("");
  });
});

// ─── Single iteration — resolved ─────────────────────────────────────────────

describe("buildPriorIterationsBlock — single resolved iteration", () => {
  test("renders table with resolved outcome", () => {
    const finding = makeFinding({ source: "acceptance-diagnose", message: "wrong stream" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "resolved",
      findingsBefore: [finding],
      findingsAfter: [],
      fixesApplied: [acceptanceTestFix],
    });

    const output = buildPriorIterationsBlock([iter]);

    expect(output).toContain("## Prior Iterations — verdict required before new analysis");
    expect(output).toContain("| # | Strategies run | Files touched | Outcome | Findings before → after |");
    expect(output).toContain("| 1 | acceptance-test-fix | .nax-acceptance.test.ts | resolved |");
    expect(output).toContain("1 [stdout-capture] → 0");
  });

  test("does NOT include unchanged note when no unchanged iterations", () => {
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "resolved",
      findingsBefore: [makeFinding({ source: "acceptance-diagnose", message: "x" })],
      findingsAfter: [],
      fixesApplied: [acceptanceTestFix],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).not.toContain("FALSIFIED");
  });
});

// ─── Single iteration — unchanged ────────────────────────────────────────────

describe("buildPriorIterationsBlock — unchanged outcome", () => {
  test("includes falsified-hypothesis note when outcome is unchanged", () => {
    const finding = makeFinding({ source: "acceptance-diagnose", message: "wrong stream", category: "stdout-capture" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsBefore: [finding],
      findingsAfter: [finding],
      fixesApplied: [acceptanceTestFix],
    });

    const output = buildPriorIterationsBlock([iter]);

    expect(output).toContain("unchanged");
    expect(output).toContain('outcome is "unchanged", the prior hypothesis is FALSIFIED');
    expect(output).toContain("Do NOT repeat fixes listed above.");
  });

  test("finding summary shows same count before and after for unchanged", () => {
    const finding = makeFinding({ source: "acceptance-diagnose", message: "wrong stream", category: "stdout-capture" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsBefore: [finding],
      findingsAfter: [finding],
      fixesApplied: [acceptanceTestFix],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("1 [stdout-capture] → 1 [stdout-capture]");
  });
});

// ─── Multiple iterations ──────────────────────────────────────────────────────

describe("buildPriorIterationsBlock — multiple iterations", () => {
  test("renders all iteration rows in order", () => {
    const finding = makeFinding({ source: "acceptance-diagnose", message: "x", category: "stdout-capture" });
    const iter1 = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsBefore: [finding],
      findingsAfter: [finding],
      fixesApplied: [acceptanceTestFix],
    });
    const iter2 = makeIteration({
      iterationNum: 2,
      outcome: "resolved",
      findingsBefore: [finding],
      findingsAfter: [],
      fixesApplied: [{ ...acceptanceTestFix, summary: "second attempt" }],
    });

    const output = buildPriorIterationsBlock([iter1, iter2]);

    expect(output).toContain("| 1 |");
    expect(output).toContain("| 2 |");
    // unchanged note present because iter1 was unchanged
    expect(output).toContain("FALSIFIED");
  });

  test("co-run strategies are joined with comma in Strategies run column", () => {
    const sourceFix = { strategyName: "acceptance-source-fix", op: "op-a", targetFiles: ["src/foo.ts"], summary: "" };
    const testFix = { strategyName: "acceptance-test-fix", op: "op-b", targetFiles: [".nax-acceptance.test.ts"], summary: "" };
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "partial",
      findingsBefore: [makeFinding({ source: "acceptance-diagnose", message: "x" })],
      findingsAfter: [],
      fixesApplied: [sourceFix, testFix],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("acceptance-source-fix, acceptance-test-fix");
    expect(output).toContain("src/foo.ts, .nax-acceptance.test.ts");
  });

  test("no-files iteration shows dash in Files touched column", () => {
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "unchanged",
      findingsBefore: [makeFinding({ source: "acceptance-diagnose", message: "x" })],
      findingsAfter: [makeFinding({ source: "acceptance-diagnose", message: "x" })],
      fixesApplied: [{ strategyName: "lint-fix", op: "lint-op", targetFiles: [], summary: "" }],
    });

    const output = buildPriorIterationsBlock([iter]);
    expect(output).toContain("| 1 | lint-fix | - |");
  });

  test("most-frequent category shown when findings have mixed categories", () => {
    const f1 = makeFinding({ source: "lint", message: "a", category: "unused-var" });
    const f2 = makeFinding({ source: "lint", message: "b", category: "unused-var" });
    const f3 = makeFinding({ source: "lint", message: "c", category: "missing-semi" });
    const iter = makeIteration({
      iterationNum: 1,
      outcome: "partial",
      findingsBefore: [f1, f2, f3],
      findingsAfter: [f3],
      fixesApplied: [{ strategyName: "lint-fix", op: "lint-op", targetFiles: ["src/a.ts"], summary: "" }],
    });

    const output = buildPriorIterationsBlock([iter]);
    // 3 before, top category "unused-var" (2 occurrences)
    expect(output).toContain("3 [unused-var]");
    // 1 after, category "missing-semi"
    expect(output).toContain("1 [missing-semi]");
  });
});

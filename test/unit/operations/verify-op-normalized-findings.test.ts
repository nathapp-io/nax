/**
 * Tests for verifierOp.parse — normalizedFindings field (story: verifier-findings-and-cycle-honesty)
 *
 * AC1: tests-failing verdict → normalizedFindings has tdd-verifier error with category tests-failed, fixTarget source
 * AC2: success / advisory-only verdict → normalizedFindings is empty
 * AC3: verifier-rejected verdict → normalizedFindings has tdd-verifier error with category illegitimate-test-edits, fixTarget test
 */

import { describe, expect, test } from "bun:test";
import { makeStory } from "@test/helpers";
import type { ConfigSelector } from "@/config";
import { DEFAULT_CONFIG, tddConfigSelector } from "@/config";
import type { PackageView } from "@/runtime";

function makePackageView(): PackageView {
  const config = DEFAULT_CONFIG;
  return {
    packageDir: "",
    relativeFromRoot: "",
    repoRoot: "",
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
}

const makeCtx = () => ({
  packageView: makePackageView(),
  config: tddConfigSelector.select(DEFAULT_CONFIG),
});

const makeInput = () => ({ story: makeStory({ id: "US-001" }) });

// ── Verdict helpers ──────────────────────────────────────────────────────────

function makeApprovedVerdict() {
  return JSON.stringify({
    version: 1,
    approved: true,
    tests: { allPassing: true, passCount: 5, failCount: 0 },
    testModifications: { detected: false, files: [], legitimate: true, reasoning: "ok" },
    acceptanceCriteria: { allMet: true, criteria: [] },
    quality: { rating: "good", issues: [] },
    fixes: [],
    reasoning: "all good",
  });
}

function makeTestsFailingVerdict(failCount = 2) {
  return JSON.stringify({
    version: 1,
    approved: false,
    tests: { allPassing: false, passCount: 1, failCount },
    testModifications: { detected: false, files: [], legitimate: true, reasoning: "no mods" },
    acceptanceCriteria: { allMet: false, criteria: [] },
    quality: { rating: "acceptable", issues: [] },
    fixes: [],
    reasoning: `${failCount} test(s) failed`,
  });
}

function makeVerifierRejectedVerdict(files: string[] = ["test/unit/foo.test.ts"]) {
  return JSON.stringify({
    version: 1,
    approved: false,
    tests: { allPassing: true, passCount: 3, failCount: 0 },
    testModifications: { detected: true, files, legitimate: false, reasoning: "loosened assertions" },
    acceptanceCriteria: { allMet: true, criteria: [] },
    quality: { rating: "good", issues: [] },
    fixes: [],
    reasoning: "illegitimate test edits detected",
  });
}

function makeIncorrectTestVerdict() {
  return JSON.stringify({
    version: 1,
    approved: false,
    tests: { allPassing: false, passCount: 4, failCount: 1 },
    testModifications: { detected: false, files: [], legitimate: true, reasoning: "no mods" },
    testFailureDiagnosis: {
      cause: "test-incorrect",
      assertions: [
        {
          file: "test/unit/foo.test.ts",
          testName: "injects the failure note",
          reasoning: "The assertion conflicts with AC7.",
        },
      ],
    },
    acceptanceCriteria: { allMet: true, criteria: [] },
    quality: { rating: "good", issues: [] },
    fixes: [],
    reasoning: "Implementation is conformant; the assertion is incorrect.",
  });
}

/** Advisory-only rejection: tests pass, AC not met but quality advisory — categorizeVerdict returns success=true */
function makeAdvisoryOnlyVerdict() {
  return JSON.stringify({
    version: 1,
    approved: false,
    tests: { allPassing: true, passCount: 5, failCount: 0 },
    testModifications: { detected: false, files: [], legitimate: true, reasoning: "no mods" },
    acceptanceCriteria: { allMet: false, criteria: [{ criterion: "AC-1", met: false }] },
    quality: { rating: "poor", issues: ["missing docs"] },
    fixes: [],
    reasoning: "advisory only concerns",
  });
}

// ── AC1: tests-failing → populated normalizedFindings ───────────────────────

describe("AC1: normalizedFindings when tests-failing", () => {
  test("AC1: normalizedFindings is non-empty when categorization.failureCategory === tests-failing", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);

    expect(Array.isArray(result.normalizedFindings)).toBe(true);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
  });

  test("AC1: first finding has source === tdd-verifier", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);
    // Guard: fails assertively if stub returns []
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].source).toBe("tdd-verifier");
  });

  test("AC1: first finding has severity === error", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].severity).toBe("error");
  });

  test("AC1: first finding has category === tests-failed", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].category).toBe("tests-failed");
  });

  test("AC1: first finding has fixTarget === source", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].fixTarget).toBe("source");
  });

  test("AC1: first finding has a non-empty message", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeTestsFailingVerdict(3), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    const msg = result.normalizedFindings[0].message;
    expect(typeof msg).toBe("string");
    expect((msg as string).length).toBeGreaterThan(0);
  });
});

// ── AC2: success / advisory → normalizedFindings is empty ───────────────────

describe("AC2: normalizedFindings is empty on success", () => {
  test("AC2: approved verdict → normalizedFindings.length === 0", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeApprovedVerdict(), makeInput(), ctx);

    expect(result.normalizedFindings.length).toBe(0);
  });

  test("AC2: advisory-only verdict (tests pass, AC/quality concerns only) → normalizedFindings.length === 0", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    // categorizeVerdict treats AC/quality-only as success (advisory)
    const result = parse(makeAdvisoryOnlyVerdict(), makeInput(), ctx);

    expect(result.normalizedFindings.length).toBe(0);
  });
});

// ── AC3: verifier-rejected → illegitimate-test-edits finding ────────────────

describe("AC3: normalizedFindings when verifier-rejected", () => {
  test("AC3: normalizedFindings contains exactly one entry", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);

    expect(result.normalizedFindings.length).toBe(1);
  });

  test("AC3: finding has source === tdd-verifier", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);
    // Guard: fails assertively if stub returns []
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].source).toBe("tdd-verifier");
  });

  test("AC3: finding has severity === error", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].severity).toBe("error");
  });

  test("AC3: finding has category === illegitimate-test-edits", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].category).toBe("illegitimate-test-edits");
  });

  test("AC3: finding has fixTarget === test", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict(), makeInput(), ctx);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].fixTarget).toBe("test");
  });

  test("AC3: normalizedFindings present when testModifications.files is empty list", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeVerifierRejectedVerdict([]), makeInput(), ctx);

    expect(result.normalizedFindings.length).toBe(1);
    expect(result.normalizedFindings.length).toBeGreaterThan(0);
    expect(result.normalizedFindings[0].category).toBe("illegitimate-test-edits");
  });
});

describe("test-incorrect normalized finding", () => {
  test("preserves the assertion diagnosis as a test-targeted finding", async () => {
    const { verifierOp } = await import("@/operations");
    const ctx = await makeCtx();
    const parse = verifierOp.parse;

    const result = parse(makeIncorrectTestVerdict(), makeInput(), ctx);
    const finding = result.normalizedFindings[0];

    expect(result.failureCategory).toBe("test-incorrect");
    expect(result.normalizedFindings).toHaveLength(1);
    expect(finding.category).toBe("incorrect-test-assertion");
    expect(finding.fixTarget).toBe("test");
    expect(finding.message).toContain("test/unit/foo.test.ts");
  });
});

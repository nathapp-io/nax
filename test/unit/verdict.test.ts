/**
 * Tests for src/tdd/verdict.ts
 *
 * Covers: readVerdict, cleanupVerdict, categorizeVerdict
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { categorizeVerdict, cleanupVerdict, readVerdict } from "../../src/tdd/verdict";
import type { VerifierVerdict } from "../../src/tdd/verdict";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Build a fully valid verdict with sensible defaults. */
function makeVerdict(overrides: Partial<VerifierVerdict> = {}): VerifierVerdict {
  return {
    version: 1,
    approved: true,
    tests: { allPassing: true, passCount: 10, failCount: 0 },
    testModifications: { detected: false, files: [], legitimate: true, reasoning: "No modifications" },
    acceptanceCriteria: {
      allMet: true,
      criteria: [{ criterion: "Feature works", met: true }],
    },
    quality: { rating: "good", issues: [] },
    fixes: [],
    reasoning: "All good.",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────────────

let workdir: string;

beforeEach(async () => {
  workdir = path.join(tmpdir(), `verdict-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(workdir, { recursive: true });
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// readVerdict
// ─────────────────────────────────────────────────────────────────────────────

describe("readVerdict", () => {
  it("returns parsed verdict when file exists and is valid", async () => {
    const verdict = makeVerdict();
    await writeFile(
      path.join(workdir, ".nax-verifier-verdict.json"),
      JSON.stringify(verdict),
      "utf-8",
    );

    const result = await readVerdict(workdir);
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.approved).toBe(true);
    expect(result?.tests.allPassing).toBe(true);
    expect(result?.tests.passCount).toBe(10);
    expect(result?.tests.failCount).toBe(0);
  });

  it("returns null when file does not exist (no throw)", async () => {
    const result = await readVerdict(workdir);
    expect(result).toBeNull();
  });

  it("returns null when JSON is malformed (no throw, logs warning)", async () => {
    await writeFile(
      path.join(workdir, ".nax-verifier-verdict.json"),
      "{ this is not valid json !!!",
      "utf-8",
    );

    const result = await readVerdict(workdir);
    expect(result).toBeNull();
  });

  it("returns null when required field 'version' is missing", async () => {
    const bad = { approved: true, tests: { allPassing: true, passCount: 5, failCount: 0 } };
    await writeFile(
      path.join(workdir, ".nax-verifier-verdict.json"),
      JSON.stringify(bad),
      "utf-8",
    );

    const result = await readVerdict(workdir);
    expect(result).toBeNull();
  });

  it("returns null when required field 'approved' is missing", async () => {
    const bad = { version: 1, tests: { allPassing: true, passCount: 5, failCount: 0 } };
    await writeFile(
      path.join(workdir, ".nax-verifier-verdict.json"),
      JSON.stringify(bad),
      "utf-8",
    );

    const result = await readVerdict(workdir);
    expect(result).toBeNull();
  });

  it("returns null when required field 'tests' is missing", async () => {
    const bad = { version: 1, approved: true };
    await writeFile(
      path.join(workdir, ".nax-verifier-verdict.json"),
      JSON.stringify(bad),
      "utf-8",
    );

    const result = await readVerdict(workdir);
    expect(result).toBeNull();
  });

  it("returns null when tests sub-fields are missing", async () => {
    const bad = { version: 1, approved: true, tests: { allPassing: true } };
    await writeFile(
      path.join(workdir, ".nax-verifier-verdict.json"),
      JSON.stringify(bad),
      "utf-8",
    );

    const result = await readVerdict(workdir);
    expect(result).toBeNull();
  });

  it("returns null when version is not 1", async () => {
    const bad = { version: 2, approved: true, tests: { allPassing: true, passCount: 5, failCount: 0 } };
    await writeFile(
      path.join(workdir, ".nax-verifier-verdict.json"),
      JSON.stringify(bad),
      "utf-8",
    );

    const result = await readVerdict(workdir);
    expect(result).toBeNull();
  });

  it("returns null for empty JSON object", async () => {
    await writeFile(
      path.join(workdir, ".nax-verifier-verdict.json"),
      JSON.stringify({}),
      "utf-8",
    );

    const result = await readVerdict(workdir);
    expect(result).toBeNull();
  });

  it("returns null for JSON array (not an object)", async () => {
    await writeFile(
      path.join(workdir, ".nax-verifier-verdict.json"),
      JSON.stringify([1, 2, 3]),
      "utf-8",
    );

    const result = await readVerdict(workdir);
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cleanupVerdict
// ─────────────────────────────────────────────────────────────────────────────

describe("cleanupVerdict", () => {
  it("deletes the verdict file when it exists", async () => {
    const verdictPath = path.join(workdir, ".nax-verifier-verdict.json");
    await writeFile(verdictPath, JSON.stringify(makeVerdict()), "utf-8");

    expect(existsSync(verdictPath)).toBe(true);

    await cleanupVerdict(workdir);

    expect(existsSync(verdictPath)).toBe(false);
  });

  it("does not throw when verdict file does not exist", async () => {
    // Should not throw
    await expect(cleanupVerdict(workdir)).resolves.toBeUndefined();
  });

  it("does not throw when called twice (second call is a no-op)", async () => {
    const verdictPath = path.join(workdir, ".nax-verifier-verdict.json");
    await writeFile(verdictPath, JSON.stringify(makeVerdict()), "utf-8");

    await cleanupVerdict(workdir);
    // Second call — file already gone
    await expect(cleanupVerdict(workdir)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// categorizeVerdict — with valid verdict
// ─────────────────────────────────────────────────────────────────────────────

describe("categorizeVerdict — with verdict", () => {
  it("returns success when approved=true", () => {
    const result = categorizeVerdict(makeVerdict({ approved: true }), false);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
  });

  it("returns success when approved=true regardless of testsPass", () => {
    const result = categorizeVerdict(makeVerdict({ approved: true }), false);
    expect(result.success).toBe(true);
  });

  it("returns verifier-rejected when illegitimate test modifications detected", () => {
    const verdict = makeVerdict({
      approved: false,
      testModifications: {
        detected: true,
        files: ["test/foo.test.ts"],
        legitimate: false,
        reasoning: "Assertions loosened to hide failures",
      },
    });

    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("illegitimate test modifications");
    expect(result.reviewReason).toContain("test/foo.test.ts");
  });

  it("returns tests-failing when tests are not all passing", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 8, failCount: 3 },
      testModifications: { detected: false, files: [], legitimate: true, reasoning: "" },
    });

    const result = categorizeVerdict(verdict, false);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("tests-failing");
    expect(result.reviewReason).toContain("3 failure(s)");
  });

  it("returns verifier-rejected when acceptance criteria not met", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: true, passCount: 10, failCount: 0 },
      testModifications: { detected: false, files: [], legitimate: true, reasoning: "" },
      acceptanceCriteria: {
        allMet: false,
        criteria: [
          { criterion: "Feature works", met: true },
          { criterion: "Error handling", met: false },
        ],
      },
    });

    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("Acceptance criteria not met");
    expect(result.reviewReason).toContain("Error handling");
  });

  it("returns verifier-rejected when quality rating is poor", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: true, passCount: 10, failCount: 0 },
      testModifications: { detected: false, files: [], legitimate: true, reasoning: "" },
      acceptanceCriteria: {
        allMet: true,
        criteria: [{ criterion: "Feature works", met: true }],
      },
      quality: { rating: "poor", issues: ["Security vulnerability", "Memory leak"] },
    });

    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("Poor code quality");
    expect(result.reviewReason).toContain("Security vulnerability");
  });

  it("returns verifier-rejected for catch-all (approved=false, no matching reason)", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: true, passCount: 10, failCount: 0 },
      testModifications: { detected: false, files: [], legitimate: true, reasoning: "" },
      acceptanceCriteria: { allMet: true, criteria: [] },
      quality: { rating: "acceptable", issues: [] },
      reasoning: "Something else went wrong",
    });

    const result = categorizeVerdict(verdict, true);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("Something else went wrong");
  });

  it("legitimate test modifications do not trigger verifier-rejected", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 5, failCount: 2 },
      testModifications: {
        detected: true,
        files: ["test/bar.test.ts"],
        legitimate: true,
        reasoning: "Tests updated to fix incorrect expected values",
      },
      acceptanceCriteria: { allMet: true, criteria: [] },
      quality: { rating: "good", issues: [] },
    });

    // Should fall through to tests-failing (not illegitimate mod path)
    const result = categorizeVerdict(verdict, false);
    expect(result.failureCategory).toBe("tests-failing");
  });

  it("not-detected test modifications do not trigger verifier-rejected for test mods", () => {
    const verdict = makeVerdict({
      approved: false,
      tests: { allPassing: false, passCount: 3, failCount: 4 },
      testModifications: {
        detected: false,
        files: [],
        legitimate: true,
        reasoning: "",
      },
    });

    const result = categorizeVerdict(verdict, false);
    expect(result.failureCategory).toBe("tests-failing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// categorizeVerdict — null verdict (fallback)
// ─────────────────────────────────────────────────────────────────────────────

describe("categorizeVerdict — null verdict (fallback)", () => {
  it("returns success when null verdict + testsPass=true", () => {
    const result = categorizeVerdict(null, true);
    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
  });

  it("returns tests-failing when null verdict + testsPass=false", () => {
    const result = categorizeVerdict(null, false);
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("tests-failing");
    expect(result.reviewReason).toContain("no verdict file");
  });
});

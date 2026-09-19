/**
 * Tests for src/verification/test-baseline.ts
 *
 * Covers AC1–AC18 of the deterministic test-baseline persistence and
 * classification story. Every AC exercises an exported function and
 * asserts observable behavior (file IO round-trip, return values,
 * classification side-effect, mutation safety).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFinding } from "@test/helpers";
import type { Finding } from "@/findings/types";
import {
  applyBaselineDispositions,
  type BaselineDisposition,
  type BaselineEntry,
  readRunBaseline,
  readStoryBaseline,
  resolveStoryBaseline,
  type TestBaseline,
  writeRunBaseline,
  writeStoryBaseline,
} from "@/verification";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "nax-test-baseline-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * AC1 fixture: captured `preflight` baseline with two entries.
 */
function makeCapturedRunBaseline(): TestBaseline {
  return {
    kind: "captured",
    baseRef: "abc123",
    capturedAt: "2026-01-15T00:00:00.000Z",
    source: "preflight",
    entries: [
      { file: "test/unit/foo.test.ts", testName: "should pass" },
      { file: "test/unit/bar.test.ts", testName: "should also pass" },
    ],
  };
}

/**
 * AC2 fixture: captured `roll-forward` baseline for a story.
 */
function makeCapturedStoryBaseline(): TestBaseline {
  return {
    kind: "captured",
    baseRef: "def456",
    capturedAt: "2026-01-15T01:00:00.000Z",
    source: "roll-forward",
    entries: [{ file: "test/unit/foo.test.ts", testName: "should pass" }],
  };
}

function makeNoBaseline(): TestBaseline {
  return {
    kind: "no-baseline",
    reason: "gate-disabled",
    capturedAt: "2026-01-15T02:00:00.000Z",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — writeRunBaseline round-trips through readRunBaseline
// ─────────────────────────────────────────────────────────────────────────────

describe("writeRunBaseline / readRunBaseline (AC1)", () => {
  test("AC1 — round-trips a captured preflight baseline with two entries", async () => {
    const baseline = makeCapturedRunBaseline();
    await writeRunBaseline(tempRoot, "feature-1", baseline);

    const read = await readRunBaseline(tempRoot, "feature-1");
    expect(read).toEqual(baseline);
  });

  test("AC1 — writes to <root>/.nax/features/<featureId>/test-baseline.json", async () => {
    const baseline = makeCapturedRunBaseline();
    await writeRunBaseline(tempRoot, "feature-1", baseline);

    const expectedPath = join(tempRoot, ".nax", "features", "feature-1", "test-baseline.json");
    expect(readFileSync(expectedPath, "utf-8")).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — writeStoryBaseline round-trips through readStoryBaseline
// ─────────────────────────────────────────────────────────────────────────────

describe("writeStoryBaseline / readStoryBaseline (AC2)", () => {
  test("AC2 — round-trips a roll-forward baseline for a story id", async () => {
    const baseline = makeCapturedStoryBaseline();
    await writeStoryBaseline(tempRoot, "feature-1", "US-001", baseline);

    const read = await readStoryBaseline(tempRoot, "feature-1", "US-001");
    expect(read).toEqual(baseline);
  });

  test("AC2 — writes to <root>/.nax/features/<featureId>/stories/<storyId>/test-baseline.json", async () => {
    const baseline = makeCapturedStoryBaseline();
    await writeStoryBaseline(tempRoot, "feature-1", "US-001", baseline);

    const expectedPath = join(tempRoot, ".nax", "features", "feature-1", "stories", "US-001", "test-baseline.json");
    expect(readFileSync(expectedPath, "utf-8")).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — different story id returns undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("readStoryBaseline — different story id (AC3)", () => {
  test("AC3 — returns undefined when reading a different story id", async () => {
    const baseline = makeCapturedStoryBaseline();
    await writeStoryBaseline(tempRoot, "feature-1", "US-001", baseline);

    const read = await readStoryBaseline(tempRoot, "feature-1", "US-OTHER");
    expect(read).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 / AC6 — missing artifact returns undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("readRunBaseline — missing artifact (AC4)", () => {
  test("AC4 — returns undefined when no run-baseline artifact exists", async () => {
    const result = await readRunBaseline(tempRoot, "no-such-feature");
    expect(result).toBeUndefined();
  });
});

describe("readStoryBaseline — missing artifact (AC6)", () => {
  test("AC6 — returns undefined when no story-baseline artifact exists", async () => {
    const result = await readStoryBaseline(tempRoot, "no-such-feature", "US-XYZ");
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 / AC7 — invalid JSON returns undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("readRunBaseline — invalid JSON (AC5)", () => {
  test("AC5 — returns undefined without throwing when artifact is invalid JSON", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const dir = join(tempRoot, ".nax", "features", "feature-bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test-baseline.json"), "{ this is not valid JSON");

    const result = await readRunBaseline(tempRoot, "feature-bad");
    expect(result).toBeUndefined();
  });
});

describe("readStoryBaseline — invalid JSON (AC7)", () => {
  test("AC7 — returns undefined without throwing when story artifact is invalid JSON", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const dir = join(tempRoot, ".nax", "features", "feature-bad", "stories", "US-XYZ");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test-baseline.json"), "not json at all");

    const result = await readStoryBaseline(tempRoot, "feature-bad", "US-XYZ");
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — (file, testName) match → pre-existing
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — (file, testName) match (AC8)", () => {
  test("AC8 — matches on (file, testName); disposition is pre-existing", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      baseRef: "ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "roll-forward",
      entries: [{ file: "test/unit/foo.test.ts", testName: "should pass" }],
    };
    const finding = makeFinding({
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "should pass",
      file: "test/unit/foo.test.ts",
      message: "expected true to be false",
    });

    const result = applyBaselineDispositions([finding], baseline, undefined);
    expect(result[0]?.baselineDisposition).toBe("pre-existing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — captured story baseline with no matching entry → introduced
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — no matching entry (AC9)", () => {
  test("AC9 — captured story baseline with no match → introduced", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      baseRef: "ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "roll-forward",
      entries: [{ file: "test/unit/other.test.ts", testName: "should pass" }],
    };
    const finding = makeFinding({
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "should pass",
      file: "test/unit/foo.test.ts",
      message: "expected true to be false",
    });

    const result = applyBaselineDispositions([finding], baseline, undefined);
    expect(result[0]?.baselineDisposition).toBe("introduced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — file-level entry matches any testName
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — file-level fallback entry (AC10)", () => {
  test("AC10 — entry with file and no testName matches any finding in that file", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      baseRef: "ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "roll-forward",
      entries: [{ file: "test/unit/foo.test.ts" }],
    };
    const finding = makeFinding({
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "any test",
      file: "test/unit/foo.test.ts",
      message: "expected true to be false",
    });

    const result = applyBaselineDispositions([finding], baseline, undefined);
    expect(result[0]?.baselineDisposition).toBe("pre-existing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11 — testName match requires the rule to match too
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — entry with testName but different rule (AC11)", () => {
  test("AC11 — finding with different rule in same file as testName entry → introduced", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      baseRef: "ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "roll-forward",
      entries: [{ file: "test/unit/foo.test.ts", testName: "should pass" }],
    };
    const finding = makeFinding({
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "should handle edge case",
      file: "test/unit/foo.test.ts",
      message: "expected true to be false",
    });

    const result = applyBaselineDispositions([finding], baseline, undefined);
    expect(result[0]?.baselineDisposition).toBe("introduced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC12 — roll-forward match + run baseline miss → earlier-story
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — earlier-story (AC12)", () => {
  test("AC12 — roll-forward match + run baseline miss → earlier-story", () => {
    const storyBaseline: TestBaseline = {
      kind: "captured",
      baseRef: "story-ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "roll-forward",
      entries: [{ file: "test/unit/foo.test.ts", testName: "should pass" }],
    };
    const runBaseline: TestBaseline = {
      kind: "captured",
      baseRef: "run-ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "preflight",
      entries: [], // empty — does not match the finding
    };
    const finding = makeFinding({
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "should pass",
      file: "test/unit/foo.test.ts",
      message: "expected true to be false",
    });

    const result = applyBaselineDispositions([finding], storyBaseline, runBaseline);
    expect(result[0]?.baselineDisposition).toBe("earlier-story");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC13 — roll-forward match + run baseline match → pre-existing
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — both baselines match (AC13)", () => {
  test("AC13 — roll-forward match + run baseline match → pre-existing", () => {
    const storyBaseline: TestBaseline = {
      kind: "captured",
      baseRef: "story-ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "roll-forward",
      entries: [{ file: "test/unit/foo.test.ts", testName: "should pass" }],
    };
    const runBaseline: TestBaseline = {
      kind: "captured",
      baseRef: "run-ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "preflight",
      entries: [{ file: "test/unit/foo.test.ts", testName: "should pass" }],
    };
    const finding = makeFinding({
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "should pass",
      file: "test/unit/foo.test.ts",
      message: "expected true to be false",
    });

    const result = applyBaselineDispositions([finding], storyBaseline, runBaseline);
    expect(result[0]?.baselineDisposition).toBe("pre-existing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC14 — no-baseline marker → every finding unattributed
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — no-baseline marker (AC14)", () => {
  test("AC14 — every finding is unattributed when story baseline is no-baseline", () => {
    const baseline = makeNoBaseline();
    const findings = [
      makeFinding({ file: "test/unit/foo.test.ts", rule: "r1" }),
      makeFinding({ file: "test/unit/bar.test.ts", rule: "r2" }),
    ];

    const result = applyBaselineDispositions(findings, baseline, undefined);
    expect(result.every((f) => f.baselineDisposition === "unattributed")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC15 — undefined story baseline → unattributed
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — undefined story baseline (AC15)", () => {
  test("AC15 — every finding is unattributed when story baseline is undefined", () => {
    const findings = [
      makeFinding({ file: "test/unit/foo.test.ts", rule: "r1" }),
      makeFinding({ file: "test/unit/bar.test.ts", rule: "r2" }),
    ];

    const result = applyBaselineDispositions(findings, undefined, undefined);
    expect(result.every((f) => f.baselineDisposition === "unattributed")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC16 — captured story baseline with zero entries → introduced
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — zero entries (AC16)", () => {
  test("AC16 — captured story baseline with zero entries → every finding introduced", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      baseRef: "ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "preflight",
      entries: [],
    };
    const findings = [
      makeFinding({ file: "test/unit/foo.test.ts", rule: "r1" }),
      makeFinding({ file: "test/unit/bar.test.ts", rule: "r2" }),
    ];

    const result = applyBaselineDispositions(findings, baseline, undefined);
    expect(result.every((f) => f.baselineDisposition === "introduced")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC17 — non-mutation contract
// ─────────────────────────────────────────────────────────────────────────────

describe("applyBaselineDispositions — non-mutation (AC17)", () => {
  test("AC17 — returns a new array of new objects with every original field preserved", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      baseRef: "ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "roll-forward",
      entries: [],
    };
    const finding = makeFinding({
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "should pass",
      file: "test/unit/foo.test.ts",
      line: 42,
      column: 3,
      message: "expected true to be false",
      suggestion: "fix it",
      meta: { trace: "abc" },
    });
    const inputFindings: Finding[] = [finding];
    const inputSnapshot = JSON.parse(JSON.stringify(inputFindings));

    const result = applyBaselineDispositions(inputFindings, baseline, undefined);

    expect(result).not.toBe(inputFindings);
    expect(result[0]).not.toBe(inputFindings[0]);
    expect(result[0]?.source).toBe(finding.source);
    expect(result[0]?.severity).toBe(finding.severity);
    expect(result[0]?.category).toBe(finding.category);
    expect(result[0]?.rule).toBe(finding.rule);
    expect(result[0]?.file).toBe(finding.file);
    expect(result[0]?.line).toBe(finding.line);
    expect(result[0]?.column).toBe(finding.column);
    expect(result[0]?.message).toBe(finding.message);
    expect(result[0]?.suggestion).toBe(finding.suggestion);
    expect(result[0]?.meta).toEqual(finding.meta);
    expect(inputFindings).toEqual(inputSnapshot);
    expect(result).toHaveLength(1);
  });

  test("AC17 — exactly one output finding per input finding", () => {
    const baseline: TestBaseline = {
      kind: "captured",
      baseRef: "ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "roll-forward",
      entries: [],
    };
    const findings: Finding[] = [
      makeFinding({ file: "test/unit/foo.test.ts", rule: "r1" }),
      makeFinding({ file: "test/unit/foo.test.ts", rule: "r2" }),
      makeFinding({ file: "test/unit/bar.test.ts", rule: "r3" }),
    ];

    const result = applyBaselineDispositions(findings, baseline, undefined);
    expect(result).toHaveLength(findings.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC18 — barrel re-exports
// ─────────────────────────────────────────────────────────────────────────────

describe("verification barrel — re-exports (AC18)", () => {
  test("AC18 — every named symbol is callable/importable from the barrel", () => {
    expect(typeof writeRunBaseline).toBe("function");
    expect(typeof readRunBaseline).toBe("function");
    expect(typeof writeStoryBaseline).toBe("function");
    expect(typeof readStoryBaseline).toBe("function");
    expect(typeof resolveStoryBaseline).toBe("function");
    expect(typeof applyBaselineDispositions).toBe("function");
    // Type-only symbols — the import bindings already prove they are exported
    // (a missing name would have been a compile error before this point).
    const _baselineDisposition: BaselineDisposition = "introduced";
    const _baselineEntry: BaselineEntry = { file: "x" };
    const _testBaseline: TestBaseline = { kind: "no-baseline", reason: "timeout", capturedAt: "" };
    expect([_baselineDisposition, _baselineEntry, _testBaseline]).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveStoryBaseline — execution-mode resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveStoryBaseline — execution mode", () => {
  test("returns story artifact in sequential mode when present", async () => {
    const baseline = makeCapturedStoryBaseline();
    await writeStoryBaseline(tempRoot, "feature-1", "US-001", baseline);

    const result = await resolveStoryBaseline(tempRoot, "feature-1", "US-001", "sequential");
    expect(result).toEqual(baseline);
  });

  test("returns story artifact in parallel mode? — see scope: returns run-start baseline in parallel mode", async () => {
    const storyBaseline = makeCapturedStoryBaseline();
    const runBaseline: TestBaseline = {
      kind: "captured",
      baseRef: "run-ref",
      capturedAt: "2026-01-15T00:00:00.000Z",
      source: "preflight",
      entries: [{ file: "test/unit/run.test.ts", testName: "should run" }],
    };
    await writeStoryBaseline(tempRoot, "feature-1", "US-001", storyBaseline);
    await writeRunBaseline(tempRoot, "feature-1", runBaseline);

    // Parallel mode returns the run-start baseline.
    const result = await resolveStoryBaseline(tempRoot, "feature-1", "US-001", "parallel");
    expect(result).toEqual(runBaseline);
  });

  test("returns undefined when neither artifact exists", async () => {
    const result = await resolveStoryBaseline(tempRoot, "feature-x", "US-XYZ", "sequential");
    expect(result).toBeUndefined();
  });
});

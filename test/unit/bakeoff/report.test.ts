/**
 * Tests for src/bakeoff/report.ts and src/bakeoff/coordinator.ts
 * (persistBakeoffResult lives on the coordinator module).
 *
 * Covers:
 *  - AC-5: persistBakeoffResult writes bakeoff.json with feature,
 *    ranking length, and first-place agent matching the result.
 *  - AC-6: renderBakeoffReport contains each contestant's agent name,
 *    status, storiesPassed/storiesTotal, costUsd, and wallTimeMs, with the
 *    winner row rendered before lower-ranked rows.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _coordinatorDeps, renderBakeoffReport } from "@/bakeoff";
import type { BakeoffCoordinatorDeps, BakeoffResult, ContestantResult } from "@/bakeoff";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<ContestantResult> = {}): ContestantResult {
  return {
    name: "test-contestant",
    agent: "claude",
    status: "passed",
    storiesPassed: 1,
    storiesTotal: 1,
    costUsd: 1,
    wallTimeMs: 100,
    ...overrides,
  };
}

function makeBakeoffResult(overrides: Partial<BakeoffResult> = {}): BakeoffResult {
  return {
    feature: "inline-charts",
    completedAt: new Date().toISOString(),
    outcome: 0,
    ranking: [makeResult({ agent: "claude", storiesPassed: 3 })],
    contestants: [],
    ...overrides,
  };
}

/**
 * Temporarily swap the real `persistBakeoffResult` on `_coordinatorDeps`
 * for the duration of the test, then restore. Mirrors the `_deps` style.
 */
function withCoordinatorPersist<T>(
  fn: () => Promise<T>,
  overrides: Pick<BakeoffCoordinatorDeps, "persistBakeoffResult">,
): Promise<T> {
  const saved = _coordinatorDeps.persistBakeoffResult;
  _coordinatorDeps.persistBakeoffResult = overrides.persistBakeoffResult;
  return fn().finally(() => {
    _coordinatorDeps.persistBakeoffResult = saved;
  });
}

// ── AC-5: persistBakeoffResult writes bakeoff.json correctly ─────────────────

describe("persistBakeoffResult (AC-5: bakeoff.json contents)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join("/tmp", `bakeoff-report-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("AC5: writes bakeoff.json under outputDir with feature, ranking length, and first-place agent matching the result", async () => {
    const result = makeBakeoffResult({
      feature: "inline-charts",
      ranking: [
        makeResult({ agent: "claude", storiesPassed: 3 }),
        makeResult({ agent: "codex", storiesPassed: 2 }),
        makeResult({ agent: "gemini", storiesPassed: 1 }),
      ],
    });

    await withCoordinatorPersist(async () => {
      // The implementation must be wired into _coordinatorDeps by the
      // implementer in the next session. The call site is fixed; here we
      // observe that calling through _coordinatorDeps.persistBakeoffResult
      // produces the expected file.
      await _coordinatorDeps.persistBakeoffResult(result, tempDir);
    }, { persistBakeoffResult: _coordinatorDeps.persistBakeoffResult });

    const jsonPath = join(tempDir, "bakeoff.json");
    expect(existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      feature: string;
      ranking: ContestantResult[];
    };
    expect(parsed.feature).toBe("inline-charts");
    expect(parsed.ranking).toHaveLength(3);
    expect(parsed.ranking[0].agent).toBe("claude");
  });

  // Boundary: when the bake-off wrote no winners (ranking length 0), the
  // file must still exist and the feature must round-trip correctly.
  it("AC5 (boundary): persists even with an empty ranking array", async () => {
    const result = makeBakeoffResult({ feature: "empty-feature", ranking: [] });

    await withCoordinatorPersist(async () => {
      await _coordinatorDeps.persistBakeoffResult(result, tempDir);
    }, { persistBakeoffResult: _coordinatorDeps.persistBakeoffResult });

    const jsonPath = join(tempDir, "bakeoff.json");
    expect(existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      feature: string;
      ranking: ContestantResult[];
    };
    expect(parsed.feature).toBe("empty-feature");
    expect(parsed.ranking).toEqual([]);
  });
});

// ── AC-6: renderBakeoffReport ────────────────────────────────────────────────

describe("renderBakeoffReport (AC-6: terminal table contents + ordering)", () => {
  it("AC6: returns a string containing each contestant's agent, status, storiesPassed/storiesTotal, costUsd, and wallTimeMs, with the winner row before lower-ranked rows", () => {
    const winner = makeResult({
      agent: "claude",
      status: "passed",
      storiesPassed: 3,
      storiesTotal: 3,
      costUsd: 0.5,
      wallTimeMs: 120000,
    });
    const runner = makeResult({
      agent: "codex",
      status: "passed",
      storiesPassed: 2,
      storiesTotal: 3,
      costUsd: 1.0,
      wallTimeMs: 200000,
    });

    const report = renderBakeoffReport(makeBakeoffResult({ ranking: [winner, runner] }));

    expect(typeof report).toBe("string");

    // Each contestant must be identifiable
    expect(report).toContain("claude");
    expect(report).toContain("codex");

    // Status visible for every contestant
    expect(report).toContain("passed");

    // Per-contestant stats visible — storiesPassed/Total pair, cost, wallTime
    expect(report).toContain("3/3");
    expect(report).toContain("2/3");
    expect(report).toContain("0.5");
    expect(report).toContain("1.0");
    expect(report).toContain("120000");
    expect(report).toContain("200000");

    // Winner row appears before lower-ranked row
    expect(report.indexOf("claude")).toBeLessThan(report.indexOf("codex"));
  });

  // Boundary: DNF statuses must still render their identifying fields,
  // and ranking[0] still defines "winner" for layout purposes.
  it("AC6 (boundary): renders DNF statuses and keeps ranking[0] first", () => {
    const first = makeResult({
      agent: "claude",
      status: "dnf-crashed",
      storiesPassed: 0,
      storiesTotal: 5,
      costUsd: 0,
      wallTimeMs: 50,
    });
    const second = makeResult({
      agent: "codex",
      status: "dnf-not-installed",
      storiesPassed: 0,
      storiesTotal: 5,
      costUsd: 0,
      wallTimeMs: 30,
    });

    const report = renderBakeoffReport(makeBakeoffResult({ ranking: [first, second] }));

    expect(report).toContain("dnf-crashed");
    expect(report).toContain("dnf-not-installed");
    expect(report.indexOf("claude")).toBeLessThan(report.indexOf("codex"));
  });
});
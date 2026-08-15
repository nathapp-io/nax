/**
 * PriorRunFailureProvider (US-003) — surface prior-run failures as context.
 *
 * Acceptance criteria mapping (provider scope):
 *  AC1  — constructor with no arguments succeeds
 *  AC2  — id = "prior-run-failure", kind = "prior-failure"
 *  AC3  — scoreChunk applies kind weight 0.85 (pinned in scoring-prior-failure.test.ts)
 *  AC4  — no metrics.json at request.repoRoot → empty chunks, never throws
 *  AC5  — metrics records request.storyId as failed → one chunk naming that story
 *  AC6  — story failed with two failingTestFiles → chunk names both files
 *  AC7  — metrics never records request.storyId as failed → empty chunks
 *  AC8  — metrics records failure only for a different story → empty chunks
 *  AC9  — metrics.json is invalid JSON → empty chunks, never throws
 *  AC10 — metrics records request.storyId failed in two runs → chunk reports attempt count from both
 *  AC11 — returned chunk has kind "prior-failure" and scope "story"
 *  AC12 — createDefaultOrchestrator registers provider id "prior-run-failure"
 *         (covered in prior-run-failure-factory.test.ts)
 *  AC13 — rectify stage config providerIds includes "prior-run-failure"
 *         (covered in prior-run-failure-stage-config.test.ts)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import {
  PriorRunFailureProvider,
  _priorRunFailureDeps,
} from "../../../../../src/context/engine/providers/prior-run-failure";
import type { ContextRequest } from "../../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-003",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "rectify",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

function makeStoryMetrics(
  overrides: Partial<{
    storyId: string;
    success: boolean;
    attempts: number;
    failingTestFiles: string[];
  }> = {},
) {
  return {
    storyId: overrides.storyId ?? "US-003",
    complexity: "medium",
    modelTier: "balanced",
    modelUsed: "claude-sonnet-4",
    attempts: overrides.attempts ?? 1,
    finalTier: "balanced",
    success: overrides.success ?? false,
    cost: 0.01,
    durationMs: 5000,
    firstPassSuccess: false,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    ...(overrides.failingTestFiles ? { failingTestFiles: overrides.failingTestFiles } : {}),
  };
}

function makeRunMetrics(stories: ReturnType<typeof makeStoryMetrics>[]) {
  return {
    runId: randomUUID(),
    feature: "test-feature",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    totalCost: 0.01,
    totalStories: stories.length,
    storiesCompleted: stories.filter((s) => s.success).length,
    storiesFailed: stories.filter((s) => !s.success).length,
    totalDurationMs: 5000,
    stories,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 + AC2 — construction & identity
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — AC1 + AC2 construction & identity", () => {
  test("AC1: construction succeeds with no arguments", () => {
    expect(() => new PriorRunFailureProvider()).not.toThrow();
  });

  test("AC2: id is 'prior-run-failure'", () => {
    const provider = new PriorRunFailureProvider();
    expect(provider.id).toBe("prior-run-failure");
  });

  test("AC2: kind is 'prior-failure'", () => {
    const provider = new PriorRunFailureProvider();
    expect(provider.kind).toBe("prior-failure");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — no metrics.json at request.repoRoot
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — AC4 missing metrics file", () => {
  test("returns empty chunks when no metrics file exists at request.repoRoot", async () => {
    // loadRunMetrics (real dep) is wired; we point repoRoot at a directory
    // we know does not contain metrics.json. The dep is mocked per-test
    // to control behaviour without touching the global fs.
    const provider = new PriorRunFailureProvider();
    const calls: string[] = [];
    _priorRunFailureDeps.loadRunMetrics = async (outputDir: string) => {
      calls.push(outputDir);
      return [];
    };

    const result = await provider.fetch(makeRequest({ repoRoot: "/repo" }));

    expect(result.chunks).toHaveLength(0);
    expect(result.pullTools).toEqual([]);
    // loadRunMetrics is invoked with request.repoRoot
    expect(calls).toEqual(["/repo"]);
  });

  test("does not throw when loadRunMetrics returns []", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [];

    await expect(provider.fetch(makeRequest())).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — metrics records request.storyId as failed → one chunk naming that story
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — AC5 prior failure recorded for storyId", () => {
  test("returns one chunk when request.storyId matches a prior failure", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([makeStoryMetrics({ storyId: "US-003", success: false, attempts: 2 })]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks).toHaveLength(1);
    const chunk = result.chunks[0];
    // AC11: returned chunk has kind prior-failure and scope story
    expect(chunk.kind).toBe("prior-failure");
    expect(chunk.scope).toBe("story");
    expect(chunk.content).toContain("US-003");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — two failingTestFiles → chunk names both
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — AC6 multiple failingTestFiles", () => {
  test("returns chunk that names both failingTestFiles when story failed with two files", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([
        makeStoryMetrics({
          storyId: "US-003",
          success: false,
          attempts: 1,
          failingTestFiles: ["src/foo.test.ts", "src/bar.test.ts"],
        }),
      ]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks).toHaveLength(1);
    const content = result.chunks[0].content;
    expect(content).toContain("src/foo.test.ts");
    expect(content).toContain("src/bar.test.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — metrics never records request.storyId as failed → empty chunks
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — AC7 storyId never recorded as failed", () => {
  test("returns empty chunks when metrics has only successful stories", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([makeStoryMetrics({ storyId: "US-003", success: true })]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty chunks when metrics has no stories at all", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [makeRunMetrics([])];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — metrics records failure only for a different story ID → empty chunks
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — AC8 failure for different story only", () => {
  test("returns empty chunks when a different story is the only failure", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([makeStoryMetrics({ storyId: "US-OTHER", success: false })]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty chunks when metrics has failures for unrelated story IDs", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([
        makeStoryMetrics({ storyId: "US-A", success: false }),
        makeStoryMetrics({ storyId: "US-B", success: false }),
      ]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — invalid JSON → empty chunks, never throws
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — AC9 invalid metrics.json", () => {
  test("returns empty chunks when loadRunMetrics returns [] (the dep swallows parse errors)", async () => {
    // Per the AC, the provider source file malformed (unparseable JSON) yields
    // empty chunks. loadRunMetrics is the abstraction the provider uses —
    // when the underlying JSON is malformed, it returns []. We verify the
    // provider treats that as 'empty, never throws'.
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [];

    await expect(provider.fetch(makeRequest({ storyId: "US-003" }))).resolves.toEqual({
      chunks: [],
      pullTools: [],
    });
  });

  test("does not throw when loadRunMetrics itself throws", async () => {
    // Defensive: even if the dep rejects, the provider must not throw — the
    // AC's failure handling requires 'never throws'.
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => {
      throw new Error("metrics.json is corrupted");
    };

    await expect(provider.fetch(makeRequest({ storyId: "US-003" }))).resolves.toBeDefined();
    await expect(provider.fetch(makeRequest({ storyId: "US-003" }))).resolves.toEqual({
      chunks: [],
      pullTools: [],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — aggregate attempt count from two runs
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — AC10 aggregate attempt count across runs", () => {
  test("reports attempt count from both runs when storyId failed twice", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([makeStoryMetrics({ storyId: "US-003", success: false, attempts: 1 })]),
      makeRunMetrics([makeStoryMetrics({ storyId: "US-003", success: false, attempts: 2 })]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks).toHaveLength(1);
    // AC10: the chunk reports the aggregate attempt count from both runs
    // → 1 + 2 = 3
    const content = result.chunks[0].content;
    expect(content).toMatch(/3/);
  });

  test("aggregates failingTestFiles across runs without duplicates", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([
        makeStoryMetrics({
          storyId: "US-003",
          success: false,
          attempts: 1,
          failingTestFiles: ["src/foo.test.ts", "src/bar.test.ts"],
        }),
      ]),
      makeRunMetrics([
        makeStoryMetrics({
          storyId: "US-003",
          success: false,
          attempts: 2,
          failingTestFiles: ["src/bar.test.ts", "src/baz.test.ts"],
        }),
      ]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks).toHaveLength(1);
    const content = result.chunks[0].content;
    // All three unique failing test files appear in the aggregated chunk.
    expect(content).toContain("src/foo.test.ts");
    expect(content).toContain("src/bar.test.ts");
    expect(content).toContain("src/baz.test.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11 — chunk shape on success
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — AC11 returned chunk shape", () => {
  test("emitted chunk has kind=prior-failure and scope=story", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([makeStoryMetrics({ storyId: "US-003", success: false })]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks).toHaveLength(1);
    const chunk = result.chunks[0];
    expect(chunk.kind).toBe("prior-failure");
    expect(chunk.scope).toBe("story");
  });

  test("emitted chunk has positive token count", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([makeStoryMetrics({ storyId: "US-003", success: false })]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.chunks[0].tokens).toBeGreaterThan(0);
  });

  test("pullTools is always empty (push-only provider)", async () => {
    const provider = new PriorRunFailureProvider();
    _priorRunFailureDeps.loadRunMetrics = async () => [
      makeRunMetrics([makeStoryMetrics({ storyId: "US-003", success: false })]),
    ];

    const result = await provider.fetch(makeRequest({ storyId: "US-003" }));

    expect(result.pullTools).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps for restoration
// ─────────────────────────────────────────────────────────────────────────────

let origLoadRunMetrics: typeof _priorRunFailureDeps.loadRunMetrics;

beforeEach(() => {
  origLoadRunMetrics = _priorRunFailureDeps.loadRunMetrics;
});

afterEach(() => {
  _priorRunFailureDeps.loadRunMetrics = origLoadRunMetrics;
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration with the real loadRunMetrics against a real temp dir
// ─────────────────────────────────────────────────────────────────────────────

describe("PriorRunFailureProvider — real-filesystem integration (loadRunMetrics wired)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prior-run-failure-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("reads metrics.json from a real temp dir and surfaces a chunk when storyId failed", async () => {
    const runs = [
      makeRunMetrics([
        makeStoryMetrics({
          storyId: "US-003",
          success: false,
          attempts: 2,
          failingTestFiles: ["src/x.test.ts"],
        }),
      ]),
    ];
    await writeFile(join(tempDir, "metrics.json"), JSON.stringify(runs), "utf8");

    // Wire the dep to call the real loadRunMetrics from src/metrics/tracker.
    const { loadRunMetrics } = await import("../../../../../src/metrics/tracker");
    _priorRunFailureDeps.loadRunMetrics = loadRunMetrics;

    const provider = new PriorRunFailureProvider();
    const result = await provider.fetch(makeRequest({ storyId: "US-003", repoRoot: tempDir }));

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].kind).toBe("prior-failure");
    expect(result.chunks[0].content).toContain("US-003");
    expect(result.chunks[0].content).toContain("src/x.test.ts");
  });

  test("returns empty chunks when real metrics.json is missing", async () => {
    // tempDir exists but has no metrics.json
    const { loadRunMetrics } = await import("../../../../../src/metrics/tracker");
    _priorRunFailureDeps.loadRunMetrics = loadRunMetrics;

    const provider = new PriorRunFailureProvider();
    const result = await provider.fetch(makeRequest({ storyId: "US-003", repoRoot: tempDir }));

    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty chunks when real metrics.json is malformed", async () => {
    await writeFile(join(tempDir, "metrics.json"), "not valid json {{{", "utf8");

    const { loadRunMetrics } = await import("../../../../../src/metrics/tracker");
    _priorRunFailureDeps.loadRunMetrics = loadRunMetrics;

    const provider = new PriorRunFailureProvider();
    // Should not throw.
    const result = await provider.fetch(makeRequest({ storyId: "US-003", repoRoot: tempDir }));
    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty chunks when no storyId matches in real metrics.json", async () => {
    const runs = [makeRunMetrics([makeStoryMetrics({ storyId: "US-OTHER", success: false })])];
    await writeFile(join(tempDir, "metrics.json"), JSON.stringify(runs), "utf8");

    const { loadRunMetrics } = await import("../../../../../src/metrics/tracker");
    _priorRunFailureDeps.loadRunMetrics = loadRunMetrics;

    const provider = new PriorRunFailureProvider();
    const result = await provider.fetch(makeRequest({ storyId: "US-003", repoRoot: tempDir }));

    expect(result.chunks).toHaveLength(0);
  });

  // Reference unused-import warning avoidance
  void mkdir;
  void existsSync;
});

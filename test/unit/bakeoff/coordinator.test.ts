/**
 * Tests for src/bakeoff/coordinator.ts
 *
 * Covers AC-1, AC-2, AC-3, AC-4, AC-7, AC-8, AC-9 of the "Bake-off
 * coordinator, reporting, persistence, and run-command wiring" story.
 *
 * The CLI wiring branch (AC-10, AC-11) lives in
 * `test/unit/bakeoff/run-action.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  _coordinatorDeps,
  rankContestants,
  runBakeoff,
} from "@/bakeoff";
import type { BakeoffCoordinatorDeps, BakeoffOptions, BakeoffResult, ContestantResult } from "@/bakeoff";
import type { NaxConfig } from "@/config";

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

function baseOptions(overrides: Partial<BakeoffOptions> = {}): BakeoffOptions {
  return {
    agents: ["claude", "codex"],
    feature: "test-feature",
    projectRoot: "/tmp/proj",
    outputDir: "/tmp/out",
    config: {} as unknown as NaxConfig,
    ...overrides,
  };
}

/**
 * Replace `_coordinatorDeps` with the supplied overrides for the duration of
 * the callback. Mirrors the pattern used by other bake-off tests.
 */
async function withCoordinatorDeps<T>(
  overrides: Partial<BakeoffCoordinatorDeps>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = (_coordinatorDeps as Record<string, unknown>)[key];
  }
  Object.assign(_coordinatorDeps, overrides);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      (_coordinatorDeps as Record<string, unknown>)[key] = saved[key];
    }
  }
}

// ── AC-1: Sequential contestant execution ────────────────────────────────────

describe("runBakeoff (AC-1: sequential execution)", () => {
  it("AC1: starts the second runContestant call only after the first resolves", async () => {
    const callOrder: Array<{ agent: string; startedAt: number; resolvedAt: number }> = [];

    const runContestantSpy = mock(async (agent: string) => {
      const startedAt = Date.now();
      await new Promise((r) => setTimeout(r, 15));
      const resolvedAt = Date.now();
      callOrder.push({ agent, startedAt, resolvedAt });
      return makeResult({ agent });
    });

    await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: runContestantSpy as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions()),
    );

    expect(callOrder).toHaveLength(2);
    expect(callOrder[0].agent).toBe("claude");
    expect(callOrder[1].agent).toBe("codex");
    expect(callOrder[1].startedAt).toBeGreaterThanOrEqual(callOrder[0].resolvedAt);
  });

  // Boundary: a single contestant must still flow through the coordinator
  // (no parallel/coalescing short-circuits that would skip the resolver).
  it("AC1 (boundary): a single validated contestant still resolves sequentially", async () => {
    const order: string[] = [];
    const runContestantSpy = mock(async (agent: string) => {
      order.push(`start:${agent}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${agent}`);
      return makeResult({ agent });
    });

    await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: runContestantSpy as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions({ agents: ["claude"] })),
    );

    expect(order).toEqual(["start:claude", "end:claude"]);
  });
});

// ── AC-2: Validation failure aborts before any runContestant call ─────────────

describe("runBakeoff (AC-2: validation failure)", () => {
  it("AC2: does not invoke runContestant and resolves with a non-zero outcome when pre-flight fails", async () => {
    const runContestantSpy = mock(async (agent: string) => makeResult({ agent }));

    const result = await withCoordinatorDeps(
      {
        validateContestants: ((_names: string[]) => ({
          errors: [{ agent: "bogus", reason: "unknown-agent" }],
          validAgents: [],
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: runContestantSpy as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions({ agents: ["bogus"] })),
    );

    expect(runContestantSpy).not.toHaveBeenCalled();
    expect(result.outcome).not.toBe(0);
  });

  // Boundary: validation failure still returns a BakeoffResult with no
  // contestants and an empty ranking — never throws to the caller.
  it("AC2 (boundary): validation failure returns a BakeoffResult (no throw) with empty ranking", async () => {
    const result = await withCoordinatorDeps(
      {
        validateContestants: ((_names: string[]) => ({
          errors: [{ agent: "bogus", reason: "unknown-agent" }],
          validAgents: [],
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: mock(async (agent: string) => makeResult({ agent })) as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions({ agents: ["bogus"] })),
    );

    expect(result.ranking).toEqual([]);
    expect(result.outcome).not.toBe(0);
  });
});

// ── AC-3: Exactly one runContestant call per validated agent ─────────────────

describe("runBakeoff (AC-3: one runContestant call per validated agent)", () => {
  it("AC3: calls runContestant exactly once per validated agent", async () => {
    const captured: Array<{ agent: string; feature: string }> = [];
    const runContestantSpy = mock(async (agent: string, opts: { feature: string }) => {
      captured.push({ agent, feature: opts.feature });
      return makeResult({ agent });
    });

    await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: runContestantSpy as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions({ feature: "my-feature" })),
    );

    expect(runContestantSpy).toHaveBeenCalledTimes(2);
    expect(captured[0].agent).toBe("claude");
    expect(captured[1].agent).toBe("codex");
    expect(captured.every((c) => c.feature === "my-feature")).toBe(true);
  });

  // Boundary: when validateContestants narrows the list (e.g. drops one
  // unknown agent), only the validated subset must be invoked.
  it("AC3 (boundary): only the validated subset is passed to runContestant", async () => {
    const captured: string[] = [];
    const runContestantSpy = mock(async (agent: string) => {
      captured.push(agent);
      return makeResult({ agent });
    });

    await withCoordinatorDeps(
      {
        validateContestants: ((_names: string[]) => ({
          errors: [],
          validAgents: ["claude"],
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: runContestantSpy as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions({ agents: ["claude", "codex"] })),
    );

    expect(runContestantSpy).toHaveBeenCalledTimes(1);
    expect(captured).toEqual(["claude"]);
  });
});

// ── AC-4: rankContestants called with the full result array; ranking matches ─

describe("runBakeoff (AC-4: ranking wiring)", () => {
  it("AC4: passes the full results array to rankContestants and returns a BakeoffResult whose ranking equals its return value", async () => {
    const claudeResult = makeResult({ agent: "claude", storiesPassed: 2 });
    const codexResult = makeResult({ agent: "codex", storiesPassed: 1 });
    const rankSpy = mock((results: ContestantResult[]) => rankContestants(results));

    const result = await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: mock(async (agent: string) =>
          agent === "claude" ? claudeResult : codexResult,
        ) as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants: rankSpy,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions()),
    );

    expect(rankSpy).toHaveBeenCalledTimes(1);
    const spyArg = rankSpy.mock.calls[0][0] as ContestantResult[];
    expect(spyArg.some((r) => r.agent === "claude")).toBe(true);
    expect(spyArg.some((r) => r.agent === "codex")).toBe(true);
    expect(result.ranking).toEqual(rankSpy.mock.results[0].value);
  });

  // Boundary: rankContestants may reorder contestants — BakeoffResult.ranking
  // must mirror its output verbatim, not the input order.
  it("AC4 (boundary): BakeoffResult.ranking follows rankContestants' return value, not the input order", async () => {
    const lower = makeResult({ agent: "codex", storiesPassed: 1 });
    const higher = makeResult({ agent: "claude", storiesPassed: 3 });

    const result = await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: mock(async (agent: string) =>
          agent === "claude" ? higher : lower,
        ) as unknown as BakeoffCoordinatorDeps["runContestant"],
        // Force a specific ordering so we can observe that ranking mirrors
        // rankContestants rather than the input collection order.
        rankContestants: (() => [lower, higher]) as unknown as BakeoffCoordinatorDeps["rankContestants"],
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions()),
    );

    expect(result.ranking[0].agent).toBe("codex");
    expect(result.ranking[1].agent).toBe("claude");
  });
});

// ── AC-7: Fail-open across DNF contestants ───────────────────────────────────

describe("runBakeoff (AC-7: fail-open across DNF contestants)", () => {
  it("AC7: still invokes later contestants when an earlier contestant resolves to a DNF status", async () => {
    const runContestantSpy = mock(async (agent: string) =>
      makeResult({
        agent,
        status: agent === "claude" ? "dnf-crashed" : "passed",
        storiesPassed: agent === "claude" ? 0 : 2,
      }),
    );

    const result = await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: runContestantSpy as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions()),
    );

    expect(runContestantSpy).toHaveBeenCalledTimes(2);
    expect(result.ranking).toHaveLength(2);
    expect(result.ranking.some((r) => r.agent === "claude")).toBe(true);
    expect(result.ranking.some((r) => r.agent === "codex")).toBe(true);
  });

  // Boundary: a DNF mid-sequence must not abort later contestants — every
  // validated contestant still appears in the final ranking.
  it("AC7 (boundary): every validated contestant appears in the ranking, including the one after the DNF", async () => {
    const result = await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: mock(async (agent: string) =>
          makeResult({
            agent,
            status: agent === "claude" ? "dnf-crashed" : "passed",
            storiesPassed: agent === "claude" ? 0 : 3,
          }),
        ) as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions()),
    );

    const agents = result.ranking.map((r) => r.agent);
    expect(agents).toContain("claude");
    expect(agents).toContain("codex");
    expect(result.ranking).toHaveLength(2);
  });
});

// ── AC-8: All-DNF still persists and signals non-zero outcome ────────────────

describe("runBakeoff (AC-8: all-DNF persistence + non-zero outcome)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join("/tmp", `bakeoff-coord-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("AC8: persists bakeoff.json, returns BakeoffResult with all contestants, and signals a non-zero outcome when every contestant DNFs", async () => {
    const allDnf: ContestantResult[] = [
      makeResult({ agent: "claude", status: "dnf-crashed", storiesPassed: 0 }),
      makeResult({ agent: "codex", status: "dnf-not-installed", storiesPassed: 0 }),
    ];

    const result = await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: mock(async (agent: string) => allDnf.find((d) => d.agent === agent)!) as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        // Use real write semantics so the file actually exists on disk.
        persistBakeoffResult: async (r: BakeoffResult, dir: string) => {
          await import("node:fs/promises").then((m) => m.writeFile(join(dir, "bakeoff.json"), JSON.stringify(r), "utf8"));
        },
      },
      () => runBakeoff(baseOptions({ outputDir: tempDir })),
    );

    // bakeoff.json must exist on disk after the run
    const jsonPath = join(tempDir, "bakeoff.json");
    const { existsSync } = await import("node:fs");
    expect(existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as BakeoffResult;

    // BakeoffResult contains all contestants
    expect(result.ranking).toHaveLength(allDnf.length);
    expect(parsed.ranking).toHaveLength(allDnf.length);

    // Outcome signals non-zero
    expect(result.outcome).not.toBe(0);
  });

  // Boundary: with a single contestant that DNFs, outcome is still non-zero
  // and ranking still contains that one contestant.
  it("AC8 (boundary): single-DNF bake-off persists + signals non-zero", async () => {
    const result = await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: mock(async (agent: string) =>
          makeResult({ agent, status: "dnf-crashed", storiesPassed: 0 }),
        ) as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: async (r: BakeoffResult, dir: string) => {
          await import("node:fs/promises").then((m) => m.writeFile(join(dir, "bakeoff.json"), JSON.stringify(r), "utf8"));
        },
      },
      () => runBakeoff(baseOptions({ agents: ["claude"], outputDir: tempDir })),
    );

    expect(result.ranking).toHaveLength(1);
    expect(result.ranking[0].status).toBe("dnf-crashed");
    expect(result.outcome).not.toBe(0);
  });
});

// ── AC-9: At least one finisher → zero outcome ───────────────────────────────

describe("runBakeoff (AC-9: at-least-one-finisher zero outcome)", () => {
  it("AC9: signals a zero exit outcome when at least one contestant finishes and a report is produced", async () => {
    const result = await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: mock(async (agent: string) =>
          makeResult({
            agent,
            status: agent === "claude" ? "passed" : "dnf-crashed",
          }),
        ) as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions()),
    );

    expect(result.outcome).toBe(0);
  });

  // Boundary: every contestant passes → outcome is still 0 (zero is not a
  // "no finisher" signal — it is a "all is well" signal).
  it("AC9 (boundary): all-pass bake-off signals outcome === 0", async () => {
    const result = await withCoordinatorDeps(
      {
        validateContestants: ((names: string[]) => ({
          errors: [],
          validAgents: names,
        })) as BakeoffCoordinatorDeps["validateContestants"],
        runContestant: mock(async (agent: string) =>
          makeResult({ agent, status: "passed", storiesPassed: 3 }),
        ) as unknown as BakeoffCoordinatorDeps["runContestant"],
        rankContestants,
        persistBakeoffResult: mock(async () => {}),
      },
      () => runBakeoff(baseOptions()),
    );

    expect(result.outcome).toBe(0);
  });
});
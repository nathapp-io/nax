import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  assertCompareAgentExclusive,
  computeWorstCaseCost,
  parseCompareList,
  persistBakeoffResult,
  rankContestants,
  renderBakeoffReport,
  runBakeoff,
  runContestant,
  validateContestants,
  _bakeoffCliDeps,
} from "../../../src/bakeoff";
import type { BakeoffResult, ContestantResult } from "../../../src/bakeoff";
import { NaxError } from "../../../src/errors";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<ContestantResult> = {}): ContestantResult {
  return {
    agent: "claude",
    status: "passed",
    storiesPassed: 1,
    storiesTotal: 1,
    costUsd: 1,
    wallTimeMs: 100,
    tierEscalations: 0,
    reviewFindings: 0,
    ...overrides,
  };
}

function makeValidateDeps(installed: string[] = ["claude", "codex", "gemini", "opencode"]) {
  return { isInstalled: (b: string) => installed.includes(b) };
}

function makeWorktreeDeps() {
  return {
    create: mock(async (_root: string, _id: string) => "/tmp/wt"),
    remove: mock(async (_root: string, _id: string) => undefined),
  };
}

const baseOpts = {
  feature: "feat",
  projectRoot: "/tmp/proj",
  outputDir: "/tmp/out",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: {} as any,
};

// ─── US-001: Types and ranking ────────────────────────────────────────────────

describe("US-001: rankContestants", () => {
  test("AC-1: importing rankContestants from @/bakeoff succeeds; accepts ContestantResult[] and returns ContestantResult[] of same length", () => {
    const input: ContestantResult[] = [makeResult()];
    const result = rankContestants(input);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(input.length);
    for (const item of result) {
      expect(typeof item.agent).toBe("string");
      expect(typeof item.storiesPassed).toBe("number");
      expect(typeof item.costUsd).toBe("number");
      expect(typeof item.wallTimeMs).toBe("number");
    }
  });

  test("AC-2: higher storiesPassed ranks first regardless of costUsd", () => {
    const result = rankContestants([
      makeResult({ storiesPassed: 3, costUsd: 9, wallTimeMs: 100 }),
      makeResult({ storiesPassed: 2, costUsd: 1, wallTimeMs: 100 }),
    ]);
    expect(result[0]?.storiesPassed).toBe(3);
  });

  test("AC-3: equal storiesPassed — lower costUsd ranks first", () => {
    const result = rankContestants([
      makeResult({ storiesPassed: 2, costUsd: 1, wallTimeMs: 100 }),
      makeResult({ storiesPassed: 2, costUsd: 2, wallTimeMs: 100 }),
    ]);
    expect(result[0]?.costUsd).toBe(1);
  });

  test("AC-4: equal storiesPassed and costUsd — lower wallTimeMs ranks first", () => {
    const result = rankContestants([
      makeResult({ storiesPassed: 2, costUsd: 1, wallTimeMs: 200 }),
      makeResult({ storiesPassed: 2, costUsd: 1, wallTimeMs: 100 }),
    ]);
    expect(result[0]?.wallTimeMs).toBe(100);
  });

  test("AC-5: finisher (status passed) ranks above DNF regardless of DNF cost or time", () => {
    const result = rankContestants([
      makeResult({ status: "dnf-crashed", storiesPassed: 0, costUsd: 0.01, wallTimeMs: 100 }),
      makeResult({ status: "passed", storiesPassed: 1, costUsd: 100, wallTimeMs: 10000 }),
    ]);
    expect(result[0]?.status).toBe("passed");
  });

  test("AC-6: all-DNF input returns array of length 2 ordered by costUsd ascending, no exception", () => {
    expect(() => {
      const result = rankContestants([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeResult({ status: "dnf-crashed", storiesPassed: 0, costUsd: 2, wallTimeMs: 100 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeResult({ status: "dnf-timeout" as any, storiesPassed: 0, costUsd: 1, wallTimeMs: 200 }),
      ]);
      expect(result.length).toBe(2);
      expect(result[0]?.costUsd).toBe(1);
    }).not.toThrow();
  });

  test("AC-7: ContestantResult with no error field — error is undefined and not an own property", () => {
    const result: ContestantResult = {
      agent: "claude",
      status: "passed",
      storiesPassed: 1,
      storiesTotal: 1,
      costUsd: 1,
      wallTimeMs: 100,
      tierEscalations: 0,
      reviewFindings: 0,
    };
    expect(result.error).toBeUndefined();
    expect(Object.keys(result)).not.toContain("error");
  });
});

// ─── US-002: parseCompareList ─────────────────────────────────────────────────

describe("US-002: parseCompareList", () => {
  test("AC-8: parseCompareList('claude, codex ,gemini') returns string[] of length 3 with whitespace trimmed", () => {
    const result = parseCompareList("claude, codex ,gemini");
    expect(result.length).toBe(3);
    expect(result).toContain("claude");
    expect(result).toContain("codex");
    expect(result).toContain("gemini");
  });

  test("AC-9: parseCompareList('claude,,') returns string[] of length 1 containing only 'claude'", () => {
    const result = parseCompareList("claude,,");
    expect(result.length).toBe(1);
    expect(result[0]).toBe("claude");
  });
});

// ─── US-002: validateContestants ─────────────────────────────────────────────

describe("US-002: validateContestants", () => {
  test("AC-10: claude and codex with binaries present → no errors, both in validAgents", () => {
    const deps = makeValidateDeps(["claude", "codex"]);
    const result = validateContestants(["claude", "codex"], deps);
    expect(result.errors).toEqual([]);
    expect(result.validAgents).toContain("claude");
    expect(result.validAgents).toContain("codex");
  });

  test("AC-11: unknown agent 'bogus' → errors[0].agent === 'bogus', errors[0].reason === 'unknown-agent'", () => {
    const deps = makeValidateDeps([]);
    const result = validateContestants(["bogus"], deps);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.agent).toBe("bogus");
    expect(result.errors[0]?.reason).toBe("unknown-agent");
  });

  test("AC-12: aider (known name, no ACP adapter) → errors[0].agent === 'aider', reason === 'no-acp-adapter'", () => {
    const deps = makeValidateDeps(["aider"]);
    const result = validateContestants(["aider"], deps);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.agent).toBe("aider");
    expect(result.errors[0]?.reason).toBe("no-acp-adapter");
  });

  test("AC-13: gemini binary absent → errors[0].agent === 'gemini', reason === 'dnf-not-installed'", () => {
    const deps = makeValidateDeps([]); // gemini binary not installed
    const result = validateContestants(["gemini"], deps);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.agent).toBe("gemini");
    expect(result.errors[0]?.reason).toBe("dnf-not-installed");
  });
});

// ─── US-002: assertCompareAgentExclusive ─────────────────────────────────────

describe("US-002: assertCompareAgentExclusive", () => {
  test("AC-14: throws NaxError with code COMPARE_AGENT_EXCLUSIVE and message referencing both --compare and --agent", () => {
    let thrown: unknown;
    try {
      assertCompareAgentExclusive({ compare: "claude", agent: "codex" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NaxError);
    const naxErr = thrown as NaxError;
    expect(naxErr.code).toBe("COMPARE_AGENT_EXCLUSIVE");
    expect(naxErr.message).toContain("--compare");
    expect(naxErr.message).toContain("--agent");
  });
});

// ─── US-002: computeWorstCaseCost ────────────────────────────────────────────

describe("US-002: computeWorstCaseCost", () => {
  test("AC-15: computeWorstCaseCost(3, 5) returns 15", () => {
    expect(computeWorstCaseCost(3, 5)).toBe(15);
  });
});

// ─── US-003: runContestant ────────────────────────────────────────────────────

describe("US-003: runContestant", () => {
  test("AC-16: resolves to ContestantResult with agent equal to requested agent name after successful pipeline", async () => {
    const worktreeManager = makeWorktreeDeps();
    const pipeline = mock(async () => ({
      results: [{ status: "passed" }],
      metrics: [{ cost: 1, durationMs: 100, attempts: 1 }],
    }));
    const result = await runContestant("claude", baseOpts, { worktreeManager, pipeline });
    expect(result.agent).toBe("claude");
  });

  test("AC-17: create called before pipeline, remove called after even when pipeline throws", async () => {
    const order: string[] = [];
    const worktreeManager = {
      create: mock(async (_r: string, _id: string) => { order.push("create"); return "/tmp/wt"; }),
      remove: mock(async (_r: string, _id: string) => { order.push("remove"); }),
    };
    const pipeline = mock(async () => { order.push("pipeline-throw"); throw new Error("fail"); });

    const result = await runContestant("claude", baseOpts, { worktreeManager, pipeline });

    expect(result.status).toBe("dnf-crashed");
    expect(worktreeManager.create).toHaveBeenCalledTimes(1);
    expect(worktreeManager.remove).toHaveBeenCalledTimes(1);
    expect(order.indexOf("create")).toBeLessThan(order.indexOf("pipeline-throw"));
    expect(order.indexOf("pipeline-throw")).toBeLessThan(order.indexOf("remove"));
  });

  test("AC-18: config passed to pipeline has agent.default === agent and agent.fallback.enabled === false", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedConfig: any = null;
    const worktreeManager = makeWorktreeDeps();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline = mock(async (config: any) => {
      capturedConfig = config;
      return { results: [{ status: "passed" }], metrics: [] };
    });

    await runContestant("claude", baseOpts, { worktreeManager, pipeline });

    expect(capturedConfig?.agent?.default).toBe("claude");
    expect(capturedConfig?.agent?.fallback?.enabled).toBe(false);
  });

  test("AC-19: all 5 stories passing → status passed, storiesPassed === 5, storiesTotal === 5", async () => {
    const worktreeManager = makeWorktreeDeps();
    const pipeline = mock(async () => ({
      results: Array.from({ length: 5 }, () => ({ status: "passed" })),
      metrics: Array.from({ length: 5 }, () => ({ cost: 1, durationMs: 100, attempts: 1 })),
    }));

    const result = await runContestant("claude", { ...baseOpts, storiesTotal: 5 }, { worktreeManager, pipeline });

    expect(result.status).toBe("passed");
    expect(result.storiesPassed).toBe(5);
    expect(result.storiesTotal).toBe(5);
  });

  test("AC-20: at least one story not passed → status failed", async () => {
    const worktreeManager = makeWorktreeDeps();
    const pipeline = mock(async () => ({
      results: [{ status: "passed" }, { status: "failed" }],
      metrics: [],
    }));

    const result = await runContestant("claude", baseOpts, { worktreeManager, pipeline });

    expect(result.status).toBe("failed");
  });

  test("AC-21: pipeline throws → status dnf-crashed, error is non-empty string, no re-throw", async () => {
    const worktreeManager = makeWorktreeDeps();
    const pipeline = mock(async () => { throw new Error("mid-run failure"); });

    const result = await runContestant("claude", baseOpts, { worktreeManager, pipeline });

    expect(result.status).toBe("dnf-crashed");
    expect(typeof result.error).toBe("string");
    expect((result.error as string).length).toBeGreaterThan(0);
  });

  test("AC-22: pipeline returns costLimitReached true → status cost-limit", async () => {
    const worktreeManager = makeWorktreeDeps();
    const pipeline = mock(async () => ({
      results: [],
      metrics: [],
      costLimitReached: true,
    }));

    const result = await runContestant("claude", baseOpts, { worktreeManager, pipeline });

    expect(result.status).toBe("cost-limit");
  });

  test("AC-23: costUsd === sum of metric costs, wallTimeMs === sum of metric durations, tierEscalations >= 0", async () => {
    const worktreeManager = makeWorktreeDeps();
    const pipeline = mock(async () => ({
      results: [{ status: "passed" }, { status: "passed" }],
      metrics: [
        { cost: 100, durationMs: 5000, attempts: 1 },
        { cost: 200, durationMs: 3000, attempts: 3 },
      ],
    }));

    const result = await runContestant("claude", baseOpts, { worktreeManager, pipeline });

    expect(result.costUsd).toBe(300);
    expect(result.wallTimeMs).toBe(8000);
    expect(result.tierEscalations).toBeGreaterThanOrEqual(0);
  });

  test("AC-24: pipeline returns status timeout → result.status === 'timeout'", async () => {
    const worktreeManager = makeWorktreeDeps();
    const pipeline = mock(async () => ({
      results: [],
      metrics: [],
      status: "timeout",
    }));

    const result = await runContestant("claude", baseOpts, { worktreeManager, pipeline });

    expect(result.status).toBe("timeout");
  });
});

// ─── US-004: runBakeoff coordinator ──────────────────────────────────────────

type BakeoffDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validateContestants?: (agents: string[], deps: any) => { errors: Array<{ agent: string; reason: string }>; validAgents: string[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runContestant?: (agent: string, options: any, deps: any) => Promise<ContestantResult>;
  rankContestants?: (results: ContestantResult[]) => ContestantResult[];
  persistBakeoffResult?: (result: BakeoffResult, outputDir: string) => Promise<void>;
};

const bakeoffOpts = {
  agents: ["claude", "codex"],
  feature: "test-feature",
  projectRoot: "/tmp/proj",
  outputDir: "/tmp/out",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: {} as any,
};

describe("US-004: runBakeoff sequential execution and coordination", () => {
  test("AC-25: second contestant starts only after first contestant resolves (sequential execution)", async () => {
    const callTimestamps: Array<{ startMs: number; resolveMs: number }> = [];

    const runContestantSpy = mock(async (agent: string) => {
      const startMs = Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      const resolveMs = Date.now();
      callTimestamps.push({ startMs, resolveMs });
      return makeResult({ agent });
    });

    await runBakeoff(bakeoffOpts, {
      validateContestants: () => ({ errors: [], validAgents: ["claude", "codex"] }),
      runContestant: runContestantSpy as unknown as BakeoffDeps["runContestant"],
      rankContestants,
      persistBakeoffResult: mock(async () => {}),
    } as BakeoffDeps);

    expect(callTimestamps.length).toBe(2);
    expect(callTimestamps[1]!.startMs).toBeGreaterThanOrEqual(callTimestamps[0]!.resolveMs);
  });

  test("AC-26: validation failure prevents runContestant call; outcome is non-zero", async () => {
    const runContestantSpy = mock(async (agent: string) => makeResult({ agent }));

    const result = await runBakeoff({ ...bakeoffOpts, agents: ["bogus"] }, {
      validateContestants: () => ({
        errors: [{ agent: "bogus", reason: "unknown-agent" }],
        validAgents: [],
      }),
      runContestant: runContestantSpy as unknown as BakeoffDeps["runContestant"],
      rankContestants,
      persistBakeoffResult: mock(async () => {}),
    } as BakeoffDeps);

    expect(runContestantSpy).not.toHaveBeenCalled();
    expect(result.outcome).not.toBe(0);
  });

  test("AC-27: runContestant called exactly once per validated agent with correct agent and feature", async () => {
    const captured: Array<{ agent: string; feature: string }> = [];
    const runContestantSpy = mock(async (agent: string, opts: { feature: string }) => {
      captured.push({ agent, feature: opts.feature });
      return makeResult({ agent });
    });

    await runBakeoff({ ...bakeoffOpts, feature: "my-feature" }, {
      validateContestants: () => ({ errors: [], validAgents: ["claude", "codex"] }),
      runContestant: runContestantSpy as unknown as BakeoffDeps["runContestant"],
      rankContestants,
      persistBakeoffResult: mock(async () => {}),
    } as BakeoffDeps);

    expect(runContestantSpy).toHaveBeenCalledTimes(2);
    expect(captured[0]?.agent).toBe("claude");
    expect(captured[1]?.agent).toBe("codex");
    expect(captured.every((c) => c.feature === "my-feature")).toBe(true);
  });

  test("AC-28: rankContestants receives all collected results; BakeoffResult.ranking equals its return value", async () => {
    const claudeResult = makeResult({ agent: "claude", storiesPassed: 2 });
    const codexResult = makeResult({ agent: "codex", storiesPassed: 1 });
    const rankSpy = mock((results: ContestantResult[]) => rankContestants(results));

    const bakeoffResult = await runBakeoff(bakeoffOpts, {
      validateContestants: () => ({ errors: [], validAgents: ["claude", "codex"] }),
      runContestant: mock(async (agent: string) => (agent === "claude" ? claudeResult : codexResult)) as unknown as BakeoffDeps["runContestant"],
      rankContestants: rankSpy,
      persistBakeoffResult: mock(async () => {}),
    } as BakeoffDeps);

    expect(rankSpy).toHaveBeenCalledTimes(1);
    const spyArg = rankSpy.mock.calls[0]![0] as ContestantResult[];
    expect(spyArg.some((r) => r.agent === "claude")).toBe(true);
    expect(spyArg.some((r) => r.agent === "codex")).toBe(true);
    expect(bakeoffResult.ranking).toEqual(rankSpy.mock.results[0]?.value);
  });
});

// ─── US-004: persistBakeoffResult ────────────────────────────────────────────

describe("US-004: persistBakeoffResult", () => {
  test("AC-29: writes bakeoff.json whose parsed contents match feature, ranking length, and winner agent", async () => {
    const outputDir = join("/tmp", `bakeoff-ac29-${randomUUID()}`);
    mkdirSync(outputDir, { recursive: true });
    try {
      await persistBakeoffResult(
        {
          feature: "inline-charts",
          createdAt: new Date().toISOString(),
          ranking: [makeResult({ agent: "claude", storiesPassed: 3 })],
        },
        outputDir,
      );

      const jsonPath = join(outputDir, "bakeoff.json");
      expect(existsSync(jsonPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as { feature: string; ranking: ContestantResult[] };
      expect(parsed.feature).toBe("inline-charts");
      expect(parsed.ranking.length).toBe(1);
      expect(parsed.ranking[0]?.agent).toBe("claude");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

// ─── US-004: renderBakeoffReport ─────────────────────────────────────────────

describe("US-004: renderBakeoffReport", () => {
  test("AC-30: returns string containing each contestant's details; winner appears before lower-ranked contestants", () => {
    const winner = makeResult({ agent: "claude", status: "passed", storiesPassed: 3, storiesTotal: 3, costUsd: 0.5, wallTimeMs: 120000 });
    const runner = makeResult({ agent: "codex", status: "passed", storiesPassed: 2, storiesTotal: 3, costUsd: 1.0, wallTimeMs: 200000 });

    const report = renderBakeoffReport({
      feature: "test-feature",
      createdAt: new Date().toISOString(),
      ranking: [winner, runner],
    });

    expect(typeof report).toBe("string");
    expect(report).toContain("claude");
    expect(report).toContain("codex");
    expect(report).toContain("passed");
    expect(report.indexOf("claude")).toBeLessThan(report.indexOf("codex"));
  });
});

// ─── US-004: runBakeoff failure modes ────────────────────────────────────────

describe("US-004: runBakeoff failure modes", () => {
  test("AC-31: crashed contestant + normal contestant — both in ranking, runContestant called twice", async () => {
    const runContestantSpy = mock(async (agent: string) =>
      makeResult({ agent, status: agent === "claude" ? "dnf-crashed" : "passed", storiesPassed: agent === "claude" ? 0 : 2 }),
    );

    const result = await runBakeoff(bakeoffOpts, {
      validateContestants: () => ({ errors: [], validAgents: ["claude", "codex"] }),
      runContestant: runContestantSpy as unknown as BakeoffDeps["runContestant"],
      rankContestants,
      persistBakeoffResult: mock(async () => {}),
    } as BakeoffDeps);

    expect(runContestantSpy).toHaveBeenCalledTimes(2);
    expect(result.ranking.length).toBe(2);
    expect(result.ranking.some((r) => r.agent === "claude")).toBe(true);
    expect(result.ranking.some((r) => r.agent === "codex")).toBe(true);
  });

  test("AC-32: all-DNF — bakeoff.json still exists, ranking has all entries, outcome non-zero", async () => {
    const outputDir = join("/tmp", `bakeoff-ac32-${randomUUID()}`);
    mkdirSync(outputDir, { recursive: true });
    try {
      const allDnf = [
        makeResult({ agent: "claude", status: "dnf-crashed", storiesPassed: 0 }),
        makeResult({ agent: "codex", status: "dnf-timeout" as ContestantResult["status"], storiesPassed: 0 }),
      ];

      const result = await runBakeoff({ ...bakeoffOpts, outputDir }, {
        validateContestants: () => ({ errors: [], validAgents: ["claude", "codex"] }),
        runContestant: mock(async (agent: string) => allDnf.find((d) => d.agent === agent)!) as unknown as BakeoffDeps["runContestant"],
        rankContestants,
        // Use real persistBakeoffResult so file is actually written
        persistBakeoffResult: async (r: BakeoffResult, dir: string) => {
          await persistBakeoffResult(r, dir);
        },
      } as BakeoffDeps);

      expect(existsSync(join(outputDir, "bakeoff.json"))).toBe(true);
      expect(result.ranking.length).toBe(allDnf.length);
      expect(result.outcome).not.toBe(0);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("AC-33: at least one non-DNF contestant → outcome === 0", async () => {
    const result = await runBakeoff(bakeoffOpts, {
      validateContestants: () => ({ errors: [], validAgents: ["claude", "codex"] }),
      runContestant: mock(async (agent: string) =>
        makeResult({ agent, status: agent === "claude" ? "passed" : "dnf-crashed" }),
      ) as unknown as BakeoffDeps["runContestant"],
      rankContestants,
      persistBakeoffResult: mock(async () => {}),
    } as BakeoffDeps);

    expect(result.outcome).toBe(0);
  });
});

// ─── US-004: CLI routing ──────────────────────────────────────────────────────

describe("US-004: CLI routing", () => {
  test("AC-34: --compare routes to runBakeoff; singleAgentRun is not called", async () => {
    const origRunBakeoff = _bakeoffCliDeps.runBakeoff;
    const origRunSingleAgent = _bakeoffCliDeps.runSingleAgent;

    const runBakeoffSpy = mock(async () => ({ feature: "f", createdAt: "", ranking: [], outcome: 0 }));
    const singleAgentRunSpy = mock(async () => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _bakeoffCliDeps.runBakeoff = runBakeoffSpy as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _bakeoffCliDeps.runSingleAgent = singleAgentRunSpy as any;

    try {
      await _bakeoffCliDeps.handleRunAction({
        compare: "claude,codex",
        feature: "test-feature",
        projectRoot: "/tmp",
        outputDir: "/tmp/out",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: {} as any,
      });

      expect(runBakeoffSpy).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callArg = (runBakeoffSpy.mock.calls[0] as any[])[0] as { agents: string[]; feature: string };
      expect(callArg.agents).toEqual(["claude", "codex"]);
      expect(callArg.feature).toBe("test-feature");
      expect(singleAgentRunSpy).not.toHaveBeenCalled();
    } finally {
      _bakeoffCliDeps.runBakeoff = origRunBakeoff;
      _bakeoffCliDeps.runSingleAgent = origRunSingleAgent;
    }
  });

  test("AC-35: no --compare flag routes to singleAgentRun; runBakeoff is not called", async () => {
    const origRunBakeoff = _bakeoffCliDeps.runBakeoff;
    const origRunSingleAgent = _bakeoffCliDeps.runSingleAgent;

    const runBakeoffSpy = mock(async () => ({ feature: "f", createdAt: "", ranking: [], outcome: 0 }));
    const singleAgentRunSpy = mock(async () => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _bakeoffCliDeps.runBakeoff = runBakeoffSpy as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _bakeoffCliDeps.runSingleAgent = singleAgentRunSpy as any;

    try {
      await _bakeoffCliDeps.handleRunAction({
        feature: "test-feature",
        projectRoot: "/tmp",
        outputDir: "/tmp/out",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: {} as any,
      });

      expect(singleAgentRunSpy).toHaveBeenCalledTimes(1);
      expect(runBakeoffSpy).not.toHaveBeenCalled();
    } finally {
      _bakeoffCliDeps.runBakeoff = origRunBakeoff;
      _bakeoffCliDeps.runSingleAgent = origRunSingleAgent;
    }
  });
});
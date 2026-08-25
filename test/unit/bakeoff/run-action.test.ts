/**
 * Tests for src/bakeoff/coordinator.ts — `handleRunAction` dispatch.
 *
 * Covers AC-10 and AC-11 of the "Bake-off coordinator, reporting,
 * persistence, and run-command wiring" story:
 *
 *  - AC-10: when --compare is provided, handleRunAction routes to
 *    runBakeoff with the parsed contestant list and does not invoke
 *    the single-agent runner.
 *  - AC-11: when --compare is absent, handleRunAction routes to the
 *    single-agent runner and does not invoke runBakeoff.
 *
 * Contract drift (US-004): handleRunAction now calls the injected
 * `assertPrdCommitted` guard before dispatching to runBakeoff. Tests below
 * that exercise the --compare path but predate the guard override it with a
 * no-op so they keep asserting dispatch behavior without needing a real git
 * fixture — the guard's own behavior is covered separately (AC-1/AC-8/AC-9/AC-10).
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { BakeoffCliDeps, BakeoffResult, ContestantRunnerDeps, HandleRunActionOptions } from "@/bakeoff";
import { _bakeoffCliDeps, handleRunAction, pipeline, runBakeoff, runContestant } from "@/bakeoff";
import type { NaxConfig } from "@/config";

function baseOptions(overrides: Partial<HandleRunActionOptions> = {}): HandleRunActionOptions {
  return {
    feature: "test-feature",
    projectRoot: "/tmp/proj",
    outputDir: "/tmp/out",
    config: makeNaxConfig(),
    ...overrides,
  };
}

function withCliDeps<T>(overrides: Partial<BakeoffCliDeps>, fn: () => Promise<T>): Promise<T> {
  const saved = { ..._bakeoffCliDeps };
  Object.assign(_bakeoffCliDeps, overrides);
  return fn().finally(() => {
    Object.assign(_bakeoffCliDeps, saved);
  });
}

describe("handleRunAction (AC-10: --compare routes to runBakeoff)", () => {
  afterEach(() => {
    // Reset to defaults — `_bakeoffCliDeps.runBakeoff` is the real
    // (currently stub) function, but tests overwrite it.
  });

  it("AC10: routes to runBakeoff with the parsed contestant list and does not call runSingleAgent", async () => {
    const expected: BakeoffResult = {
      feature: "test-feature",
      completedAt: new Date().toISOString(),
      outcome: 0,
      ranking: [],
      contestants: [],
    };

    const runBakeoffSpy = mock(async (_opts: Parameters<BakeoffCliDeps["runBakeoff"]>[0]) => expected);
    const runSingleAgentSpy = mock(async () => undefined);

    await withCliDeps(
      {
        runBakeoff: runBakeoffSpy,
        runSingleAgent: runSingleAgentSpy,
        assertPrdCommitted: async () => undefined,
      },
      () =>
        handleRunAction(
          baseOptions({
            compare: "claude,codex",
          }),
        ),
    );

    expect(runBakeoffSpy).toHaveBeenCalledTimes(1);
    const callArg = runBakeoffSpy.mock.calls[0][0];
    expect(callArg.agents).toEqual(["claude", "codex"]);
    expect(callArg.feature).toBe("test-feature");
    expect(runSingleAgentSpy).not.toHaveBeenCalled();
  });

  // Boundary: extra whitespace in the compare flag is normalised before the
  // dispatch reaches runBakeoff, matching parseCompareList's behaviour.
  it("AC10 (boundary): trims whitespace from --compare list before forwarding to runBakeoff", async () => {
    const runBakeoffSpy = mock(async (_opts: Parameters<BakeoffCliDeps["runBakeoff"]>[0]) => ({
      feature: "test-feature",
      completedAt: "",
      outcome: 0,
      ranking: [],
      contestants: [],
    }));
    const runSingleAgentSpy = mock(async () => undefined);

    await withCliDeps(
      {
        runBakeoff: runBakeoffSpy,
        runSingleAgent: runSingleAgentSpy,
        assertPrdCommitted: async () => undefined,
      },
      () =>
        handleRunAction(
          baseOptions({
            compare: "claude, codex ,gemini",
          }),
        ),
    );

    expect(runBakeoffSpy).toHaveBeenCalledTimes(1);
    const callArg = runBakeoffSpy.mock.calls[0][0];
    expect(callArg.agents).toEqual(["claude", "codex", "gemini"]);
    expect(runSingleAgentSpy).not.toHaveBeenCalled();
  });

  // maxCostUsd threads through to runBakeoff for per-contestant enforcement
  // (the CLI already confirms N × max-cost before calling handleRunAction).
  it("forwards maxCostUsd from options to runBakeoff", async () => {
    const runBakeoffSpy = mock(async (_opts: Parameters<BakeoffCliDeps["runBakeoff"]>[0]) => ({
      feature: "test-feature",
      completedAt: "",
      outcome: 0,
      ranking: [],
      contestants: [],
    }));
    const runSingleAgentSpy = mock(async () => undefined);

    await withCliDeps(
      {
        runBakeoff: runBakeoffSpy,
        runSingleAgent: runSingleAgentSpy,
        assertPrdCommitted: async () => undefined,
      },
      () => handleRunAction(baseOptions({ compare: "claude,codex", maxCostUsd: 5 })),
    );

    const callArg = runBakeoffSpy.mock.calls[0][0];
    expect(callArg.maxCostUsd).toBe(5);
  });
});

describe("handleRunAction (AC-11: no --compare routes to runSingleAgent)", () => {
  it("AC11: routes to runSingleAgent when --compare is absent and does not call runBakeoff", async () => {
    const runBakeoffSpy = mock(async () => ({
      feature: "test-feature",
      completedAt: "",
      outcome: 0,
      ranking: [],
      contestants: [],
    }));
    const runSingleAgentSpy = mock(async () => undefined);

    await withCliDeps(
      {
        runBakeoff: runBakeoffSpy,
        runSingleAgent: runSingleAgentSpy,
      },
      () => handleRunAction(baseOptions()),
    );

    expect(runSingleAgentSpy).toHaveBeenCalledTimes(1);
    expect(runBakeoffSpy).not.toHaveBeenCalled();
  });

  // Boundary: when --compare is an empty string after trimming, the
  // dispatch must still take the single-agent path (not the bake-off path
  // with an empty contestant list).
  it("AC11 (boundary): empty --compare string still routes to runSingleAgent", async () => {
    const runBakeoffSpy = mock(async () => ({
      feature: "test-feature",
      completedAt: "",
      outcome: 0,
      ranking: [],
      contestants: [],
    }));
    const runSingleAgentSpy = mock(async () => undefined);

    await withCliDeps(
      {
        runBakeoff: runBakeoffSpy,
        runSingleAgent: runSingleAgentSpy,
      },
      () => handleRunAction(baseOptions({ compare: "   " })),
    );

    expect(runSingleAgentSpy).toHaveBeenCalledTimes(1);
    expect(runBakeoffSpy).not.toHaveBeenCalled();
  });
});

describe("handleRunAction (US-003 AC1: pipeline adapter invocation count)", () => {
  it("AC1: invokes the pipeline adapter exactly twice for two resolvable profiles", async () => {
    let pipelineCallCount = 0;
    const spyDeps: ContestantRunnerDeps = {
      worktreeManager: {
        create: async () => undefined,
        remove: async () => undefined,
      },
      pipeline: async (ctx) => {
        pipelineCallCount++;
        // Route through the real pipeline adapter under test so a spy
        // wrapper doesn't silently diverge from production wiring.
        try {
          return await pipeline(ctx);
        } catch {
          return { results: [], metrics: [] };
        }
      },
    };

    const stubbedRunBakeoff: BakeoffCliDeps["runBakeoff"] = (options) =>
      runBakeoff(options, {
        validateContestants: async () => ({
          validAgents: ["profile-a", "profile-b"],
          errors: [],
          profileData: {},
        }),
        runContestant: (agent, contestantOptions) => runContestant(agent, contestantOptions, spyDeps),
        persistBakeoffResult: async () => undefined,
      });

    await withCliDeps({ runBakeoff: stubbedRunBakeoff, assertPrdCommitted: async () => undefined }, () =>
      handleRunAction(
        baseOptions({
          compare: "profile-a,profile-b",
        }),
      ),
    );

    expect(pipelineCallCount).toBe(2);
  });
});

describe("handleRunAction (US-004 AC1, AC10: PRD-tracking guard)", () => {
  it("US-004 AC1: creates no worktree when the PRD-tracking guard rejects a compare invocation", async () => {
    const worktreeCreateSpy = mock(async () => undefined);
    const pipelineSpy = mock(async () => ({ results: [], metrics: [] }));

    const spyDeps: ContestantRunnerDeps = {
      worktreeManager: {
        create: worktreeCreateSpy,
        remove: async () => undefined,
      },
      pipeline: pipelineSpy,
    };

    const stubbedRunBakeoff: BakeoffCliDeps["runBakeoff"] = (options) =>
      runBakeoff(options, {
        validateContestants: async () => ({
          validAgents: ["profile-a"],
          errors: [],
          profileData: {},
        }),
        runContestant: (agent, contestantOptions) => runContestant(agent, contestantOptions, spyDeps),
        persistBakeoffResult: async () => undefined,
      });

    const rejectingGuard = mock(async (prdPath: string) => {
      throw new Error(`prd not committed: ${prdPath}`);
    });

    await expect(
      withCliDeps(
        {
          runBakeoff: stubbedRunBakeoff,
          assertPrdCommitted: rejectingGuard,
        },
        () => handleRunAction(baseOptions({ compare: "profile-a" })),
      ),
    ).rejects.toThrow();

    expect(rejectingGuard).toHaveBeenCalledTimes(1);
    expect(worktreeCreateSpy).not.toHaveBeenCalled();
  });

  it("US-004 AC10: does not invoke the pipeline dependency when the feature PRD is untracked", async () => {
    const pipelineSpy = mock(async () => ({ results: [], metrics: [] }));

    const spyDeps: ContestantRunnerDeps = {
      worktreeManager: {
        create: async () => undefined,
        remove: async () => undefined,
      },
      pipeline: pipelineSpy,
    };

    const stubbedRunBakeoff: BakeoffCliDeps["runBakeoff"] = (options) =>
      runBakeoff(options, {
        validateContestants: async () => ({
          validAgents: ["profile-a"],
          errors: [],
          profileData: {},
        }),
        runContestant: (agent, contestantOptions) => runContestant(agent, contestantOptions, spyDeps),
        persistBakeoffResult: async () => undefined,
      });

    const rejectingGuard = mock(async (prdPath: string) => {
      throw new Error(`prd not committed: ${prdPath}`);
    });

    await expect(
      withCliDeps(
        {
          runBakeoff: stubbedRunBakeoff,
          assertPrdCommitted: rejectingGuard,
        },
        () => handleRunAction(baseOptions({ compare: "profile-a" })),
      ),
    ).rejects.toThrow();

    expect(pipelineSpy).not.toHaveBeenCalled();
  });
});

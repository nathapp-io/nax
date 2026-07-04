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
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { _bakeoffCliDeps, handleRunAction } from "@/bakeoff";
import type { BakeoffCliDeps, BakeoffResult, HandleRunActionOptions } from "@/bakeoff";
import type { NaxConfig } from "@/config";

function baseOptions(overrides: Partial<HandleRunActionOptions> = {}): HandleRunActionOptions {
  return {
    feature: "test-feature",
    projectRoot: "/tmp/proj",
    outputDir: "/tmp/out",
    config: {} as unknown as NaxConfig,
    ...overrides,
  };
}

function withCliDeps<T>(overrides: Partial<BakeoffCliDeps>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = (_bakeoffCliDeps as Record<string, unknown>)[key];
  }
  Object.assign(_bakeoffCliDeps, overrides);
  return fn().finally(() => {
    for (const key of Object.keys(saved)) {
      (_bakeoffCliDeps as Record<string, unknown>)[key] = saved[key];
    }
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

    const runBakeoffSpy = mock(async () => expected);
    const runSingleAgentSpy = mock(async () => undefined);

    await withCliDeps(
      {
        runBakeoff: runBakeoffSpy as unknown as BakeoffCliDeps["runBakeoff"],
        runSingleAgent: runSingleAgentSpy as unknown as BakeoffCliDeps["runSingleAgent"],
      },
      () =>
        handleRunAction(
          baseOptions({
            compare: "claude,codex",
          }),
        ),
    );

    expect(runBakeoffSpy).toHaveBeenCalledTimes(1);
    const callArg = runBakeoffSpy.mock.calls[0][0] as { agents: string[]; feature: string };
    expect(callArg.agents).toEqual(["claude", "codex"]);
    expect(callArg.feature).toBe("test-feature");
    expect(runSingleAgentSpy).not.toHaveBeenCalled();
  });

  // Boundary: extra whitespace in the compare flag is normalised before the
  // dispatch reaches runBakeoff, matching parseCompareList's behaviour.
  it("AC10 (boundary): trims whitespace from --compare list before forwarding to runBakeoff", async () => {
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
        runBakeoff: runBakeoffSpy as unknown as BakeoffCliDeps["runBakeoff"],
        runSingleAgent: runSingleAgentSpy as unknown as BakeoffCliDeps["runSingleAgent"],
      },
      () =>
        handleRunAction(
          baseOptions({
            compare: "claude, codex ,gemini",
          }),
        ),
    );

    expect(runBakeoffSpy).toHaveBeenCalledTimes(1);
    const callArg = runBakeoffSpy.mock.calls[0][0] as { agents: string[] };
    expect(callArg.agents).toEqual(["claude", "codex", "gemini"]);
    expect(runSingleAgentSpy).not.toHaveBeenCalled();
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
        runBakeoff: runBakeoffSpy as unknown as BakeoffCliDeps["runBakeoff"],
        runSingleAgent: runSingleAgentSpy as unknown as BakeoffCliDeps["runSingleAgent"],
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
        runBakeoff: runBakeoffSpy as unknown as BakeoffCliDeps["runBakeoff"],
        runSingleAgent: runSingleAgentSpy as unknown as BakeoffCliDeps["runSingleAgent"],
      },
      () => handleRunAction(baseOptions({ compare: "   " })),
    );

    expect(runSingleAgentSpy).toHaveBeenCalledTimes(1);
    expect(runBakeoffSpy).not.toHaveBeenCalled();
  });
});
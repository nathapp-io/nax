/**
 * #2201: the deferred regression gate dispatches `fullSuiteRectifyOp`, which
 * declares Bash, so its fix-cycle context must carry the ask resolver and the
 * command shadow — and the wiring must be disposed once the story's cycle
 * settles, including when the cycle throws.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeMockRuntime, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { CommandShadow } from "@/command-safety";
import type { StorySnapshot } from "@/execution";
import { _regressionDeps, runDeferredRegression } from "@/execution";
import type { FixCycleContext } from "@/findings";
import type { DispatchAskWiring, RunDispatchAskOptions } from "@/interaction";
import { InteractionChain } from "@/interaction";
import { headlessAskResolver } from "@/permissions";
import type { FlakeTriageInput, FlakeTriageResult, VerificationResult } from "@/verification";

const config = makeNaxConfig({
  quality: { commands: { test: "bun test" } },
  execution: { regressionGate: { mode: "deferred", timeoutSeconds: 60, acceptOnTimeout: true } },
});

const FAILING: VerificationResult = {
  success: false,
  status: "TEST_FAILURE",
  countsTowardEscalation: true,
  output: "fail",
  passCount: 0,
  failCount: 1,
};

const SNAPSHOTS: StorySnapshot[] = [
  { storyId: "US-001", completedAt: "2026-01-01T00:00:00.000Z", failingTestFiles: ["foo.test.ts"] },
];

function fakeWiring(): { wiring: DispatchAskWiring; disposed: () => number } {
  let disposed = 0;
  const shadow: CommandShadow = { observe: () => {}, settle: () => {}, drain: async () => {} };
  return {
    wiring: { askResolver: headlessAskResolver(), commandShadow: shadow, dispose: async () => void disposed++ },
    disposed: () => disposed,
  };
}

let saved: typeof _regressionDeps;
beforeEach(() => {
  saved = { ..._regressionDeps };
  _regressionDeps.triageFlakyFindings = async (input: FlakeTriageInput): Promise<FlakeTriageResult> => ({
    findings: input.findings.map((f) => ({ ...f })),
    quarantineReport: { keys: [], reasons: [] },
  });
  _regressionDeps.runVerification = mock(async () => FAILING);
  _regressionDeps.parseTestOutput = mock(() => ({
    passed: 0,
    failed: 1,
    failures: [{ file: "foo.test.ts", testName: "t", error: "boom", stackTrace: [] }],
  }));
});
afterEach(() => {
  Object.assign(_regressionDeps, saved);
});

describe("runDeferredRegression — rectifier ask wiring (#2201)", () => {
  test("the cycle context carries the resolver and shadow, built with the run's interaction chain", async () => {
    const fake = fakeWiring();
    const built: RunDispatchAskOptions[] = [];
    _regressionDeps.buildRunDispatchAskWiring = async (opts) => {
      built.push(opts);
      return fake.wiring;
    };
    let seen: FixCycleContext | undefined;
    _regressionDeps.runFixCycle = mock(async (_cycle, cycleCtx) => {
      seen = cycleCtx;
      expect(fake.disposed()).toBe(0); // still live while the cycle dispatches
      return { iterations: [], finalFindings: [], exitReason: "resolved" as const, costUsd: 0 };
    });
    const interactionChain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });

    await runDeferredRegression({
      config,
      prd: makePRD({ userStories: [makeStory({ id: "US-001", status: "passed" })] }),
      workdir: "/tmp/test-workdir",
      runtime: makeMockRuntime(),
      storyMetrics: SNAPSHOTS,
      interactionChain,
    });

    expect(seen?.askResolver).toBe(fake.wiring.askResolver);
    expect(seen?.commandShadow).toBe(fake.wiring.commandShadow);
    expect(built[0]).toMatchObject({ interaction: interactionChain, storyId: "US-001", repoRoot: "/tmp/test-workdir" });
    expect(fake.disposed()).toBe(1);
  });

  test("US-005 AC7: the deferred regression gate labels its approval prompts 'review'", async () => {
    const fake = fakeWiring();
    const built: RunDispatchAskOptions[] = [];
    _regressionDeps.buildRunDispatchAskWiring = async (opts) => {
      built.push(opts);
      return fake.wiring;
    };
    _regressionDeps.runFixCycle = mock(async () => ({
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as const,
      costUsd: 0,
    }));

    await runDeferredRegression({
      config,
      prd: makePRD({ userStories: [makeStory({ id: "US-001", status: "passed" })] }),
      workdir: "/tmp/test-workdir",
      runtime: makeMockRuntime(),
      storyMetrics: SNAPSHOTS,
    });

    expect(built).toHaveLength(1);
    expect(built[0]?.stage).toBe("review");
  });

  test("the wiring is disposed even when the fix cycle throws", async () => {
    const fake = fakeWiring();
    _regressionDeps.buildRunDispatchAskWiring = async () => fake.wiring;
    _regressionDeps.runFixCycle = mock(async () => {
      throw new Error("cycle blew up");
    });

    await expect(
      runDeferredRegression({
        config,
        prd: makePRD({ userStories: [makeStory({ id: "US-001", status: "passed" })] }),
        workdir: "/tmp/test-workdir",
        runtime: makeMockRuntime(),
        storyMetrics: SNAPSHOTS,
      }),
    ).rejects.toThrow("cycle blew up");
    expect(fake.disposed()).toBe(1);
  });
});

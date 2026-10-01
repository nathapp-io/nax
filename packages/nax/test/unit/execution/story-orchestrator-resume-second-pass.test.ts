/**
 * Story-Orchestrator — the post-rectification resume's second rectification pass.
 *
 * When a phase fails inside the resume loop, one more rectification pass runs on
 * its findings. That pass must re-judge the phase that triggered it: the fixing
 * strategy's own revalidation set can exclude it (autofix-implementer claims
 * `tdd-verifier` findings but never revalidates the verifier), and then the pass
 * reports "resolved" while the failed output stays stale and the story fails
 * terminally anyway (#2264).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  makeCallOp,
  makeFixCycleResult,
  makeNaxConfig,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";
import { pickSelector } from "@/config";
import { _storyOrchestratorDeps, StoryOrchestratorBuilder } from "@/execution";
import type { Finding } from "@/findings";
import type { CallContext, DeterministicOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("test-resume-second-pass-selector", "execution");
type TestOpConfig = ReturnType<(typeof testSel)["select"]>;

const GATE_FINDING: Finding = {
  source: "test-runner",
  category: "failed-test",
  severity: "error",
  message: "suite failed",
  rule: "test",
  file: "test/foo.test.ts",
};

const VERIFIER_FINDING: Finding = {
  source: "tdd-verifier",
  category: "tests-failing",
  severity: "error",
  message: "verifier rejected",
  fixTarget: "source",
};

/** A deterministic op whose Nth execution returns `results[N]` (the last one repeats). */
function makeSequencedOp(
  name: string,
  results: ReadonlyArray<{ success: boolean; findings?: Finding[] }>,
): { op: DeterministicOperation<unknown, unknown, TestOpConfig>; runs: () => number } {
  let runs = 0;
  const op: DeterministicOperation<unknown, unknown, TestOpConfig> = {
    kind: "deterministic",
    name,
    stage: "verify",
    config: testSel,
    execute: async () => {
      const result = results[Math.min(runs, results.length - 1)];
      runs++;
      return { ...result, estimatedCostUsd: 0 };
    },
  };
  return { op, runs: () => runs };
}

let runtime: NaxRuntime | undefined;
const origCallOp = _storyOrchestratorDeps.callOp;
const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
  await runtime?.close();
  runtime = undefined;
});

/**
 * Gate red then green; the verifier fails the first time the resume loop runs
 * it and returns `verifierRerun` after that. Every fix cycle "resolves"; the
 * second one first runs the lite validate an autofix-implementer pass performs.
 */
async function runResumeScenario(verifierRerun: { success: boolean; findings?: Finding[] }) {
  runtime = makeTestRuntime({ config: makeNaxConfig() });
  const gate = makeSequencedOp("full-suite-gate", [{ success: false, findings: [GATE_FINDING] }, { success: true }]);
  const implementer = makeSequencedOp("mock-implementer", [{ success: true }]);
  const verifier = makeSequencedOp("verifier", [{ success: false, findings: [VERIFIER_FINDING] }, verifierRerun]);

  _storyOrchestratorDeps.callOp = makeCallOp();
  let cycles = 0;
  _storyOrchestratorDeps.runFixCycle = async <F extends Finding>(
    ...[cycle, ctx]: Parameters<typeof origRunFixCycle<F>>
  ) => {
    cycles++;
    if (cycles === 2) await cycle.validate(ctx, { mode: "lite", strategiesRun: ["autofix-implementer"] });
    return makeFixCycleResult<F>({ iterations: [], finalFindings: [], exitReason: "resolved", costUsd: 0 });
  };

  assertDefined(runtime, "runtime");
  const ctx: CallContext = {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-2264",
  };
  const result = await new StoryOrchestratorBuilder()
    .addImplementer({ op: implementer.op, input: {} })
    .addFullSuiteGate({ op: gate.op, input: { story: makeStory({ id: "US-2264" }), workdir: "/tmp" } })
    .addVerifier({ op: verifier.op, input: {} })
    .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
    .build(ctx)
    .run();
  return { result, cycles, verifierRuns: verifier.runs() };
}

describe("post-rectification resume — second rectification pass", () => {
  test("re-judges the phase that triggered it, so a now-passing verifier clears the story", async () => {
    const { result, cycles, verifierRuns } = await runResumeScenario({ success: true });

    expect(cycles).toBe(2);
    expect(verifierRuns).toBe(2);
    expect(result.success).toBe(true);
  });

  test("still fails terminally when the re-judged verifier fails again", async () => {
    const { result, cycles, verifierRuns } = await runResumeScenario({
      success: false,
      findings: [VERIFIER_FINDING],
    });

    expect(cycles).toBe(2);
    expect(verifierRuns).toBe(2);
    expect(result.success).toBe(false);
  });
});

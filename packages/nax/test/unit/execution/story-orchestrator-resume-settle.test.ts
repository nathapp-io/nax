/**
 * Story-Orchestrator — settling a provisional rectification outcome after the
 * post-rectification resume (#2406).
 *
 * A fix cycle that exits "validate-short-circuit" with no remaining findings has
 * not decided anything: it hands the missing phases to the resume loop
 * (`liteScopeIncomplete`). Its `rectification.success: false` is provisional. When
 * the resume then runs every remaining phase green, the outcome must settle to
 * success; otherwise a story whose every gate passed is paused as "requires review".
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
import { settleProvisionalRectification } from "@/execution/story-orchestrator/execution-plan-phases";
import type { Finding } from "@/findings";
import type { CallContext, DeterministicOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("test-resume-settle-selector", "execution");
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

type OpResult = { success: boolean; findings?: Finding[] };

/** A deterministic op whose Nth execution returns `results[N]` (the last one repeats). */
function makeSequencedOp(
  name: string,
  results: ReadonlyArray<OpResult>,
): DeterministicOperation<unknown, unknown, TestOpConfig> {
  let runs = 0;
  return {
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
 * Gate red then green. The first fix cycle exits validate-short-circuit with no
 * findings, so the verifier is left for the resume loop; `verifierResults` scripts
 * its runs there. `laterCycles` scripts any second rectification pass.
 */
async function runShortCircuitScenario(opts: {
  verifierResults: ReadonlyArray<OpResult>;
  laterCycles?: (n: number) => ReturnType<typeof makeFixCycleResult<Finding>>;
}) {
  runtime = makeTestRuntime({ config: makeNaxConfig() });
  _storyOrchestratorDeps.callOp = makeCallOp();
  let cycles = 0;
  _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() => {
    cycles++;
    if (cycles === 1) {
      return makeFixCycleResult<F>({
        iterations: [],
        finalFindings: [],
        exitReason: "validate-short-circuit",
        costUsd: 0,
      });
    }
    const later = opts.laterCycles?.(cycles);
    assertDefined(later, `fix cycle ${cycles} result`);
    return makeFixCycleResult<F>({ ...later, finalFindings: [] });
  };

  assertDefined(runtime, "runtime");
  const ctx: CallContext = {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-2406",
  };
  const result = await new StoryOrchestratorBuilder()
    .addImplementer({ op: makeSequencedOp("mock-implementer", [{ success: true }]), input: {} })
    .addFullSuiteGate({
      op: makeSequencedOp("full-suite-gate", [{ success: false, findings: [GATE_FINDING] }, { success: true }]),
      input: { story: makeStory({ id: "US-2406" }), workdir: "/tmp" },
    })
    .addVerifier({ op: makeSequencedOp("verifier", opts.verifierResults), input: {} })
    .addRectification({ maxAttempts: 3, strategies: [], abortOnIncreasingFailures: false })
    .build(ctx)
    .run();
  return { result, cycles };
}

function rectificationOutput(result: { phaseOutputs: Record<string, unknown> }) {
  return result.phaseOutputs.rectification as { success?: boolean; settledBy?: string } | undefined;
}

describe("provisional rectification outcome (#2406)", () => {
  test("settles to success when the resume runs every remaining phase green", async () => {
    const { result, cycles } = await runShortCircuitScenario({ verifierResults: [{ success: true }] });

    expect(cycles).toBe(1);
    expect(result.liteScopeIncomplete).toBe(true);
    expect(rectificationOutput(result)?.success).toBe(true);
    expect(rectificationOutput(result)?.settledBy).toBe("resume");
    expect(result.success).toBe(true);
  });

  test("stays failed when a resumed phase fails and the second pass is exhausted", async () => {
    const { result, cycles } = await runShortCircuitScenario({
      verifierResults: [{ success: false, findings: [VERIFIER_FINDING] }],
      laterCycles: () => ({
        iterations: [],
        finalFindings: [],
        exitReason: "max-attempts-per-strategy",
        costUsd: 0,
      }),
    });

    expect(cycles).toBe(2);
    expect(rectificationOutput(result)?.success).toBe(false);
    expect(rectificationOutput(result)?.settledBy).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.failedPhases).toEqual(expect.arrayContaining(["verifier", "rectification"]));
  });

  test("stays failed when the second pass itself short-circuits with no findings", async () => {
    const { result, cycles } = await runShortCircuitScenario({
      verifierResults: [{ success: false, findings: [VERIFIER_FINDING] }],
      laterCycles: () => ({ iterations: [], finalFindings: [], exitReason: "validate-short-circuit", costUsd: 0 }),
    });

    expect(cycles).toBe(2);
    expect(rectificationOutput(result)?.settledBy).toBeUndefined();
    expect(result.success).toBe(false);
  });

  test("stays failed when the re-judged phase still fails after a resolved second pass", async () => {
    const { result, cycles } = await runShortCircuitScenario({
      verifierResults: [{ success: false, findings: [VERIFIER_FINDING] }],
      laterCycles: () => ({ iterations: [], finalFindings: [], exitReason: "resolved", costUsd: 0 }),
    });

    expect(cycles).toBe(2);
    expect(rectificationOutput(result)?.settledBy).toBeUndefined();
    expect(result.success).toBe(false);
  });
});

describe("settleProvisionalRectification", () => {
  test("leaves a non-provisional outcome untouched", () => {
    const rectification = { success: false, exitReason: "max-attempts-per-strategy", finalFindingsCount: 0 };
    const phaseOutputs: Record<string, unknown> = { verifier: { success: true }, rectification };

    settleProvisionalRectification(phaseOutputs, "US-2406");

    expect(phaseOutputs.rectification).toBe(rectification);
  });

  test("leaves a provisional outcome failed while another phase output fails", () => {
    const rectification = { success: false, exitReason: "validate-short-circuit", provisional: true };
    const phaseOutputs: Record<string, unknown> = {
      verifier: { success: true },
      "adversarial-review": { passed: false },
      rectification,
    };

    settleProvisionalRectification(phaseOutputs, "US-2406");

    expect(phaseOutputs.rectification).toBe(rectification);
  });

  test("settles a provisional outcome to success when every other phase passes", () => {
    const phaseOutputs: Record<string, unknown> = {
      verifier: { success: true },
      "adversarial-review": { passed: true },
      rectification: { success: false, exitReason: "validate-short-circuit", finalFindingsCount: 0, provisional: true },
    };

    settleProvisionalRectification(phaseOutputs, "US-2406");

    expect(phaseOutputs.rectification).toEqual({
      success: true,
      exitReason: "validate-short-circuit",
      finalFindingsCount: 0,
      settledBy: "resume",
    });
  });
});

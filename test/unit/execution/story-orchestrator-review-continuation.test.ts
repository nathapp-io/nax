/**
 * Story-Orchestrator Review-Continuation Tests — #1666 Parts A & B
 *
 * Split out of story-orchestrator.test.ts (already at its grandfathered
 * file-size baseline — see .claude/rules/project-conventions.md) rather than
 * appended to it, per test-architecture.md's "split by describe block" rule.
 *
 * Covers:
 * - Part B: semantic-review failing continues to adversarial-review instead of
 *   short-circuiting, and the story still fails on semantic-review's finding.
 * - Part A: a gate/verifier failure still halts the loop unconditionally (no
 *   general "reviews are exempt" regression), and `missingRequiredReviewPhases`
 *   stays populated so escalation still fires for the upstream-short-circuit case.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  makeAdversarialReviewConfig,
  makeCallOp,
  makeNaxConfig,
  makeSemanticReviewConfig,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";
import { pickSelector } from "@/config";
import { _storyOrchestratorDeps, StoryOrchestratorBuilder } from "@/execution";
import type { CallContext, DeterministicOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("test-review-continuation-selector", "execution");
type TestOpConfig = ReturnType<(typeof testSel)["select"]>;

const mockImplementerOp: RunOperation<{ code: string }, { success: boolean }, TestOpConfig> = {
  kind: "run",
  name: "mock-implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: (input) => ({
    role: { id: "r1", content: "Implement", overridable: false },
    task: { id: "t1", content: input.code, overridable: false },
  }),
  parse: (output) => {
    try {
      return JSON.parse(output);
    } catch {
      return { success: false };
    }
  },
};

function makeDeterministicOp(
  name: string,
  result: { success: boolean; findings?: unknown[] },
): DeterministicOperation<unknown, unknown, TestOpConfig> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: testSel,
    execute: async () => ({ ...result, estimatedCostUsd: 0 }),
  };
}

let runtime: NaxRuntime | undefined;
const origCallOp = _storyOrchestratorDeps.callOp;
afterEach(async () => {
  _storyOrchestratorDeps.callOp = origCallOp;
  await runtime?.close();
  runtime = undefined;
});

function buildCtx(rt: NaxRuntime, storyId: string): CallContext {
  return {
    runtime: rt,
    packageView: rt.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
  };
}

describe("Part B (#1666): semantic-review failure continues to adversarial-review", () => {
  test("adversarial-review DOES run after semantic-review fails, and the story still fails", async () => {
    runtime = makeTestRuntime({ config: makeNaxConfig() });
    const opRunCount: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });

    const semOp = makeDeterministicOp("semantic-review", { success: false, findings: [] });
    const advOp = makeDeterministicOp("adversarial-review", { success: true, findings: [] });
    const story = makeStory({ id: "US-b1" });

    const result = await new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addSemanticReview({
        op: semOp,
        input: { workdir: "/tmp", story, semanticConfig: makeSemanticReviewConfig(), mode: "ref" },
      })
      .addAdversarialReview({
        op: advOp,
        input: { workdir: "/tmp", story, adversarialConfig: makeAdversarialReviewConfig(), mode: "ref" },
      })
      .build(buildCtx(runtime, "US-b1"))
      .run();

    // adversarial-review must run even though semantic-review failed.
    expect(opRunCount["adversarial-review"] ?? 0).toBeGreaterThan(0);
    // Both outputs land in phaseOutputs (rectification still needs both sets of findings).
    expect(result.phaseOutputs["semantic-review"]).toBeDefined();
    expect(result.phaseOutputs["adversarial-review"]).toBeDefined();
    // The story still fails on semantic-review's own finding — Part B changes
    // what runs, not the verdict.
    expect(result.success).toBe(false);
    // Both configured reviews ran, so there is nothing missing to report.
    expect(result.missingRequiredReviewPhases).toBeUndefined();
  });

  test("semantic-review's failure is not silently upgraded to a pass by continuing", async () => {
    runtime = makeTestRuntime({ config: makeNaxConfig() });
    _storyOrchestratorDeps.callOp = makeCallOp();

    const semOp = makeDeterministicOp("semantic-review", { success: false, findings: [] });
    const advOp = makeDeterministicOp("adversarial-review", { success: true, findings: [] });
    const story = makeStory({ id: "US-b2" });

    const result = await new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addSemanticReview({
        op: semOp,
        input: { workdir: "/tmp", story, semanticConfig: makeSemanticReviewConfig(), mode: "ref" },
      })
      .addAdversarialReview({
        op: advOp,
        input: { workdir: "/tmp", story, adversarialConfig: makeAdversarialReviewConfig(), mode: "ref" },
      })
      .build(buildCtx(runtime, "US-b2"))
      .run();

    const semanticOutput = result.phaseOutputs["semantic-review"] as { success?: boolean };
    expect(semanticOutput.success).toBe(false);
    expect(result.success).toBe(false);
  });
});

describe("Part A (#1666): every OTHER phase still halts the loop unconditionally", () => {
  test("full-suite-gate failure still short-circuits before reaching reviews (no rectification configured)", async () => {
    runtime = makeTestRuntime({ config: makeNaxConfig() });
    const opRunCount: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });

    const gateOp = makeDeterministicOp("full-suite-gate", {
      success: false,
      findings: [
        { source: "test-runner", category: "failed-test", severity: "error", message: "f", rule: "r", file: "f.ts" },
      ],
    });
    const semOp = makeDeterministicOp("semantic-review", { success: true, findings: [] });
    const advOp = makeDeterministicOp("adversarial-review", { success: true, findings: [] });
    const story = makeStory({ id: "US-a1" });

    const result = await new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addFullSuiteGate({ op: gateOp, input: { story, workdir: "/tmp" } })
      .addSemanticReview({
        op: semOp,
        input: { workdir: "/tmp", story, semanticConfig: makeSemanticReviewConfig(), mode: "ref" },
      })
      .addAdversarialReview({
        op: advOp,
        input: { workdir: "/tmp", story, adversarialConfig: makeAdversarialReviewConfig(), mode: "ref" },
      })
      .build(buildCtx(runtime, "US-a1"))
      .run();

    // Neither review ran — the gate failure halts unconditionally, no exemption
    // was introduced for phases other than the semantic->adversarial transition.
    expect(opRunCount["semantic-review"] ?? 0).toBe(0);
    expect(opRunCount["adversarial-review"] ?? 0).toBe(0);
    expect(result.success).toBe(false);
    // Still reported so escalation fires (the field itself is unaffected by
    // Part A — only how the *reason* is surfaced changes).
    expect(result.missingRequiredReviewPhases).toEqual(["semantic-review", "adversarial-review"]);
  });

  test("verifier failure still short-circuits before reaching reviews", async () => {
    runtime = makeTestRuntime({ config: makeNaxConfig() });
    const opRunCount: Record<string, number> = {};
    _storyOrchestratorDeps.callOp = makeCallOp({
      onDispatch: (op) => {
        opRunCount[op.name] = (opRunCount[op.name] ?? 0) + 1;
      },
    });

    const verOp = makeDeterministicOp("verifier", { success: false });
    const semOp = makeDeterministicOp("semantic-review", { success: true, findings: [] });
    const advOp = makeDeterministicOp("adversarial-review", { success: true, findings: [] });
    const story = makeStory({ id: "US-a2" });

    const result = await new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addVerifier({ op: verOp, input: { code: "" } })
      .addSemanticReview({
        op: semOp,
        input: { workdir: "/tmp", story, semanticConfig: makeSemanticReviewConfig(), mode: "ref" },
      })
      .addAdversarialReview({
        op: advOp,
        input: { workdir: "/tmp", story, adversarialConfig: makeAdversarialReviewConfig(), mode: "ref" },
      })
      .build(buildCtx(runtime, "US-a2"))
      .run();

    expect(opRunCount["semantic-review"] ?? 0).toBe(0);
    expect(opRunCount["adversarial-review"] ?? 0).toBe(0);
    expect(result.success).toBe(false);
  });
});

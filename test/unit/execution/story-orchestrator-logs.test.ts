/**
 * StoryOrchestrator — beforeRef threading tests
 *
 * Verifies that runPhase decorates TDD slot inputs with a captured git ref
 * before dispatching to callOp.
 *
 * Covers:
 * - Task 4: captureGitRef added to _storyOrchestratorDeps
 * - Task 4: TDD phase inputs decorated with { ...input, beforeRef } before dispatch
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _storyOrchestratorDeps } from "@/execution/story-orchestrator";
import { makeTestRuntime } from "../../helpers";

describe("StoryOrchestrator runPhase — beforeRef threading", () => {
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;

  beforeEach(() => {
    origCallOp = _storyOrchestratorDeps.callOp;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  });

  afterEach(() => {
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  });

  test("decorates TDD slot inputs with captured beforeRef before dispatch", async () => {
    const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");
    const { testWriterOp } = await import("@/operations");

    let capturedInput: unknown;
    _storyOrchestratorDeps.callOp = (async (_ctx: unknown, _op: unknown, input: unknown) => {
      capturedInput = input;
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
    }) as typeof _storyOrchestratorDeps.callOp;

    _storyOrchestratorDeps.captureGitRef = async (_dir: string) => "abc1234";

    const runtime = makeTestRuntime();
    try {
      const builder = new StoryOrchestratorBuilder();
      // addTestWriter accepts an OrchestratorSlot — we supply a minimal TestWriterInput
      // We must also call addImplementer because build() requires it
      const { implementerOp } = await import("@/operations");
      builder.addTestWriter({ op: testWriterOp, input: { story: { id: "US-001" } as any } });
      builder.addImplementer({ op: implementerOp, input: { story: { id: "US-001" } as any } });

      const plan = builder.build({
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp/x",
        agentName: "claude",
        storyId: "US-001",
      });
      await plan.run();

      expect((capturedInput as { beforeRef?: string }).beforeRef).toBe("abc1234");
    } finally {
      await runtime.close();
    }
  });

  test("does not decorate non-TDD phase inputs with beforeRef", async () => {
    const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");
    const { implementerOp, semanticReviewOp } = await import("@/operations");

    const capturedInputs: { opName: string; input: unknown }[] = [];
    _storyOrchestratorDeps.callOp = (async (_ctx: unknown, op: any, input: unknown) => {
      capturedInputs.push({ opName: op.name, input });
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
    }) as typeof _storyOrchestratorDeps.callOp;

    _storyOrchestratorDeps.captureGitRef = async (_dir: string) => "abc1234";

    const runtime = makeTestRuntime();
    try {
      const builder = new StoryOrchestratorBuilder();
      builder.addImplementer({ op: implementerOp, input: { story: { id: "US-001" } as any } });
      builder.addSemanticReview({
        op: semanticReviewOp,
        input: { story: { id: "US-001" } as any },
      });

      const plan = builder.build({
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp/x",
        agentName: "claude",
        storyId: "US-001",
      });
      await plan.run();

      // implementer IS a TDD phase — should have beforeRef
      const implCapture = capturedInputs.find((c) => c.opName === "implementer");
      expect((implCapture?.input as { beforeRef?: string }).beforeRef).toBe("abc1234");

      // semantic-review is NOT a TDD phase — should not have beforeRef
      const reviewCapture = capturedInputs.find((c) => c.opName === "semantic-review");
      expect((reviewCapture?.input as { beforeRef?: string }).beforeRef).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});

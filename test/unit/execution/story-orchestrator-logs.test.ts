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
import { _storyOrchestratorDeps } from "@/execution";
import { getSafeLogger } from "@/logger";
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
    const { StoryOrchestratorBuilder } = await import("@/execution");
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

      const plan = builder.build(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp/x",
          agentName: "claude",
          storyId: "US-001",
        },
        { isThreeSession: true },
      );
      await plan.run();

      expect((capturedInput as { beforeRef?: string }).beforeRef).toBe("abc1234");
    } finally {
      await runtime.close();
    }
  });

  test("does not decorate non-TDD phase inputs with beforeRef", async () => {
    const { StoryOrchestratorBuilder } = await import("@/execution");
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

      const plan = builder.build(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp/x",
          agentName: "claude",
          storyId: "US-001",
        },
        { isThreeSession: true },
      );
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

describe("StoryOrchestrator runPhase — log emission", () => {
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

  test("emits '-> Session: <role>' and 'Session complete: <role>' for TDD phases", async () => {
    const { StoryOrchestratorBuilder } = await import("@/execution");
    const { testWriterOp, implementerOp } = await import("@/operations");

    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: ["test/foo.test.ts"],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "",
    })) as any;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const logs: Array<{ stage: string; msg: string }> = [];
    const logger = getSafeLogger();
    const origInfo = logger!.info;
    logger!.info = ((stage: string, msg: string) => {
      logs.push({ stage, msg });
    }) as any;

    const runtime = makeTestRuntime();
    try {
      const builder = new StoryOrchestratorBuilder();
      builder.addTestWriter({ op: testWriterOp, input: { story: { id: "US-001" } as any } });
      builder.addImplementer({ op: implementerOp, input: { story: { id: "US-001" } as any } });
      const plan = builder.build(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp/x",
          agentName: "claude",
          storyId: "US-001",
        },
        { isThreeSession: true },
      );
      await plan.run();
    } finally {
      logger!.info = origInfo;
      await runtime.close();
    }

    expect(logs.some((l) => l.stage === "tdd" && l.msg === "-> Session: test-writer")).toBe(true);
    expect(logs.some((l) => l.stage === "tdd" && l.msg === "Session complete: test-writer")).toBe(true);
  });

  test("emits 'Created test files' after test-writer with filesChanged count", async () => {
    const { StoryOrchestratorBuilder } = await import("@/execution");
    const { testWriterOp, implementerOp } = await import("@/operations");

    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: ["test/a.test.ts", "test/b.test.ts"],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "",
    })) as any;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const logs: Array<{ stage: string; msg: string; data?: any }> = [];
    const logger = getSafeLogger();
    const origInfo = logger!.info;
    logger!.info = ((stage: string, msg: string, data?: unknown) => {
      logs.push({ stage, msg, data });
    }) as any;

    const runtime = makeTestRuntime();
    try {
      const builder = new StoryOrchestratorBuilder();
      builder.addTestWriter({ op: testWriterOp, input: { story: { id: "US-001" } as any } });
      builder.addImplementer({ op: implementerOp, input: { story: { id: "US-001" } as any } });
      const plan = builder.build(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp/x",
          agentName: "claude",
          storyId: "US-001",
        },
        { isThreeSession: true },
      );
      await plan.run();
    } finally {
      logger!.info = origInfo;
      await runtime.close();
    }

    const createdLog = logs.find((l) => l.stage === "tdd" && l.msg === "Created test files");
    expect(createdLog).toBeDefined();
    expect(createdLog!.data.testFilesCount).toBe(2);
    expect(createdLog!.data.testFiles).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  });

  test("emits 'Isolation maintained' when phase output carries passing isolation", async () => {
    const { StoryOrchestratorBuilder } = await import("@/execution");
    const { testWriterOp, implementerOp } = await import("@/operations");

    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      filesChanged: ["test/a.test.ts"],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "",
      isolation: { passed: true, violations: [], description: "ok" },
    })) as any;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const logs: Array<{ stage: string; msg: string }> = [];
    const logger = getSafeLogger();
    const origInfo = logger!.info;
    logger!.info = ((stage: string, msg: string) => {
      logs.push({ stage, msg });
    }) as any;

    const runtime = makeTestRuntime();
    try {
      const builder = new StoryOrchestratorBuilder();
      builder.addTestWriter({ op: testWriterOp, input: { story: { id: "US-001" } as any } });
      builder.addImplementer({ op: implementerOp, input: { story: { id: "US-001" } as any } });
      const plan = builder.build(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp/x",
          agentName: "claude",
          storyId: "US-001",
        },
        { isThreeSession: true },
      );
      await plan.run();
    } finally {
      logger!.info = origInfo;
      await runtime.close();
    }

    expect(logs.some((l) => l.stage === "tdd" && l.msg === "Isolation maintained")).toBe(true);
  });

  test("single-session strategy (isThreeSession=false) skips TDD logs and beforeRef capture", async () => {
    const { StoryOrchestratorBuilder } = await import("@/execution");
    const { implementerOp } = await import("@/operations");

    let capturedInput: unknown;
    let captureGitRefCalls = 0;
    _storyOrchestratorDeps.callOp = (async (_ctx: unknown, _op: unknown, input: unknown) => {
      capturedInput = input;
      return {
        success: true,
        filesChanged: ["src/foo.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "",
      };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => {
      captureGitRefCalls += 1;
      return "abc1234";
    };

    const logs: Array<{ stage: string; msg: string }> = [];
    const logger = getSafeLogger();
    const origInfo = logger!.info;
    logger!.info = ((stage: string, msg: string) => {
      logs.push({ stage, msg });
    }) as any;

    const runtime = makeTestRuntime();
    try {
      const builder = new StoryOrchestratorBuilder();
      builder.addImplementer({ op: implementerOp, input: { story: { id: "US-001" } as any } });
      // build() defaults to isThreeSession=false — same as the single-session ("no-test") path
      const plan = builder.build({
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp/x",
        agentName: "claude",
        storyId: "US-001",
      });
      await plan.run();
    } finally {
      logger!.info = origInfo;
      await runtime.close();
    }

    // No git ref capture — saves a spawn per phase on the hot path
    expect(captureGitRefCalls).toBe(0);
    // Input dispatched as-is, no beforeRef injected
    expect((capturedInput as { beforeRef?: string }).beforeRef).toBeUndefined();
    // No TDD-stage logs emitted
    expect(logs.some((l) => l.stage === "tdd" && l.msg === "-> Session: implementer")).toBe(false);
    expect(logs.some((l) => l.stage === "tdd" && l.msg === "Session complete: implementer")).toBe(false);
    expect(logs.some((l) => l.stage === "tdd" && l.msg === "Isolation maintained")).toBe(false);
  });
});

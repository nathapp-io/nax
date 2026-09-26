/**
 * runPhase -> commitRedState wiring (spec 2026-09-26-tdd-red-commit-design.md, US-001 ACs 13-16).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeCallOp, makeMockCallContext, makeNaxConfig } from "@test/helpers";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution/story-orchestrator";
import type { RunOperation } from "@/operations";
import type { RedCommitOptions, RedCommitResult } from "@/tdd";

function makeSlot(opName: string): AnySlot {
  const op = {
    kind: "run" as const,
    name: opName,
    stage: "run" as const,
    config: [] as const,
    session: { role: "test-writer" as const, lifetime: "warm" as const },
    build: () => ({
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: "", overridable: false },
    }),
    parse: () => ({}),
  } satisfies RunOperation<unknown, unknown, unknown>;
  return { op, input: {} };
}

const TEST_WRITER_OUTPUT = { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0, output: "" };
const COMMITTED: RedCommitResult = { status: "committed", files: ["test/a.test.ts"], hooksSkipped: true };

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
let origCommitRedState: typeof _storyOrchestratorDeps.commitRedState;

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  origCommitRedState = _storyOrchestratorDeps.commitRedState;
  _storyOrchestratorDeps.callOp = makeCallOp({ fallback: TEST_WRITER_OUTPUT });
  _storyOrchestratorDeps.captureGitRef = async () => "abc123";
});

afterEach(() => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  _storyOrchestratorDeps.commitRedState = origCommitRedState;
});

function spyCommit(result: RedCommitResult = COMMITTED): RedCommitOptions[] {
  const calls: RedCommitOptions[] = [];
  _storyOrchestratorDeps.commitRedState = async (opts: RedCommitOptions) => {
    calls.push(opts);
    return result;
  };
  return calls;
}

describe("runPhase RED commit", () => {
  test("AC13: a passed three-session test-writer phase commits with the phase's own beforeRef", async () => {
    const calls = spyCommit();
    const ctx = makeMockCallContext();
    await runPhase(ctx, makeSlot("test-writer"), {}, {}, true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      workdir: ctx.packageDir,
      beforeRef: "abc123",
      storyId: ctx.storyId,
      hooks: "skip",
    });
  });

  test("AC14: tdd.testWriterCommitHooks 'run' is passed through", async () => {
    const calls = spyCommit();
    const ctx = makeMockCallContext({ config: makeNaxConfig({ tdd: { testWriterCommitHooks: "run" } }) });
    await runPhase(ctx, makeSlot("test-writer"), {}, {}, true);
    expect(calls[0]?.hooks).toBe("run");
  });

  test("AC15: no commit when the phase throws, is not three-session, is a rectification, or is not the test-writer", async () => {
    const calls = spyCommit();
    const ctx = makeMockCallContext();
    await runPhase(ctx, makeSlot("test-writer"), {}, {}, false);
    await runPhase(ctx, makeSlot("test-writer"), {}, {}, true, undefined, true);
    await runPhase(ctx, makeSlot("implementer"), {}, {}, true);
    _storyOrchestratorDeps.callOp = async () => {
      throw new Error("dispatch failed");
    };
    await expect(runPhase(ctx, makeSlot("test-writer"), {}, {}, true)).rejects.toThrow("dispatch failed");
    expect(calls).toHaveLength(0);
  });

  test("AC16: a failed RED commit changes neither the phase's return value nor its phaseOutputs entry", async () => {
    const ctx = makeMockCallContext();
    spyCommit(COMMITTED);
    const okOutputs: Record<string, unknown> = {};
    const okReturn = await runPhase(ctx, makeSlot("test-writer"), {}, okOutputs, true);
    spyCommit({ status: "failed", reason: "x" });
    const failedOutputs: Record<string, unknown> = {};
    const failedReturn = await runPhase(ctx, makeSlot("test-writer"), {}, failedOutputs, true);
    expect(failedReturn).toEqual(okReturn);
    expect(failedOutputs["test-writer"]).toEqual(okOutputs["test-writer"]);
  });
});

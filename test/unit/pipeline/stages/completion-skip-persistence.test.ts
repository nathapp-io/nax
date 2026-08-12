/**
 * Unit tests for skipPrdPersistence gate in completion stage (CR-1)
 *
 * Covers:
 * - savePRD is NOT called when skipPrdPersistence is true (parallel worktree mode)
 * - Story status is NOT mutated to "passed" when skipPrdPersistence is true
 * - savePRD IS called and story IS marked passed when skipPrdPersistence is unset (serial mode)
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { pipelineEventBus } from "../../../../src/pipeline";
import { _completionDeps, completionStage } from "../../../../src/pipeline/stages/completion";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { makeNaxConfig, makePRD, makeStory } from "../../../helpers";
import { makeMockRuntime } from "../../../helpers/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration
// ─────────────────────────────────────────────────────────────────────────────

const origSavePRD = _completionDeps.savePRD;
const origGetDiffText = _completionDeps.getDiffText;
const origCheckReviewGate = _completionDeps.checkReviewGate;
const origSpawn = _completionDeps.spawn;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<PipelineContext>): PipelineContext {
  const story = makeStory({ id: "US-001", status: "in-progress" });
  const prd = makePRD({ userStories: [story] });
  return {
    config: makeNaxConfig(),
    rootConfig: makeNaxConfig(),
    prd,
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp/x",
    projectDir: "/tmp/x",
    prdPath: "/tmp/x/prd.json",
    agentResult: { success: true, estimatedCostUsd: 0.01, output: "", stderr: "", exitCode: 0, rateLimited: false },
    hooks: {} as PipelineContext["hooks"],
    storyStartTime: new Date().toISOString(),
    runtime: makeMockRuntime(),
    ...overrides,
  } as unknown as PipelineContext;
}

afterEach(() => {
  _completionDeps.savePRD = origSavePRD;
  _completionDeps.getDiffText = origGetDiffText;
  _completionDeps.checkReviewGate = origCheckReviewGate;
  _completionDeps.spawn = origSpawn;
});

// ─────────────────────────────────────────────────────────────────────────────
// skipPrdPersistence tests
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage skipPrdPersistence", () => {
  test("does NOT call savePRD when skipPrdPersistence is true", async () => {
    const saveSpy = mock(async () => {});
    _completionDeps.savePRD = saveSpy;
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ skipPrdPersistence: true });

    await completionStage.execute(ctx);

    expect(saveSpy).not.toHaveBeenCalled();
  });

  test("does NOT mutate story status to passed when skipPrdPersistence is true", async () => {
    _completionDeps.savePRD = mock(async () => {});
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ skipPrdPersistence: true });

    await completionStage.execute(ctx);

    // Shared PRD must not be mutated to "passed" by a parallel worktree pipeline
    expect(ctx.prd.userStories[0].status).not.toBe("passed");
  });

  test("calls savePRD and marks story passed when skipPrdPersistence is unset (serial mode)", async () => {
    const saveSpy = mock(async () => {});
    _completionDeps.savePRD = saveSpy;
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({});

    await completionStage.execute(ctx);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(ctx.prd.userStories[0].status).toBe("passed");
  });

  test("still returns { action: continue } when skipPrdPersistence is true", async () => {
    _completionDeps.savePRD = mock(async () => {});
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ skipPrdPersistence: true });

    const result = await completionStage.execute(ctx);

    expect(result.action).toBe("continue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// skipCompletionEvents tests (BUG-36) — a rectification re-run must not
// double-emit story:completed for a story whose worktree pipeline already
// emitted it once, before the merge conflict that triggered rectification.
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage skipCompletionEvents", () => {
  afterEach(() => {
    pipelineEventBus.clear();
  });

  test("does NOT emit story:completed when skipCompletionEvents is true", async () => {
    _completionDeps.savePRD = mock(async () => {});
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ skipPrdPersistence: true, skipCompletionEvents: true });

    const received: unknown[] = [];
    pipelineEventBus.on("story:completed", (ev) => {
      received.push(ev);
    });

    await completionStage.execute(ctx);

    expect(received).toHaveLength(0);
  });

  test("still emits story:completed when skipCompletionEvents is unset (normal worktree pass)", async () => {
    _completionDeps.savePRD = mock(async () => {});
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ skipPrdPersistence: true });

    const received: unknown[] = [];
    pipelineEventBus.on("story:completed", (ev) => {
      received.push(ev);
    });

    await completionStage.execute(ctx);

    expect(received).toHaveLength(1);
  });
});

describe("completionStage bounded stream reading", () => {
  test("getDiffText retains 8,000 characters and drains stderr", async () => {
    const encoder = new TextEncoder();
    let stderrPulls = 0;
    _completionDeps.spawn = (() => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("x".repeat(9_000)));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (stderrPulls++ === 0) controller.enqueue(encoder.encode("warning"));
          else controller.close();
        },
      }),
      exited: Promise.resolve(0),
    })) as unknown as typeof _completionDeps.spawn;

    const output = await _completionDeps.getDiffText("/repo", "base-ref");

    expect(output).toBe("x".repeat(8_000));
    expect(stderrPulls).toBe(2);
  });

  test("retains only the requested prefix while draining the full stream", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const chunks = ["abc", "def", "ghi"];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk) controller.enqueue(encoder.encode(chunk));
        else controller.close();
      },
    });

    const output = await _completionDeps.readTextStreamPrefix(stream, 5);

    expect(output).toBe("abcde");
    expect(pulls).toBe(4);
  });

  test("decodes multibyte characters split across stream chunks", async () => {
    const bytes = new TextEncoder().encode("A😀BC");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });

    const output = await _completionDeps.readTextStreamPrefix(stream, 4);

    expect(output).toBe("A😀B");
  });
});

/**
 * Unit tests for the completion stage's persistence and completion events.
 *
 * Covers:
 * - the story is marked passed in ctx.prd and the PRD is saved once, to ctx.prdPath
 * - exactly one story:completed event is emitted for the story
 * - the bounded stream reading of the `git diff` output
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeSpawn,
  makeSpawnResult,
  makeStory,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline";
import { _completionDeps, completionStage } from "@/pipeline/stages/completion";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD } from "@/prd";
import type { PrdProgressCommitOptions } from "@/prd/progress-commit";

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration
// ─────────────────────────────────────────────────────────────────────────────

const origSavePRD = _completionDeps.savePRD;
const origCommitPrdProgress = _completionDeps.commitPrdProgress;
const origGetDiffText = _completionDeps.getDiffText;
const origCheckReviewGate = _completionDeps.checkReviewGate;
const origSpawn = _completionDeps.spawn;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The `ctx.prdPath` these tests use — asserted on so the commit targets it. */
const PRD_PATH = "/tmp/x/prd.json";

function makeCtx(overrides: Partial<PipelineContext>): PipelineContext {
  const story = makeStory({ id: "US-001", status: "in-progress" });
  const prd = makePRD({ userStories: [story] });
  return Object.assign(
    makeTestContext({
      config: makeNaxConfig(),
      rootConfig: makeNaxConfig(),
      prd,
      story,
      stories: [story],
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      workdir: "/tmp/x",
      projectDir: "/tmp/x",
    }),
    {
      prdPath: "/tmp/x/prd.json",
      agentResult: {
        success: true,
        estimatedCostUsd: 0.01,
        output: "",
        stderr: "",
        exitCode: 0,
        rateLimited: false,
      },
      storyStartTime: new Date().toISOString(),
      runtime: makeMockRuntime(),
    },
    overrides,
  );
}

afterEach(() => {
  _completionDeps.savePRD = origSavePRD;
  _completionDeps.commitPrdProgress = origCommitPrdProgress;
  _completionDeps.getDiffText = origGetDiffText;
  _completionDeps.checkReviewGate = origCheckReviewGate;
  _completionDeps.spawn = origSpawn;
});

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — the story is marked passed in ctx.prd and the PRD is saved
// to ctx.prdPath.
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage outcome reporting", () => {
  test.each([
    { state: "complete-gate-open" as const, message: "Story closed gate-open" },
    { state: "complete" as const, message: "Story passed" },
    { state: undefined, message: "Story passed" },
  ])("reports $state", async ({ state, message }) => {
    const dir = makeTempDir("completion-outcome-");
    const logs: LogEntry[] = [];
    resetLogger();
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
    _completionDeps.savePRD = async () => {};
    _completionDeps.commitPrdProgress = async () => true;
    const ctx = makeCtx({ featureDir: dir, workflowEndState: state });
    try {
      await completionStage.execute(ctx);
      expect(ctx.prd.userStories[0].status).toBe("passed");
      if (state === "complete-gate-open") expect(ctx.storyMetrics?.[0]?.success).toBe(false);
      const messages = logs.filter((entry) => entry.stage === "completion").map((entry) => entry.message);
      expect(messages).toContain(message);
      if (state === "complete-gate-open") {
        expect(messages).not.toContain("Story passed");
        const progress = (await Bun.file(`${dir}/progress.txt`).text()).trim();
        expect(progress).toContain("US-001 — PASSED —");
        expect(progress).toEndWith("— closed gate-open");
      }
    } finally {
      resetLogger();
      cleanupTempDir(dir);
    }
  });
});

describe("completionStage persists the PRD", () => {
  test("AC-1: marks the story passed in ctx.prd and saves the PRD once with that path", async () => {
    const saved: Array<[PRD, string]> = [];
    _completionDeps.savePRD = mock(async (prd: PRD, prdPath: string) => {
      saved.push([prd, prdPath]);
    });
    _completionDeps.commitPrdProgress = mock(async () => true);
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ prdPath: PRD_PATH });

    const result = await completionStage.execute(ctx);

    expect(ctx.prd.userStories[0].status).toBe("passed");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[0]).toBe(ctx.prd);
    expect(saved[0]?.[1]).toBe(PRD_PATH);
    expect(result.action).toBe("continue");
  });

  test("commits the PRD once, after saving it, with the story id and label 'passed'", async () => {
    // Order matters, not just the count: a commit that ran before the write
    // would commit the previous status and leave the new one dirty again —
    // which is the state this story exists to remove.
    const order: string[] = [];
    const commits: PrdProgressCommitOptions[] = [];
    _completionDeps.savePRD = async () => {
      order.push("save");
    };
    _completionDeps.commitPrdProgress = async (options) => {
      order.push("commit");
      commits.push(options);
      return true;
    };
    _completionDeps.getDiffText = async () => "";
    const ctx = makeCtx({ prdPath: PRD_PATH });

    await completionStage.execute(ctx);

    expect(order).toEqual(["save", "commit"]);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.prdPath).toBe(PRD_PATH);
    expect(commits[0]?.feature).toBe("test-feature");
    expect(commits[0]?.storyId).toBe("US-001");
    expect(commits[0]?.label).toBe("passed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Completion events — the story:completed emit is unconditional.
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage emits story:completed", () => {
  let featureDir: string;
  let unsubscribe: (() => void) | undefined;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    cleanupTempDir(featureDir);
  });

  test("AC-2: emits exactly one story:completed event for the story", async () => {
    featureDir = makeTempDir("nax-completion-events-");
    _completionDeps.savePRD = mock(async () => {});
    _completionDeps.commitPrdProgress = mock(async () => true);
    _completionDeps.getDiffText = mock(async () => "");
    const ctx = makeCtx({ featureDir });

    const received: Array<{ storyId: string; passed: boolean }> = [];
    unsubscribe = pipelineEventBus.on("story:completed", (event) => {
      received.push(event);
    });

    await completionStage.execute(ctx);

    expect(received).toHaveLength(1);
    expect(received[0]?.storyId).toBe("US-001");
    expect(received[0]?.passed).toBe(true);
  });
});

describe("completionStage bounded stream reading", () => {
  test("getDiffText retains 8,000 characters and drains stderr", async () => {
    const encoder = new TextEncoder();
    let stderrPulls = 0;
    _completionDeps.spawn = makeSpawn(() => {
      const proc = makeSpawnResult({ stdout: "x".repeat(9_000) });
      // Pull-based stderr so the test can observe that getDiffText drains it.
      Object.defineProperty(proc, "stderr", {
        value: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (stderrPulls++ === 0) controller.enqueue(encoder.encode("warning"));
            else controller.close();
          },
        }),
      });
      return proc;
    }).spawn;

    const output = await _completionDeps.getDiffText("/repo", "base-ref");

    expect(output).toBe("x".repeat(8_000));
    expect(stderrPulls).toBe(2);
  });

  test("getDiffText passes through a diff shorter than MAX_DIFF_TEXT_CHARS", async () => {
    // The cap must not chop shorter diffs — the fragment capture (and the
    // effectiveness annotation) rely on every byte of a small diff being
    // preserved verbatim.
    const _encoder = new TextEncoder();
    const diff = "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-x\n+y\n";
    _completionDeps.spawn = makeSpawn(() => diff).spawn;

    const output = await _completionDeps.getDiffText("/repo", "base-ref");

    expect(output).toBe(diff);
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

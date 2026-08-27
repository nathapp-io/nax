/**
 * CheckpointWriter tests
 *
 * Tests for src/execution/checkpoint/writer.ts:
 * - Construction with injected _deps
 * - recordGreen appends a single newline-terminated JSONL line
 * - recordGreen awaits the injected append
 * - checkpoint-specific errors surface as NaxError with stage=checkpoint
 */

import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { CheckpointWriter } from "@/execution";

function makeAppend() {
  const calls: Array<{ path: string; line: string }> = [];
  return {
    calls,
    append: async (path: string, line: string): Promise<void> => {
      calls.push({ path, line });
    },
  };
}

describe("CheckpointWriter construction", () => {
  test("is importable from src/execution/checkpoint and constructable with injected _deps", () => {
    const deps = { append: async () => {} };
    const writer = new CheckpointWriter({
      filePath: "/tmp/checkpoint.jsonl",
      runId: "run-1",
      _deps: deps,
    });
    expect(writer).toBeInstanceOf(CheckpointWriter);
  });
});

describe("CheckpointWriter.recordGreen", () => {
  test("invokes _deps.append exactly once with a newline-terminated line", async () => {
    const deps = makeAppend();
    const writer = new CheckpointWriter({
      filePath: "/tmp/checkpoint.jsonl",
      runId: "run-1",
      _deps: deps,
    });

    await writer.recordGreen("US-001", "test-writer", { headSha: "abc123", dirtyDigest: "deadbeef" });

    expect(deps.calls).toHaveLength(1);
    const call = deps.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    expect(call.path).toBe("/tmp/checkpoint.jsonl");
    expect(call.line.endsWith("\n")).toBe(true);
  });

  test("the appended line parses to JSON with storyId, phase, headSha, dirtyDigest, runId, ts equal to inputs", async () => {
    const deps = makeAppend();
    const writer = new CheckpointWriter({
      filePath: "/tmp/checkpoint.jsonl",
      runId: "run-fixed-42",
      _deps: deps,
    });

    const treeState = { headSha: "head-sha-value", dirtyDigest: "dirty-digest-value" };
    await writer.recordGreen("US-007", "implementer", treeState);

    const call = deps.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const trimmed = call.line.trimEnd();
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    expect(parsed.storyId).toBe("US-007");
    expect(parsed.phase).toBe("implementer");
    expect(parsed.headSha).toBe(treeState.headSha);
    expect(parsed.dirtyDigest).toBe(treeState.dirtyDigest);
    expect(parsed.runId).toBe("run-fixed-42");
    expect(typeof parsed.ts).toBe("number");
    expect(parsed.ts).toBeGreaterThan(0);
  });

  test("does not resolve until the injected append has completed", async () => {
    let appendResolved = false;
    let recordGreenResolved = false;
    const appendPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        appendResolved = true;
        resolve();
      }, 20);
    });
    const deps = {
      append: (_path: string, _line: string): Promise<void> => appendPromise,
    };
    const writer = new CheckpointWriter({
      filePath: "/tmp/checkpoint.jsonl",
      runId: "run-async",
      _deps: deps,
    });

    const recordPromise = writer.recordGreen("US-001", "verifier", {
      headSha: "h",
      dirtyDigest: "d",
    });
    void recordPromise.then(() => {
      recordGreenResolved = true;
    });

    // Yield a microtask; recordGreen must still be pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(appendResolved).toBe(false);
    expect(recordGreenResolved).toBe(false);

    await recordPromise;
    expect(appendResolved).toBe(true);
    expect(recordGreenResolved).toBe(true);
  });
});

describe("CheckpointWriter.recordGreen error handling", () => {
  test("when append raises a checkpoint-specific error, it surfaces as NaxError with stage=checkpoint", async () => {
    const deps = {
      append: async (_path: string, _line: string): Promise<void> => {
        throw new Error("disk full");
      },
    };
    const writer = new CheckpointWriter({
      filePath: "/tmp/checkpoint.jsonl",
      runId: "run-err",
      _deps: deps,
    });

    let caught: unknown;
    try {
      await writer.recordGreen("US-001", "test-writer", { headSha: "h", dirtyDigest: "d" });
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.context?.stage).toBe("checkpoint");
  });
});

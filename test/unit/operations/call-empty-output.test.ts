import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AdapterFailure } from "../../../src/context/engine";
import { _callOpDeps, callOp } from "../../../src/operations";
import type { RunOperation } from "../../../src/operations";
import { DEFAULT_CONFIG, pickSelector } from "../../../src/config";
import { makeMockAgentManager, makeMockRuntime, makeSessionManager } from "../../helpers";
import type { NaxRuntime } from "../../../src/runtime";

// This file covers synthesis logic in sendWithFileOutput (src/operations/call.ts).
// The AC9 tests below are a forward-declaration placeholder — Task 2 adds
// behavioral tests once the synthesis is implemented.
describe("AdapterFailure – optional reason field", () => {
  test("AdapterFailure accepts optional reason field", () => {
    const f: AdapterFailure = {
      category: "availability",
      outcome: "fail-stale",
      retriable: true,
      message: "test",
      reason: "empty-output",
    };
    expect(f.reason).toBe("empty-output");
  });

  test("AdapterFailure without reason still compiles and has undefined reason", () => {
    const f: AdapterFailure = {
      category: "availability",
      outcome: "fail-stale",
      retriable: true,
      message: "idle watchdog",
    };
    expect(f.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const testSel = pickSelector("empty-output-test", "routing");

/** A minimal run-kind op that expects JSON object output. */
function makeRunOp(
  name: string,
  fileOutputPath?: string,
): RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You echo input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    ...(fileOutputPath ? { fileOutput: () => fileOutputPath } : {}),
    parse: (output) => output.trim(),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle: save/restore _callOpDeps + runtime cleanup
// ---------------------------------------------------------------------------

let origReadFileOutput: typeof _callOpDeps.readFileOutput;
const createdRuntimes: NaxRuntime[] = [];

beforeEach(() => {
  origReadFileOutput = _callOpDeps.readFileOutput;
});
afterEach(async () => {
  _callOpDeps.readFileOutput = origReadFileOutput;
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

// ---------------------------------------------------------------------------
// AC1: empty agent output → synthesis fires → callOp throws CALL_OP_NO_OUTPUT
// ---------------------------------------------------------------------------

describe("sendWithFileOutput — AC1: empty output synthesises fail-stale AdapterFailure", () => {
  test("empty turn output with no fileOutput → throws CALL_OP_NO_OUTPUT (not CALL_OP_PARSE_FAILED)", async () => {
    // runWithFallbackFn invokes executeHop so sendWithFileOutput runs.
    // runAsSessionFn is the underlying send stub that returns empty output.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: Error & { code?: string } | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeRunOp("empty-output-no-file"),
        "hello",
      );
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    // Must throw CALL_OP_NO_OUTPUT, not CALL_OP_PARSE_FAILED
    expect(thrown?.message).toContain("agent returned no output");
    expect((thrown as { code?: string })?.code).toBe("CALL_OP_NO_OUTPUT");
  });

  test("strictly empty string output (output: '') → synthesis fires → CALL_OP_NO_OUTPUT", async () => {
    // Verify the explicit empty-string case is the trigger for synthesis,
    // distinct from whitespace-only (which does not reach callOp's no-output check
    // because turnResultToAgentResult preserves the whitespace string as-is).
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: Error & { code?: string } | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeRunOp("empty-string-op"),
        "hello",
      );
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect((thrown as { code?: string })?.code).toBe("CALL_OP_NO_OUTPUT");
  });

  test("synthesised adapterFailure message references the op name", async () => {
    // Capture the hop result to inspect the synthesised adapterFailure before
    // it propagates through runWithFallback → CALL_OP_NO_OUTPUT.
    let capturedOutput: string | undefined;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedOutput = hopResult.result.output;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: Error & { code?: string; context?: { storyId?: string } } | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeRunOp("my-named-op"),
        "hello",
      );
    } catch (err) {
      thrown = err as Error & { code?: string; context?: { storyId?: string } };
    }

    expect(thrown).not.toBeNull();
    // The synthesised failure output is empty string (no content injected).
    // The CALL_OP_NO_OUTPUT error message confirms synthesis did fire (op name in msg).
    expect(thrown?.message).toContain("my-named-op");
    expect((thrown as { code?: string })?.code).toBe("CALL_OP_NO_OUTPUT");
    // The hop result output is empty because sendWithFileOutput set adapterFailure
    // but left output as-is (empty), which then flows to callOp as rawOutput="".
    expect(capturedOutput).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AC2: file-overlay with non-empty content → synthesis does NOT fire
// ---------------------------------------------------------------------------

describe("sendWithFileOutput — AC2: file overlay with content suppresses synthesis", () => {
  test("file overlay returns non-empty content → callOp succeeds (no synthesis)", async () => {
    const outputPath = "/tmp/plan-ac2.json";
    _callOpDeps.readFileOutput = async (path) => {
      expect(path).toBe(outputPath);
      return "file content from overlay";
    };

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        // Agent acknowledged but wrote nothing to stdout — the file has the real output.
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      makeRunOp("file-overlay-op", outputPath),
      "hello",
    );

    // parse trims — content from file is used directly
    expect(result).toBe("file content from overlay");
  });

  test("file overlay returns null (file missing) → synthesis still fires → CALL_OP_NO_OUTPUT", async () => {
    _callOpDeps.readFileOutput = async () => null;

    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    let thrown: { code?: string } | null = null;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeRunOp("file-missing-op", "/tmp/missing-file.txt"),
        "hello",
      );
    } catch (err) {
      thrown = err as { code?: string };
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("CALL_OP_NO_OUTPUT");
  });

  test("non-empty agent output without fileOutput → synthesis does NOT fire", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "substantial agent output",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      makeRunOp("non-empty-op"),
      "hello",
    );

    expect(result).toBe("substantial agent output");
  });
});

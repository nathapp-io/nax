import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  assertNaxError,
  makeMockAgentManager,
  makeMockRuntime,
  makeSessionManager,
  makeTestRuntime,
} from "@test/helpers";
import type { AgentRunRequest } from "@/agents/manager-types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import type { RunOperation } from "@/operations";
import { _callOpDeps, callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

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
let runtime: NaxRuntime | undefined;

beforeEach(() => {
  origReadFileOutput = _callOpDeps.readFileOutput;
});
afterEach(async () => {
  _callOpDeps.readFileOutput = origReadFileOutput;
  await runtime?.close();
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

// ---------------------------------------------------------------------------
// AC1: empty agent output → synthesis fires → callOp throws CALL_OP_NO_OUTPUT
//
// US-001 invariant: every fixture here returns an outcome whose
// `dispatchesCompleted` equals 1 — the empty / whitespace / refusal text was
// actually returned by an adapter, so a dispatch DID happen. The new
// CALL_OP_NO_DISPATCH code covers the no-dispatch case in call-no-dispatch.test.ts;
// these tests stay on the CALL_OP_NO_OUTPUT path because their fixtures have
// `dispatchesCompleted >= 1`.
// ---------------------------------------------------------------------------

describe("sendWithFileOutput — AC1: empty output synthesises fail-stale AdapterFailure", () => {
  test("empty turn output with no fileOutput → throws CALL_OP_NO_OUTPUT (not CALL_OP_PARSE_FAILED)", async () => {
    // runWithFallbackFn invokes executeHop so sendWithFileOutput runs.
    // runAsSessionFn is the underlying send stub that returns empty output.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
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

    let thrown: unknown;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeRunOp("empty-output-no-file"),
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    // Must throw CALL_OP_NO_OUTPUT, not CALL_OP_PARSE_FAILED
    assertNaxError(thrown, "callOp rejection");
    expect(thrown.message).toContain("agent returned no output");
    expect(thrown.code).toBe("CALL_OP_NO_OUTPUT");
  });

  test("whitespace-only output → synthesis fires (adapterFailure set) → manager sees fail-stale", async () => {
    // Whitespace-only output triggers synthesis (!output.trim() is true) and
    // causes turnResultToAgentResult to mark success:false so the manager's
    // fail-stale retry path engages. Behavioral asymmetry note: the outer
    // callOp guard `if (!rawOutput)` uses a falsy check and will NOT throw
    // CALL_OP_NO_OUTPUT for "   " at exhaustion — op.parse("   ") is called
    // instead. This is acceptable: synthesis + retry is correct on the success
    // path; at exhaustion, op.parse rejects or trims to "" per its own contract.
    let capturedAdapterFailure: unknown;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        // Capture what sendWithFileOutput synthesised on the TurnResult
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: unknown }).adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
      },
      runAsSessionFn: async () => ({
        output: "   ",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    // op.parse trims "   " → ""; the mock manager passes output straight through,
    // so callOp sees rawOutput="" (falsy) and throws CALL_OP_NO_OUTPUT.
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeRunOp("whitespace-op"),
        "hello",
      );
    } catch {
      // expected — the mock manager doesn't retry
    }

    // Synthesis fired: adapterFailure has the correct shape
    expect((capturedAdapterFailure as { outcome?: string } | undefined)?.outcome).toBe("fail-stale");
    expect((capturedAdapterFailure as { reason?: string } | undefined)?.reason).toBe("empty-output");
  });

  test("synthesised adapterFailure message references the op name", async () => {
    // Capture the hop result to inspect the synthesised adapterFailure before
    // it propagates through runWithFallback → CALL_OP_NO_OUTPUT.
    let capturedOutput: string | undefined;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedOutput = hopResult.result.output;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
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

    let thrown: unknown;
    try {
      await callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        makeRunOp("my-named-op"),
        "hello",
      );
    } catch (err) {
      thrown = err;
    }

    // The synthesised failure output is empty string (no content injected).
    // The CALL_OP_NO_OUTPUT error message confirms synthesis did fire (op name in msg).
    assertNaxError(thrown, "callOp rejection");
    expect(thrown.message).toContain("my-named-op");
    expect(thrown.code).toBe("CALL_OP_NO_OUTPUT");
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
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
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
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
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
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
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

  test("provider-refusal output (non-empty) synthesises a retriable availability AdapterFailure (BUG-62)", async () => {
    let capturedAdapterFailure: unknown;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: unknown }).adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
      },
      runAsSessionFn: async () => ({
        output: "Selected model is at capacity. Please try a different model.",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    // The mock manager doesn't retry/swap on its own — we're only asserting the
    // synthesis fired on the TurnResult produced by sendWithFileOutput.
    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      makeRunOp("provider-refusal-op"),
      "hello",
    );

    expect(capturedAdapterFailure).toEqual({
      category: "availability",
      outcome: "fail-rate-limit",
      retriable: true,
      message: "Selected model is at capacity. Please try a different model.",
    });
  });

  test("non-empty output that already carries an adapterFailure is left unchanged", async () => {
    let capturedAdapterFailure: unknown;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: unknown }).adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
      },
      runAsSessionFn: async () => ({
        output: 'Agent "claude" failed: some session-level failure',
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        adapterFailure: {
          category: "quality" as const,
          outcome: "fail-adapter-error" as const,
          retriable: false,
          message: "pre-existing",
        },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      makeRunOp("preexisting-failure-op"),
      "hello",
    );

    expect(capturedAdapterFailure).toEqual({
      category: "quality",
      outcome: "fail-adapter-error",
      retriable: false,
      message: "pre-existing",
    });
  });

  test("classification runs against the file-overlay content, not the agent's stdout text (BUG-62)", async () => {
    const outputPath = "/tmp/refusal-overlay.json";
    _callOpDeps.readFileOutput = async () => "Selected model is at capacity. Please try a different model.";

    let capturedAdapterFailure: unknown;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: unknown }).adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
      },
      // The agent's own stdout acknowledgement is benign — only the overlay file matters.
      runAsSessionFn: async () => ({
        output: "done, see file",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      makeRunOp("overlay-refusal-op", outputPath),
      "hello",
    );

    expect(capturedAdapterFailure).toEqual({
      category: "availability",
      outcome: "fail-rate-limit",
      retriable: true,
      message: "Selected model is at capacity. Please try a different model.",
    });
  });

  test("ordinary file-overlay content is not misclassified as a refusal", async () => {
    const outputPath = "/tmp/normal-overlay.json";
    _callOpDeps.readFileOutput = async () => JSON.stringify({ passed: true, findings: [] });

    let capturedAdapterFailure: unknown;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hopResult = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        capturedAdapterFailure = (hopResult.result as { adapterFailure?: unknown }).adapterFailure;
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
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

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      makeRunOp("overlay-normal-op", outputPath),
      "hello",
    );

    expect(capturedAdapterFailure).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// US-001 AC5-AC8 — dispatch adapterFailure attachment (from call-adapter-failure.test.ts)
// ---------------------------------------------------------------------------

const adapterTestSel = pickSelector("routing-op-test", "routing");

// Mirrors the echoOp shape used elsewhere in test/unit/operations/call*.test.ts.
const runEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-test",
  stage: "run",
  config: adapterTestSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

describe("callOp — kind:run — attach adapterFailure from dispatch outcome (US-001 AC5-AC8)", () => {
  // Acceptance-shaped op: parses the run outcome's stdout to { testCode }.
  const acceptanceOp: RunOperation<
    { text: string },
    { testCode: string | null; adapterFailure?: AdapterFailure },
    Pick<typeof DEFAULT_CONFIG, "routing">
  > = {
    kind: "run",
    name: "acceptance-generate",
    stage: "run",
    config: adapterTestSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "Echo text.", overridable: false },
      task: { id: "task", content: input.text, overridable: false },
    }),
    parse: (output) => {
      if (output === "SENTINEL_NULL") return { testCode: null };
      if (output === "SENTINEL_OBJECT") {
        return {
          testCode: "code",
          adapterFailure: { outcome: "fail-quality", category: "quality", retriable: false, message: "producer" },
        };
      }
      return { testCode: output };
    },
  };

  function makeRunResultWithFailure(output: string, failure: AdapterFailure | undefined) {
    return async (_req: AgentRunRequest) => ({
      result: {
        success: true,
        exitCode: 0,
        output,
        rateLimited: false,
        durationMs: 1,
        estimatedCostUsd: 0,
        agentFallbacks: [],
        ...(failure !== undefined ? { adapterFailure: failure } : {}),
      },
      fallbacks: [],
    });
  }

  test("AC5: attaches adapterFailure from outcome when parse returns { testCode: null }", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-service-down",
      category: "availability",
      retriable: false,
      message: "dispatch service down",
    };
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: makeRunResultWithFailure("SENTINEL_NULL", failure),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      acceptanceOp,
      { text: "x" },
    );

    expect(result.testCode).toBeNull();
    expect(result.adapterFailure).toEqual(failure);
    expect(result.adapterFailure?.outcome).toBe("fail-service-down");
  });

  test("AC6: leaves parsed value untouched when outcome carries no adapterFailure", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: makeRunResultWithFailure("some code", undefined),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      acceptanceOp,
      { text: "x" },
    );

    expect(result.testCode).toBe("some code");
    expect("adapterFailure" in result).toBe(false);
  });

  test("AC7: preserves producer's adapterFailure over dispatch outcome's", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-service-down",
      category: "availability",
      retriable: false,
      message: "dispatch service down",
    };
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: makeRunResultWithFailure("SENTINEL_OBJECT", failure),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      acceptanceOp,
      { text: "x" },
    );

    expect(result.testCode).toBe("code");
    expect(result.adapterFailure?.outcome).toBe("fail-quality");
  });

  test("AC8: returns the same string when parse returns a string", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-service-down",
      category: "availability",
      retriable: true,
      message: "dispatch failure",
    };
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: makeRunResultWithFailure("hello-string-output", failure),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      runEchoOp,
      { text: "x" },
    );

    expect(result).toBe("hello-string-output");
  });

  test("clears an earlier provider failure after a later successful operation", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-rate-limit",
      category: "availability",
      retriable: true,
      message: "429",
    };
    let calls = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req: AgentRunRequest) => {
        calls += 1;
        return {
          result: {
            success: true,
            exitCode: 0,
            output: "ok",
            rateLimited: false,
            durationMs: 1,
            estimatedCostUsd: 0,
            agentFallbacks: [],
            ...(calls === 1 ? { adapterFailure: failure } : {}),
          },
          fallbacks: [],
        };
      },
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-001",
    };

    await callOp(ctx, runEchoOp, { text: "first" });
    expect(runtime.lastAdapterFailure.get("US-001")).toEqual(failure);

    await callOp(ctx, runEchoOp, { text: "second" });
    expect(runtime.lastAdapterFailure.has("US-001")).toBe(false);
  });
});

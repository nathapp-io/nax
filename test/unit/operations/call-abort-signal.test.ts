import { afterEach, describe, expect, test } from "bun:test";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { callOp } from "@/operations";
import type { CallContext, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";

// Split out of call.test.ts (Task 4) once that file approached the 800-line
// test-file limit — see .claude/rules/test-architecture.md "split by describe
// block, not by bug number."

let runtime: NaxRuntime | undefined;
afterEach(async () => {
  await runtime?.close();
});

// Local helper mirroring the CallContext literal call.test.ts builds inline
// for its other callOp cases — spreads `extra` over the common base so
// signal-specific tests can add `signal` without repeating the boilerplate.
function makeCtx(runtime: NaxRuntime, extra?: Partial<CallContext>): CallContext {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-001",
    ...extra,
  };
}

describe("callOp — CallContext.signal (Task 4: caller-supplied abort signal)", () => {
  const abortSel = pickSelector("finish-abort-test", "routing");

  function abortingOp(
    name: string,
    onRetry: () => void,
  ): RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
    return {
      kind: "run",
      name,
      stage: "review",
      config: abortSel,
      session: { role: "finish-review-spec", lifetime: "fresh" },
      build: () => ({
        role: { id: "role", content: "You retry.", overridable: false },
        task: { id: "task", content: "go", overridable: false },
      }),
      parse: (out) => out,
      retry: {
        shouldRetry: () => {
          onRetry();
          return { retry: true, delayMs: 0 };
        },
      },
    };
  }

  // Invokes req.executeHop so the retry loop inside sendWithParseRetry actually
  // runs — the same pattern used by the #993 recover-invocation describe block
  // in call.test.ts, needed because a plain runWithFallback mock never calls
  // executeHop.
  function makeHopInvokingAgentManager() {
    return makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: "File already valid.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      }),
      runWithFallbackFn: async (req) => {
        const result = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return {
          result: {
            success: true,
            exitCode: 0,
            rateLimited: false,
            durationMs: 1,
            output: result.result.output,
            estimatedCostUsd: result.result.estimatedCostUsd ?? 0,
            agentFallbacks: [],
          },
          fallbacks: [],
        };
      },
    });
  }

  test("ctx.signal aborts a retry while runtime.signal is still live", async () => {
    const agentManager = makeHopInvokingAgentManager();
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager }); // its own signal is never aborted
    const caller = new AbortController();
    let attempts = 0;
    const op = abortingOp("test-caller-abort", () => {
      attempts += 1;
      caller.abort();
    });

    await expect(callOp(makeCtx(runtime, { signal: caller.signal }), op, { text: "x" })).rejects.toThrow(/aborted/);
    expect(attempts).toBe(1);
  });

  test("with no ctx.signal, runtime.signal still aborts", async () => {
    const agentManager = makeHopInvokingAgentManager();
    const sessionManager = makeSessionManager();
    const parent = new AbortController();
    // parentSignal is the sanctioned seam for driving runtime.signal from a test
    // (src/runtime/index.ts:175, 205-207) — aborting it aborts the runtime's own
    // controller. Do not reach for a hand-built runtime fake; check-test-as-unknown-as
    // is baselined and must not grow.
    runtime = makeTestRuntime({ agentManager, sessionManager, parentSignal: parent.signal });
    let attempts = 0;
    const op = abortingOp("test-runtime-abort", () => {
      attempts += 1;
      parent.abort();
    });

    await expect(callOp(makeCtx(runtime), op, { text: "x" })).rejects.toThrow(/aborted/);
    expect(attempts).toBe(1);
  });
});

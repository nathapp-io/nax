/**
 * callOp — run-scoped pull-tool counter threading.
 *
 * Own file rather than appended to call.test.ts, matching the existing
 * call-*.test.ts topical split (call-correlation, call-fail-timeout,
 * call-op-retry, ...). call.test.ts is 736 lines against an 800 limit, so the
 * split is by convention, not because the ratchet forced it.
 */

import { describe, expect, test } from "bun:test";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import { _callOpDeps, callOp } from "@/operations";
import type { BuildHopCallbackContext, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";

const testSel = pickSelector("test", "routing");

const runEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-counter-test",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Gap finding 7 / AC-18. BuildHopCallbackContext declared contextToolRunCounter
// but callOp's hopCtx literal never set it, so the run-level pull cap reset on
// every hop and no invocation was ever recorded. The line could not be added
// until #1460 took call.ts back under the file-size limit.
// ─────────────────────────────────────────────────────────────────────────────

describe("callOp — contextToolRunCounter threading", () => {
  test("forwards ctx.contextToolRunCounter into the hop context", async () => {
    const orig = _callOpDeps.buildHopCallback;
    let seen: unknown;
    let stubCalled = false;
    _callOpDeps.buildHopCallback = (hopCtx: BuildHopCallbackContext) => {
      stubCalled = true;
      seen = hopCtx.contextToolRunCounter;
      return async () => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ok",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
        },
        bundle: undefined,
      });
    };

    const counter = { count: 3, calls: [] };
    const agentManager = makeMockAgentManager({});
    const localRuntime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager({}) });
    try {
      await callOp(
        {
          runtime: localRuntime,
          packageView: localRuntime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
          contextToolRunCounter: counter,
        } as never,
        runEchoOp,
        { text: "hi" },
      ).catch(() => undefined);
    } finally {
      _callOpDeps.buildHopCallback = orig;
      await localRuntime.close();
    }

    expect({ stubCalled, seen }).toEqual({ stubCalled: true, seen: counter });
  });
});

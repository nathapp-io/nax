/**
 * Live-check defect 1: a soft interrupt that lands while the native agent is mid tool-call
 * ends the turn with a tool-args parse fault, not an AbortError. With the REAL SessionManager
 * seam, the finish-fix hopBody must still see the interrupted fail-stale, send the handoff
 * prompt in the SAME session (turn 2, with the work's memory), and never re-run the fix.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeAgentAdapter, makeMockAgentManager, makeMockRuntime } from "@test/helpers";
import type { OpenSessionOpts, SessionHandle, TurnResult } from "@/agents/types";
import { SessionTurnError } from "@/agents/types";
import { callOp, finishFixOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { SessionManager } from "@/session/manager";

const HANDOFF_TURN: TurnResult = {
  output: "I finished the guard in foo.ts",
  tokenUsage: { inputTokens: 1, outputTokens: 1 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};
const TOOL_ARGS = 'Tool "Write" returned unparseable arguments.';

function handleFor(name: string): SessionHandle {
  return { id: name, agentName: "claude" };
}

const created: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(created.map((r) => r.close()));
  created.length = 0;
});

describe("finish-fix hopBody over the real SessionManager: tool-args fault after an interrupt", () => {
  test("the handoff turn runs in the same session as turn 2 and the fix is not re-run", async () => {
    let onActiveCall: OpenSessionOpts["onActiveCall"];
    let started: () => void = () => {};
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    const turns: { session: string; prompt: string }[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        onActiveCall = opts.onActiveCall;
        return handleFor(name);
      }),
      sendTurn: mock(async (handle: SessionHandle, prompt: string) => {
        turns.push({ session: handle.id, prompt });
        if (turns.length > 1) return HANDOFF_TURN;
        return new Promise<TurnResult>((_resolve, reject) => {
          assertDefined(onActiveCall, "onActiveCall");
          onActiveCall("call-1", async () => {
            reject(new SessionTurnError(TOOL_ARGS, false, false));
          });
          started();
        });
      }),
    });
    const sessionManager = new SessionManager({ getAdapter: () => adapter });
    sessionManager.configureRuntime({ watchdogControllerRegistry: new Map() });
    let hops = 0;
    const agentManager = makeMockAgentManager({
      getAgentFn: () => adapter,
      runWithFallbackFn: async (req) => {
        hops += 1;
        assertDefined(req.executeHop, "req.executeHop");
        const hop = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
      },
      runAsSessionFn: (_agent, handle, prompt, opts) => sessionManager.sendPrompt(handle, prompt, opts),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager });
    created.push(runtime);
    const interrupt = new AbortController();
    const op = callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      finishFixOp,
      { phase: "gate", workdir: "/tmp/finish-fix-session", gateOutput: "lint failed", interrupt: interrupt.signal },
    );
    await startedP;
    interrupt.abort();
    const out = await op;
    expect(turns.length).toBe(2);
    expect(turns[1]?.session).toBe(turns[0]?.session);
    expect(hops).toBe(1);
    expect(out).toMatchObject({ interrupted: true });
    expect(turns[1]?.prompt).not.toBe(turns[0]?.prompt);
  });
});

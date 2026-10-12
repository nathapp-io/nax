/**
 * Finish A: a hopBody that sends with `{ interrupt }` must reach the session manager's `interruptTurn`.
 * The chain has four hand-offs (op hopBody -> effectiveHopBody -> normalizeHopOutput -> dispatch `send` ->
 * `withInterrupt`); each passed its own seam test while the interrupt was dead end to end.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeMockRuntime, makeSessionManager } from "@test/helpers";
import type { SessionHandle, TurnResult } from "@/agents/types";
import { type DEFAULT_CONFIG, pickSelector } from "@/config";
import type { RunOperation } from "@/operations";
import { callOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const TURN: TurnResult = {
  output: "done",
  tokenUsage: { inputTokens: 1, outputTokens: 1 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};

const created: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(created.map((r) => r.close()));
  created.length = 0;
});

describe("hopBody send({ interrupt }) reaches the session manager", () => {
  test("aborting the interrupt mid-turn calls interruptTurn with the hop's session handle id", async () => {
    const interrupt = new AbortController();
    let release: () => void = () => {};
    const interrupted = new Promise<void>((r) => {
      release = r;
    });
    const interruptTurn = mock(async (_id: string) => {
      release();
      return true;
    });
    const sessionManager = makeSessionManager({
      openSession: mock(async (_name: string, opts: { agentName: string }) => {
        return { id: "handle-42", agentName: opts.agentName } satisfies SessionHandle;
      }),
      closeSession: mock(async () => {}),
      interruptTurn,
    });
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hop = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [], dispatchesCompleted: 1 };
      },
      runAsSessionFn: async () => {
        interrupt.abort(); // the soft limit fires while the turn is running
        await interrupted; // the turn only ends once the interrupt reached the session manager
        return TURN;
      },
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager });
    created.push(runtime);
    const op: RunOperation<string, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "hop-body-interrupt",
      stage: "run",
      config: pickSelector("hop-body-interrupt", "routing"),
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "r", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      hopBody: (prompt, ctx) => ctx.send(prompt, { interrupt: interrupt.signal }),
      parse: (output) => output.trim(),
    };
    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      op,
      "hello",
    );
    expect(interruptTurn).toHaveBeenCalledTimes(1);
    expect(interruptTurn).toHaveBeenCalledWith("handle-42");
  });
});

import { describe, expect, test } from "bun:test";
import type { AskChannel, AskChannelResponse, InteractionRequest } from "@/interaction";
import { cancelPendingAsk, createHumanAskLink } from "@/interaction";
import type { AskRequest } from "@/permissions";

const REQ: AskRequest = {
  tool: "Bash",
  stage: "implementer",
  rule: "Bash",
  summary: "Bash command=bun run test",
  command: "bun run test 2>&1 | tail -n 40",
  root: "/repo",
  reason: "segment 2 (`tail`) matched no allow rule",
};

/**
 * A chain double that reproduces production's FAILURE modes, not just success.
 *
 * The link depends on the narrow structural `AskChannel`, so the double is a
 * plain object literal with no double cast and no boundary cast.
 */
function fakeChain(behaviour: { reply?: string; throws?: boolean; sent?: InteractionRequest[] }): AskChannel {
  return {
    prompt: (request: InteractionRequest): Promise<AskChannelResponse> => {
      behaviour.sent?.push(request);
      if (behaviour.throws) return Promise.reject(new Error("all interaction plugins failed"));
      return Promise.resolve({
        requestId: request.id,
        action: behaviour.reply ?? "deny",
        respondedAt: Date.now(),
      });
    },
    cancel: () => Promise.resolve(),
  };
}

describe("human ask link", () => {
  test("dispatches type 'choose' carrying the command verbatim", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    await link.resolve(REQ);
    expect(sent[0]?.type).toBe("choose");
    expect(sent[0]?.options?.map((o) => o.key)).toEqual(["allow", "allow-remember", "deny"]);
    expect(sent[0]?.metadata).toEqual({ approvalPrompt: true });
    expect(JSON.stringify(sent[0])).toContain("bun run test 2>&1 | tail -n 40");
  });

  test("'allow' permits, attributed to human", async () => {
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow" }), timeoutMs: 1000 });
    expect(await link.resolve(REQ)).toEqual({ decision: "allow", decidedBy: "human" });
  });

  test("'allow-remember' permits and calls onRemember", async () => {
    let remembered = false;
    const link = createHumanAskLink({
      chain: fakeChain({ reply: "allow-remember" }),
      timeoutMs: 1000,
      onRemember: async () => {
        remembered = true;
      },
    });
    expect((await link.resolve(REQ)).decision).toBe("allow");
    expect(remembered).toBe(true);
  });

  test("a failed onRemember still allows the approved call", async () => {
    const link = createHumanAskLink({
      chain: fakeChain({ reply: "allow-remember" }),
      timeoutMs: 1000,
      onRemember: async () => {
        throw new Error("approvals.json lock timeout");
      },
    });
    expect(await link.resolve(REQ)).toEqual({ decision: "allow", decidedBy: "human" });
  });

  test("a non-command request's detail carries its summary", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "deny", sent }), timeoutMs: 1000 });
    const { command: _omit, ...noCommand } = REQ;
    await link.resolve({ ...noCommand, tool: "Write", summary: "Write path=src/a.ts" });
    expect(JSON.stringify(sent[0])).toContain("Write path=src/a.ts");
  });

  test("a command of exactly 3500 chars is dispatched", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    const out = await link.resolve({ ...REQ, command: "x".repeat(3500) });
    expect(out.decision).toBe("allow");
    expect(sent).toHaveLength(1);
  });

  test("a command of 3501 chars denies without dispatching", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    const out = await link.resolve({ ...REQ, command: "x".repeat(3501) });
    expect(out.decision).toBe("deny");
    expect(sent).toHaveLength(0);
  });

  test.each([["deny"], ["skip"], ["abort"], ["approve"], ["continue"], ["anything-else"]])(
    "ALLOWLIST: action %s denies",
    async (action) => {
      const link = createHumanAskLink({ chain: fakeChain({ reply: action }), timeoutMs: 1000 });
      expect((await link.resolve(REQ)).decision).toBe("deny");
    },
  );

  test("no chain denies, attributed to unavailable", async () => {
    const link = createHumanAskLink({ chain: null, timeoutMs: 1000 });
    expect(await link.resolve(REQ)).toEqual({ decision: "deny", decidedBy: "unavailable" });
  });

  test("a throwing chain denies rather than escaping", async () => {
    const link = createHumanAskLink({ chain: fakeChain({ throws: true }), timeoutMs: 1000 });
    expect((await link.resolve(REQ)).decision).toBe("deny");
  });

  test("a command too long to display denies rather than truncating", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    const out = await link.resolve({ ...REQ, command: `echo ${"x".repeat(5000)}` });
    expect(out.decision).toBe("deny");
    expect(sent).toHaveLength(0);
  });

  // SPEC CASE 3 -- the single most important regression test in this design.
  // applyFallback maps BOTH "continue" and "escalate" to "approve"
  // (src/interaction/chain.ts:186-193), and this author's global config sets
  // "escalate". A link built on applyFallback auto-approves every escalated
  // command on timeout. This test MUST fail against such an implementation.
  test.each([["continue"], ["escalate"], ["skip"], ["abort"]])(
    "a timeout DENIES even when interaction fallback is %s",
    async (fallback) => {
      const timingOutChain = {
        prompt: (request: InteractionRequest): Promise<AskChannelResponse> =>
          Promise.resolve({
            requestId: request.id,
            action: "approve",
            respondedBy: "timeout",
            respondedAt: Date.now(),
          }),
        cancel: () => Promise.resolve(),
        // Present so an implementation that reaches for it compiles and then
        // fails this assertion, rather than failing to compile and being
        // "fixed" by deleting the test.
        applyFallback: () => (fallback === "continue" || fallback === "escalate" ? "approve" : fallback),
      };
      const link = createHumanAskLink({ chain: timingOutChain, timeoutMs: 1000 });
      expect(await link.resolve(REQ)).toEqual({ decision: "deny", decidedBy: "timeout" });
    },
  );

  // SPEC CASE 3b
  test("the prompt carries execution.approvalTimeout, not the interaction default", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 600_000 });
    await link.resolve(REQ);
    expect(sent[0]?.timeout).toBe(600_000);
  });

  // SPEC CASE 15
  test("run-end cancellation settles a pending prompt even when the channel cancel does not", async () => {
    let cancelled: string | undefined;
    const hangingChain: AskChannel = {
      prompt: () => new Promise<AskChannelResponse>(() => {}),
      cancel: (id: string) => {
        cancelled = id;
        return Promise.resolve();
      },
    };

    const link = createHumanAskLink({ chain: hangingChain, timeoutMs: 3_600_000 });
    const inFlight = link.resolve(REQ);
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(link.pending()).toBeDefined();

    await cancelPendingAsk(link);
    const outcome = await Promise.race([inFlight, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    expect(cancelled).toBeDefined();
    expect(outcome).not.toBeNull();
    expect(outcome?.decision).toBe("deny");
  });

  test("a throw in one ask does not deadlock the next (mutex releases)", async () => {
    const link = createHumanAskLink({ chain: fakeChain({ throws: true }), timeoutMs: 1000 });
    await link.resolve(REQ);
    const second = await Promise.race([link.resolve(REQ), new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    expect(second).not.toBeNull();
  });

  test("identical concurrent asks join the pending prompt", async () => {
    let promptCalls = 0;
    let release: ((response: AskChannelResponse) => void) | undefined;
    const chain: AskChannel = {
      prompt: () => {
        promptCalls++;
        return new Promise<AskChannelResponse>((resolve) => {
          release = resolve;
        });
      },
      cancel: () => Promise.resolve(),
    };
    const link = createHumanAskLink({ chain, timeoutMs: 1000 });

    const first = link.resolve(REQ);
    const second = link.resolve(REQ);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(promptCalls).toBe(1);

    release?.({ action: "allow", respondedAt: Date.now() });
    expect(await first).toEqual({ decision: "allow", decidedBy: "human" });
    expect(await second).toEqual({ decision: "allow", decidedBy: "human" });
    expect(promptCalls).toBe(1);
  });
});

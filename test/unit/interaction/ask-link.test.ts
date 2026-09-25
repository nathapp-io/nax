import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, type FakeClock, makeFakeClock, waitForCondition } from "@test/helpers";
import type { AskChannel, AskChannelResponse, InteractionRequest } from "@/interaction";
import { cancelPendingAsk, createHumanAskLink } from "@/interaction";
import { _askLinkDeps } from "@/interaction/ask-link";
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

  test("US-005 AC1: a supplied stage labels the dispatched request 'review'", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000, stage: "review" });
    await link.resolve(REQ);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.stage).toBe("review");
  });

  test("US-005 AC2: without a stage the dispatched request is labelled 'execution'", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    await link.resolve(REQ);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.stage).toBe("execution");
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

// US-003: cancel pending human-approval waiters. The link accepts an optional
// per-ask AskControl; its signal cancels just that waiter ("deny/cancelled"),
// settles the on-screen chain prompt once no live waiter remains, and never
// prompts for a waiter whose signal is already aborted.
describe("US-003 — cancel pending human-approval waiters", () => {
  /**
   * Wait until the link has dispatched its on-screen prompt. Used in place of
   * a fixed-duration sleep: the serial queue's runSession is queued on a
   * promise chain, and `link.pending()` is the observable condition that
   * fires once chain.prompt has been called.
   */
  const waitForOnScreen = (link: ReturnType<typeof createHumanAskLink>) =>
    waitForCondition(() => link.pending() !== undefined, 1_000);

  /**
   * Wait until the chain's prompt has been dispatched a given number of times.
   * Used in tests that share a counter across the whole suite so the
   * condition is observable synchronously on the call to chain.prompt.
   */
  const waitForPromptCount = (count: () => number, target: number) => waitForCondition(() => count() === target, 1_000);

  /** A chain whose prompt never resolves until cancelled or released. */
  function hangingChain(cancel: (id: string) => void): AskChannel {
    return {
      prompt: () => new Promise<AskChannelResponse>(() => {}),
      cancel: (id) => {
        cancel(id);
        return Promise.resolve();
      },
    };
  }

  test("AC10: a request whose signal is already aborted settles cancelled and is never prompted", async () => {
    const sent: InteractionRequest[] = [];
    const controller = new AbortController();
    controller.abort("turn ended");
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });

    const outcome = await link.resolve(REQ, { signal: controller.signal });

    expect(outcome).toEqual({ decision: "deny", decidedBy: "cancelled" });
    expect(sent).toHaveLength(0);
  });

  test("AC4: aborting an on-screen waiter settles it deny/cancelled", async () => {
    const link = createHumanAskLink({ chain: hangingChain(() => {}), timeoutMs: 1_000_000 });
    const controller = new AbortController();
    const waiter = link.resolve(REQ, { signal: controller.signal });
    await waitForOnScreen(link);
    expect(link.pending()).toBeDefined(); // the prompt is on screen

    controller.abort();

    expect(await waiter).toEqual({ decision: "deny", decidedBy: "cancelled" });
  });

  test("AC5: aborting the sole waiter cancels the chain prompt with its id", async () => {
    const cancelled: string[] = [];
    const link = createHumanAskLink({ chain: hangingChain((id) => cancelled.push(id)), timeoutMs: 1_000_000 });
    const controller = new AbortController();
    const waiter = link.resolve(REQ, { signal: controller.signal });
    await waitForOnScreen(link);
    const promptId = link.pending();
    assertDefined(promptId, "on-screen prompt id");

    controller.abort();
    await waiter;

    expect(cancelled).toEqual([promptId]);
  });

  test("AC6: two same-key waiters — aborting the first settles it cancelled, the second still allows", async () => {
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
    const link = createHumanAskLink({ chain, timeoutMs: 1_000_000 });
    const firstCtrl = new AbortController();
    const secondCtrl = new AbortController();
    const first = link.resolve(REQ, { signal: firstCtrl.signal });
    const second = link.resolve(REQ, { signal: secondCtrl.signal });
    await waitForPromptCount(() => promptCalls, 1); // same key joins the single on-screen prompt
    expect(promptCalls).toBe(1);

    firstCtrl.abort();
    expect(await first).toEqual({ decision: "deny", decidedBy: "cancelled" });

    release?.({ action: "allow", respondedAt: Date.now() });
    expect(await second).toEqual({ decision: "allow", decidedBy: "human" });
    expect(promptCalls).toBe(1);
  });

  test("AC7: aborting only the first of two same-key waiters never cancels the chain prompt", async () => {
    const cancelled: string[] = [];
    const link = createHumanAskLink({ chain: hangingChain((id) => cancelled.push(id)), timeoutMs: 1_000_000 });
    const firstCtrl = new AbortController();
    const secondCtrl = new AbortController();
    const first = link.resolve(REQ, { signal: firstCtrl.signal });
    void link.resolve(REQ, { signal: secondCtrl.signal }); // second stays live
    await waitForOnScreen(link);

    firstCtrl.abort();
    expect(await first).toEqual({ decision: "deny", decidedBy: "cancelled" });

    // The second waiter is still live, so the on-screen prompt is not cancelled.
    expect(cancelled).toEqual([]);
  });

  test("AC8: aborting both same-key waiters cancels the chain prompt exactly once", async () => {
    const cancelled: string[] = [];
    const link = createHumanAskLink({ chain: hangingChain((id) => cancelled.push(id)), timeoutMs: 1_000_000 });
    const firstCtrl = new AbortController();
    const secondCtrl = new AbortController();
    const first = link.resolve(REQ, { signal: firstCtrl.signal });
    const second = link.resolve(REQ, { signal: secondCtrl.signal });
    await waitForOnScreen(link);

    firstCtrl.abort();
    secondCtrl.abort();

    expect(await first).toEqual({ decision: "deny", decidedBy: "cancelled" });
    expect(await second).toEqual({ decision: "deny", decidedBy: "cancelled" });
    expect(cancelled).toHaveLength(1);
  });

  test("cancelling a hanging prompt releases the serial queue for the next approval", async () => {
    const prompted: string[] = [];
    const chain: AskChannel = {
      prompt: (request) => {
        prompted.push(request.id);
        if (prompted.length === 1) return new Promise<AskChannelResponse>(() => {});
        return Promise.resolve({ action: "allow", respondedAt: Date.now() });
      },
      cancel: () => Promise.resolve(),
    };
    const link = createHumanAskLink({ chain, timeoutMs: 1_000_000 });
    const controller = new AbortController();
    const first = link.resolve(REQ, { signal: controller.signal });
    await waitForOnScreen(link);
    controller.abort();
    expect(await first).toEqual({ decision: "deny", decidedBy: "cancelled" });

    const second = link.resolve({ ...REQ, command: "echo next" });
    await waitForPromptCount(() => prompted.length, 2);
    expect(await second).toEqual({ decision: "allow", decidedBy: "human" });
  });

  test("AC9: a queued request that aborts before its turn is never prompted", async () => {
    const QUEUED = { ...REQ, command: "echo queued" };
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
    const link = createHumanAskLink({ chain, timeoutMs: 1_000_000 });
    const queuedCtrl = new AbortController();
    const first = link.resolve(REQ); // takes the serial queue and prompts
    const queued = link.resolve(QUEUED, { signal: queuedCtrl.signal }); // queues behind it
    await waitForPromptCount(() => promptCalls, 1);
    expect(promptCalls).toBe(1);

    queuedCtrl.abort(); // before the queued waiter's turn
    release?.({ action: "deny", respondedAt: Date.now() });

    expect(await first).toEqual({ decision: "deny", decidedBy: "human" });
    expect(await queued).toEqual({ decision: "deny", decidedBy: "cancelled" });
    expect(promptCalls).toBe(1);
  });
});

// US-004: keep the native turn alive during human approval. While a pending
// prompt is on screen the link calls every live waiter's onWaiting once at
// prompt send, then once each ASK_KEEPALIVE_MS via a re-armed cancellable
// setTimeout, clearing the timer on every settlement so a resolved prompt
// never keepsalives again. `ASK_KEEPALIVE_MS` and the timer functions live in
// `_askLinkDeps` and are swapped for a fake clock here.
describe("US-004 — keepalive while a human approval prompt is pending", () => {
  let clock: FakeClock;
  let savedTimers: { setTimeout: typeof _askLinkDeps.setTimeout; clearTimeout: typeof _askLinkDeps.clearTimeout };

  beforeEach(() => {
    clock = makeFakeClock();
    savedTimers = { setTimeout: _askLinkDeps.setTimeout, clearTimeout: _askLinkDeps.clearTimeout };
    _askLinkDeps.setTimeout = clock.setTimeout as typeof _askLinkDeps.setTimeout;
    _askLinkDeps.clearTimeout = clock.clearTimeout as typeof _askLinkDeps.clearTimeout;
  });

  afterEach(() => {
    _askLinkDeps.setTimeout = savedTimers.setTimeout;
    _askLinkDeps.clearTimeout = savedTimers.clearTimeout;
  });

  const waitForOnScreen = (link: ReturnType<typeof createHumanAskLink>) =>
    waitForCondition(() => link.pending() !== undefined, 1_000);

  test("AC2: onWaiting runs once at prompt send, then once each ASK_KEEPALIVE_MS", async () => {
    const link = createHumanAskLink({
      chain: { prompt: () => new Promise<AskChannelResponse>(() => {}), cancel: () => Promise.resolve() },
      timeoutMs: 1_000_000,
    });
    const calls: number[] = [];
    // The hanging chain never resolves, so the waiter is deliberately not
    // awaited — the keepalive cadence is what this test observes.
    void link.resolve(REQ, { onWaiting: () => calls.push(clock.now()) });
    await waitForOnScreen(link);

    // Once at prompt send.
    expect(calls).toHaveLength(1);

    // Then once each keepalive period, on the requested cadence — not sooner.
    await clock.advance(_askLinkDeps.ASK_KEEPALIVE_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1] - calls[0]).toBe(_askLinkDeps.ASK_KEEPALIVE_MS);

    await clock.advance(_askLinkDeps.ASK_KEEPALIVE_MS);
    expect(calls).toHaveLength(3);
    expect(calls[2] - calls[1]).toBe(_askLinkDeps.ASK_KEEPALIVE_MS);
  });

  test.each([
    ["allow", "human"],
    ["deny", "human"],
    ["timeout", "timeout"],
    ["cancelled", "cancelled"],
  ] as const)(
    "AC3: after the prompt settles by %s, onWaiting never runs during later keepalive periods",
    async (mode, decidedBy) => {
      let release: ((response: AskChannelResponse) => void) | undefined;
      const chain: AskChannel = {
        prompt: () =>
          new Promise<AskChannelResponse>((resolve) => {
            release = resolve;
          }),
        // Cancelling the on-screen prompt settles its pending promise, so the
        // session's runSession finally runs and the keepalive timer is freed —
        // the same way a real interaction channel's cancel resolves a prompt.
        cancel: () => {
          release?.({ action: "deny", respondedAt: Date.now() });
          return Promise.resolve();
        },
      };
      const link = createHumanAskLink({ chain, timeoutMs: 1_000_000 });
      const controller = new AbortController();
      const calls: number[] = [];
      const waiter = link.resolve(REQ, {
        onWaiting: () => calls.push(clock.now()),
        signal: controller.signal,
      });
      await waitForOnScreen(link);
      expect(calls).toHaveLength(1);

      // Settle the prompt the way the row describes.
      if (mode === "allow") release?.({ action: "allow", respondedAt: Date.now() });
      else if (mode === "deny") release?.({ action: "deny", respondedAt: Date.now() });
      else if (mode === "timeout") release?.({ action: "approve", respondedBy: "timeout", respondedAt: Date.now() });
      else controller.abort("turn ended");
      expect(await waiter).toEqual({ decision: mode === "allow" ? "allow" : "deny", decidedBy });

      // No keepalive may fire after settlement, however many periods elapse...
      await clock.advance(_askLinkDeps.ASK_KEEPALIVE_MS * 3);
      expect(calls).toHaveLength(1);
      // ...and the timer slot is freed, not merely inert.
      expect(clock.pending()).toBe(0);
    },
  );
});

describe("review #9: secrets in the prompt", () => {
  const GHP = "ghp_abcdefghijklmnop1234";

  test("Review Focus 1: a command with no secret produces the same detail as before", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    await link.resolve(REQ);
    expect(sent[0]?.detail).toContain(["```", REQ.command, "```"].join("\n"));
    expect(sent[0]?.detail).not.toContain("secret value");
  });

  test("an inert secret is masked in the detail, with a footer; onRemember gets the raw command", async () => {
    const sent: InteractionRequest[] = [];
    const remembered: string[] = [];
    const link = createHumanAskLink({
      chain: fakeChain({ reply: "allow-remember", sent }),
      timeoutMs: 1000,
      onRemember: async (req) => void remembered.push(req.command ?? ""),
    });
    const command = `gh api -H x-token ${GHP}`;
    const outcome = await link.resolve({ ...REQ, command });
    expect(outcome.decision).toBe("allow");
    expect(sent[0]?.detail).not.toContain(GHP);
    expect(sent[0]?.detail).toContain("[REDACTED:github]");
    expect(sent[0]?.detail).toContain("1 secret value(s) masked; the approved command contains them");
    expect(remembered).toEqual([command]);
  });

  test("a secret spanning shell syntax denies unshowable without prompting", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    const outcome = await link.resolve({ ...REQ, command: "curl -H 'Cookie: a=b'; rm -rf ~" });
    expect(outcome).toEqual({ decision: "deny", decidedBy: "unshowable" });
    expect(sent).toHaveLength(0);
  });

  test("a request flagged unshowable upstream (Exec) denies without prompting", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    const { command: _command, ...execReq } = REQ;
    const outcome = await link.resolve({ ...execReq, tool: "Exec", unshowable: true });
    expect(outcome.decidedBy).toBe("unshowable");
    expect(sent).toHaveLength(0);
  });

  test("Review Focus 4: masked command plus footer over the limit denies unavailable", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    // Raw length 3475 passes the old check; masked (3468) + footer line pushes it over 3500.
    const command = `${"x".repeat(3450)} ${GHP}`;
    const outcome = await link.resolve({ ...REQ, command });
    expect(outcome.decidedBy).toBe("unavailable");
    expect(sent).toHaveLength(0);
  });
});

describe("review #21: dedupe key", () => {
  function holdingChain() {
    const state = { promptCalls: 0, releases: [] as ((r: AskChannelResponse) => void)[] };
    const chain: AskChannel = {
      prompt: () => {
        state.promptCalls++;
        return new Promise<AskChannelResponse>((resolve) => {
          state.releases.push(resolve);
        });
      },
      cancel: () => Promise.resolve(),
    };
    const allowNext = (): void => {
      state.releases.shift()?.({ action: "allow", respondedAt: Date.now() });
    };
    return { chain, state, allowNext };
  }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  const { command: _command, ...NO_COMMAND } = REQ;

  test("two concurrent command-less asks get two prompts", async () => {
    const { chain, state, allowNext } = holdingChain();
    const link = createHumanAskLink({ chain, timeoutMs: 1000 });
    const a = link.resolve({ ...NO_COMMAND, tool: "Write", summary: "Write path=a.txt" });
    const b = link.resolve({ ...NO_COMMAND, tool: "Write", summary: "Write path=b.txt" });
    await tick();
    expect(state.promptCalls).toBe(1);
    allowNext();
    expect((await a).decision).toBe("allow");
    await tick();
    expect(state.promptCalls).toBe(2);
    allowNext();
    expect((await b).decision).toBe("allow");
  });

  test("the same command under two tools gets two prompts", async () => {
    const { chain, state, allowNext } = holdingChain();
    const link = createHumanAskLink({ chain, timeoutMs: 1000 });
    const a = link.resolve(REQ);
    const b = link.resolve({ ...REQ, tool: "Exec" });
    await tick();
    allowNext();
    await a;
    await tick();
    expect(state.promptCalls).toBe(2);
    allowNext();
    await b;
  });

  test("two identical Bash asks still share one prompt", async () => {
    const { chain, state, allowNext } = holdingChain();
    const link = createHumanAskLink({ chain, timeoutMs: 1000 });
    const a = link.resolve(REQ);
    const b = link.resolve(REQ);
    await tick();
    allowNext();
    expect(await a).toEqual({ decision: "allow", decidedBy: "human" });
    expect(await b).toEqual({ decision: "allow", decidedBy: "human" });
    expect(state.promptCalls).toBe(1);
  });

  test("cancel() settles a pending command-less ask", async () => {
    const { chain } = holdingChain();
    const link = createHumanAskLink({ chain, timeoutMs: 1000 });
    const pending = link.resolve({ ...NO_COMMAND, tool: "Write", summary: "Write path=a.txt" });
    await tick();
    await link.cancel();
    expect((await pending).decision).toBe("deny");
  });
});

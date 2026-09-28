import { describe, expect, test } from "bun:test";
import { assertDefined, waitForCondition } from "@test/helpers";
import { type AskChannel, type AskChannelResponse, createHumanAskLink, type InteractionRequest } from "@/interaction";
import type { AskRequest } from "@/permissions";

/**
 * Characterisation of `runSession` branches the mirror suite leaves unpinned,
 * written green against the UNREFACTORED function (B7 complexity drain).
 *
 * Pinned here, one test each:
 * - `pending()` clears once the prompt settles (the activeId reset in
 *   runSession's finally), on the allow path and after link-level cancel;
 * - link-level cancel settles the waiter `unavailable` (the story's "out of
 *   scope" rule: the link-level abort is never `cancelled`);
 * - the dispatched request carries `featureName`/`storyId`/`summary` when
 *   supplied, and defaults `featureName` to "unknown" while omitting the
 *   `storyId` key entirely;
 * - the detail block's fallback arms: `runs in: unknown` for a root-less ask,
 *   `reason:` falling back to the rule, and the `stage:` line;
 * - a throwing chain attributes the deny to `unavailable`;
 * - a real response arriving after the sole waiter aborted settles nobody and
 *   releases the serial queue (the `size === 0` arm of the post-race guard).
 */

const REQ: AskRequest = {
  tool: "Bash",
  stage: "implementer",
  rule: "Bash",
  summary: "Bash command=bun run test",
  command: "bun run test 2>&1 | tail -n 40",
  root: "/repo",
  reason: "segment 2 (`tail`) matched no allow rule",
};

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

function releaseChain(): { chain: AskChannel; promptCalls: () => number; release: () => void } {
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
  return {
    chain,
    promptCalls: () => promptCalls,
    release: () => release?.({ action: "allow", respondedAt: Date.now() }),
  };
}

const waitForOnScreen = (link: ReturnType<typeof createHumanAskLink>) =>
  waitForCondition(() => link.pending() !== undefined, 1_000);

describe("runSession edges (B7 characterisation)", () => {
  test("pending() clears once the prompt settles on the allow path", async () => {
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow" }), timeoutMs: 1000 });
    expect((await link.resolve(REQ)).decision).toBe("allow");
    expect(link.pending()).toBeUndefined();
  });

  test("link-level cancel settles the waiter unavailable and clears pending()", async () => {
    const chain: AskChannel = {
      prompt: () => new Promise<AskChannelResponse>(() => {}),
      cancel: () => Promise.resolve(),
    };
    const link = createHumanAskLink({ chain, timeoutMs: 3_600_000 });
    const waiter = link.resolve(REQ);
    await waitForOnScreen(link);

    await link.cancel();

    expect(await waiter).toEqual({ decision: "deny", decidedBy: "unavailable" });
    await waitForCondition(() => link.pending() === undefined, 1_000);
  });

  test("the dispatched request carries featureName, storyId and the approval summary when supplied", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({
      chain: fakeChain({ reply: "allow", sent }),
      timeoutMs: 1000,
      featureName: "my-feature",
      storyId: "S-42",
    });
    await link.resolve(REQ);
    expect(sent[0]?.featureName).toBe("my-feature");
    assertDefined(sent[0], "dispatched request");
    expect("storyId" in sent[0]).toBe(true);
    expect(sent[0].storyId).toBe("S-42");
    expect(sent[0].summary).toBe("Bash - approval required");
  });

  test("the dispatched request defaults featureName to 'unknown' and omits the storyId key", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    await link.resolve(REQ);
    assertDefined(sent[0], "dispatched request");
    expect(sent[0].featureName).toBe("unknown");
    expect("storyId" in sent[0]).toBe(false);
  });

  test("detail fallbacks: root-less ask renders 'runs in: unknown', reason falls back to the rule, stage is shown", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "deny", sent }), timeoutMs: 1000 });
    const { root: _root, reason: _reason, ...bare } = REQ;
    await link.resolve(bare);
    const detail = sent[0]?.detail ?? "";
    expect(detail).toContain("runs in: unknown");
    expect(detail).toContain("reason:  Bash");
    expect(detail).toContain("stage:   implementer");
  });

  test("a throwing chain attributes the deny to 'unavailable'", async () => {
    const link = createHumanAskLink({ chain: fakeChain({ throws: true }), timeoutMs: 1000 });
    expect(await link.resolve(REQ)).toEqual({ decision: "deny", decidedBy: "unavailable" });
  });

  test("a real response after the sole waiter aborted settles nobody and releases the queue", async () => {
    const { chain, promptCalls, release } = releaseChain();
    const link = createHumanAskLink({ chain, timeoutMs: 1_000_000 });
    const controller = new AbortController();
    const waiter = link.resolve(REQ, { signal: controller.signal });
    await waitForOnScreen(link);

    controller.abort();
    expect(await waiter).toEqual({ decision: "deny", decidedBy: "cancelled" });

    // The prompt resolves with a real allow, but no waiter is live: the guard
    // must return early (settling nothing), not deliver "allow" anywhere, and
    // not hold the serial queue.
    release();
    await new Promise<void>((r) => setTimeout(r, 10));

    const next = link.resolve({ ...REQ, command: "echo after" });
    await waitForCondition(() => promptCalls() === 2, 1_000);
    release();
    expect(await next).toEqual({ decision: "allow", decidedBy: "human" });
    expect(promptCalls()).toBe(2);
  });
});

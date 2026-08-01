/**
 * Telegram Interaction Plugin — inbound chat authorization tests.
 *
 * Split out of telegram.test.ts, which was at the 800-line limit.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { InteractionRequest } from "@/interaction";
import { TelegramInteractionPlugin, _telegramPluginDeps, normalizeChatId } from "@/interaction";

// The poll loop sleeps `basePollBackoffMs` between getUpdates calls, so with the
// production 1s base every multi-poll test costs seconds of wall-clock. The
// behaviour under test is ordering and filtering, not the production cadence —
// shrink the base and scale the receive() timeouts to match.
const POLL_BACKOFF_MS = 20;
const originalBackoffMs = _telegramPluginDeps.basePollBackoffMs;

beforeEach(() => {
  _telegramPluginDeps.basePollBackoffMs = POLL_BACKOFF_MS;
});

afterEach(() => {
  _telegramPluginDeps.basePollBackoffMs = originalBackoffMs;
});

// ---------------------------------------------------------------------------
// Inbound chat authorization (closes #1365)
//
// getUpdates() returns updates from EVERY chat the bot participates in. Without
// a chat-id filter at ingestion, any third party who can message the bot can
// answer a pending input interaction -- injected straight into the coding
// agent's turn by the ACP interaction bridge -- or forge a callback_query to
// approve, reject, or abort a run. Request ids are deterministic and guessable
// for some flows.
// ---------------------------------------------------------------------------

describe("TelegramInteractionPlugin - inbound chat authorization", () => {
  const originalFetch = _telegramPluginDeps.fetch;

  afterEach(() => {
    mock.restore();
    _telegramPluginDeps.fetch = originalFetch;
  });

  /**
   * Stubs the Telegram API.
   *
   * Two behaviours here are load-bearing, and getting either wrong produces a
   * test that passes for the wrong reason:
   *
   * 1. Updates stay INVISIBLE until sendMessage has been called. send() calls
   *    drainBacklog() before posting the prompt, so an update that is visible
   *    from the start is consumed by the drain and never reaches receive() at
   *    all -- the assertion would then pass even with the security fix reverted.
   *    Gating on `posted` models what actually happens: the attacker taps the
   *    button after the prompt appears.
   *
   * 2. getUpdates honours the offset, so an update is served once and not
   *    re-served. That is what makes the lastUpdateId test meaningful.
   */
  function stubTelegram(updates: Array<Record<string, unknown>>) {
    const acked: string[] = [];
    const offsets: number[] = [];
    let posted = false;

    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = JSON.parse((init?.body as string) ?? "{}");

      if (urlStr.includes("sendMessage")) {
        posted = true;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: 99999 } } }), {
          status: 200,
        });
      }
      if (urlStr.includes("answerCallbackQuery")) {
        acked.push(body.callback_query_id as string);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (urlStr.includes("getUpdates")) {
        const offset = body.offset as number;
        offsets.push(offset);
        const visible = posted ? updates.filter((u) => (u.update_id as number) >= offset) : [];
        return new Response(JSON.stringify({ ok: true, result: visible }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    return { acked, offsets };
  }

  function makeConfirmRequest(id: string): InteractionRequest {
    return {
      id,
      type: "confirm",
      featureName: "my-feature",
      stage: "review",
      summary: "Proceed with merge?",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest;
  }

  test("a correctly-formed callback_query from a foreign chat does not resolve the request", async () => {
    stubTelegram([
      {
        update_id: 1,
        callback_query: {
          id: "cq-foreign",
          // Payload is exactly what a legitimate approval looks like.
          data: "auth-1:approve",
          message: { message_id: 10, chat: { id: 424242 } },
        },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("auth-1"));

    const response = await plugin.receive("auth-1", 60);

    expect(response.respondedBy).toBe("timeout");
    expect(response.action).not.toBe("approve");
  });

  test("a foreign callback_query is never acknowledged", async () => {
    const { acked } = stubTelegram([
      {
        update_id: 1,
        callback_query: {
          id: "cq-foreign",
          data: "auth-2:approve",
          message: { message_id: 10, chat: { id: 424242 } },
        },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("auth-2"));
    await plugin.receive("auth-2", 60);

    expect(acked).not.toContain("cq-foreign");
  });

  test("a text message from a foreign chat does not answer a pending input request", async () => {
    stubTelegram([
      {
        update_id: 1,
        message: { message_id: 77, chat: { id: 424242 }, text: "rm -rf /" },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send({
      id: "auth-3",
      type: "input",
      featureName: "my-feature",
      stage: "review",
      summary: "What should I do?",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest);

    const response = await plugin.receive("auth-3", 60);

    expect(response.respondedBy).toBe("timeout");
    expect(response.value).toBeUndefined();
  });

  test("lastUpdateId still advances past foreign updates so they are not re-served forever", async () => {
    const { offsets } = stubTelegram([
      {
        update_id: 7,
        message: { message_id: 77, chat: { id: 424242 }, text: "noise" },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("auth-4"));
    // Must span several backoff cycles: a timeout shorter than one POLL_BACKOFF_MS
    // yields a single poll and never demonstrates the offset moving.
    await plugin.receive("auth-4", POLL_BACKOFF_MS * 8);

    // Reaching offset 8 is the discriminating assertion. If the filter ran
    // before lastUpdateId advanced, the offset would stay parked at 1 forever
    // and 8 would never appear.
    expect(offsets).toContain(8);
    expect(offsets.at(-1)).toBe(8);
  });

  test("a callback_query from the configured chat still resolves", async () => {
    stubTelegram([
      {
        update_id: 1,
        callback_query: {
          id: "cq-ok",
          data: "auth-5:approve",
          message: { message_id: 10, chat: { id: 99999 } },
        },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("auth-5"));

    const response = await plugin.receive("auth-5", 1000);

    expect(response.action).toBe("approve");
    expect(response.respondedBy).toBe("telegram");
  });

  test("a text reply from the configured chat still answers an input request", async () => {
    stubTelegram([
      {
        update_id: 1,
        message: { message_id: 78, chat: { id: 99999 }, text: "ship it" },
      },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send({
      id: "auth-6",
      type: "input",
      featureName: "my-feature",
      stage: "review",
      summary: "What should I do?",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest);

    const response = await plugin.receive("auth-6", 1000);

    expect(response.action).toBe("input");
    expect(response.value).toBe("ship it");
  });
});

// ---------------------------------------------------------------------------
// Backlog drain vs. the authorization filter
//
// drainBacklog() advances lastUpdateId past everything already queued so a stale
// update can never be misread as the answer to the next prompt. Once ingestion
// filtering landed, the drain's "this page was empty, we're done" signal had to
// keep meaning "Telegram has nothing left" -- not "nothing on this page was
// ours". A page filled entirely with foreign traffic is the case that separates
// the two.
// ---------------------------------------------------------------------------

describe("TelegramInteractionPlugin - backlog drain with foreign traffic", () => {
  const originalFetch = _telegramPluginDeps.fetch;

  afterEach(() => {
    mock.restore();
    _telegramPluginDeps.fetch = originalFetch;
  });

  /**
   * Stubs Telegram with a ONE-UPDATE-PER-PAGE getUpdates.
   *
   * The page size is the whole point. Telegram serves getUpdates in pages, and
   * the bug only appears when a page contains foreign updates and nothing else
   * -- with every update crammed into a single page the filter always leaves
   * something behind and the drain keeps going for the wrong reason.
   */
  function stubPagedTelegram(updates: Array<Record<string, unknown>>) {
    const getUpdatesCalls: number[] = [];

    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = JSON.parse((init?.body as string) ?? "{}");

      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: 99999 } } }), {
          status: 200,
        });
      }
      if (urlStr.includes("getUpdates")) {
        const offset = body.offset as number;
        getUpdatesCalls.push(offset);
        const next = updates.find((u) => (u.update_id as number) >= offset);
        return new Response(JSON.stringify({ ok: true, result: next ? [next] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    return { getUpdatesCalls };
  }

  test("a page of purely foreign updates does not end the drain early", async () => {
    // Update 1 is foreign and fills its whole page; update 2 is a stale message
    // from the configured chat that predates the prompt. The drain must get past
    // the foreign page and consume BOTH.
    //
    // Exactly one foreign update, deliberately: the stale update then sits on the
    // very first page receive() would poll, so the bug shows up on the first poll
    // and the test needs no backoff cycles to expose it.
    stubPagedTelegram([
      { update_id: 1, message: { message_id: 71, chat: { id: 424242 }, text: "noise" } },
      { update_id: 2, message: { message_id: 74, chat: { id: 99999 }, text: "yes do it" } },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send({
      id: "drain-1",
      type: "input",
      featureName: "my-feature",
      stage: "review",
      summary: "What should I do?",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest);

    const response = await plugin.receive("drain-1", 60);

    // "yes do it" was sitting in the queue BEFORE the prompt was posted, so it
    // cannot be the answer to it. If the drain stopped at update 1 -- the first
    // page holding only foreign traffic -- this comes back as a real answer.
    expect(response.respondedBy).toBe("timeout");
    expect(response.value).toBeUndefined();
  });

  test("the drain still stops once Telegram reports an empty page", async () => {
    const { getUpdatesCalls } = stubPagedTelegram([
      { update_id: 1, message: { message_id: 71, chat: { id: 424242 }, text: "noise" } },
    ]);

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send({
      id: "drain-2",
      type: "confirm",
      featureName: "my-feature",
      stage: "review",
      summary: "Proceed?",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest);

    // One page holding update 1, then one empty page. Anything more means the
    // drain is burning its full MAX_DRAIN_PAGES budget on every single send().
    expect(getUpdatesCalls).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Configured chat id normalization
//
// The filter compares the inbound chat.id against the configured one as a
// string. An id that cannot match anything Telegram will ever send makes every
// inbound update fail the filter -- send() still works, so the prompt appears
// and simply never accepts an answer. That has to be loud, not silent.
// ---------------------------------------------------------------------------

describe("normalizeChatId", () => {
  test("strips surrounding whitespace", () => {
    expect(normalizeChatId("  99999  ").chatId).toBe("99999");
  });

  test("accepts negative ids used by groups and supergroups", () => {
    const result = normalizeChatId("-1001234567890");
    expect(result.chatId).toBe("-1001234567890");
    expect(result.unmatchable).toBe(false);
  });

  test("accepts a plain numeric id", () => {
    expect(normalizeChatId("99999").unmatchable).toBe(false);
  });

  test("flags an @username id as unmatchable against inbound updates", () => {
    // Valid for sendMessage, which is exactly why this fails silently today:
    // outbound works, so nothing looks broken until an answer never arrives.
    expect(normalizeChatId("@mychannel").unmatchable).toBe(true);
  });

  test("flags a non-numeric id as unmatchable", () => {
    expect(normalizeChatId("not-an-id").unmatchable).toBe(true);
  });
});

describe("TelegramInteractionPlugin - configured chat id normalization", () => {
  const originalFetch = _telegramPluginDeps.fetch;

  afterEach(() => {
    mock.restore();
    _telegramPluginDeps.fetch = originalFetch;
  });

  test("a whitespace-padded chatId still accepts a callback from that chat", async () => {
    let posted = false;
    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (urlStr.includes("sendMessage")) {
        posted = true;
        return new Response(JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: 99999 } } }), {
          status: 200,
        });
      }
      if (urlStr.includes("getUpdates")) {
        const offset = body.offset as number;
        const update = {
          update_id: 1,
          callback_query: { id: "cq-ok", data: "norm-1:approve", message: { message_id: 10, chat: { id: 99999 } } },
        };
        const visible = posted && offset <= 1 ? [update] : [];
        return new Response(JSON.stringify({ ok: true, result: visible }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    // Trailing whitespace is easy to pick up from a .env file or a copy-paste.
    await plugin.init({ botToken: "bot-abc123", chatId: " 99999\n" });
    await plugin.send({
      id: "norm-1",
      type: "confirm",
      featureName: "my-feature",
      stage: "review",
      summary: "Proceed?",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest);

    const response = await plugin.receive("norm-1", 60);

    expect(response.action).toBe("approve");
    expect(response.respondedBy).toBe("telegram");
  });
});

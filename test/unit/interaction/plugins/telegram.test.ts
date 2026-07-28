/**
 * Telegram Interaction Plugin Unit Tests
 *
 * Split out of interaction-plugins.test.ts, which was at the 800-line limit.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { InteractionRequest } from "@/interaction";
import { TelegramInteractionPlugin } from "@/interaction";
import { _telegramPluginDeps } from "../../../../src/interaction/plugins/telegram";

describe("TelegramInteractionPlugin", () => {
  let savedToken: string | undefined;
  let savedChatId: string | undefined;
  let savedBotToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env.NAX_TELEGRAM_TOKEN;
    savedChatId = process.env.NAX_TELEGRAM_CHAT_ID;
    savedBotToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.NAX_TELEGRAM_TOKEN;
    delete process.env.NAX_TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    if (savedToken !== undefined) process.env.NAX_TELEGRAM_TOKEN = savedToken;
    else delete process.env.NAX_TELEGRAM_TOKEN;
    if (savedChatId !== undefined) process.env.NAX_TELEGRAM_CHAT_ID = savedChatId;
    else delete process.env.NAX_TELEGRAM_CHAT_ID;
    if (savedBotToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedBotToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
  });

  test("should validate required config", async () => {
    const plugin = new TelegramInteractionPlugin();

    // Should throw without botToken and chatId
    await expect(plugin.init({})).rejects.toThrow("botToken and chatId");
  });

  test("should initialize with config", async () => {
    const plugin = new TelegramInteractionPlugin();

    await plugin.init({
      botToken: "test-token",
      chatId: "12345",
    });

    expect(plugin.name).toBe("telegram");
  });

  test("should initialize with env vars", async () => {
    const plugin = new TelegramInteractionPlugin();

    // Set env vars
    process.env.NAX_TELEGRAM_TOKEN = "env-token";
    process.env.NAX_TELEGRAM_CHAT_ID = "env-chat";

    await plugin.init({});

    expect(plugin.name).toBe("telegram");

    // Cleanup
    process.env.NAX_TELEGRAM_TOKEN = undefined;
    process.env.NAX_TELEGRAM_CHAT_ID = undefined;
  });
});

// ---------------------------------------------------------------------------
// Telegram send() and poll() flow tests (TC-006)
// ---------------------------------------------------------------------------

describe("TelegramInteractionPlugin - send() and poll()", () => {
  const originalFetch = _telegramPluginDeps.fetch;

  afterEach(() => {
    mock.restore();
    _telegramPluginDeps.fetch = originalFetch;
  });

  function makeConfirmRequest(id: string): InteractionRequest {
    return {
      id,
      type: "confirm",
      featureName: "my-feature",
      stage: "review",
      summary: "Proceed with merge?",
      fallback: "abort",
      createdAt: Date.now(),
    };
  }

  test("send() POSTs to correct Telegram API URL with message text and inline keyboard", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      // Only track sendMessage calls — init() also calls getUpdates() to drain any backlog.
      if (urlStr.includes("sendMessage")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        calls.push({ url: urlStr, body });
      }
      if (urlStr.includes("getUpdates")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 12345 } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    await plugin.send(makeConfirmRequest("tg-send-1"));

    expect(calls).toHaveLength(1);
    const { url, body } = calls[0];

    // Correct API endpoint
    expect(url).toContain("api.telegram.org/botbot-abc123/sendMessage");

    // Correct chat_id
    expect(body.chat_id).toBe("99999");

    // Message text present
    expect(typeof body.text).toBe("string");
    expect((body.text as string).length).toBeGreaterThan(0);

    // Inline keyboard has approve and reject buttons
    const keyboard = (body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard;
    expect(Array.isArray(keyboard)).toBe(true);
    const allButtons = keyboard.flat();
    const approveBtn = allButtons.find((b) => b.callback_data === "tg-send-1:approve");
    const rejectBtn = allButtons.find((b) => b.callback_data === "tg-send-1:reject");
    expect(approveBtn).toBeDefined();
    expect(rejectBtn).toBeDefined();
  });

  test("receive() parses callback_query correctly", async () => {
    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: 99999 } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("getUpdates")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: {
                  id: "cq-001",
                  data: "tg-poll-1:approve",
                  message: { message_id: 10, chat: { id: 99999 } },
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    // send() first so message_id is stored (needed for text-message flow, not callback_query)
    await plugin.send(makeConfirmRequest("tg-poll-1"));

    const response = await plugin.receive("tg-poll-1", 5000);

    expect(response.action).toBe("approve");
    expect(response.respondedBy).toBe("telegram");
    expect(response.requestId).toBe("tg-poll-1");
  });

  test("receive() handles choose callback_query with value", async () => {
    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 11, chat: { id: 99999 } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("getUpdates")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 2,
                callback_query: {
                  id: "cq-002",
                  data: "tg-choose-1:choose:option-b",
                  message: { message_id: 11, chat: { id: 99999 } },
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    const chooseRequest: InteractionRequest = {
      id: "tg-choose-1",
      type: "choose",
      featureName: "my-feature",
      stage: "review",
      summary: "Which option?",
      fallback: "continue",
      createdAt: Date.now(),
      options: [
        { key: "a", label: "Option A" },
        { key: "b", label: "Option B" },
      ],
    };

    await plugin.send(chooseRequest);
    const response = await plugin.receive("tg-choose-1", 5000);

    expect(response.action).toBe("choose");
    expect(response.value).toBe("option-b");
  });

  test("receive() acknowledges callback queries even when requestId does not match", async () => {
    const answeredCallbackIds: string[] = [];
    let resolveOtherAck: (() => void) | null = null;
    let resolveCurrentAck: (() => void) | null = null;
    const otherAcked = new Promise<void>((resolve) => {
      resolveOtherAck = resolve;
    });
    const currentAcked = new Promise<void>((resolve) => {
      resolveCurrentAck = resolve;
    });

    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 12, chat: { id: 99999 } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("getUpdates")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 3,
                callback_query: {
                  id: "cq-other",
                  data: "other-request:approve",
                  message: { message_id: 12, chat: { id: 99999 } },
                },
              },
              {
                update_id: 4,
                callback_query: {
                  id: "cq-current",
                  data: "tg-match-1:approve",
                  message: { message_id: 12, chat: { id: 99999 } },
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("answerCallbackQuery")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { callback_query_id?: string };
        if (body.callback_query_id === "cq-other") {
          answeredCallbackIds.push(body.callback_query_id);
          resolveOtherAck?.();
        }
        if (body.callback_query_id === "cq-current") {
          answeredCallbackIds.push(body.callback_query_id);
          resolveCurrentAck?.();
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (urlStr.includes("editMessageReplyMarkup")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    await plugin.send(makeConfirmRequest("tg-match-1"));
    const response = await plugin.receive("tg-match-1", 5000);
    await Promise.all([otherAcked, currentAcked]);

    expect(response.action).toBe("approve");
    expect(answeredCallbackIds).toContain("cq-other");
    expect(answeredCallbackIds).toContain("cq-current");
  });

  test("send() drains stale backlog so receive() does not misattribute it as the answer", async () => {
    // Regression: paused-story prompts reuse a deterministic requestId
    // (`ix-<storyId>-paused-resume`) across runs. If a prior run posted the same
    // prompt and crashed/exited before the human tapped a button, that stale
    // callback_query sits in Telegram's queue. A fresh plugin instance starts at
    // lastUpdateId=0, so without draining, the very first receive() poll for the
    // *new* run's identically-named request would replay that old tap and resolve
    // instantly — exactly the reported symptom (resolved before the human replied).
    // Using a callback_query here (not text) means this test exercises the backlog
    // drain specifically, independent of the type==="input" text-gating fix below.
    const staleUpdate = {
      update_id: 1,
      callback_query: {
        id: "cq-stale",
        data: "ix-US-002-paused-resume:resume",
        message: { message_id: 999, chat: { id: 99999 } },
      },
    };

    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 20, chat: { id: 99999 } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("getUpdates")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { offset?: number };
        const offset = body.offset ?? 0;
        // Real Telegram semantics: only updates with update_id >= offset are returned.
        const pending = staleUpdate.update_id >= offset ? [staleUpdate] : [];
        return new Response(JSON.stringify({ ok: true, result: pending }), { status: 200 });
      }

      if (urlStr.includes("answerCallbackQuery") || urlStr.includes("editMessageReplyMarkup")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" }); // no network call — nothing drained here

    const chooseRequest: InteractionRequest = {
      id: "ix-US-002-paused-resume",
      type: "choose",
      featureName: "my-feature",
      stage: "pre-flight",
      summary: "Story is paused — how to proceed?",
      fallback: "continue",
      createdAt: Date.now(),
      options: [
        { key: "resume", label: "Resume" },
        { key: "skip", label: "Skip" },
        { key: "keep", label: "Keep paused" },
      ],
    };

    // send() drains the backlog immediately before posting — the stale tap above
    // is consumed and discarded here, before pendingMessages is even populated.
    await plugin.send(chooseRequest);

    // No new update arrives after send() — the stale tap must not be replayed as
    // the answer. receive() should time out instead of resolving instantly.
    const response = await plugin.receive("ix-US-002-paused-resume", 150);

    expect(response.respondedBy).toBe("timeout");
  });

  test("receive() ignores a plain-text reply to a button-only (choose) prompt", async () => {
    // Regression (C2): the proximate cause of the reported incident. A `choose`
    // request is only ever answerable via the inline keyboard buttons nax posts
    // for it (see buildKeyboard()) — a stray or misdirected plain-text message must
    // never be treated as its answer, even when it *is* a direct reply to the
    // prompt message. Only `type: "input"` requests accept free text.
    //
    // getUpdatesCallCount gates when the reply becomes visible: call #1 is send()'s
    // own pre-post backlog drain (must see nothing — the reply doesn't exist yet),
    // calls #2+ are receive()'s polls, simulating the human replying only after the
    // prompt was actually posted.
    let getUpdatesCallCount = 0;

    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 30, chat: { id: 99999 } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("getUpdates")) {
        getUpdatesCallCount++;
        if (getUpdatesCallCount === 1) {
          return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
        }
        const textReply = {
          update_id: 1,
          message: {
            message_id: 31,
            chat: { id: 99999 },
            text: "resume",
            reply_to_message: { message_id: 30, chat: { id: 99999 } },
          },
        };
        return new Response(JSON.stringify({ ok: true, result: [textReply] }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    const chooseRequest: InteractionRequest = {
      id: "tg-choose-text-reply-1",
      type: "choose",
      featureName: "my-feature",
      stage: "pre-flight",
      summary: "Story is paused — how to proceed?",
      fallback: "continue",
      createdAt: Date.now(),
      options: [
        { key: "resume", label: "Resume" },
        { key: "skip", label: "Skip" },
      ],
    };

    await plugin.send(chooseRequest);

    // The text reply is a direct reply to the correct message and matches an
    // option key, yet must still be rejected — buttons are the only valid answer.
    const response = await plugin.receive("tg-choose-text-reply-1", 150);

    expect(response.respondedBy).toBe("timeout");
  });

  test("receive() clears inline keyboard on successful callback response", async () => {
    const replyMarkupBodies: Array<Record<string, unknown>> = [];
    let resolveMarkupClear: (() => void) | null = null;
    const markupCleared = new Promise<void>((resolve) => {
      resolveMarkupClear = resolve;
    });

    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 13, chat: { id: 99999 } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("getUpdates")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 5,
                callback_query: {
                  id: "cq-clear",
                  data: "tg-clear-1:approve",
                  message: { message_id: 13, chat: { id: 99999 } },
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (urlStr.includes("editMessageReplyMarkup")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
        replyMarkupBodies.push(body);
        resolveMarkupClear?.();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    await plugin.send(makeConfirmRequest("tg-clear-1"));
    const response = await plugin.receive("tg-clear-1", 5000);
    await markupCleared;

    expect(response.action).toBe("approve");
    expect(replyMarkupBodies).toHaveLength(1);
    expect(replyMarkupBodies[0].message_id).toBe(13);
    expect((replyMarkupBodies[0].reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _telegramPluginDeps.fetch seam (closes #1366)
// ---------------------------------------------------------------------------

describe("TelegramInteractionPlugin - fetch deps seam", () => {
  const originalFetch = _telegramPluginDeps.fetch;

  afterEach(() => {
    mock.restore();
    _telegramPluginDeps.fetch = originalFetch;
  });

  test("send() routes through _telegramPluginDeps.fetch, not the global", async () => {
    const urls: string[] = [];
    _telegramPluginDeps.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      urls.push(urlStr);
      if (urlStr.includes("getUpdates")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 99999 } } }),
        { status: 200 },
      );
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send({
      id: "deps-1",
      type: "confirm",
      featureName: "f",
      stage: "review",
      summary: "s",
      fallback: "abort",
      createdAt: Date.now(),
    } as InteractionRequest);

    expect(urls.some((u) => u.includes("sendMessage"))).toBe(true);
  });
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

    const response = await plugin.receive("auth-1", 300);

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
    await plugin.receive("auth-2", 300);

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

    const response = await plugin.receive("auth-3", 300);

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
    // 2500ms, not 300ms: the poll loop backs off 1000ms between attempts, so a
    // short timeout yields a single poll and never demonstrates the offset moving.
    await plugin.receive("auth-4", 2500);

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

    const response = await plugin.receive("auth-5", 5000);

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

    const response = await plugin.receive("auth-6", 5000);

    expect(response.action).toBe("input");
    expect(response.value).toBe("ship it");
  });
});

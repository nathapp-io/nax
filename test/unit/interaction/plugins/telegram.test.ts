/**
 * Telegram Interaction Plugin Unit Tests
 *
 * Split out of interaction-plugins.test.ts, which was at the 800-line limit.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockFetch } from "@test/helpers";
import type { InteractionRequest } from "@/interaction";
import { _telegramPluginDeps, TelegramInteractionPlugin, truncateIdForCallbackData } from "@/interaction";

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
    delete process.env.NAX_TELEGRAM_TOKEN;
    delete process.env.NAX_TELEGRAM_CHAT_ID;
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

  // A ":" in the request id cannot round-trip through the callback_data grammar,
  // so buildKeyboard rejects it. That rejection must not escape send(): the
  // interaction chain has no fallback cascade on the send path, so a throw here
  // would take down the run, where every other interaction failure degrades to
  // the request's own `fallback`. Degrade loudly instead — send the prompt
  // without buttons rather than crashing.
  test("send() degrades to a button-free message when the request id cannot round-trip", async () => {
    const calls: Array<Record<string, unknown>> = [];

    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes("sendMessage")) calls.push(JSON.parse((init?.body as string) ?? "{}"));
      if (urlStr.includes("getUpdates")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      const body = JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: 12345 } } });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    await plugin.send(makeConfirmRequest("tg:bad:id"));

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("reply_markup");
  });

  test("send() POSTs to correct Telegram API URL with message text and inline keyboard", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      // Only track sendMessage calls — init() also calls getUpdates() to drain any backlog.
      if (urlStr.includes("sendMessage")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        calls.push({ url: urlStr, body });
      }
      if (urlStr.includes("getUpdates")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 12345 } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

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
    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: 99999 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
    });

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
    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 11, chat: { id: 99999 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
    });

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

  test("one shared poll dispatches concurrent prompt responses to their matching receivers", async () => {
    let interactive = false;
    let updatePolls = 0;
    _telegramPluginDeps.fetch = Object.assign(
      async (url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes("sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 12, chat: { id: 99999 } } }));
        }
        if (urlStr.includes("getUpdates")) {
          if (!interactive) return new Response(JSON.stringify({ ok: true, result: [] }));
          updatePolls++;
          const result =
            updatePolls === 1
              ? [
                  {
                    update_id: 10,
                    callback_query: {
                      id: "cq-a",
                      data: "tg-a:approve",
                      message: { message_id: 12, chat: { id: 99999 } },
                    },
                  },
                  {
                    update_id: 11,
                    callback_query: {
                      id: "cq-b",
                      data: "tg-b:reject",
                      message: { message_id: 12, chat: { id: 99999 } },
                    },
                  },
                ]
              : [];
          return new Response(JSON.stringify({ ok: true, result }));
        }
        return new Response(JSON.stringify({ ok: true }));
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("tg-a"));
    await plugin.send(makeConfirmRequest("tg-b"));
    interactive = true;

    const [first, second] = await Promise.all([plugin.receive("tg-a", 100), plugin.receive("tg-b", 100)]);

    expect(first.action).toBe("approve");
    expect(second.action).toBe("reject");
    expect(updatePolls).toBe(1);
  });

  test("buffers a prompt response fetched before that prompt calls receive", async () => {
    let interactive = false;
    _telegramPluginDeps.fetch = Object.assign(
      async (url: string | URL | Request) => {
        const urlStr = url.toString();
        if (urlStr.includes("sendMessage")) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 13, chat: { id: 99999 } } }));
        }
        if (urlStr.includes("getUpdates")) {
          const result = interactive
            ? [
                {
                  update_id: 20,
                  callback_query: {
                    id: "cq-b",
                    data: "tg-late-b:reject",
                    message: { message_id: 13, chat: { id: 99999 } },
                  },
                },
              ]
            : [];
          interactive = false;
          return new Response(JSON.stringify({ ok: true, result }));
        }
        return new Response(JSON.stringify({ ok: true }));
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("tg-a"));
    await plugin.send(makeConfirmRequest("tg-late-b"));
    interactive = true;

    const firstReceiver = plugin.receive("tg-a", 30);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondReceiver = plugin.receive("tg-late-b", 30);

    expect((await secondReceiver).action).toBe("reject");
    expect((await firstReceiver).action).toBe("skip");
  });

  test("BUG-48: receive() matches a callback_query built from a long (truncated) request id", async () => {
    // A long id (e.g. a UUID-prefixed story/request id) means buildKeyboard()
    // truncates the id in callback_data to stay within Telegram's 64-byte
    // limit. Telegram echoes back exactly what was sent, so the response
    // received on getUpdates() carries the truncated id — receive() must
    // still resolve it to the original (full) requestId.
    const longId = `req-${"z".repeat(80)}`;

    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> };
        };
        const approveBtn = body.reply_markup?.inline_keyboard.flat().find((b) => b.callback_data.endsWith(":approve"));
        expect(approveBtn).toBeDefined();
        // Every callback_data Telegram would accept must be <=64 bytes.
        for (const btn of body.reply_markup?.inline_keyboard.flat() ?? []) {
          expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThanOrEqual(64);
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 13, chat: { id: 99999 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlStr.includes("getUpdates")) {
        // The truncated id, as Telegram would actually echo it back — computed
        // via the real truncation function so build/parse can't silently drift.
        const truncatedId = truncateIdForCallbackData(longId, ":approve");
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 4,
                callback_query: {
                  id: "cq-long-id",
                  data: `${truncatedId}:approve`,
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

      return new Response("not found", { status: 404 });
    });

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    await plugin.send(makeConfirmRequest(longId));
    const response = await plugin.receive(longId, 5000);

    expect(response.action).toBe("approve");
    expect(response.requestId).toBe(longId);
  });

  // BUG-42 (D-26): parts[1] used to be cast to InteractionResponse["action"]
  // without validating. An unknown action then fell through every switch arm
  // with no observable failure. Now the plugin logs a warn and returns null
  // (a no-op) so a malformed callback can never silently route through —
  // receive() must time out instead of resolving with the bogus action.
  test("BUG-42: receive() ignores a callback with an unknown action", async () => {
    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 30, chat: { id: 99999 } } }));
      }
      if (urlStr.includes("getUpdates")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 40,
                callback_query: {
                  id: "cq-bogus",
                  // Garbage action — must not be accepted.
                  data: "tg-bogus:rm-rf:DOES_NOT_EXIST",
                  message: { message_id: 30, chat: { id: 99999 } },
                },
              },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ ok: true }));
    });

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });
    await plugin.send(makeConfirmRequest("tg-bogus"));

    // The unknown-action callback must be ignored — receive() falls
    // through to its timeout, which resolves as { action: "skip",
    // respondedBy: "timeout" }. It must NOT resolve with the bogus
    // action or value.
    const response = await plugin.receive("tg-bogus", 200);
    expect(response.action).toBe("skip");
    expect(response.respondedBy).toBe("timeout");
    expect(response.value).toBeUndefined();
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

    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 12, chat: { id: 99999 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
    });

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

    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 20, chat: { id: 99999 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
    });

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

    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 30, chat: { id: 99999 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
    });

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

    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 13, chat: { id: 99999 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
    });

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
    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      urls.push(urlStr);
      if (urlStr.includes("getUpdates")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 99999 } } }), {
        status: 200,
      });
    });

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

// BUG-7: sendMessage must enforce a client-side timeout via AbortController
// so a hung Telegram API doesn't stall the run.
describe("TelegramInteractionPlugin - sendMessage timeout (BUG-7)", () => {
  const originalFetch = _telegramPluginDeps.fetch;
  const originalSendTimeout = _telegramPluginDeps.sendTimeoutMs;

  afterEach(() => {
    mock.restore();
    _telegramPluginDeps.fetch = originalFetch;
    _telegramPluginDeps.sendTimeoutMs = originalSendTimeout;
  });

  test("aborts sendMessage via AbortController when fetch never resolves", async () => {
    _telegramPluginDeps.sendTimeoutMs = 50; // shrunk from the 5s production cap
    let observedSignal: AbortSignal | undefined;
    _telegramPluginDeps.fetch = mockFetch(async (_url: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      // Honor the abort signal: reject immediately when it fires.
      return await new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        const timer = setTimeout(() => reject(new Error("test-timeout")), 30_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    });

    const plugin = new TelegramInteractionPlugin();
    // Bypass init (which would start the getUpdates poller) — sanctioned
    // element-access route for private fields, per test-debt drain §8.9.
    plugin["botToken"] = "bot-abc123";
    plugin["chatId"] = "99999";

    const start = Date.now();
    await expect(
      plugin.send({
        id: "timeout-1",
        type: "notify", // not interactive → skip drainBacklog getUpdates call
        featureName: "f",
        stage: "review",
        summary: "s",
        fallback: "abort",
        createdAt: Date.now(),
      } as InteractionRequest),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Without the AbortController this rides OS TCP timeout (~75s+) or hangs.
    expect(elapsed).toBeLessThan(1000);
    expect(observedSignal).toBeDefined();
  });
});

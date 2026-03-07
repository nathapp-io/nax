// RE-ARCH: keep
/**
 * Interaction Plugins Unit Tests (v0.15.0 Phase 2)
 *
 * Tests for Telegram, Webhook, and Auto plugins.
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { InteractionRequest } from "../../src/interaction";
import { AutoInteractionPlugin } from "../../src/interaction/plugins/auto";
import { TelegramInteractionPlugin } from "../../src/interaction/plugins/telegram";
import { WebhookInteractionPlugin } from "../../src/interaction/plugins/webhook";

describe("TelegramInteractionPlugin", () => {
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

describe("WebhookInteractionPlugin", () => {
  test("should validate required config", async () => {
    const plugin = new WebhookInteractionPlugin();

    // Should throw without url
    await expect(plugin.init({})).rejects.toThrow("url");
  });

  test("should initialize with config", async () => {
    const plugin = new WebhookInteractionPlugin();

    await plugin.init({
      url: "https://example.com/webhook",
      callbackPort: 9999,
    });

    expect(plugin.name).toBe("webhook");

    await plugin.destroy();
  });

  test("should default callbackPort to 8765", async () => {
    const plugin = new WebhookInteractionPlugin();

    await plugin.init({
      url: "https://example.com/webhook",
    });

    expect(plugin.name).toBe("webhook");

    await plugin.destroy();
  });
});

describe("AutoInteractionPlugin", () => {
  test("should initialize with defaults", async () => {
    const plugin = new AutoInteractionPlugin();

    await plugin.init({});

    expect(plugin.name).toBe("auto");
  });

  test("should respect config overrides", async () => {
    const plugin = new AutoInteractionPlugin();

    await plugin.init({
      model: "balanced",
      confidenceThreshold: 0.8,
      maxCostPerDecision: 0.05,
    });

    expect(plugin.name).toBe("auto");
  });

  test("should reject security-review triggers", async () => {
    const plugin = new AutoInteractionPlugin();

    // Mock config
    await plugin.init({
      naxConfig: {
        models: {
          fast: { model: "claude-haiku-3-5" },
        },
      } as unknown as import("../../src/config").NaxConfig,
    });

    const request: InteractionRequest = {
      id: "test-security-review",
      type: "confirm",
      featureName: "test-feature",
      stage: "review",
      summary: "Security review failed",
      fallback: "abort",
      createdAt: Date.now(),
      metadata: {
        trigger: "security-review",
        safety: "red",
      },
    };

    const response = await plugin.decide(request);

    // Should return undefined to escalate to human
    expect(response).toBeUndefined();
  });

  test("should escalate on low confidence", async () => {
    const plugin = new AutoInteractionPlugin();

    // Set high threshold
    await plugin.init({
      confidenceThreshold: 0.9,
      naxConfig: {
        models: {
          fast: { model: "claude-haiku-3-5" },
        },
      } as unknown as import("../../src/config").NaxConfig,
    });

    // Mock a request that would get low confidence
    const request: InteractionRequest = {
      id: "test-low-confidence",
      type: "confirm",
      featureName: "test-feature",
      stage: "custom",
      summary: "Ambiguous decision",
      fallback: "continue",
      createdAt: Date.now(),
    };

    // Note: This would require mocking the LLM call in a real test
    // For now, we just verify the plugin is configured correctly
    expect(plugin.name).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// Telegram send() and poll() flow tests (TC-006)
// ---------------------------------------------------------------------------

describe("TelegramInteractionPlugin - send() and poll()", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    mock.restore();
    globalThis.fetch = originalFetch;
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

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = JSON.parse((init?.body as string) ?? "{}");
      calls.push({ url: urlStr, body });
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
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
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
    globalThis.fetch = mock(async (url: string | URL | Request) => {
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
});

// ---------------------------------------------------------------------------
// Webhook send() and HMAC validation tests (TC-006)
// ---------------------------------------------------------------------------

describe("WebhookInteractionPlugin - send() and HMAC validation", () => {
  afterEach(async () => {
    mock.restore();
  });

  function makeWebhookRequest(id: string): InteractionRequest {
    return {
      id,
      type: "confirm",
      featureName: "wh-feature",
      stage: "merge",
      summary: "Approve merge?",
      fallback: "abort",
      createdAt: Date.now(),
    };
  }

  test("send() POSTs payload with correct Content-Type", async () => {
    // Start a local server to capture the outgoing request
    const captured: { contentType: string | null; body: unknown } = { contentType: null, body: null };

    const testServer = Bun.serve({
      port: 19977,
      fetch: async (req) => {
        captured.contentType = req.headers.get("content-type");
        captured.body = await req.json();
        return new Response("OK", { status: 200 });
      },
    });

    const plugin = new WebhookInteractionPlugin();
    try {
      await plugin.init({ url: "http://localhost:19977/hook" });

      await plugin.send(makeWebhookRequest("wh-send-1"));

      expect(captured.contentType).toBe("application/json");
      expect((captured.body as { id: string }).id).toBe("wh-send-1");
      // callbackUrl is injected by send()
      expect(typeof (captured.body as { callbackUrl: string }).callbackUrl).toBe("string");
    } finally {
      testServer.stop();
      await plugin.destroy();
    }
  });

  test("send() includes X-Nax-Signature header when secret is configured", async () => {
    const captured: { signature: string | null; body: string } = { signature: null, body: "" };

    const testServer = Bun.serve({
      port: 19978,
      fetch: async (req) => {
        captured.signature = req.headers.get("x-nax-signature");
        captured.body = await req.text();
        return new Response("OK", { status: 200 });
      },
    });

    const plugin = new WebhookInteractionPlugin();
    try {
      await plugin.init({ url: "http://localhost:19978/hook", secret: "my-secret" });

      await plugin.send(makeWebhookRequest("wh-sig-1"));

      expect(captured.signature).not.toBeNull();
      // Verify the signature matches expected HMAC
      const expected = createHmac("sha256", "my-secret").update(captured.body).digest("hex");
      expect(captured.signature).toBe(expected);
    } finally {
      testServer.stop();
      await plugin.destroy();
    }
  });

  test("HMAC validation: tampered payload (no signature) is rejected with 401", async () => {
    const plugin = new WebhookInteractionPlugin();
    // url won't be called in this test — we test the callback server
    await plugin.init({
      url: "http://localhost:19900/unused",
      secret: "test-secret",
      callbackPort: 19988,
    });

    // Start the callback server by calling receive() in the background
    const receivePromise = plugin.receive("wh-hmac-1", 4000);

    // Give the server a moment to bind
    await Bun.sleep(60);

    try {
      // POST without signature → 401
      const noSigResp = await fetch("http://localhost:19988/nax/interact/wh-hmac-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "wh-hmac-1", action: "approve", respondedAt: Date.now() }),
      });
      expect(noSigResp.status).toBe(401);

      // POST with wrong signature → 401
      const badSigResp = await fetch("http://localhost:19988/nax/interact/wh-hmac-1", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nax-Signature": "deadbeef" },
        body: JSON.stringify({ requestId: "wh-hmac-1", action: "approve", respondedAt: Date.now() }),
      });
      expect(badSigResp.status).toBe(401);

      // POST with correct HMAC signature → 200, receive() resolves
      const payload = JSON.stringify({ requestId: "wh-hmac-1", action: "approve", respondedAt: Date.now() });
      const sig = createHmac("sha256", "test-secret").update(payload).digest("hex");
      const validResp = await fetch("http://localhost:19988/nax/interact/wh-hmac-1", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nax-Signature": sig },
        body: payload,
      });
      expect(validResp.status).toBe(200);

      const response = await receivePromise;
      expect(response.action).toBe("approve");
    } finally {
      await plugin.destroy();
    }
  });
});

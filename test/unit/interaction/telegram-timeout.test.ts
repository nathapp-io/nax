// RE-ARCH: keep
/**
 * Telegram Interaction Plugin Regression Test for BUG-116
 */

import { describe, expect, mock, test } from "bun:test";
import { TelegramInteractionPlugin } from "../../../src/interaction/plugins/telegram";
import type { InteractionRequest } from "../../../src/interaction/types";

describe("TelegramInteractionPlugin - Regression BUG-116", () => {
  test("receive() returns respondedBy: 'timeout' on timeout", async () => {
    // Mock fetch to always return empty updates so it times out
    globalThis.fetch = mock(async (url: string | URL | Request) => {
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
            result: [], // No updates
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("editMessageText")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    const request: InteractionRequest = {
      id: "tg-timeout-test",
      type: "confirm",
      featureName: "test",
      stage: "custom",
      summary: "test summary",
      fallback: "continue",
      createdAt: Date.now(),
    };

    // Use a very short timeout for the test
    const startTime = Date.now();
    const response = await plugin.receive("tg-timeout-test", 100);
    const duration = Date.now() - startTime;

    expect(duration).toBeGreaterThanOrEqual(100);
    expect(response.respondedBy).toBe("timeout");
    expect(response.requestId).toBe("tg-timeout-test");
  });
});

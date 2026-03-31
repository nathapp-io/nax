// RE-ARCH: keep
/**
 * Telegram Interaction Plugin Regression Tests
 *
 * BUG-116: expired checkpoint buttons stay active (keyboard not cleared on timeout)
 * BUG-116: checkReviewGate ignores fallback on timeout (should auto-approve for fallback:"continue")
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { TelegramInteractionPlugin } from "../../../src/interaction/plugins/telegram";
import type { InteractionRequest } from "../../../src/interaction/types";

describe("TelegramInteractionPlugin - Regression BUG-116", () => {
  let savedFetch: typeof globalThis.fetch;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    mock.restore();
    globalThis.fetch = savedFetch;
  });

  test("receive() returns respondedBy: 'timeout' on timeout", async () => {
    let editCalled = false;
    let editBody: Record<string, unknown> | null = null;

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
          JSON.stringify({ ok: true, result: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("editMessageText")) {
        editCalled = true;
        const body = (await (url instanceof Request ? url.json() : JSON.parse(new TextDecoder().decode((await (url as unknown as Response).arrayBuffer()))).json())) as Record<string, unknown>;
        editBody = body;
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

    await plugin.send(request);
    const response = await plugin.receive("tg-timeout-test", 100);

    expect(response.respondedBy).toBe("timeout");
    expect(response.requestId).toBe("tg-timeout-test");
  });

  test("sendTimeoutMessage clears inline keyboard (reply_markup empty)", async () => {
    let editBody: Record<string, unknown> | null = null;

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 99999 } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("getUpdates")) {
        return new Response(
          JSON.stringify({ ok: true, result: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("editMessageText")) {
        if (init?.body) {
          editBody = JSON.parse(init.body as string) as Record<string, unknown>;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "bot-abc123", chatId: "99999" });

    const request: InteractionRequest = {
      id: "tg-clear-keyboard",
      type: "confirm",
      featureName: "test",
      stage: "custom",
      summary: "test summary",
      fallback: "continue",
      createdAt: Date.now(),
    };

    await plugin.send(request);
    await plugin.receive("tg-clear-keyboard", 100);

    // The editMessageText call must include reply_markup with empty inline_keyboard
    // so that expired checkpoints can't be re-tapped by accident
    expect(editBody).not.toBeNull();
    expect(editBody?.reply_markup).toBeDefined();
    expect((editBody?.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([]);
  });
});

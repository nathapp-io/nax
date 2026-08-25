// RE-ARCH: keep
/**
 * Telegram Interaction Plugin Regression Tests
 *
 * BUG-116: expired checkpoint buttons stay active (keyboard not cleared on timeout)
 * BUG-116: checkReviewGate ignores fallback on timeout (should auto-approve for fallback:"continue")
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mockFetch } from "@test/helpers";
import { _telegramPluginDeps, TelegramInteractionPlugin } from "@/interaction/plugins/telegram";
import type { InteractionRequest } from "@/interaction/types";

describe("TelegramInteractionPlugin - Regression BUG-116", () => {
  let savedFetch: typeof _telegramPluginDeps.fetch;

  beforeEach(() => {
    savedFetch = _telegramPluginDeps.fetch;
  });

  afterEach(() => {
    mock.restore();
    _telegramPluginDeps.fetch = savedFetch;
  });

  test("receive() returns respondedBy: 'timeout' on timeout", async () => {
    let editCalled = false;
    let editBody: Record<string, unknown> | null = null;

    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: 99999 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlStr.includes("getUpdates")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlStr.includes("editMessageText")) {
        editCalled = true;
        if (init?.body) {
          editBody = JSON.parse(init.body as string) as Record<string, unknown>;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });

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
    // A holder, not a `let`: TypeScript narrows a `let` initialised to null and
    // only reassigned inside a callback down to `null`, so the assertions below
    // would read `never`. A property keeps its declared union.
    const captured: { editBody: Record<string, unknown> | null } = { editBody: null };

    _telegramPluginDeps.fetch = mockFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes("sendMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: 99999 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlStr.includes("getUpdates")) {
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlStr.includes("editMessageText")) {
        if (init?.body) {
          captured.editBody = JSON.parse(init.body as string) as Record<string, unknown>;
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });

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
    expect(captured.editBody).not.toBeNull();
    expect(captured.editBody?.reply_markup).toBeDefined();
    expect((captured.editBody?.reply_markup as { inline_keyboard: unknown[] } | undefined)?.inline_keyboard).toEqual(
      [],
    );
  });
});

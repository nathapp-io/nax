/**
 * nax-finish Telegram notifier — SEC-4: fetch timeout (AbortController).
 *
 * Without a client-side timeout, a hung Telegram API connection stalls the
 * post-run completion phase for ~75s (OS TCP timeout) or forever. The
 * interaction plugin's sendMessage already uses a 5s AbortController pattern;
 * mirror it here so the notify path can't wedge the run.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _telegramDeps, sendTelegramNotify } from "@/plugins/builtin/nax-finish";

const orig = _telegramDeps.fetch;

afterEach(() => {
  _telegramDeps.fetch = orig;
});

describe("sendTelegramNotify — fetch timeout (SEC-4)", () => {
  test("aborts when fetch never resolves (returns false within 7s)", async () => {
    let observedSignal: AbortSignal | undefined;
    _telegramDeps.fetch = mock(async (_url, init) => {
      observedSignal = init?.signal;
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

    const start = Date.now();
    const ok = await sendTelegramNotify({ token: "tok", chatId: "999" }, "hello");
    const elapsed = Date.now() - start;
    expect(ok).toBe(false);
    expect(elapsed).toBeLessThan(7_000);
    expect(observedSignal).toBeDefined();
  }, 10_000);

  test("returns true on a successful response", async () => {
    _telegramDeps.fetch = mock(async () => new Response("{}", { status: 200 }));
    const ok = await sendTelegramNotify({ token: "tok", chatId: "999" }, "hello");
    expect(ok).toBe(true);
  });
});

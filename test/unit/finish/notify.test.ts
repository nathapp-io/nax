/**
 * nax-finish Telegram notifier — SEC-4: fetch timeout (AbortController).
 *
 * Without a client-side timeout, a hung Telegram API connection stalls the
 * post-run completion phase for ~75s (OS TCP timeout) or forever. The
 * interaction plugin's sendMessage already uses a 5s AbortController pattern;
 * mirror it here so the notify path can't wedge the run.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _notifyDeps, sendTelegramNotify, telegramCreds, isTelegramConfigured } from "@/finish";

const orig = _notifyDeps.fetch;

afterEach(() => {
  _notifyDeps.fetch = orig;
});

describe("sendTelegramNotify — fetch timeout (SEC-4)", () => {
  test("aborts when fetch never resolves (returns false within 7s)", async () => {
    let observedSignal: AbortSignal | undefined;
    _notifyDeps.fetch = mock(async (_url, init) => {
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
    _notifyDeps.fetch = mock(async () => new Response("{}", { status: 200 }));
    const ok = await sendTelegramNotify({ token: "tok", chatId: "999" }, "hello");
    expect(ok).toBe(true);
  });
});

describe("telegramCreds", () => {
  test("telegramCreds reads interaction.config when the plugin is telegram", () => {
    expect(telegramCreds({ interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } } })).toEqual({
      token: "t",
      chatId: "c",
    });
  });

  test("telegramCreds ignores interaction.config when another plugin is selected", () => {
    const prev = { ...process.env };
    process.env.NAX_TELEGRAM_TOKEN = undefined as unknown as string; // test-ratchet-allow: as-unknown-as
    try {
      delete process.env.NAX_TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.NAX_TELEGRAM_CHAT_ID;
      expect(telegramCreds({ interaction: { plugin: "cli", config: { botToken: "t", chatId: "c" } } })).toBeNull();
    } finally {
      process.env = prev;
    }
  });

  test("telegramCreds needs both halves", () => {
    expect(telegramCreds({ interaction: { plugin: "telegram", config: { botToken: "t" } } })).toBeNull();
  });
});

describe("isTelegramConfigured", () => {
  test("returns true when creds are available", () => {
    const result = isTelegramConfigured({ interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } } });
    expect(result).toBe(true);
  });

  test("returns false when creds are not available", () => {
    const prev = { ...process.env };
    try {
      delete process.env.NAX_TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.NAX_TELEGRAM_CHAT_ID;
      const result = isTelegramConfigured({ interaction: { plugin: "cli", config: {} } });
      expect(result).toBe(false);
    } finally {
      process.env = prev;
    }
  });
});

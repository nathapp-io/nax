/**
 * nax-finish Telegram notifier — SEC-4: fetch timeout (AbortController).
 *
 * Without a client-side timeout, a hung Telegram API connection stalls the
 * post-run completion phase for ~75s (OS TCP timeout) or forever. The
 * interaction plugin's sendMessage already uses a 5s AbortController pattern;
 * mirror it here so the notify path can't wedge the run.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { _notifyDeps, isTelegramConfigured, sendTelegramNotify, telegramCreds } from "@/finish";

const orig = _notifyDeps.fetch;

afterEach(() => {
  _notifyDeps.fetch = orig;
});

describe("sendTelegramNotify — fetch timeout (SEC-4)", () => {
  /**
   * The abort deadline under test, shrunk from the production 5s cap so the
   * hang path costs milliseconds. The contract exercised is identical — the
   * timer fires, the AbortController aborts the in-flight fetch, and the call
   * resolves false — and the tightened bound below is strictly stronger.
   */
  const TEST_TIMEOUT_MS = 50;

  test("aborts when fetch never resolves", async () => {
    const origTimeout = _notifyDeps.timeoutMs;
    _notifyDeps.timeoutMs = TEST_TIMEOUT_MS;
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
    let ok: boolean;
    try {
      ok = await sendTelegramNotify({ token: "tok", chatId: "999" }, "hello");
    } finally {
      _notifyDeps.timeoutMs = origTimeout;
    }
    const elapsed = Date.now() - start;
    expect(ok).toBe(false);
    expect(elapsed).toBeLessThan(1_000);
    expect(observedSignal).toBeDefined();
  });

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
    const prevToken = process.env.NAX_TELEGRAM_TOKEN;
    const prevBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const prevChatId = process.env.NAX_TELEGRAM_CHAT_ID;
    try {
      delete process.env.NAX_TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.NAX_TELEGRAM_CHAT_ID;
      expect(telegramCreds({ interaction: { plugin: "cli", config: { botToken: "t", chatId: "c" } } })).toBeNull();
    } finally {
      if (prevToken === undefined) delete process.env.NAX_TELEGRAM_TOKEN;
      else process.env.NAX_TELEGRAM_TOKEN = prevToken;
      if (prevBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prevBotToken;
      if (prevChatId === undefined) delete process.env.NAX_TELEGRAM_CHAT_ID;
      else process.env.NAX_TELEGRAM_CHAT_ID = prevChatId;
    }
  });

  test("telegramCreds needs both halves", () => {
    expect(telegramCreds({ interaction: { plugin: "telegram", config: { botToken: "t" } } })).toBeNull();
  });
});

describe("isTelegramConfigured", () => {
  test("returns true when creds are available", () => {
    const result = isTelegramConfigured({
      interaction: { plugin: "telegram", config: { botToken: "t", chatId: "c" } },
    });
    expect(result).toBe(true);
  });

  test("returns false when creds are not available", () => {
    const prevToken = process.env.NAX_TELEGRAM_TOKEN;
    const prevBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const prevChatId = process.env.NAX_TELEGRAM_CHAT_ID;
    try {
      delete process.env.NAX_TELEGRAM_TOKEN;
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.NAX_TELEGRAM_CHAT_ID;
      const result = isTelegramConfigured({ interaction: { plugin: "cli", config: {} } });
      expect(result).toBe(false);
    } finally {
      if (prevToken === undefined) delete process.env.NAX_TELEGRAM_TOKEN;
      else process.env.NAX_TELEGRAM_TOKEN = prevToken;
      if (prevBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = prevBotToken;
      if (prevChatId === undefined) delete process.env.NAX_TELEGRAM_CHAT_ID;
      else process.env.NAX_TELEGRAM_CHAT_ID = prevChatId;
    }
  });
});

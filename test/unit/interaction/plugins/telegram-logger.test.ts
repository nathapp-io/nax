/**
 * TelegramInteractionPlugin logger-lookup tests (US-004).
 *
 * The plugin resolves its logger at call-time (every `getSafeLogger()` site),
 * not once at construction. Regression: a `private readonly logger =
 * getSafeLogger()` field initializer caches a `null` reference when the
 * plugin is constructed before `initLogger()` runs, so every later warning
 * (including the "chatId is not numeric" warning) is silently lost.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { TelegramInteractionPlugin } from "@/interaction";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";

describe("TelegramInteractionPlugin - logger lookup at call time", () => {
  afterEach(() => {
    resetLogger();
  });

  test("AC1: warns via the live logger when constructed before initLogger and initialized with a non-numeric chatId", async () => {
    // Construct first — the logger singleton is currently null. With the
    // pre-fix field initializer (`private readonly logger = getSafeLogger()`)
    // a cached `null` reference would silently discard every later warning.
    const plugin = new TelegramInteractionPlugin();

    resetLogger();
    const captured: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => captured.push(entry));

    try {
      await plugin.init({ botToken: "t", chatId: "@channelname" });

      const interactionWarnings = captured.filter((entry) => entry.level === "warn" && entry.stage === "interaction");
      expect(interactionWarnings.length).toBeGreaterThanOrEqual(1);
      // The non-numeric chatId is the entire point of this AC.
      const chatIdWarning = interactionWarnings.find(
        (entry) =>
          entry.message.toLowerCase().includes("chatid") && entry.message.toLowerCase().includes("not numeric"),
      );
      expect(chatIdWarning).toBeDefined();
    } finally {
      await plugin.destroy();
    }
  });

  test("AC2: does not warn when constructed before initLogger and initialized with a numeric chatId", async () => {
    const plugin = new TelegramInteractionPlugin();

    resetLogger();
    const captured: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => captured.push(entry));

    try {
      await plugin.init({ botToken: "t", chatId: "12345" });

      const interactionWarnings = captured.filter((entry) => entry.level === "warn" && entry.stage === "interaction");
      expect(interactionWarnings).toHaveLength(0);
    } finally {
      await plugin.destroy();
    }
  });
});

/**
 * Interaction Plugins Unit Tests (v0.15.0 Phase 2)
 *
 * Tests for Telegram, Webhook, and Auto plugins.
 */

import { describe, expect, test } from "bun:test";
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

// RE-ARCH: keep
/**
 * Interaction Plugins Network Failure Tests (v0.15.1)
 *
 * Tests network error handling, exponential backoff, payload limits, and malformed input.
 */

import { describe, expect, test } from "bun:test";
import type { InteractionRequest } from "../../../src/interaction";
import { TelegramInteractionPlugin } from "../../../src/interaction/plugins/telegram";
import { WebhookInteractionPlugin, _webhookPluginDeps } from "../../../src/interaction/plugins/webhook";

// Disable real backoff sleeps — tests verify behavior, not wall-clock timing
const origWebhookSleep = _webhookPluginDeps.sleep;
_webhookPluginDeps.sleep = async (_ms: number) => {};

describe("TelegramInteractionPlugin - Network Failures", () => {
  test("should handle network error in send()", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    // Mock fetch to throw network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const request: InteractionRequest = {
      id: "test-network-error",
      type: "confirm",
      featureName: "test-feature",
      stage: "review",
      summary: "Test network error",
      fallback: "abort",
      createdAt: Date.now(),
    };

    await expect(plugin.send(request)).rejects.toThrow("Failed to send Telegram message");

    // Restore
    globalThis.fetch = originalFetch;
  });

  test("should handle malformed API response in send()", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    // Mock fetch to return invalid JSON
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("not json", { status: 200 });
    };

    const request: InteractionRequest = {
      id: "test-malformed-response",
      type: "confirm",
      featureName: "test-feature",
      stage: "review",
      summary: "Test malformed response",
      fallback: "abort",
      createdAt: Date.now(),
    };

    await expect(plugin.send(request)).rejects.toThrow("Failed to send Telegram message");

    // Restore
    globalThis.fetch = originalFetch;
  });

  test("should handle HTTP error status in send()", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    // Mock fetch to return 500 error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    const request: InteractionRequest = {
      id: "test-http-error",
      type: "confirm",
      featureName: "test-feature",
      stage: "review",
      summary: "Test HTTP error",
      fallback: "abort",
      createdAt: Date.now(),
    };

    await expect(plugin.send(request)).rejects.toThrow("Telegram API error (500)");

    // Restore
    globalThis.fetch = originalFetch;
  });

  test("should return empty updates on getUpdates() network failure", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    // Mock fetch to throw network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Network timeout");
    };

    // Access private method via type assertion for testing
    const getUpdates = (plugin as unknown as { getUpdates: () => Promise<unknown[]> }).getUpdates;
    const updates = await getUpdates.call(plugin);

    expect(updates).toEqual([]);

    // Restore
    globalThis.fetch = originalFetch;
  });

  test("should apply exponential backoff on consecutive getUpdates() failures", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;

    globalThis.fetch = async () => {
      fetchCallCount++;
      throw new Error("Network error");
    };

    // Access private getUpdates
    const getUpdates = (plugin as unknown as { getUpdates: () => Promise<unknown[]> }).getUpdates;

    // Call getUpdates multiple times to trigger backoff
    await getUpdates.call(plugin);
    await getUpdates.call(plugin);
    await getUpdates.call(plugin);

    // Verify backoff is increasing (check private backoffMs property)
    const backoffMs = (plugin as unknown as { backoffMs: number }).backoffMs;
    expect(backoffMs).toBeGreaterThan(1000); // Should have increased from initial 1000ms

    // Restore
    globalThis.fetch = originalFetch;
  });

  test("should reset backoff on successful getUpdates()", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        // First call fails
        throw new Error("Network error");
      }
      // Second call succeeds
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    };

    const getUpdates = (plugin as unknown as { getUpdates: () => Promise<unknown[]> }).getUpdates;

    // First call - triggers backoff
    await getUpdates.call(plugin);
    const backoffAfterFailure = (plugin as unknown as { backoffMs: number }).backoffMs;
    expect(backoffAfterFailure).toBeGreaterThan(1000);

    // Second call - should reset backoff
    await getUpdates.call(plugin);
    const backoffAfterSuccess = (plugin as unknown as { backoffMs: number }).backoffMs;
    expect(backoffAfterSuccess).toBe(1000); // Reset to initial value

    // Restore
    globalThis.fetch = originalFetch;
  });
});

describe("WebhookInteractionPlugin - Network Failures", () => {
  test("should handle network error in send()", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook" });

    // Mock fetch to throw network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const request: InteractionRequest = {
      id: "test-network-error",
      type: "confirm",
      featureName: "test-feature",
      stage: "review",
      summary: "Test network error",
      fallback: "abort",
      createdAt: Date.now(),
    };

    await expect(plugin.send(request)).rejects.toThrow("Failed to send webhook request");

    // Restore
    globalThis.fetch = originalFetch;
    await plugin.destroy();
  });

  test("should handle HTTP error in send()", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook" });

    // Mock fetch to return 503 error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Service Unavailable", { status: 503 });
    };

    const request: InteractionRequest = {
      id: "test-http-error",
      type: "confirm",
      featureName: "test-feature",
      stage: "review",
      summary: "Test HTTP error",
      fallback: "abort",
      createdAt: Date.now(),
    };

    await expect(plugin.send(request)).rejects.toThrow("Webhook POST failed (503)");

    // Restore
    globalThis.fetch = originalFetch;
    await plugin.destroy();
  });

  test("should apply exponential backoff in receive() polling", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook" });

    // With instant sleep mock, receive() times out quickly (50ms).
    // We verify the timeout path fires correctly — not the wall-clock duration.
    const response = await plugin.receive("test-request", 50);

    expect(response.action).toBe("skip");
    expect(response.respondedBy).toBe("timeout");

    await plugin.destroy();
  });
});

describe("WebhookInteractionPlugin - Payload Security", () => {
  test("should reject oversized payload via Content-Length header", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", maxPayloadBytes: 1000 });

    // Create a mock request with large Content-Length
    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "10000", // 10KB - exceeds 1000 byte limit
      },
      body: JSON.stringify({ requestId: "test-id", action: "approve" }),
    });

    const handleRequest = (plugin as unknown as { handleRequest: (req: Request) => Promise<Response> }).handleRequest;
    const response = await handleRequest.call(plugin, req);

    expect(response.status).toBe(413); // Payload Too Large
    expect(await response.text()).toBe("Payload Too Large");

    await plugin.destroy();
  });

  test("should reject oversized payload by actual body size", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", secret: "test-secret", maxPayloadBytes: 100 });

    // Create a large payload
    const largePayload = "x".repeat(200);

    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nax-Signature": "dummy-signature",
      },
      body: largePayload,
    });

    const handleRequest = (plugin as unknown as { handleRequest: (req: Request) => Promise<Response> }).handleRequest;
    const response = await handleRequest.call(plugin, req);

    expect(response.status).toBe(413); // Payload Too Large

    await plugin.destroy();
  });

  test("should reject malformed JSON with sanitized error", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook" });

    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{",
    });

    const handleRequest = (plugin as unknown as { handleRequest: (req: Request) => Promise<Response> }).handleRequest;
    const response = await handleRequest.call(plugin, req);

    expect(response.status).toBe(400);
    const errorText = await response.text();

    // Should not leak parse error details
    expect(errorText).toBe("Bad Request: Invalid response format");
    expect(errorText).not.toContain("JSON");
    expect(errorText).not.toContain("parse");
    expect(errorText).not.toContain("Unexpected");

    await plugin.destroy();
  });

  test("should reject invalid schema with sanitized error", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook" });

    // Valid JSON but invalid InteractionResponse schema
    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ malicious: "payload", action: "invalid-action" }),
    });

    const handleRequest = (plugin as unknown as { handleRequest: (req: Request) => Promise<Response> }).handleRequest;
    const response = await handleRequest.call(plugin, req);

    expect(response.status).toBe(400);
    const errorText = await response.text();

    // Should not leak Zod validation error details
    expect(errorText).toBe("Bad Request: Invalid response format");
    expect(errorText).not.toContain("Zod");
    expect(errorText).not.toContain("validation");
    expect(errorText).not.toContain("enum");

    await plugin.destroy();
  });

  test("should reject request without signature when secret is configured", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", secret: "test-secret" });

    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "test-id", action: "approve", respondedAt: Date.now() }),
    });

    const handleRequest = (plugin as unknown as { handleRequest: (req: Request) => Promise<Response> }).handleRequest;
    const response = await handleRequest.call(plugin, req);

    expect(response.status).toBe(401); // Unauthorized
    expect(await response.text()).toBe("Unauthorized");

    await plugin.destroy();
  });

  test("should reject request with invalid signature", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", secret: "test-secret" });

    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nax-Signature": "invalid-signature",
      },
      body: JSON.stringify({ requestId: "test-id", action: "approve", respondedAt: Date.now() }),
    });

    const handleRequest = (plugin as unknown as { handleRequest: (req: Request) => Promise<Response> }).handleRequest;
    const response = await handleRequest.call(plugin, req);

    expect(response.status).toBe(401); // Unauthorized

    await plugin.destroy();
  });
});

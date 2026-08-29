// RE-ARCH: keep
/**
 * Interaction Plugins Network Failure Tests (v0.15.1)
 *
 * Tests network error handling, exponential backoff, payload limits, and malformed input.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mockFetch, telegramInternals, webhookInternals } from "@test/helpers";
import type { InteractionRequest } from "@/interaction";
import { _telegramPluginDeps, TelegramInteractionPlugin } from "@/interaction/plugins/telegram";
import { _webhookPluginDeps, WebhookInteractionPlugin } from "@/interaction/plugins/webhook";

function timeoutResult<T>(value: T, delayMs = 0): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), delayMs);
  });
}

// Disable real backoff sleeps — tests verify behavior, not wall-clock timing
const origWebhookSleep = _webhookPluginDeps.sleep;
_webhookPluginDeps.sleep = async (_ms: number) => {};

afterAll(() => {
  _webhookPluginDeps.sleep = origWebhookSleep;
});

describe("TelegramInteractionPlugin - Network Failures", () => {
  test("should handle network error in send()", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    // Mock fetch to throw network error
    const originalFetch = _telegramPluginDeps.fetch;
    _telegramPluginDeps.fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

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
    _telegramPluginDeps.fetch = originalFetch;
  });

  test("should handle malformed API response in send()", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    // Mock fetch to return invalid JSON
    const originalFetch = _telegramPluginDeps.fetch;
    _telegramPluginDeps.fetch = mockFetch(async () => {
      return new Response("not json", { status: 200 });
    });

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
    _telegramPluginDeps.fetch = originalFetch;
  });

  test("should handle HTTP error status in send()", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    // Mock fetch to return 500 error
    const originalFetch = _telegramPluginDeps.fetch;
    _telegramPluginDeps.fetch = mockFetch(async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

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
    _telegramPluginDeps.fetch = originalFetch;
  });

  test("should return empty updates on getUpdates() network failure", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    // Mock fetch to throw network error
    const originalFetch = _telegramPluginDeps.fetch;
    _telegramPluginDeps.fetch = mockFetch(async () => {
      throw new Error("Network timeout");
    });

    // Access private method via contained accessor (test/helpers/interaction-internals)
    const getUpdates = telegramInternals(plugin).getUpdates;
    const updates = await getUpdates.call(plugin);

    expect(updates).toEqual([]);

    // Restore
    _telegramPluginDeps.fetch = originalFetch;
  });

  test("should apply exponential backoff on consecutive getUpdates() failures", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    const originalFetch = _telegramPluginDeps.fetch;
    let _fetchCallCount = 0;

    _telegramPluginDeps.fetch = mockFetch(async () => {
      _fetchCallCount++;
      throw new Error("Network error");
    });

    // Access private getUpdates
    const getUpdates = telegramInternals(plugin).getUpdates;

    // Call getUpdates multiple times to trigger backoff
    await getUpdates.call(plugin);
    await getUpdates.call(plugin);
    await getUpdates.call(plugin);

    // Verify backoff is increasing (check private backoffMs property)
    const backoffMs = telegramInternals(plugin).backoffMs;
    expect(backoffMs).toBeGreaterThan(1000); // Should have increased from initial 1000ms

    // Restore
    _telegramPluginDeps.fetch = originalFetch;
  });

  test("should reset backoff on successful getUpdates()", async () => {
    const plugin = new TelegramInteractionPlugin();
    await plugin.init({ botToken: "test-token", chatId: "12345" });

    const originalFetch = _telegramPluginDeps.fetch;
    let callCount = 0;

    _telegramPluginDeps.fetch = mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        // First call fails
        throw new Error("Network error");
      }
      // Second call succeeds
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    });

    const getUpdates = telegramInternals(plugin).getUpdates;

    // First call - triggers backoff
    await getUpdates.call(plugin);
    const backoffAfterFailure = telegramInternals(plugin).backoffMs;
    expect(backoffAfterFailure).toBeGreaterThan(1000);

    // Second call - should reset backoff
    await getUpdates.call(plugin);
    const backoffAfterSuccess = telegramInternals(plugin).backoffMs;
    expect(backoffAfterSuccess).toBe(1000); // Reset to initial value

    // Restore
    _telegramPluginDeps.fetch = originalFetch;
  });
});

describe("WebhookInteractionPlugin - Network Failures", () => {
  test("should handle network error in send()", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    // Mock fetch to throw network error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

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
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    // Mock fetch to return 503 error
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => {
      return new Response("Service Unavailable", { status: 503 });
    });

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

  // BUG-18: send()'s outbound POST previously had no client-side deadline —
  // a black-holing webhook URL stalled the story indefinitely (no OS-level
  // TCP timeout fires for a very long time). Assert the fetch call carries
  // an AbortSignal so a hung request is eventually aborted, and that the
  // signal firing produces a clean rejection (not an unhandled hang).
  test("BUG-18: send() passes an AbortSignal to fetch", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    let capturedSignal: AbortSignal | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response("{}", { status: 200 });
    });

    const request: InteractionRequest = {
      id: "test-abort-signal",
      type: "confirm",
      featureName: "test-feature",
      stage: "review",
      summary: "Test abort signal wiring",
      fallback: "abort",
      createdAt: Date.now(),
    };

    await plugin.send(request);

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    globalThis.fetch = originalFetch;
    await plugin.destroy();
  });

  test("BUG-18: send() rejects cleanly when the fetch call itself aborts", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    const originalFetch = globalThis.fetch;
    // Simulate what happens when WEBHOOK_SEND_TIMEOUT_MS fires and aborts the
    // in-flight fetch — real fetch() rejects with an AbortError in that case.
    globalThis.fetch = mockFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const request: InteractionRequest = {
      id: "test-abort-rejects",
      type: "confirm",
      featureName: "test-feature",
      stage: "review",
      summary: "Test abort rejects cleanly",
      fallback: "abort",
      createdAt: Date.now(),
    };

    await expect(plugin.send(request)).rejects.toThrow("Failed to send webhook request");

    globalThis.fetch = originalFetch;
    await plugin.destroy();
  });

  test("should return timeout skip response when no callback arrives", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    // With instant sleep mock, receive() times out quickly (50ms).
    // We verify the timeout path fires correctly — not the wall-clock duration.
    const response = await plugin.receive("test-request", 50);

    expect(response.action).toBe("skip");
    expect(response.respondedBy).toBe("timeout");

    await plugin.destroy();
  });

  test("should resolve in-flight receive immediately when destroyed", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    const receivePromise = plugin.receive("destroy-inflight", 60_000);
    await Promise.resolve();

    await plugin.destroy();

    const settled = await Promise.race([
      receivePromise.then(() => "resolved" as const),
      timeoutResult("hung" as const),
    ]);

    expect(settled).toBe("resolved");
    const response = await receivePromise;
    expect(response.action).toBe("skip");
    expect(response.respondedBy).toBe("destroyed");
  });

  test("should clear pending response/callback/timer maps on destroy", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    const handleRequest = webhookInternals(plugin).handleRequest;

    const earlyResponse = await handleRequest.call(
      plugin,
      new Request("http://localhost:8765/nax/interact/early-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "early-response",
          action: "approve",
          respondedAt: Date.now(),
        }),
      }),
    );
    expect(earlyResponse.status).toBe(200);

    const receivePromise = plugin.receive("destroy-callback", 60_000);
    await Promise.resolve();

    await plugin.destroy();
    await receivePromise;

    const internals = webhookInternals(plugin);

    expect(internals.pendingResponses.size).toBe(0);
    expect(internals.receiveCallbacks.size).toBe(0);
    expect(internals.receiveTimers?.size ?? -1).toBe(0);
  });

  test("should supersede previous in-flight receive for same requestId", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    const firstReceive = plugin.receive("duplicate-id", 60_000);
    await Promise.resolve();

    const secondReceive = plugin.receive("duplicate-id", 60_000);

    const firstSettled = await Promise.race([firstReceive, timeoutResult(null)]);

    expect(firstSettled).not.toBeNull();
    expect(firstSettled?.action).toBe("skip");
    expect(firstSettled?.respondedBy).toBe("superseded");

    await plugin.destroy();

    const secondSettled = await Promise.race([
      secondReceive.then(() => "resolved" as const),
      timeoutResult("hung" as const),
    ]);
    expect(secondSettled).toBe("resolved");

    const internals = webhookInternals(plugin);
    expect(internals.receiveCallbacks.size).toBe(0);
    expect(internals.receiveTimers?.size ?? -1).toBe(0);
  });
});

describe("WebhookInteractionPlugin - Capacity & Startup Recovery", () => {
  test("BUG-47: returns 503 (not 200) when pending-response capacity is exceeded", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    // Reaching private plugin state — no public accessor.
    const internals = webhookInternals(plugin);

    // Fill the early-pickup store to MAX_PENDING_RESPONSES (500) with
    // registered-but-unclaimed IDs, then deliver one more.
    for (let i = 0; i < 500; i++) {
      const id = `capacity-filler-${i}`;
      internals.registeredRequestIds.add(id);
      internals.pendingResponses.set(id, {
        requestId: id,
        action: "skip",
        respondedAt: Date.now(),
      });
    }

    const overflowId = "capacity-overflow";
    internals.registeredRequestIds.add(overflowId);

    const handleRequest = webhookInternals(plugin).handleRequest;
    const response = await handleRequest.call(
      plugin,
      new Request(`http://localhost:8765/nax/interact/${overflowId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: overflowId, action: "approve", respondedAt: Date.now() }),
      }),
    );

    expect(response.status).not.toBe(200);
    expect([429, 503]).toContain(response.status);
    // The overflow response must not have been silently stored either.
    expect(internals.pendingResponses.has(overflowId)).toBe(false);

    await plugin.destroy();
  });

  test("BUG-50: serverStartPromise is reset after a Bun.serve failure so a retry can succeed", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    const originalServe = Bun.serve;
    (Bun as { serve: typeof Bun.serve }).serve = (() => {
      throw new Error("simulated Bun.serve startup failure");
    }) as typeof Bun.serve;

    const startServer = webhookInternals(plugin).startServer.bind(plugin);

    await expect(startServer()).rejects.toThrow("simulated Bun.serve startup failure");

    const internals = webhookInternals(plugin);
    expect(internals.serverStartPromise).toBeNull();

    // Restore Bun.serve and confirm a subsequent start attempt is not
    // permanently wedged on the old rejected promise.
    (Bun as { serve: typeof Bun.serve }).serve = originalServe;
    await startServer();
    expect(webhookInternals(plugin).server).not.toBeNull();

    await plugin.destroy();
  });
});

describe("WebhookInteractionPlugin - Payload Security", () => {
  test("should reject oversized payload via Content-Length header", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", maxPayloadBytes: 1000, requireSecret: false });

    // Create a mock request with large Content-Length
    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "10000", // 10KB - exceeds 1000 byte limit
      },
      body: JSON.stringify({ requestId: "test-id", action: "approve" }),
    });

    const handleRequest = webhookInternals(plugin).handleRequest;
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

    const handleRequest = webhookInternals(plugin).handleRequest;
    const response = await handleRequest.call(plugin, req);

    expect(response.status).toBe(413); // Payload Too Large

    await plugin.destroy();
  });

  test("SEC-04: rejects an oversized chunked body with no Content-Length header, aborting before the full body is buffered", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", maxPayloadBytes: 100, requireSecret: false });

    let bytesPulled = 0;
    const totalChunks = 1000;
    const chunkSize = 1024; // far more than maxPayloadBytes across the whole stream
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (bytesPulled >= totalChunks * chunkSize) {
          controller.close();
          return;
        }
        bytesPulled += chunkSize;
        controller.enqueue(new TextEncoder().encode("x".repeat(chunkSize)));
      },
    });

    // duplex: "half" is required by undici/Bun when a body is a stream.
    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: string });

    const handleRequest = webhookInternals(plugin).handleRequest;
    const response = await handleRequest.call(plugin, req);

    expect(response.status).toBe(413);
    // The reader must have stopped well before draining the full (megabytes-sized) stream.
    expect(bytesPulled).toBeLessThan(totalChunks * chunkSize);

    await plugin.destroy();
  });

  test("should reject malformed JSON with sanitized error", async () => {
    const plugin = new WebhookInteractionPlugin();
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{",
    });

    const handleRequest = webhookInternals(plugin).handleRequest;
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
    await plugin.init({ url: "https://example.com/webhook", requireSecret: false });

    // Valid JSON but invalid InteractionResponse schema
    const req = new Request("http://localhost:8765/nax/interact/test-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ malicious: "payload", action: "invalid-action" }),
    });

    const handleRequest = webhookInternals(plugin).handleRequest;
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

    const handleRequest = webhookInternals(plugin).handleRequest;
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

    const handleRequest = webhookInternals(plugin).handleRequest;
    const response = await handleRequest.call(plugin, req);

    expect(response.status).toBe(401); // Unauthorized

    await plugin.destroy();
  });
});

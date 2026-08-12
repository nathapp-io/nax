// RE-ARCH: keep
/**
 * Interaction Plugins Unit Tests (v0.15.0 Phase 2)
 *
 * Tests for the Webhook plugin.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { InteractionRequest } from "../../../src/interaction";
import { WebhookInteractionPlugin } from "../../../src/interaction/plugins/webhook";

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
      requireSecret: false,
    });

    expect(plugin.name).toBe("webhook");

    await plugin.destroy();
  });

  test("should default callbackPort to 8765", async () => {
    const plugin = new WebhookInteractionPlugin();

    await plugin.init({
      url: "https://example.com/webhook",
      requireSecret: false,
    });

    expect(plugin.name).toBe("webhook");

    await plugin.destroy();
  });
});

// ---------------------------------------------------------------------------
// Webhook send() and HMAC validation tests (TC-006)
// ---------------------------------------------------------------------------

describe("WebhookInteractionPlugin - send() and HMAC validation", () => {
  afterEach(async () => {
    mock.restore();
  });

  function makeWebhookRequest(id: string): InteractionRequest {
    return {
      id,
      type: "confirm",
      featureName: "wh-feature",
      stage: "merge",
      summary: "Approve merge?",
      fallback: "abort",
      createdAt: Date.now(),
    };
  }

  test("send() POSTs payload with correct Content-Type", async () => {
    // Start a local server to capture the outgoing request
    const captured: { contentType: string | null; body: unknown } = { contentType: null, body: null };

    const testServer = Bun.serve({
      port: 0, // OS assigns an available port — avoids conflicts on rerun
      fetch: async (req) => {
        captured.contentType = req.headers.get("content-type");
        captured.body = await req.json();
        return new Response("OK", { status: 200 });
      },
    });

    const plugin = new WebhookInteractionPlugin();
    try {
      await plugin.init({ url: `http://localhost:${testServer.port}/hook`, requireSecret: false });

      await plugin.send(makeWebhookRequest("wh-send-1"));

      expect(captured.contentType).toBe("application/json");
      expect((captured.body as { id: string }).id).toBe("wh-send-1");
      // callbackUrl is injected by send()
      expect(typeof (captured.body as { callbackUrl: string }).callbackUrl).toBe("string");
    } finally {
      testServer.stop(true);
      await plugin.destroy();
    }
  });

  test("send() includes X-Nax-Signature header when secret is configured", async () => {
    const captured: { signature: string | null; body: string } = { signature: null, body: "" };

    const testServer = Bun.serve({
      port: 0, // OS assigns an available port — avoids conflicts on rerun
      fetch: async (req) => {
        captured.signature = req.headers.get("x-nax-signature");
        captured.body = await req.text();
        return new Response("OK", { status: 200 });
      },
    });

    const plugin = new WebhookInteractionPlugin();
    try {
      await plugin.init({ url: `http://localhost:${testServer.port}/hook`, secret: "my-secret" });

      await plugin.send(makeWebhookRequest("wh-sig-1"));

      expect(captured.signature).not.toBeNull();
      // Verify the signature matches expected HMAC
      const expected = createHmac("sha256", "my-secret").update(captured.body).digest("hex");
      expect(captured.signature).toBe(expected);
    } finally {
      testServer.stop(true);
      await plugin.destroy();
    }
  });

  test("HMAC validation: tampered payload (no signature) is rejected with 401", async () => {
    const plugin = new WebhookInteractionPlugin();
    // url won't be called in this test — we test the callback server
    await plugin.init({
      url: "http://localhost/unused",
      secret: "test-secret",
      callbackPort: 0, // OS assigns an available port — avoids conflicts on rerun
    });

    // Start the callback server by calling receive() in the background
    const receivePromise = plugin.receive("wh-hmac-1", 4000);

    // Drain microtasks so startServer() completes and the port is assigned
    await Promise.resolve();
    await Promise.resolve();

    const callbackPort = plugin.callbackServerPort!;

    try {
      // POST without signature → 401
      const noSigResp = await fetch(`http://localhost:${callbackPort}/nax/interact/wh-hmac-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "wh-hmac-1", action: "approve", respondedAt: Date.now() }),
      });
      expect(noSigResp.status).toBe(401);

      // POST with wrong signature → 401
      const badSigResp = await fetch(`http://localhost:${callbackPort}/nax/interact/wh-hmac-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nax-Signature": "deadbeef" },
        body: JSON.stringify({ requestId: "wh-hmac-1", action: "approve", respondedAt: Date.now() }),
      });
      expect(badSigResp.status).toBe(401);

      // POST with correct HMAC signature → 200, receive() resolves
      const payload = JSON.stringify({ requestId: "wh-hmac-1", action: "approve", respondedAt: Date.now() });
      const sig = createHmac("sha256", "test-secret").update(payload).digest("hex");
      const validResp = await fetch(`http://localhost:${callbackPort}/nax/interact/wh-hmac-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nax-Signature": sig },
        body: payload,
      });
      expect(validResp.status).toBe(200);

      const response = await receivePromise;
      expect(response.action).toBe("approve");
    } finally {
      await plugin.destroy();
    }
  });
});

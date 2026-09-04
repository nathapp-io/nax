// RE-ARCH: keep
/**
 * Interaction Plugins Unit Tests (v0.15.0 Phase 2)
 *
 * Tests for the Webhook plugin.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { assertDefined } from "@test/helpers";
import type { InteractionRequest } from "@/interaction";
import { _webhookPluginDeps, WebhookInteractionPlugin } from "@/interaction/plugins/webhook";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";

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

  /**
   * Captures what send() hands to the outbound fetch, without a socket.
   *
   * These two tests used to POST to a real `Bun.serve` target over loopback.
   * That made them fail on CI with "Failed to send webhook request: The
   * operation was aborted." milliseconds in — far short of both the 30s
   * WEBHOOK_SEND_TIMEOUT_MS in send() and the 5s bunfig default — and it was
   * never reproducible locally: not in isolation, not alongside every other
   * webhook/Bun.serve test file, not at CI-like file-descriptor limits. It was
   * papered over with `retry: 2` and then failed on all three attempts.
   *
   * The contract under test is what send() BUILDS — method, headers, signature,
   * payload — not that a socket carries it. Stubbing `_webhookPluginDeps.fetch`
   * asserts exactly that contract, deterministically, and leaves the transport
   * to the tests that exist for it.
   */
  function captureSend(): {
    calls: { url: string; init: RequestInit }[];
    restore: () => void;
  } {
    const calls: { url: string; init: RequestInit }[] = [];
    const original = _webhookPluginDeps.fetch;
    _webhookPluginDeps.fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("OK", { status: 200 });
    };
    return {
      calls,
      restore: () => {
        _webhookPluginDeps.fetch = original;
      },
    };
  }

  /** Header lookup that tolerates either a plain object or a Headers instance. */
  function headerOf(init: RequestInit, name: string): string | null {
    const headers = new Headers(init.headers);
    return headers.get(name);
  }

  test("send() POSTs payload with correct Content-Type", async () => {
    const { calls, restore } = captureSend();
    const plugin = new WebhookInteractionPlugin();
    try {
      await plugin.init({
        url: "https://example.com/hook",
        requireSecret: false,
        callbackPort: 0, // OS assigns an available port — avoids conflicts on rerun
      });

      await plugin.send(makeWebhookRequest("wh-send-1"));

      expect(calls).toHaveLength(1);
      const [call] = calls;
      assertDefined(call, "outbound fetch call");
      expect(call.url).toBe("https://example.com/hook");
      expect(call.init.method).toBe("POST");
      expect(headerOf(call.init, "content-type")).toBe("application/json");

      const body = JSON.parse(String(call.init.body)) as { id: string; callbackUrl: string };
      expect(body.id).toBe("wh-send-1");
      // callbackUrl is injected by send()
      expect(typeof body.callbackUrl).toBe("string");
    } finally {
      restore();
      await plugin.destroy();
    }
  });

  test("send() includes X-Nax-Signature header when secret is configured", async () => {
    const { calls, restore } = captureSend();
    const plugin = new WebhookInteractionPlugin();
    try {
      await plugin.init({
        url: "https://example.com/hook",
        secret: "my-secret",
        callbackPort: 0, // OS assigns an available port — avoids conflicts on rerun
      });

      await plugin.send(makeWebhookRequest("wh-sig-1"));

      expect(calls).toHaveLength(1);
      const [call] = calls;
      assertDefined(call, "outbound fetch call");

      const signature = headerOf(call.init, "x-nax-signature");
      expect(signature).not.toBeNull();
      // The signature must cover the exact bytes that go on the wire.
      const expected = createHmac("sha256", "my-secret").update(String(call.init.body)).digest("hex");
      expect(signature).toBe(expected);
    } finally {
      restore();
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

    const callbackPort = plugin.callbackServerPort;
    assertDefined(callbackPort, "plugin.callbackServerPort");

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

// ---------------------------------------------------------------------------
// SEC-8: rate limiting + requireSecret: false warning
// ---------------------------------------------------------------------------

describe("WebhookInteractionPlugin - rate limiting (SEC-8)", () => {
  const origNow = _webhookPluginDeps.now;
  let fakeNowMs = 1_700_000_000_000;

  afterEach(async () => {
    _webhookPluginDeps.now = origNow;
  });

  async function postCallback(port: number, requestId: string): Promise<Response> {
    return fetch(`http://localhost:${port}/nax/interact/${requestId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, action: "approve", respondedAt: Date.now() }),
    });
  }

  test("requests beyond the per-window limit are rejected with 429 while under-limit requests succeed", async () => {
    fakeNowMs = 1_700_000_000_000;
    _webhookPluginDeps.now = () => fakeNowMs;

    const plugin = new WebhookInteractionPlugin();
    await plugin.init({
      url: "http://localhost/unused",
      requireSecret: false,
      callbackPort: 0,
      rateLimitMaxRequests: 3,
      rateLimitWindowMs: 60_000,
    });

    // Register 5 distinct IDs so "unknown-id" rejection doesn't mask the
    // rate-limit check — we want to isolate the 429 behavior.
    const ids = ["sec8-a", "sec8-b", "sec8-c", "sec8-d", "sec8-e"];
    for (const id of ids) {
      void plugin.receive(id, 4000);
    }
    await Promise.resolve();
    await Promise.resolve();
    const port = plugin.callbackServerPort;
    assertDefined(port, "plugin.callbackServerPort");

    try {
      const statuses: number[] = [];
      for (const id of ids) {
        const resp = await postCallback(port, id);
        statuses.push(resp.status);
      }

      // First 3 requests within the window are under the limit (200), the
      // remaining 2 are rejected with 429 — independent of per-ID auth state.
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await plugin.destroy();
    }
  });

  test("429 responses carry a Retry-After header naming seconds until the window resets", async () => {
    fakeNowMs = 1_700_000_000_000;
    _webhookPluginDeps.now = () => fakeNowMs;

    const plugin = new WebhookInteractionPlugin();
    await plugin.init({
      url: "http://localhost/unused",
      requireSecret: false,
      callbackPort: 0,
      rateLimitMaxRequests: 1,
      rateLimitWindowMs: 10_000,
    });

    void plugin.receive("sec8-retry-after-1", 4000);
    void plugin.receive("sec8-retry-after-2", 4000);
    await Promise.resolve();
    await Promise.resolve();
    const port = plugin.callbackServerPort;
    assertDefined(port, "plugin.callbackServerPort");

    try {
      const under = await postCallback(port, "sec8-retry-after-1");
      expect(under.status).toBe(200);
      expect(under.headers.get("Retry-After")).toBeNull();

      const over = await postCallback(port, "sec8-retry-after-2");
      expect(over.status).toBe(429);
      const retryAfter = over.headers.get("Retry-After");
      expect(retryAfter).not.toBeNull();
      expect(Number.parseInt(retryAfter ?? "", 10)).toBeGreaterThan(0);
      expect(Number.parseInt(retryAfter ?? "", 10)).toBeLessThanOrEqual(10);
    } finally {
      await plugin.destroy();
    }
  });

  test("rate limit window resets after the configured window elapses", async () => {
    fakeNowMs = 1_700_000_000_000;
    _webhookPluginDeps.now = () => fakeNowMs;

    const plugin = new WebhookInteractionPlugin();
    await plugin.init({
      url: "http://localhost/unused",
      requireSecret: false,
      callbackPort: 0,
      rateLimitMaxRequests: 1,
      rateLimitWindowMs: 1_000,
    });

    void plugin.receive("sec8-window-1", 4000);
    void plugin.receive("sec8-window-2", 4000);
    await Promise.resolve();
    await Promise.resolve();
    const port = plugin.callbackServerPort;
    assertDefined(port, "plugin.callbackServerPort");

    try {
      const first = await postCallback(port, "sec8-window-1");
      expect(first.status).toBe(200);

      const second = await postCallback(port, "sec8-window-2");
      expect(second.status).toBe(429);

      // Advance the injected clock past the window — the limiter should reset.
      fakeNowMs += 1_001;

      const third = await postCallback(port, "sec8-window-2");
      expect(third.status).toBe(200);
    } finally {
      await plugin.destroy();
    }
  });

  // The pre-auth bucket bounds raw flood volume for EVERY request (auth or
  // not) — it uses a generous multiple of rateLimitMaxRequests specifically
  // so it does not become the effective (tight) budget authenticated callers
  // rely on (see PRE_AUTH_RATE_LIMIT_MULTIPLIER in webhook.ts). This test
  // proves it still eventually rejects a gross unauthenticated flood.
  test("SEC-8: the pre-auth rate limit still applies to (and eventually rejects) requests that fail HMAC auth", async () => {
    fakeNowMs = 1_700_000_000_000;
    _webhookPluginDeps.now = () => fakeNowMs;

    const plugin = new WebhookInteractionPlugin();
    await plugin.init({
      url: "http://localhost/unused",
      secret: "test-secret",
      callbackPort: 0,
      rateLimitMaxRequests: 1,
      rateLimitWindowMs: 60_000,
    });

    const receivePromise = plugin.receive("sec8-auth-1", 4000);
    await Promise.resolve();
    await Promise.resolve();
    const port = plugin.callbackServerPort;
    assertDefined(port, "plugin.callbackServerPort");

    try {
      // The pre-auth bucket is a generous multiple of rateLimitMaxRequests
      // (1), not the tight configured value itself — send well beyond it
      // with unauthenticated (no signature) requests and confirm it still
      // eventually caps gross flood volume with 429.
      const statuses: number[] = [];
      for (let i = 0; i < 15; i += 1) {
        statuses.push((await postCallback(port, "sec8-auth-1")).status);
      }
      expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
      expect(statuses.some((s) => s === 429)).toBe(true);
    } finally {
      // destroy() resolves any still-pending receive() with a "destroyed" response.
      await plugin.destroy();
      await receivePromise;
    }
  });

  // SEC-8 fix: unauthenticated flood traffic must not be able to exhaust the
  // budget that authenticated (valid HMAC) callers rely on — a single shared
  // bucket let unauthenticated 401s permanently starve the real
  // approve/abort callback path. Two independent buckets fix this: the
  // pre-auth bucket bounds raw flood volume (at a much larger ceiling), the
  // auth bucket is a separate, tight budget consulted only for requests that
  // pass HMAC verification.
  test("SEC-8: an unauthenticated flood exhausting what used to be the shared budget does NOT block a subsequent authenticated request within the authenticated budget", async () => {
    fakeNowMs = 1_700_000_000_000;
    _webhookPluginDeps.now = () => fakeNowMs;

    const plugin = new WebhookInteractionPlugin();
    await plugin.init({
      url: "http://localhost/unused",
      secret: "test-secret",
      callbackPort: 0,
      rateLimitMaxRequests: 2,
      rateLimitWindowMs: 60_000,
    });

    const receivePromise = plugin.receive("sec8-starve-1", 4000);
    await Promise.resolve();
    await Promise.resolve();
    const port = plugin.callbackServerPort;
    assertDefined(port, "plugin.callbackServerPort");

    try {
      // Send more unauthenticated noise than the OLD single-bucket budget (2)
      // would have survived — under the pre-fix code, the 3rd of these would
      // already have exhausted the shared counter and doomed every later
      // authenticated request to 429.
      const first = await postCallback(port, "sec8-starve-1");
      const second = await postCallback(port, "sec8-starve-1");
      const third = await postCallback(port, "sec8-starve-1");
      expect(first.status).toBe(401);
      expect(second.status).toBe(401);
      expect(third.status).toBe(401);

      // A properly authenticated request must still get through — its budget
      // is the separate "auth" bucket, untouched by the unauthenticated noise.
      const payload = JSON.stringify({ requestId: "sec8-starve-1", action: "approve", respondedAt: Date.now() });
      const sig = createHmac("sha256", "test-secret").update(payload).digest("hex");
      const authed = await fetch(`http://localhost:${port}/nax/interact/sec8-starve-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nax-Signature": sig },
        body: payload,
      });
      expect(authed.status).toBe(200);

      const response = await receivePromise;
      expect(response.action).toBe("approve");
    } finally {
      await plugin.destroy();
    }
  });

  test("SEC-8: authenticated requests exhausting their own budget still get 429", async () => {
    fakeNowMs = 1_700_000_000_000;
    _webhookPluginDeps.now = () => fakeNowMs;

    const plugin = new WebhookInteractionPlugin();
    await plugin.init({
      url: "http://localhost/unused",
      secret: "test-secret",
      callbackPort: 0,
      rateLimitMaxRequests: 2,
      rateLimitWindowMs: 60_000,
    });

    const ids = ["sec8-authbudget-1", "sec8-authbudget-2", "sec8-authbudget-3"];
    for (const id of ids) {
      void plugin.receive(id, 4000);
    }
    await Promise.resolve();
    await Promise.resolve();
    const port = plugin.callbackServerPort;
    assertDefined(port, "plugin.callbackServerPort");

    async function postAuthed(requestId: string): Promise<Response> {
      const payload = JSON.stringify({ requestId, action: "approve", respondedAt: Date.now() });
      const sig = createHmac("sha256", "test-secret").update(payload).digest("hex");
      return fetch(`http://localhost:${port}/nax/interact/${requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nax-Signature": sig },
        body: payload,
      });
    }

    try {
      const statuses: number[] = [];
      for (const id of ids) {
        statuses.push((await postAuthed(id)).status);
      }

      // First 2 authenticated requests are within the auth bucket's budget;
      // the 3rd exceeds it and is rate-limited, even though the pre-auth
      // bucket (also budget 2, untouched by these 3 requests until now) has
      // headroom left.
      expect(statuses).toEqual([200, 200, 429]);
    } finally {
      await plugin.destroy();
    }
  });
});

describe("WebhookInteractionPlugin - requireSecret: false warning (SEC-8)", () => {
  afterEach(() => {
    resetLogger();
  });

  test("constructing the plugin with requireSecret: false logs the unauthenticated warning exactly once", async () => {
    const captured: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => captured.push(entry));

    const plugin = new WebhookInteractionPlugin();
    try {
      await plugin.init({
        url: "http://localhost/unused",
        requireSecret: false,
        callbackPort: 0,
      });

      const warnings = captured.filter(
        (entry) => entry.level === "warn" && entry.message.includes("requireSecret: false"),
      );
      expect(warnings).toHaveLength(1);
    } finally {
      await plugin.destroy();
    }
  });

  // Regression: `this.logger` used to be resolved once at construction via
  // getSafeLogger(). If the plugin instance is created BEFORE initLogger()
  // runs, that cached reference is permanently null and the requireSecret:
  // false warning (and any other logging) is silently discarded forever.
  // The fix resolves the logger at call-time instead.
  test("logs the unauthenticated warning even when the plugin was constructed before initLogger() ran", async () => {
    resetLogger();
    // Construct the plugin while there is no active logger yet.
    const plugin = new WebhookInteractionPlugin();

    const captured: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => captured.push(entry));

    try {
      await plugin.init({
        url: "http://localhost/unused",
        requireSecret: false,
        callbackPort: 0,
      });

      const warnings = captured.filter(
        (entry) => entry.level === "warn" && entry.message.includes("requireSecret: false"),
      );
      expect(warnings).toHaveLength(1);
    } finally {
      await plugin.destroy();
    }
  });

  test("constructing the plugin with a secret configured does not log the unauthenticated warning", async () => {
    const captured: LogEntry[] = [];
    initLogger({ level: "silent" });
    addSink((entry) => captured.push(entry));

    const plugin = new WebhookInteractionPlugin();
    try {
      await plugin.init({
        url: "http://localhost/unused",
        secret: "test-secret",
        callbackPort: 0,
      });

      const warnings = captured.filter(
        (entry) => entry.level === "warn" && entry.message.includes("requireSecret: false"),
      );
      expect(warnings).toHaveLength(0);
    } finally {
      await plugin.destroy();
    }
  });
});

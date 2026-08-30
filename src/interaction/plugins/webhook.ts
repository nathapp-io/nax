/**
 * Webhook Interaction Plugin (v0.15.0 US-007)
 *
 * Send interaction requests via HTTP POST to configured URL.
 * Start local HTTP server to receive callbacks with HMAC verification.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { z } from "zod";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { sleep } from "@/utils/bun-deps";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../types";
import { PayloadTooLargeError, readBodyWithLimit } from "./webhook-body-limit";
import { installServePortZeroCompat } from "./webhook-serve-compat";

/** Injectable sleep — kept for backward compat with tests; unused by receive() (event-driven delivery). @internal */
export const _webhookPluginDeps = {
  sleep,
  /** Injectable clock for the rate limiter (SEC-8); tests advance it to exercise fixed-window rollover. */
  now: () => Date.now(),
};

/** Webhook plugin configuration */
interface WebhookConfig {
  /** Webhook URL to POST requests to */
  url?: string;
  /** Local callback port (default: auto-assign) */
  callbackPort?: number;
  /** HMAC secret for signature verification */
  secret?: string;
  /** Maximum payload size in bytes (default: 1MB) */
  maxPayloadBytes?: number;
  /** Reject startup when no secret is configured (default: true) */
  requireSecret?: boolean;
  /** Max callback requests accepted per rate-limit window (default: 30) */
  rateLimitMaxRequests?: number;
  /** Rate-limit window size in ms (default: 60_000) */
  rateLimitWindowMs?: number;
}

/** Zod schema for validating webhook plugin config */
const WebhookConfigSchema = z.object({
  url: z.string().url().optional(),
  callbackPort: z
    .number()
    .int()
    .refine((p) => p === 0 || (p >= 1024 && p <= 65535), {
      message: "Port must be 0 (auto-assign) or between 1024 and 65535",
    })
    .optional(),
  secret: z.string().optional(),
  maxPayloadBytes: z.number().int().positive().optional(),
  requireSecret: z.boolean().optional(),
  rateLimitMaxRequests: z.number().int().positive().optional(),
  rateLimitWindowMs: z.number().int().positive().optional(),
});

/** Zod schema for validating webhook callback payloads */
const InteractionResponseSchema = z.object({
  requestId: z.string(),
  action: z.enum(["approve", "reject", "choose", "input", "skip", "abort"]),
  value: z.string().optional(),
  respondedBy: z.string().optional(),
  respondedAt: z.number(),
});

/** Max entries in pendingResponses (defense-in-depth; registered-ID gate is the primary control) */
const MAX_PENDING_RESPONSES = 500;

/**
 * BUG-18 — client-side deadline on the outbound webhook POST. Without it, a
 * black-holing webhook URL stalls send() (and thus the story waiting on the
 * interaction) indefinitely — no OS-level TCP timeout fires for a very long
 * time. Mirrors the AbortController pattern already used by the Telegram
 * plugin's outbound calls.
 */
const WEBHOOK_SEND_TIMEOUT_MS = 30_000;

/** Default rate-limit window (SEC-8): bounds abuse from a co-tenant local process. */
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
/** Default max authenticated requests accepted per window (the "auth" bucket). */
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 30;
/**
 * The pre-auth bucket (SEC-8) applies to every request regardless of outcome,
 * so it must not share the authenticated bucket's tight budget — otherwise
 * unauthenticated flood traffic exhausts the SAME counter a legitimate,
 * authenticated caller depends on, reproducing the exact starvation the
 * two-bucket split exists to prevent. It is sized as a generous multiple of
 * `rateLimitMaxRequests` — large enough that ordinary unauthenticated noise
 * never starves the authenticated bucket, while still capping gross flood
 * volume (resource exhaustion from a malicious or misbehaving co-tenant
 * process hammering the loopback endpoint).
 */
const PRE_AUTH_RATE_LIMIT_MULTIPLIER = 10;

/**
 * Webhook plugin for HTTP-based interaction
 */
export class WebhookInteractionPlugin implements InteractionPlugin {
  name = "webhook";
  private config: WebhookConfig = {};
  private server: Server | null = null;
  /**
   * Rate-limit window state (SEC-8): two independent fixed-window buckets.
   * `pre` bounds every request regardless of auth outcome (raw flood volume).
   * `auth` bounds only requests that PASS HMAC verification, so unauthenticated
   * noise exhausting `pre` cannot starve a legitimate, authenticated caller —
   * it has its own separate budget. When `requireSecret: false` there is no
   * auth check at all, so only `pre` is ever consulted (single-bucket, correct
   * for that degraded case).
   */
  private rateLimitBuckets = {
    pre: { windowStart: 0, count: 0 },
    auth: { windowStart: 0, count: 0 },
  };
  private serverStartPromise: Promise<void> | null = null;
  /** Restore fn from installServePortZeroCompat(); stopServer() invokes it so the patch lives as long as the server. */
  private compatRestore: (() => void) | null = null;
  private isDestroyed = false;
  /** IDs for which send() has been called but no response has been consumed yet */
  private registeredRequestIds = new Set<string>();
  /** Early-pickup map: responses that arrive before receive() is called */
  private pendingResponses = new Map<string, InteractionResponse>();
  /** Event-driven callbacks: requestId → resolve fn (set by receive(), called by handleRequest) */
  private receiveCallbacks = new Map<string, (response: InteractionResponse) => void>();
  /** Active receive timeout handles by requestId */
  private receiveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The actual port the callback server is listening on; null if not yet started. */
  get callbackServerPort(): number | null {
    if (!this.server) return null;
    return (this.server as unknown as { port: number }).port;
  }

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = WebhookConfigSchema.parse(config);
    this.isDestroyed = false;
    this.config = {
      url: cfg.url,
      callbackPort: cfg.callbackPort,
      secret: cfg.secret,
      maxPayloadBytes: cfg.maxPayloadBytes ?? 1024 * 1024, // 1MB default
      requireSecret: cfg.requireSecret ?? true,
      rateLimitMaxRequests: cfg.rateLimitMaxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      rateLimitWindowMs: cfg.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    };
    if (!this.config.url) {
      throw new Error("Webhook plugin requires 'url' config");
    }
    // Require a shared secret unless caller explicitly opts out.
    // Without a secret, any reachable caller can submit crafted actions.
    if (this.config.requireSecret && !this.config.secret) {
      throw new Error(
        "Webhook plugin requires 'secret' for callback authentication. " +
          "Set requireSecret: false to allow unsigned callbacks (not recommended).",
      );
    }
    // SEC-8: requireSecret: false fully disables auth on the loopback callback
    // endpoint — any co-tenant local process can submit approve/abort actions.
    // Warn once at config-validation time so the user is not surprised later.
    // Resolved at call-time (not cached on `this` at construction) because the
    // plugin can be constructed before initLogger() runs — a cached reference
    // would silently be permanently null and this warning would never surface.
    if (!this.config.requireSecret) {
      getSafeLogger()?.warn(
        "interaction",
        "Webhook plugin started with requireSecret: false — the callback endpoint is unauthenticated. " +
          "Any local process on this machine can submit interaction responses.",
      );
    }
    this.rateLimitBuckets = {
      pre: { windowStart: 0, count: 0 },
      auth: { windowStart: 0, count: 0 },
    };
  }

  /**
   * Fixed-window request rate limiter (SEC-8), operating on one of two
   * independent buckets:
   * - `"pre"` — checked for every request before auth, bounds raw flood
   *   volume. When `requireSecret` is true (the `"auth"` bucket exists and is
   *   the real per-caller budget), `"pre"` is sized to
   *   `rateLimitMaxRequests * PRE_AUTH_RATE_LIMIT_MULTIPLIER` so it never
   *   becomes the *effective* budget for authenticated traffic — otherwise
   *   unauthenticated noise exhausting `"pre"` would starve legitimate
   *   authenticated requests exactly like the pre-fix single-bucket bug,
   *   since `"pre"` is still checked ahead of every request including
   *   authenticated ones. When `requireSecret` is false there is no `"auth"`
   *   bucket at all (no auth check exists) — `"pre"` IS the single meaningful
   *   budget in that degraded case, so it stays at the exact configured
   *   `rateLimitMaxRequests`, unchanged from the pre-split behavior.
   * - `"auth"` — checked only for requests that pass HMAC verification, at
   *   the exact configured `rateLimitMaxRequests` — this is the real,
   *   isolated budget a legitimate caller relies on.
   */
  private checkRateLimit(bucket: "pre" | "auth"): boolean {
    const now = _webhookPluginDeps.now();
    const windowMs = this.config.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    const configuredMax = this.config.rateLimitMaxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS;
    const maxRequests =
      bucket === "pre" && this.config.requireSecret ? configuredMax * PRE_AUTH_RATE_LIMIT_MULTIPLIER : configuredMax;
    const state = this.rateLimitBuckets[bucket];

    if (now - state.windowStart >= windowMs) {
      state.windowStart = now;
      state.count = 0;
    }

    state.count += 1;
    return state.count <= maxRequests;
  }

  /**
   * Build a 429 response carrying a `Retry-After` header so a well-behaved
   * caller knows when the current fixed window resets, instead of retrying
   * blind. Must be called immediately after the `checkRateLimit` call that
   * rejected the request, so `state.windowStart` reflects the active window.
   */
  private rateLimitedResponse(bucket: "pre" | "auth"): Response {
    const windowMs = this.config.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    const state = this.rateLimitBuckets[bucket];
    const now = _webhookPluginDeps.now();
    const retryAfterSeconds = Math.max(1, Math.ceil((state.windowStart + windowMs - now) / 1000));
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    });
  }

  async destroy(): Promise<void> {
    this.isDestroyed = true;
    this.resolvePendingReceivesOnDestroy();
    this.pendingResponses.clear();
    this.registeredRequestIds.clear();

    if (this.server) {
      await this.stopServer();
    }
  }

  async send(request: InteractionRequest): Promise<void> {
    if (!this.config.url) {
      throw new Error("Webhook plugin not initialized");
    }

    await this.startServer();
    const callbackPort = this.callbackServerPort;
    if (callbackPort === null) {
      throw new NaxError("[interaction] Webhook callback server failed to start", "WEBHOOK_SERVER_START_FAILED", {
        stage: "interaction",
      });
    }

    // Register this ID so callbacks for it are accepted
    this.registeredRequestIds.add(request.id);

    const payload = {
      ...request,
      callbackUrl: `http://127.0.0.1:${callbackPort}/nax/interact/${request.id}`,
    };

    const signature = this.config.secret ? this.sign(JSON.stringify(payload)) : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (signature) {
      headers["X-Nax-Signature"] = signature;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_SEND_TIMEOUT_MS);
    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`Webhook POST failed (${response.status}): ${errorBody || response.statusText}`);
      }
    } catch (err) {
      // Unregister on send failure so the ID slot is released
      this.registeredRequestIds.delete(request.id);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send webhook request: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async receive(requestId: string, timeout = 60000): Promise<InteractionResponse> {
    const destroyedResponse: InteractionResponse = {
      requestId,
      action: "skip",
      respondedBy: "destroyed",
      respondedAt: Date.now(),
    };

    if (this.isDestroyed) {
      return destroyedResponse;
    }

    // Start HTTP server to receive callback
    await this.startServer();

    // destroy() may have been called while startServer() was in-flight
    if (this.isDestroyed) {
      return destroyedResponse;
    }

    // Mark this ID as actively expected so deliverResponse() accepts its callback.
    // receive() can be called without a prior send() in some flows (e.g. resume after restart).
    this.registeredRequestIds.add(requestId);

    // Check if a response already arrived before receive() was called
    const early = this.pendingResponses.get(requestId);
    if (early) {
      this.pendingResponses.delete(requestId);
      this.registeredRequestIds.delete(requestId);
      return early;
    }

    // Event-driven: resolve immediately when handleRequest delivers the response
    return new Promise<InteractionResponse>((resolve) => {
      const existingCallback = this.receiveCallbacks.get(requestId);
      if (existingCallback) {
        this.clearReceiveTimer(requestId);
        existingCallback({
          requestId,
          action: "skip",
          respondedBy: "superseded",
          respondedAt: Date.now(),
        });
      }

      const timer = setTimeout(() => {
        this.clearReceiveTimer(requestId);
        this.receiveCallbacks.delete(requestId);
        this.registeredRequestIds.delete(requestId);
        resolve({
          requestId,
          action: "skip",
          respondedBy: "timeout",
          respondedAt: Date.now(),
        });
      }, timeout);
      this.receiveTimers.set(requestId, timer);

      this.receiveCallbacks.set(requestId, (response) => {
        this.clearReceiveTimer(requestId);
        this.receiveCallbacks.delete(requestId);
        this.registeredRequestIds.delete(requestId);
        resolve(response);
      });
    });
  }

  async cancel(requestId: string): Promise<void> {
    this.clearReceiveTimer(requestId);
    this.pendingResponses.delete(requestId);
    this.receiveCallbacks.delete(requestId);
    this.registeredRequestIds.delete(requestId);
  }

  /**
   * Deliver a response to a waiting receive() callback, or store for later pickup.
   * Responses for unknown (unregistered) request IDs are rejected.
   *
   * Returns "capacity-exceeded" when the early-pickup store is full
   * (MAX_PENDING_RESPONSES) and the response was silently discarded — the
   * caller must surface this as an error status rather than reporting
   * success (BUG-47). Other outcomes are informational only; existing
   * callers already return a generic 200/reject for those.
   */
  private deliverResponse(
    requestId: string,
    response: InteractionResponse,
  ): "delivered" | "unknown-id" | "destroyed" | "capacity-exceeded" {
    if (this.isDestroyed) {
      return "destroyed";
    }

    // Reject callbacks for IDs that were never sent — prevents DoS via unknown IDs
    if (!this.registeredRequestIds.has(requestId)) {
      return "unknown-id";
    }

    const cb = this.receiveCallbacks.get(requestId);
    if (cb) {
      cb(response);
      return "delivered";
    }

    if (this.pendingResponses.size < MAX_PENDING_RESPONSES) {
      // receive() hasn't been called yet — store for early-pickup path
      this.pendingResponses.set(requestId, response);
      return "delivered";
    }

    // Capacity exceeded — the response was NOT stored. Caller must not
    // report success to the webhook caller.
    return "capacity-exceeded";
  }

  private clearReceiveTimer(requestId: string): void {
    const timer = this.receiveTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.receiveTimers.delete(requestId);
    }
  }

  private resolvePendingReceivesOnDestroy(): void {
    const now = Date.now();

    for (const [requestId, callback] of this.receiveCallbacks.entries()) {
      callback({
        requestId,
        action: "skip",
        respondedBy: "destroyed",
        respondedAt: now,
      });
    }

    for (const timer of this.receiveTimers.values()) {
      clearTimeout(timer);
    }

    this.receiveTimers.clear();
    this.receiveCallbacks.clear();
  }

  /**
   * Start HTTP server for callbacks (with mutex to prevent race conditions).
   * Binds to localhost only — the callback URL is an internal nax-to-nax channel.
   */
  private async startServer(): Promise<void> {
    if (this.server) return; // Already running
    if (this.serverStartPromise !== null) {
      await this.serverStartPromise;
      return;
    }
    // SEC-06: install the compat shim lazily on first actual server start,
    // not as a module-import side effect (previously patched two
    // process-wide globals merely by importing webhook.ts).
    this.compatRestore = installServePortZeroCompat();
    this.serverStartPromise = (async () => {
      const port = this.config.callbackPort ?? 0;
      this.server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: (req) => this.handleRequest(req),
      }) as unknown as Server;
    })();
    try {
      await this.serverStartPromise;
    } catch (err) {
      // BUG-50: if Bun.serve rejects, serverStartPromise must not stay
      // wedged on a rejected promise — reset it so the next startServer()
      // call gets a clean retry instead of permanently reusing this
      // rejected promise (every future send()/receive() would await it and
      // immediately re-throw, wedging the plugin until a full re-init).
      this.serverStartPromise = null;
      this.compatRestore?.();
      this.compatRestore = null;
      throw err;
    }
    this.serverStartPromise = null;
  }

  /**
   * Stop HTTP server
   */
  private async stopServer(): Promise<void> {
    if (!this.server) return;

    // Bun.serve returns a server with stop() method
    const bunServer = this.server as unknown as { stop: () => void };
    bunServer.stop();
    this.server = null;
    this.serverStartPromise = null;
    this.compatRestore?.();
    this.compatRestore = null;
  }

  /**
   * Handle HTTP request
   */
  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Only accept POST to /nax/interact/:requestId
    if (req.method !== "POST" || !url.pathname.startsWith("/nax/interact/")) {
      return new Response("Not Found", { status: 404 });
    }

    const requestId = url.pathname.split("/").pop();
    if (!requestId) {
      return new Response("Bad Request", { status: 400 });
    }

    // SEC-8: enforce the pre-auth rate limit before auth/body handling —
    // applies to every request, authenticated or not, bounding raw flood
    // volume. This alone must not be able to starve authenticated callers —
    // see the separate "auth" bucket check after signature verification below.
    if (!this.checkRateLimit("pre")) {
      return this.rateLimitedResponse("pre");
    }

    const maxBytes = this.config.maxPayloadBytes ?? 1024 * 1024;

    // Check content length before reading body
    const contentLength = req.headers.get("Content-Length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      return new Response("Payload Too Large", { status: 413 });
    }

    // SEC-04: read the body via a stream reader and abort as soon as the
    // accumulated byte count crosses maxBytes, instead of buffering the
    // full body with req.text() first. A chunked-transfer request with no
    // (or a lying) Content-Length header would otherwise be fully read
    // into memory before size was ever checked — the Content-Length guard
    // above is bypassable and was the only enforcement that ran before the
    // buffer existed.
    let body: string;
    try {
      body = await readBodyWithLimit(req, maxBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return new Response("Payload Too Large", { status: 413 });
      }
      return new Response("Bad Request", { status: 400 });
    }

    // Verify signature if secret is configured
    if (this.config.secret) {
      const signature = req.headers.get("X-Nax-Signature");
      if (!signature || !this.verify(body, signature)) {
        return new Response("Unauthorized", { status: 401 });
      }
      // SEC-8: authenticated requests get their own separate budget, so
      // unauthenticated noise exhausting the "pre" bucket above cannot starve
      // a legitimate authenticated caller. Only meaningful when auth is
      // actually required — with requireSecret: false there is no auth check
      // at all, so the single "pre" bucket is correct as-is for that case.
      if (this.config.requireSecret && !this.checkRateLimit("auth")) {
        return this.rateLimitedResponse("auth");
      }
    }

    // Parse and validate body
    let deliveryResult: "delivered" | "unknown-id" | "destroyed" | "capacity-exceeded";
    try {
      const parsed = JSON.parse(body);
      const response = InteractionResponseSchema.parse(parsed);
      deliveryResult = this.deliverResponse(requestId, response);
    } catch {
      // Sanitize error - do not leak parse/validation details
      return new Response("Bad Request: Invalid response format", { status: 400 });
    }

    // BUG-47: capacity exceeded means the response was silently discarded —
    // returning 200 here would mislead the caller into thinking it was
    // recorded. Surface a retryable error status instead.
    if (deliveryResult === "capacity-exceeded") {
      return new Response("Service Unavailable: pending response capacity exceeded", { status: 503 });
    }

    return new Response("OK", { status: 200 });
  }

  /**
   * Sign payload with HMAC-SHA256
   */
  private sign(payload: string): string {
    if (!this.config.secret) return "";
    const hmac = createHmac("sha256", this.config.secret);
    hmac.update(payload);
    return hmac.digest("hex");
  }

  /**
   * Verify HMAC signature
   */
  private verify(payload: string, signature: string): boolean {
    if (!this.config.secret) return false;
    const expected = this.sign(payload);
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
}

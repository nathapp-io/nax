/**
 * Webhook Interaction Plugin (v0.15.0 US-007)
 *
 * Send interaction requests via HTTP POST to configured URL.
 * Start local HTTP server to receive callbacks with HMAC verification.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { z } from "zod";
import { sleep } from "../../utils/bun-deps";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../types";

/**
 * Injectable sleep — kept for backward compat with existing tests that override it.
 * No longer used internally by receive() (replaced by event-driven delivery).
 * @internal
 */
export const _webhookPluginDeps = {
  sleep,
};

/** Webhook plugin configuration */
interface WebhookConfig {
  /** Webhook URL to POST requests to */
  url?: string;
  /** Local callback port (default: 8765) */
  callbackPort?: number;
  /** HMAC secret for signature verification */
  secret?: string;
  /** Maximum payload size in bytes (default: 1MB) */
  maxPayloadBytes?: number;
  /** Reject startup when no secret is configured (default: true) */
  requireSecret?: boolean;
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
 * Webhook plugin for HTTP-based interaction
 */
export class WebhookInteractionPlugin implements InteractionPlugin {
  name = "webhook";
  private config: WebhookConfig = {};
  private server: Server | null = null;
  private serverStartPromise: Promise<void> | null = null;
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
      callbackPort: cfg.callbackPort ?? 8765,
      secret: cfg.secret,
      maxPayloadBytes: cfg.maxPayloadBytes ?? 1024 * 1024, // 1MB default
      requireSecret: cfg.requireSecret ?? true,
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

    // Register this ID so callbacks for it are accepted
    this.registeredRequestIds.add(request.id);

    const payload = {
      ...request,
      callbackUrl: `http://127.0.0.1:${this.config.callbackPort}/nax/interact/${request.id}`,
    };

    const signature = this.config.secret ? this.sign(JSON.stringify(payload)) : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (signature) {
      headers["X-Nax-Signature"] = signature;
    }

    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
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
   */
  private deliverResponse(requestId: string, response: InteractionResponse): void {
    if (this.isDestroyed) {
      return;
    }

    // Reject callbacks for IDs that were never sent — prevents DoS via unknown IDs
    if (!this.registeredRequestIds.has(requestId)) {
      return;
    }

    const cb = this.receiveCallbacks.get(requestId);
    if (cb) {
      cb(response);
    } else if (this.pendingResponses.size < MAX_PENDING_RESPONSES) {
      // receive() hasn't been called yet — store for early-pickup path
      this.pendingResponses.set(requestId, response);
    }
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
    if (this.serverStartPromise) {
      await this.serverStartPromise;
      return;
    }
    this.serverStartPromise = (async () => {
      const port = this.config.callbackPort ?? 8765;
      this.server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: (req) => this.handleRequest(req),
      }) as unknown as Server;
    })();
    await this.serverStartPromise;
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

    const maxBytes = this.config.maxPayloadBytes ?? 1024 * 1024;

    // Check content length before reading body
    const contentLength = req.headers.get("Content-Length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      return new Response("Payload Too Large", { status: 413 });
    }

    // Read body once, then enforce byte-accurate size limit in both branches
    let body: string;
    try {
      body = await req.text();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Use TextEncoder for byte-accurate measurement (handles multibyte chars correctly)
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
      return new Response("Payload Too Large", { status: 413 });
    }

    // Verify signature if secret is configured
    if (this.config.secret) {
      const signature = req.headers.get("X-Nax-Signature");
      if (!signature || !this.verify(body, signature)) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // Parse and validate body
    try {
      const parsed = JSON.parse(body);
      const response = InteractionResponseSchema.parse(parsed);
      this.deliverResponse(requestId, response);
    } catch {
      // Sanitize error - do not leak parse/validation details
      return new Response("Bad Request: Invalid response format", { status: 400 });
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

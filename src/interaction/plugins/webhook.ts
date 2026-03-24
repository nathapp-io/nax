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
}

/** Zod schema for validating webhook plugin config */
const WebhookConfigSchema = z.object({
  url: z.string().url().optional(),
  callbackPort: z.number().int().min(1024).max(65535).optional(),
  secret: z.string().optional(),
  maxPayloadBytes: z.number().int().positive().optional(),
});

/** Zod schema for validating webhook callback payloads */
const InteractionResponseSchema = z.object({
  requestId: z.string(),
  action: z.enum(["approve", "reject", "choose", "input", "skip", "abort"]),
  value: z.string().optional(),
  respondedBy: z.string().optional(),
  respondedAt: z.number(),
});

/**
 * Webhook plugin for HTTP-based interaction
 */
export class WebhookInteractionPlugin implements InteractionPlugin {
  name = "webhook";
  private config: WebhookConfig = {};
  private server: Server | null = null;
  private serverStartPromise: Promise<void> | null = null;
  /** Legacy map for responses that arrive before receive() is called */
  private pendingResponses = new Map<string, InteractionResponse>();
  /** Event-driven callbacks: requestId → resolve fn (set by receive(), called by handleRequest) */
  private receiveCallbacks = new Map<string, (response: InteractionResponse) => void>();

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = WebhookConfigSchema.parse(config);
    this.config = {
      url: cfg.url,
      callbackPort: cfg.callbackPort ?? 8765,
      secret: cfg.secret,
      maxPayloadBytes: cfg.maxPayloadBytes ?? 1024 * 1024, // 1MB default
    };
    if (!this.config.url) {
      throw new Error("Webhook plugin requires 'url' config");
    }
  }

  async destroy(): Promise<void> {
    if (this.server) {
      await this.stopServer();
    }
  }

  async send(request: InteractionRequest): Promise<void> {
    if (!this.config.url) {
      throw new Error("Webhook plugin not initialized");
    }

    const payload = {
      ...request,
      callbackUrl: `http://localhost:${this.config.callbackPort}/nax/interact/${request.id}`,
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
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to send webhook request: ${msg}`);
    }
  }

  async receive(requestId: string, timeout = 60000): Promise<InteractionResponse> {
    // Start HTTP server to receive callback
    await this.startServer();

    // Check if a response already arrived before receive() was called
    const early = this.pendingResponses.get(requestId);
    if (early) {
      this.pendingResponses.delete(requestId);
      return early;
    }

    // Event-driven: resolve immediately when handleRequest delivers the response
    return new Promise<InteractionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.receiveCallbacks.delete(requestId);
        resolve({
          requestId,
          action: "skip",
          respondedBy: "timeout",
          respondedAt: Date.now(),
        });
      }, timeout);

      this.receiveCallbacks.set(requestId, (response) => {
        clearTimeout(timer);
        this.receiveCallbacks.delete(requestId);
        resolve(response);
      });
    });
  }

  async cancel(requestId: string): Promise<void> {
    this.pendingResponses.delete(requestId);
    this.receiveCallbacks.delete(requestId);
  }

  /**
   * Deliver a response to a waiting receive() callback, or store for later pickup.
   */
  private deliverResponse(requestId: string, response: InteractionResponse): void {
    const cb = this.receiveCallbacks.get(requestId);
    if (cb) {
      cb(response);
    } else {
      // receive() hasn't been called yet — store for early-pickup path
      this.pendingResponses.set(requestId, response);
    }
  }

  /**
   * Start HTTP server for callbacks (with mutex to prevent race conditions)
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

    // Check content length before reading body
    const contentLength = req.headers.get("Content-Length");
    const maxBytes = this.config.maxPayloadBytes ?? 1024 * 1024;
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      return new Response("Payload Too Large", { status: 413 });
    }

    // Verify signature if secret is configured
    if (this.config.secret) {
      const signature = req.headers.get("X-Nax-Signature");
      const body = await req.text();

      // Check actual body size (in case Content-Length was missing)
      if (body.length > maxBytes) {
        return new Response("Payload Too Large", { status: 413 });
      }

      if (!signature || !this.verify(body, signature)) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Parse and validate verified body
      try {
        const parsed = JSON.parse(body);
        const response = InteractionResponseSchema.parse(parsed);
        this.deliverResponse(requestId, response);
      } catch {
        // Sanitize error - do not leak parse/validation details
        return new Response("Bad Request: Invalid response format", { status: 400 });
      }
    } else {
      // No signature verification - still validate structure
      try {
        const parsed = await req.json();
        const response = InteractionResponseSchema.parse(parsed);
        this.deliverResponse(requestId, response);
      } catch {
        // Sanitize error - do not leak parse/validation details
        return new Response("Bad Request: Invalid response format", { status: 400 });
      }
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
    if (expected.length !== signature.length) return false;

    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
}

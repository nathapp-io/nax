/**
 * Webhook Interaction Plugin (v0.15.0 US-007)
 *
 * Send interaction requests via HTTP POST to configured URL.
 * Start local HTTP server to receive callbacks with HMAC verification.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { z } from "zod";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../types";

/** Webhook plugin configuration */
interface WebhookConfig {
  /** Webhook URL to POST requests to */
  url?: string;
  /** Local callback port (default: 8765) */
  callbackPort?: number;
  /** HMAC secret for signature verification */
  secret?: string;
}

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
  private pendingResponses = new Map<string, InteractionResponse>();

  async init(config: Record<string, unknown>): Promise<void> {
    this.config = config as WebhookConfig;
    if (!this.config.url) {
      throw new Error("Webhook plugin requires 'url' config");
    }
    if (!this.config.callbackPort) {
      this.config.callbackPort = 8765;
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

    const startTime = Date.now();

    // Poll for response
    while (Date.now() - startTime < timeout) {
      const response = this.pendingResponses.get(requestId);
      if (response) {
        this.pendingResponses.delete(requestId);
        return response;
      }
      await Bun.sleep(100);
    }

    // Timeout
    return {
      requestId,
      action: "skip",
      respondedBy: "timeout",
      respondedAt: Date.now(),
    };
  }

  async cancel(requestId: string): Promise<void> {
    this.pendingResponses.delete(requestId);
  }

  /**
   * Start HTTP server for callbacks
   */
  private async startServer(): Promise<void> {
    if (this.server) return; // Already running

    const port = this.config.callbackPort ?? 8765;

    this.server = Bun.serve({
      port,
      fetch: (req) => this.handleRequest(req),
    }) as unknown as Server;
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

    // Verify signature if secret is configured
    if (this.config.secret) {
      const signature = req.headers.get("X-Nax-Signature");
      const body = await req.text();

      if (!signature || !this.verify(body, signature)) {
        return new Response("Unauthorized", { status: 401 });
      }

      // Parse and validate verified body
      try {
        const parsed = JSON.parse(body);
        const response = InteractionResponseSchema.parse(parsed);
        this.pendingResponses.set(requestId, response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`Bad Request: Invalid response format (${msg})`, { status: 400 });
      }
    } else {
      // No signature verification - still validate structure
      try {
        const parsed = await req.json();
        const response = InteractionResponseSchema.parse(parsed);
        this.pendingResponses.set(requestId, response);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(`Bad Request: Invalid response format (${msg})`, { status: 400 });
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

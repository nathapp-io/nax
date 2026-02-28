/**
 * CLI Interaction Plugin (v0.15.0 US-002)
 *
 * Default plugin for stdin/stdout interaction in non-headless mode.
 */

import * as readline from "node:readline";
import { z } from "zod";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../types";

/** Zod schema for validating CLI plugin config */
const CLIConfigSchema = z.object({}).passthrough();

/**
 * CLI plugin for interactive prompts via stdin/stdout
 */
export class CLIInteractionPlugin implements InteractionPlugin {
  name = "cli";
  private pendingRequests = new Map<string, InteractionRequest>();
  private rl: readline.Interface | null = null;

  async init(config: Record<string, unknown> = {}): Promise<void> {
    CLIConfigSchema.parse(config);
    // Initialize readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async destroy(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  async send(request: InteractionRequest): Promise<void> {
    this.pendingRequests.set(request.id, request);

    // Format and print the request
    console.log(`\n${"=".repeat(80)}`);
    console.log(`[INTERACTION] ${request.stage.toUpperCase()} — ${request.type.toUpperCase()}`);
    console.log("=".repeat(80));
    console.log(`\n${request.summary}\n`);

    if (request.detail) {
      console.log(request.detail);
      console.log("");
    }

    if (request.options && request.options.length > 0) {
      console.log("Options:");
      for (const opt of request.options) {
        const desc = opt.description ? ` — ${opt.description}` : "";
        console.log(`  [${opt.key}] ${opt.label}${desc}`);
      }
      console.log("");
    }

    if (request.timeout) {
      const timeoutSec = Math.floor(request.timeout / 1000);
      console.log(`[Timeout: ${timeoutSec}s | Fallback: ${request.fallback}]`);
    }

    console.log(`${"=".repeat(80)}\n`);
  }

  async receive(requestId: string, timeout = 60000): Promise<InteractionResponse> {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      throw new Error(`No pending request with ID: ${requestId}`);
    }

    if (!this.rl) {
      throw new Error("CLI plugin not initialized");
    }

    const response = await this.promptUser(request, timeout);
    this.pendingRequests.delete(requestId);
    return response;
  }

  async cancel(requestId: string): Promise<void> {
    this.pendingRequests.delete(requestId);
  }

  /**
   * Prompt user for response with timeout
   */
  private async promptUser(request: InteractionRequest, timeout: number): Promise<InteractionResponse> {
    if (!this.rl) {
      throw new Error("CLI plugin not initialized");
    }

    const timeoutPromise = new Promise<InteractionResponse>((resolve) => {
      setTimeout(() => {
        resolve({
          requestId: request.id,
          action: "skip",
          respondedBy: "timeout",
          respondedAt: Date.now(),
        });
      }, timeout);
    });

    const userPromise = this.getUserInput(request);

    const response = await Promise.race([userPromise, timeoutPromise]);
    return response;
  }

  /**
   * Get user input based on interaction type
   */
  private async getUserInput(request: InteractionRequest): Promise<InteractionResponse> {
    if (!this.rl) {
      throw new Error("CLI plugin not initialized");
    }

    switch (request.type) {
      case "confirm":
        return this.promptConfirm(request);
      case "choose":
        return this.promptChoose(request);
      case "input":
        return this.promptInput(request);
      case "review":
        return this.promptReview(request);
      case "notify":
        // Notify doesn't require input
        return {
          requestId: request.id,
          action: "approve",
          respondedBy: "system",
          respondedAt: Date.now(),
        };
      case "webhook":
        // Webhook is handled externally
        return {
          requestId: request.id,
          action: "approve",
          respondedBy: "system",
          respondedAt: Date.now(),
        };
    }
  }

  /**
   * Prompt for confirmation (yes/no)
   */
  private async promptConfirm(request: InteractionRequest): Promise<InteractionResponse> {
    const answer = await this.question("Approve? [y/n/skip/abort]: ");
    const normalized = answer.toLowerCase().trim();

    let action: InteractionResponse["action"];
    if (normalized === "y" || normalized === "yes") {
      action = "approve";
    } else if (normalized === "n" || normalized === "no") {
      action = "reject";
    } else if (normalized === "skip") {
      action = "skip";
    } else if (normalized === "abort") {
      action = "abort";
    } else {
      // Invalid input, default to skip
      action = "skip";
    }

    return {
      requestId: request.id,
      action,
      respondedBy: "user",
      respondedAt: Date.now(),
    };
  }

  /**
   * Prompt for choice from options
   */
  private async promptChoose(request: InteractionRequest): Promise<InteractionResponse> {
    const answer = await this.question("Choose [key or skip/abort]: ");
    const normalized = answer.toLowerCase().trim();

    if (normalized === "skip") {
      return {
        requestId: request.id,
        action: "skip",
        respondedBy: "user",
        respondedAt: Date.now(),
      };
    }

    if (normalized === "abort") {
      return {
        requestId: request.id,
        action: "abort",
        respondedBy: "user",
        respondedAt: Date.now(),
      };
    }

    // Check if answer matches an option key
    const option = request.options?.find((opt) => opt.key === normalized);
    if (option) {
      return {
        requestId: request.id,
        action: "choose",
        value: option.key,
        respondedBy: "user",
        respondedAt: Date.now(),
      };
    }

    // Invalid choice, default to skip
    return {
      requestId: request.id,
      action: "skip",
      respondedBy: "user",
      respondedAt: Date.now(),
    };
  }

  /**
   * Prompt for text input
   */
  private async promptInput(request: InteractionRequest): Promise<InteractionResponse> {
    const answer = await this.question("Input [or skip/abort]: ");
    const normalized = answer.trim();

    if (normalized.toLowerCase() === "skip") {
      return {
        requestId: request.id,
        action: "skip",
        respondedBy: "user",
        respondedAt: Date.now(),
      };
    }

    if (normalized.toLowerCase() === "abort") {
      return {
        requestId: request.id,
        action: "abort",
        respondedBy: "user",
        respondedAt: Date.now(),
      };
    }

    return {
      requestId: request.id,
      action: "input",
      value: normalized,
      respondedBy: "user",
      respondedAt: Date.now(),
    };
  }

  /**
   * Prompt for review (detailed approval)
   */
  private async promptReview(request: InteractionRequest): Promise<InteractionResponse> {
    const answer = await this.question("Review complete? [approve/reject/skip/abort]: ");
    const normalized = answer.toLowerCase().trim();

    let action: InteractionResponse["action"];
    if (normalized === "approve") {
      action = "approve";
    } else if (normalized === "reject") {
      action = "reject";
    } else if (normalized === "skip") {
      action = "skip";
    } else if (normalized === "abort") {
      action = "abort";
    } else {
      action = "skip";
    }

    return {
      requestId: request.id,
      action,
      respondedBy: "user",
      respondedAt: Date.now(),
    };
  }

  /**
   * Async wrapper for readline.question
   */
  private async question(prompt: string): Promise<string> {
    if (!this.rl) {
      throw new Error("CLI plugin not initialized");
    }

    return new Promise((resolve) => {
      this.rl?.question(prompt, (answer) => {
        resolve(answer);
      });
    });
  }
}

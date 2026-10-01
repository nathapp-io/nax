/**
 * Interaction Plugin Chain (v0.15.0)
 *
 * Manages plugin priority, fallback cascade, and request routing.
 */

import { NaxError } from "../errors";
import type { InteractionFallback, InteractionPlugin, InteractionRequest, InteractionResponse } from "./types";

/** Plugin chain entry */
interface ChainEntry {
  plugin: InteractionPlugin;
  priority: number;
}

/** Plugin chain configuration */
export interface ChainConfig {
  /** Default timeout for all requests (ms) */
  defaultTimeout: number;
  /** Default fallback behavior */
  defaultFallback: InteractionFallback;
}

/**
 * Interaction plugin chain with priority and fallback cascade
 */
export class InteractionChain {
  private plugins: ChainEntry[] = [];
  private config: ChainConfig;

  constructor(config: ChainConfig) {
    this.config = config;
  }

  /**
   * Register a plugin with priority (higher = earlier in chain)
   */
  register(plugin: InteractionPlugin, priority = 0): void {
    this.plugins.push({ plugin, priority });
    this.plugins.sort((a, b) => b.priority - a.priority); // descending
  }

  /**
   * Get primary plugin (highest priority)
   */
  getPrimary(): InteractionPlugin | null {
    return this.plugins[0]?.plugin ?? null;
  }

  /**
   * Send interaction request through the chain with fallback cascade.
   *
   * BUG-7: send() now mirrors receive() — on a transient plugin failure
   * (network 5xx, hung connection at prompt time) we try the next plugin
   * in priority order instead of aborting the run. Keyboard-build failures
   * stay plugin-local (telegram.ts:162-167 swallows them and posts without
   * buttons), so they never reach this cascade.
   */
  async send(request: InteractionRequest): Promise<void> {
    if (this.plugins.length === 0) {
      throw new NaxError("No interaction plugin registered", "INTERACTION_ERROR", {
        stage: "run",
        requestId: request.id,
      });
    }

    const errors: Error[] = [];
    for (const entry of this.plugins) {
      try {
        await entry.plugin.send(request);
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);
      }
    }

    const errorMessages = errors.map((e) => e.message).join("; ");
    throw new NaxError(`All interaction plugins failed: ${errorMessages}`, "INTERACTION_ERROR", {
      stage: "run",
      requestId: request.id,
      pluginCount: this.plugins.length,
    });
  }

  /**
   * Receive interaction response with timeout and fallback cascade
   */
  async receive(requestId: string, timeout?: number): Promise<InteractionResponse> {
    if (this.plugins.length === 0) {
      throw new NaxError("No interaction plugin registered", "INTERACTION_ERROR", { stage: "run", requestId });
    }

    const timeoutMs = timeout ?? this.config.defaultTimeout;
    const errors: Error[] = [];

    // Try each plugin in priority order (fallback cascade)
    for (const entry of this.plugins) {
      try {
        const response = await entry.plugin.receive(requestId, timeoutMs);
        return response;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errors.push(error);
        // Continue to next plugin
      }
    }

    // All plugins failed - throw with all error messages
    const errorMessages = errors.map((e) => e.message).join("; ");
    throw new NaxError(`All interaction plugins failed: ${errorMessages}`, "INTERACTION_ERROR", {
      stage: "run",
      requestId,
      pluginCount: this.plugins.length,
    });
  }

  /**
   * Send and receive in one call (convenience method).
   *
   * Normalizes "choose" type responses: when the plugin returns
   * `action: "choose"` + `value: "<key>"`, remaps action to the selected
   * option key so all consumers can switch on action directly without
   * needing to inspect value themselves.
   */
  async prompt(request: InteractionRequest): Promise<InteractionResponse> {
    await this.send(request);
    const response = await this.receive(request.id, request.timeout);

    // Normalize choose responses: action="choose" means the user picked an option;
    // the actual selection is in value. Remap to the selected key if it matches
    // one of the declared options.
    if (response.action === "choose" && response.value && request.options) {
      const matched = request.options.find((o) => o.key === response.value);
      if (matched) {
        return { ...response, action: matched.key as InteractionResponse["action"] };
      }
    }

    return response;
  }

  /**
   * Cancel a pending interaction
   */
  async cancel(requestId: string): Promise<void> {
    const plugin = this.getPrimary();
    if (plugin?.cancel) {
      await plugin.cancel(requestId);
    }
  }

  /**
   * Initialize all plugins
   */
  async init(pluginConfigs: Record<string, Record<string, unknown>>): Promise<void> {
    for (const entry of this.plugins) {
      if (entry.plugin.init) {
        const config = pluginConfigs[entry.plugin.name] ?? {};
        await entry.plugin.init(config);
      }
    }
  }

  /**
   * Destroy all plugins
   */
  async destroy(): Promise<void> {
    for (const entry of this.plugins) {
      if (entry.plugin.destroy) {
        await entry.plugin.destroy();
      }
    }
  }

  /**
   * Apply fallback behavior to get final action
   */
  applyFallback(response: InteractionResponse, fallback: InteractionFallback): InteractionAction {
    // If user responded explicitly, use their action
    if (response.respondedBy !== "timeout" && response.respondedBy !== "system") {
      return response.action;
    }

    // Otherwise apply fallback
    switch (fallback) {
      case "continue":
        return "approve";
      case "skip":
        return "skip";
      case "escalate":
        return "approve"; // proceed but escalate tier
      case "abort":
        return "abort";
      // SEC-3: fail-closed defence-in-depth. The Zod enum now rejects an
      // unrecognized fallback at config load, but this switch must not
      // silently return `undefined` (read as "proceed") for any value that
      // reaches it by another path.
      default:
        return "abort";
    }
  }
}

/** Convenience type for action */
type InteractionAction = InteractionResponse["action"];

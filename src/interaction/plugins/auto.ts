/**
 * Auto AI Responder Plugin (v0.15.0 US-008)
 *
 * Automatically responds to interactions using LLM decision-making.
 * Never auto-approves security-review triggers.
 */

import { z } from "zod";
import type { AgentAdapter } from "../../agents/types";
import type { NaxConfig } from "../../config";
import { resolveModelForAgent } from "../../config";
import type { InteractionPlugin, InteractionRequest, InteractionResponse } from "../types";

/** Auto plugin configuration */
interface AutoConfig {
  /** Model tier to use for decisions (default: fast) */
  model?: string;
  /** Confidence threshold (0-1, default: 0.7) */
  confidenceThreshold?: number;
  /** Max cost per decision in USD (default: 0.01) */
  maxCostPerDecision?: number;
  /** Global nax config (injected by chain) */
  naxConfig?: NaxConfig;
}

/** Zod schema for validating auto plugin config */
const AutoConfigSchema = z.object({
  model: z.string().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  maxCostPerDecision: z.number().positive().optional(),
  naxConfig: z.any().optional(), // NaxConfig is complex, skip deep validation
});

/** LLM decision response */
interface DecisionResponse {
  action: "approve" | "reject" | "choose" | "input" | "skip" | "abort";
  value?: string;
  confidence: number;
  reasoning: string;
}

/**
 * Module-level deps for testability (_deps pattern).
 * Override adapter in tests to mock adapter.complete() without spawning the claude CLI.
 *
 * For backward compatibility, also supports _autoPluginDeps.callLlm (deprecated).
 */
export const _autoPluginDeps = {
  adapter: null as AgentAdapter | null,
  callLlm: null as ((request: InteractionRequest) => Promise<DecisionResponse>) | null,
};

/**
 * Auto plugin for AI-powered interaction responses
 */
export class AutoInteractionPlugin implements InteractionPlugin {
  name = "auto";
  private config: AutoConfig = {};

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = AutoConfigSchema.parse(config);
    this.config = {
      model: cfg.model ?? "fast",
      confidenceThreshold: cfg.confidenceThreshold ?? 0.7,
      maxCostPerDecision: cfg.maxCostPerDecision ?? 0.01,
      naxConfig: cfg.naxConfig,
    };
  }

  async destroy(): Promise<void> {
    // No-op
  }

  async send(request: InteractionRequest): Promise<void> {
    // No-op — in-process plugin
  }

  async receive(_requestId: string, _timeout = 60000): Promise<InteractionResponse> {
    // For auto plugin, we need to fetch the request from somewhere
    // In practice, the chain should pass the request to us
    // For now, throw an error since we need the full request
    throw new Error("Auto plugin requires full request context (not just requestId)");
  }

  /**
   * Decide on an interaction request using LLM
   */
  async decide(request: InteractionRequest): Promise<InteractionResponse | undefined> {
    // SAFETY: Never auto-approve security-review
    if (request.metadata?.trigger === "security-review") {
      return undefined; // Escalate to human
    }

    try {
      // Use deprecated callLlm if provided (backward compatibility)
      if (_autoPluginDeps.callLlm) {
        const decision = await _autoPluginDeps.callLlm(request);
        if (decision.confidence < (this.config.confidenceThreshold ?? 0.7)) {
          return undefined;
        }
        return {
          requestId: request.id,
          action: decision.action,
          value: decision.value,
          respondedBy: "auto-ai",
          respondedAt: Date.now(),
        };
      }

      // Use new adapter-based path
      const decision = await this.callLlm(request);

      // Check confidence threshold
      if (decision.confidence < (this.config.confidenceThreshold ?? 0.7)) {
        return undefined; // Escalate to human
      }

      return {
        requestId: request.id,
        action: decision.action,
        value: decision.value,
        respondedBy: "auto-ai",
        respondedAt: Date.now(),
      };
    } catch (err) {
      // On error, escalate to human
      return undefined;
    }
  }

  /**
   * Call LLM to make decision
   */
  private async callLlm(request: InteractionRequest): Promise<DecisionResponse> {
    const prompt = this.buildPrompt(request);

    // Get adapter from dependency injection or throw
    const adapter = _autoPluginDeps.adapter;
    if (!adapter) {
      throw new Error("Auto plugin requires adapter to be injected via _autoPluginDeps.adapter");
    }

    const naxConfig = this.config.naxConfig;
    if (!naxConfig) {
      throw new Error("[auto] naxConfig is required for LLM-based interaction decisions");
    }

    const modelTier = this.config.model ?? "fast";
    const modelDef = resolveModelForAgent(
      naxConfig.models,
      naxConfig.autoMode.defaultAgent,
      modelTier,
      naxConfig.autoMode.defaultAgent,
    );
    const timeoutMs = (naxConfig.execution?.sessionTimeoutSeconds ?? 600) * 1000;

    const result = await adapter.complete(prompt, {
      model: modelDef.model,
      jsonMode: true,
      config: naxConfig,
      featureName: request.featureName,
      storyId: request.storyId,
      sessionRole: "auto",
      timeoutMs,
    });

    const output = typeof result === "string" ? result : result.output;
    return this.parseResponse(output);
  }

  /**
   * Build LLM prompt for decision
   */
  private buildPrompt(request: InteractionRequest): string {
    let prompt = `You are an AI decision assistant for a code orchestration system. Given an interaction request, decide the best action.

## Interaction Request
Type: ${request.type}
Stage: ${request.stage}
Feature: ${request.featureName}
${request.storyId ? `Story: ${request.storyId}` : ""}

Summary: ${request.summary.replace(/`/g, "\\`").replace(/\$/g, "\\$")}
${request.detail ? `\nDetail: ${request.detail.replace(/`/g, "\\`").replace(/\$/g, "\\$")}` : ""}
`;

    if (request.options && request.options.length > 0) {
      prompt += "\nOptions:\n";
      for (const opt of request.options) {
        const desc = opt.description ? ` — ${opt.description}` : "";
        prompt += `  [${opt.key}] ${opt.label}${desc}\n`;
      }
    }

    prompt += `\nFallback behavior on timeout: ${request.fallback}
Safety tier: ${request.metadata?.safety ?? "unknown"}

## Available Actions
- approve: Proceed with the operation
- reject: Deny the operation
- choose: Select an option (requires value field)
- input: Provide text input (requires value field)
- skip: Skip this interaction
- abort: Abort execution

## Rules
1. For "red" safety tier (security-review, cost-exceeded, merge-conflict): ALWAYS return confidence 0 to escalate to human
2. For "yellow" safety tier (cost-warning, max-retries, pre-merge): High confidence (0.8+) ONLY if clearly safe
3. For "green" safety tier (story-ambiguity, review-gate): Can approve with moderate confidence (0.6+)
4. Default to the fallback behavior if unsure
5. Never auto-approve security issues
6. If the summary mentions "critical" or "security", confidence MUST be < 0.5

Respond with ONLY this JSON (no markdown, no explanation):
{"action":"approve|reject|choose|input|skip|abort","value":"<optional>","confidence":0.0-1.0,"reasoning":"<one line>"}`;

    return prompt;
  }

  /**
   * Parse LLM response
   */
  private parseResponse(output: string): DecisionResponse {
    let jsonText = output.trim();

    // Strip markdown code fences
    if (jsonText.startsWith("```")) {
      const lines = jsonText.split("\n");
      jsonText = lines.slice(1, -1).join("\n").trim();
    }
    if (jsonText.startsWith("json")) {
      jsonText = jsonText.slice(4).trim();
    }

    const parsed = JSON.parse(jsonText) as DecisionResponse;

    // Validate
    if (!parsed.action || parsed.confidence === undefined || !parsed.reasoning) {
      throw new Error(`Invalid LLM response: ${jsonText}`);
    }

    // Validate confidence is 0-1
    if (parsed.confidence < 0 || parsed.confidence > 1) {
      throw new Error(`Invalid confidence: ${parsed.confidence} (must be 0-1)`);
    }

    return parsed;
  }
}

/**
 * Auto AI Responder Plugin (v0.15.0 US-008)
 *
 * Automatically responds to interactions using LLM decision-making.
 * Never auto-approves security-review triggers.
 */

import { z } from "zod";
import type { NaxConfig } from "../../config";
import { resolveModel } from "../../config";
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

  async receive(requestId: string, timeout = 60000): Promise<InteractionResponse> {
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
    const modelTier = this.config.model ?? "fast";

    if (!this.config.naxConfig) {
      throw new Error("Auto plugin requires naxConfig in init()");
    }

    const modelEntry = this.config.naxConfig.models[modelTier];
    if (!modelEntry) {
      throw new Error(`Model tier "${modelTier}" not found in config.models`);
    }

    const modelDef = resolveModel(modelEntry);
    const modelArg = modelDef.model;

    // Spawn claude CLI
    const proc = Bun.spawn(["claude", "-p", prompt, "--model", modelArg], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`claude CLI failed with exit code ${exitCode}: ${stderr}`);
    }

    const output = stdout.trim();
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

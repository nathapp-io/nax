/**
 * autoApproveOp — CompleteOperation that wraps AutoInteractionPlugin's LLM decision call.
 *
 * Migrates the agentManager.complete() call in auto.ts to the canonical callOp
 * dispatch path so middleware (audit, cost, cancellation) fires uniformly.
 */

import { interactionConfigSelector } from "../config";
import type { InteractionConfig } from "../config/selectors";
import type { InteractionRequest } from "../interaction/types";
import { OneShotPromptBuilder } from "../prompts";
import type { SchemaDescriptor } from "../prompts";
import { parseLLMJson } from "../utils/llm-json";
import type { BuildContext, CompleteOperation } from "./types";

const AUTO_APPROVER_SCHEMA: SchemaDescriptor = {
  name: "ApprovalDecision",
  description: "Respond with ONLY this JSON — no markdown, no explanation.",
  example: {
    action: "approve|reject|choose|input|skip|abort",
    value: "<optional>",
    confidence: 0.0,
    reasoning: "<one line>",
  },
};

const AUTO_APPROVER_INSTRUCTIONS = `Given this code orchestration interaction request, decide the best action.

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
6. If the summary mentions "critical" or "security", confidence MUST be < 0.5`;

export interface AutoApproveDecision {
  action: "approve" | "reject" | "choose" | "input" | "skip" | "abort";
  value?: string;
  confidence: number;
  reasoning: string;
}

export type AutoApproveInput = InteractionRequest;
export type AutoApproveOutput = AutoApproveDecision;

export const autoApproveOp: CompleteOperation<AutoApproveInput, AutoApproveOutput, InteractionConfig> = {
  kind: "complete",
  name: "auto-approve",
  stage: "run",
  jsonMode: true,
  config: interactionConfigSelector,

  build(input: AutoApproveInput, _ctx: BuildContext<InteractionConfig>) {
    const requestLines = [
      `Type: ${input.type}`,
      `Stage: ${input.stage}`,
      `Feature: ${input.featureName}`,
      ...(input.storyId ? [`Story: ${input.storyId}`] : []),
      `Summary: ${input.summary.replace(/`/g, "\\`").replace(/\$/g, "\\$")}`,
      ...(input.detail ? [`Detail: ${input.detail.replace(/`/g, "\\`").replace(/\$/g, "\\$")}`] : []),
      `Fallback behavior on timeout: ${input.fallback}`,
      `Safety tier: ${input.metadata?.safety ?? "unknown"}`,
    ];

    if (input.options && input.options.length > 0) {
      requestLines.push("\nOptions:");
      for (const opt of input.options) {
        const desc = opt.description ? ` — ${opt.description}` : "";
        requestLines.push(`  [${opt.key}] ${opt.label}${desc}`);
      }
    }

    const prompt = OneShotPromptBuilder.for("auto-approver")
      .instructions(AUTO_APPROVER_INSTRUCTIONS)
      .inputData("Interaction Request", requestLines.join("\n"))
      .jsonSchema(AUTO_APPROVER_SCHEMA)
      .build();

    return {
      role: { id: "role", content: "You are an AI orchestration decision-maker.", overridable: false },
      task: { id: "task", content: prompt, overridable: false },
    };
  },

  parse(output: string, _input: AutoApproveInput, _ctx: BuildContext<InteractionConfig>): AutoApproveOutput {
    const parsed = parseLLMJson<AutoApproveDecision>(output);

    if (!parsed.action || parsed.confidence === undefined || !parsed.reasoning) {
      throw new Error("Invalid LLM response for auto-approve: missing required fields");
    }

    if (parsed.confidence < 0 || parsed.confidence > 1) {
      throw new Error(`Invalid confidence: ${parsed.confidence} (must be 0-1)`);
    }

    return parsed;
  },
};

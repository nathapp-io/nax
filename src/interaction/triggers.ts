/**
 * Built-in Triggers Integration (v0.15.0 US-004)
 *
 * Wires 8 built-in triggers into the runner loop and hooks system.
 */

import type { NaxConfig } from "../config";
import type { InteractionChain } from "./chain";
import type { InteractionFallback, InteractionRequest, InteractionResponse, TriggerName } from "./types";
import { TRIGGER_METADATA } from "./types";

export type InteractionConfig = Pick<NaxConfig, "interaction">;

/** Trigger context data for template substitution */
export interface TriggerContext {
  featureName: string;
  storyId?: string;
  cost?: number;
  limit?: number;
  tier?: string;
  model?: string;
  iteration?: number;
  reason?: string;
  [key: string]: unknown;
}

/**
 * Check if a trigger is enabled in config
 */
export function isTriggerEnabled(trigger: TriggerName, config: InteractionConfig): boolean {
  const triggerConfig = config.interaction?.triggers?.[trigger];
  if (triggerConfig === undefined) return false;
  if (typeof triggerConfig === "boolean") return triggerConfig;
  return triggerConfig.enabled;
}

/**
 * Get trigger configuration (fallback, timeout)
 */
export function getTriggerConfig(
  trigger: TriggerName,
  config: InteractionConfig,
): { fallback: InteractionFallback; timeout: number } {
  const metadata = TRIGGER_METADATA[trigger];
  const triggerConfig = config.interaction?.triggers?.[trigger];
  const defaults = config.interaction?.defaults ?? {
    timeout: 600000,
    fallback: "escalate" as InteractionFallback,
  };

  let fallback: InteractionFallback = metadata.defaultFallback;
  let timeout = defaults.timeout;

  if (typeof triggerConfig === "object") {
    if (triggerConfig.fallback) {
      fallback = triggerConfig.fallback as InteractionFallback;
    }
    if (triggerConfig.timeout) {
      timeout = triggerConfig.timeout;
    }
  }

  return { fallback, timeout };
}

/**
 * Substitute {{variable}} placeholders in a template string
 */
function substituteTemplate(template: string, context: TriggerContext): string {
  let result = template;
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
    }
  }
  return result;
}

/**
 * Create an interaction request for a built-in trigger
 */
export function createTriggerRequest(
  trigger: TriggerName,
  context: TriggerContext,
  config: InteractionConfig,
): InteractionRequest {
  const metadata = TRIGGER_METADATA[trigger];
  const { fallback, timeout } = getTriggerConfig(trigger, config);

  const summary = substituteTemplate(metadata.defaultSummary, context);
  const id = `trigger-${trigger}-${Date.now()}`;

  return {
    id,
    type: "confirm",
    featureName: context.featureName,
    storyId: context.storyId,
    stage: "custom",
    summary,
    fallback,
    timeout,
    createdAt: Date.now(),
    metadata: {
      trigger,
      safety: metadata.safety,
    },
  };
}

/**
 * Execute a trigger and return response
 */
export async function executeTrigger(
  trigger: TriggerName,
  context: TriggerContext,
  config: InteractionConfig,
  chain: InteractionChain,
): Promise<InteractionResponse> {
  const request = createTriggerRequest(trigger, context, config);
  const response = await chain.prompt(request);
  return response;
}

/**
 * Check security-review trigger (abort on critical issues)
 */
export async function checkSecurityReview(
  context: TriggerContext,
  config: InteractionConfig,
  chain: InteractionChain,
): Promise<boolean> {
  if (!isTriggerEnabled("security-review", config)) return true;

  const response = await executeTrigger("security-review", context, config, chain);
  return response.action !== "abort";
}

/**
 * Check cost-exceeded trigger (abort on limit exceeded)
 */
export async function checkCostExceeded(
  context: TriggerContext,
  config: InteractionConfig,
  chain: InteractionChain,
): Promise<boolean> {
  if (!isTriggerEnabled("cost-exceeded", config)) return true;

  const response = await executeTrigger("cost-exceeded", context, config, chain);
  return response.action !== "abort";
}

/**
 * Check merge-conflict trigger (abort on conflict)
 */
export async function checkMergeConflict(
  context: TriggerContext,
  config: InteractionConfig,
  chain: InteractionChain,
): Promise<boolean> {
  if (!isTriggerEnabled("merge-conflict", config)) return true;

  const response = await executeTrigger("merge-conflict", context, config, chain);
  return response.action !== "abort";
}

/**
 * Check cost-warning trigger (escalate on approaching limit)
 */
export async function checkCostWarning(
  context: TriggerContext,
  config: InteractionConfig,
  chain: InteractionChain,
): Promise<"continue" | "escalate"> {
  if (!isTriggerEnabled("cost-warning", config)) return "continue";

  const response = await executeTrigger("cost-warning", context, config, chain);
  return response.action === "approve" ? "escalate" : "continue";
}

/**
 * Check max-retries trigger (skip story on max retries)
 */
export async function checkMaxRetries(
  context: TriggerContext,
  config: InteractionConfig,
  chain: InteractionChain,
): Promise<"continue" | "skip"> {
  if (!isTriggerEnabled("max-retries", config)) return "continue";

  const response = await executeTrigger("max-retries", context, config, chain);
  return response.action === "skip" ? "skip" : "continue";
}

/**
 * Check pre-merge trigger (escalate before merging)
 */
export async function checkPreMerge(
  context: TriggerContext,
  config: InteractionConfig,
  chain: InteractionChain,
): Promise<boolean> {
  if (!isTriggerEnabled("pre-merge", config)) return true;

  const response = await executeTrigger("pre-merge", context, config, chain);
  return response.action === "approve";
}

/**
 * Check story-ambiguity trigger (continue with best effort)
 */
export async function checkStoryAmbiguity(
  context: TriggerContext,
  config: InteractionConfig,
  chain: InteractionChain,
): Promise<boolean> {
  if (!isTriggerEnabled("story-ambiguity", config)) return true;

  const response = await executeTrigger("story-ambiguity", context, config, chain);
  return response.action === "approve";
}

/**
 * Check review-gate trigger (proceed with review)
 */
export async function checkReviewGate(
  context: TriggerContext,
  config: InteractionConfig,
  chain: InteractionChain,
): Promise<boolean> {
  if (!isTriggerEnabled("review-gate", config)) return true;

  const { fallback } = getTriggerConfig("review-gate", config);
  const response = await executeTrigger("review-gate", context, config, chain);
  // Apply configured fallback so timeout + fallback:"continue" auto-approves instead of rejecting
  const effectiveAction = chain.applyFallback(response, fallback);
  return effectiveAction === "approve";
}

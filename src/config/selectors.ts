/**
 * Named ConfigSelector Registry
 *
 * One ConfigSelector per subsystem. This is the single source of truth
 * for "which config slice does each subsystem depend on?"
 *
 * Selectors are used by operations and NaxRuntime to declare config dependencies
 * without duplicating projection logic or creating orphan hardcoded key lists.
 */

import { pickSelector, reshapeSelector } from "./selector";
import type { NaxConfig } from "./types";

export const reviewConfigSelector = pickSelector(
  "review",
  "review",
  "debate",
  "models",
  "execution",
  "project",
  "quality",
  "agent",
);
export const planConfigSelector = pickSelector("plan", "plan", "debate");
export const decomposeConfigSelector = pickSelector("decompose", "plan", "agent");
export const rectifyConfigSelector = pickSelector("rectify", "execution");
export const acceptanceConfigSelector = pickSelector("acceptance", "acceptance");
// acceptance fix take more time to fix the code, so we use a separate config selector to use execution.sessionTimeoutSeconds instead of acceptance.timeoutMs
export const acceptanceFixConfigSelector = pickSelector("acceptance-fix", "acceptance", "execution");
// acceptance generator take more time to generate the test code, so we use a separate config selector to use execution.sessionTimeoutSeconds instead of acceptance.timeoutMs
export const acceptanceGenConfigSelector = pickSelector("acceptance-gen", "acceptance", "execution");
export const tddConfigSelector = pickSelector(
  "tdd",
  "tdd",
  "execution",
  "quality",
  "agent",
  "models",
  "prompts",
  "context",
  "project",
  "precheck",
);
export const debateConfigSelector = pickSelector("debate", "debate", "models", "agent");
export const routingConfigSelector = pickSelector("routing", "routing", "autoMode", "tdd");

export const verifyConfigSelector = reshapeSelector("verify", (c: NaxConfig) => ({
  timeout: c.execution?.verificationTimeoutSeconds,
  testCommand: c.quality?.commands?.test,
}));

export const rectificationGateConfigSelector = pickSelector(
  "rectification-gate",
  "execution",
  "models",
  "agent",
  "quality",
  "review",
);

// agent only selectors for resolveDefaultAgent
export const agentConfigSelector = pickSelector("agent", "agent");
export const agentManagerConfigSelector = pickSelector("agent-manager", "agent", "execution");
export const interactionConfigSelector = pickSelector("interaction", "interaction");
export const precheckConfigSelector = pickSelector(
  "precheck",
  "precheck",
  "quality",
  "execution",
  "prompts",
  "review",
  "project",
);
export const qualityConfigSelector = pickSelector("quality", "quality", "execution");

// Test-pattern resolver — resolveTestFilePatterns reads execution.smartTestRunner
// (root config patterns). Co-located so context-tool-runtime, semantic review,
// and verification all share one shape.
export const testPatternConfigSelector = pickSelector("test-pattern", "execution", "project", "quality");

export const contextConfigSelector = pickSelector("context", "context");

// Context-engine pull-tool runtime — reads context.v2.pull.* and forwards
// execution/project/quality to resolveTestFilePatterns. Co-located so callers don't
// have to compose two selectors.
export const contextToolRuntimeConfigSelector = pickSelector(
  "context-tool-runtime",
  "context",
  "execution",
  "project",
  "quality",
);

// Prompt builder loader — withLoader / loadOverride / hermetic /
// tdd-language sections read prompts.overrides, context.featureEngine,
// project.* only.
export const promptLoaderConfigSelector = pickSelector("prompt-loader", "prompts", "context", "project");

// LLM routing — classifyWithLlm / routeBatch / callLlm need routing.llm config,
// models + agent for resolution, tdd for strategy derivation, and
// execution + precheck for the agentManager.complete() wiring layer.
export const llmRoutingConfigSelector = pickSelector(
  "llm-routing",
  "routing",
  "models",
  "agent",
  "tdd",
  "execution",
  "precheck",
);

// TODO(#853): workaround — narrows CompleteOptions.config from NaxConfig to the keys the
// wiring layer actually reads. Phase 2 of #853 removes the field entirely by pre-resolving
// at the AgentManager boundary; delete this selector when that lands.
export const completeConfigSelector = pickSelector("complete", "execution", "agent", "models", "precheck");

// Derived config-slice types — co-located with each selector so consumers
// import the type instead of re-deriving `ReturnType<typeof xSelector.select>`
// in every operation file.
export type ReviewConfig = ReturnType<typeof reviewConfigSelector.select>;
export type PlanConfig = ReturnType<typeof planConfigSelector.select>;
export type DecomposeConfig = ReturnType<typeof decomposeConfigSelector.select>;
export type RectifyConfig = ReturnType<typeof rectifyConfigSelector.select>;
export type AcceptanceConfig = ReturnType<typeof acceptanceConfigSelector.select>;
export type AcceptanceFixConfig = ReturnType<typeof acceptanceFixConfigSelector.select>;
export type AcceptanceGenConfig = ReturnType<typeof acceptanceGenConfigSelector.select>;
export type TddConfig = ReturnType<typeof tddConfigSelector.select>;
export type DebateConfig = ReturnType<typeof debateConfigSelector.select>;
export type RoutingConfig = ReturnType<typeof routingConfigSelector.select>;
export type VerifyConfig = ReturnType<typeof verifyConfigSelector.select>;
export type RectificationGateConfig = ReturnType<typeof rectificationGateConfigSelector.select>;
export type AgentConfig = ReturnType<typeof agentConfigSelector.select>;
export type AgentManagerConfig = ReturnType<typeof agentManagerConfigSelector.select>;
export type InteractionConfig = ReturnType<typeof interactionConfigSelector.select>;
export type PrecheckConfig = ReturnType<typeof precheckConfigSelector.select>;
export type QualityConfig = ReturnType<typeof qualityConfigSelector.select>;
export type TestPatternConfig = ReturnType<typeof testPatternConfigSelector.select>;
export type ContextConfig = ReturnType<typeof contextConfigSelector.select>;
export type ContextToolRuntimeConfig = ReturnType<typeof contextToolRuntimeConfigSelector.select>;
export type PromptLoaderConfig = ReturnType<typeof promptLoaderConfigSelector.select>;
export type LlmRoutingConfig = ReturnType<typeof llmRoutingConfigSelector.select>;
export type CompleteConfig = ReturnType<typeof completeConfigSelector.select>;

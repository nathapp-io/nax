/**
 * Named ConfigSelector Registry
 *
 * One ConfigSelector per subsystem that still declares its config dependency
 * through one. This is the single source of truth for "which config slice does
 * each subsystem depend on?"
 *
 * Selectors are used by operations and NaxRuntime to declare config dependencies
 * without duplicating projection logic or creating orphan hardcoded key lists.
 *
 * A subsystem whose selector nobody imported keeps its slice type as a
 * `Pick<NaxConfig, ...>` alias over the same section list (see the
 * "Config-slice types" block at the bottom), so consumers keep importing a
 * named type instead of widening to the whole `NaxConfig`.
 */

import type { z } from "zod";
import type { FixReviewConfigSchema, NonBlockingFixConfigSchema } from "./schemas-review";
import { pickSelector } from "./selector";
import type { NaxConfig } from "./types";

export const planConfigSelector = pickSelector("plan", "plan", "agent", "models", "project", "routing");
export const decomposeConfigSelector = pickSelector("decompose", "plan", "agent", "routing");
export const routingConfigSelector = pickSelector("routing", "routing", "autoMode", "tdd");

export const rectificationGateConfigSelector = pickSelector(
  "rectification-gate",
  "execution",
  "models",
  "agent",
  "quality",
  "review",
);

// "profile" is the resolved profile-chain display string ("cc-acceptance",
// "a+b", or "default"). AgentManager stamps it onto dispatch events so cost rows
// record which overlay was active — profiles repoint agent and model per stage
// and are otherwise invisible in run artifacts (#1433).
// "context" is US-007: `instructionOptionsForSession` derives a native session's
// root-instruction deny list from `context.projectContext`, and it reads it off
// the `AgentRunOptions.config` this slice fills.
export const agentManagerConfigSelector = pickSelector("agent-manager", "agent", "execution", "profile", "context");
export const qualityConfigSelector = pickSelector("quality", "quality", "execution");

// `finish` supplies the branch-review / branch-fix model fallbacks (spec §4, P4-R21).
export const workflowConfigSelector = pickSelector(
  "workflow",
  "workflow",
  "review",
  "execution",
  "autoMode",
  "quality",
  "agent",
  "models",
  "finish",
);
export const advisorConfigSelector = pickSelector("advisor", "advisor", "execution");

// Config-slice types — co-located with each selector so consumers import the
// type instead of re-deriving `ReturnType<typeof xSelector.select>` in every
// operation file. The `Pick` aliases below name the same section lists their
// former selector picked, for subsystems whose selector had no importer.
export type PlanConfig = ReturnType<typeof planConfigSelector.select>;
export type DecomposeConfig = ReturnType<typeof decomposeConfigSelector.select>;
export type RoutingConfig = ReturnType<typeof routingConfigSelector.select>;
export type AgentManagerConfig = ReturnType<typeof agentManagerConfigSelector.select>;
export type QualityConfig = ReturnType<typeof qualityConfigSelector.select>;
export type WorkflowOpConfig = ReturnType<typeof workflowConfigSelector.select>;
export type AdvisorConfigSlice = ReturnType<typeof advisorConfigSelector.select>;

/** `review/*` — review, model resolution, gates and test commands. */
export type ReviewConfig = Pick<NaxConfig, "review" | "models" | "execution" | "project" | "quality" | "agent">;
/** `resolveDefaultAgent` reads `agent.default` only. */
export type AgentConfig = Pick<NaxConfig, "agent">;
export type InteractionConfig = Pick<NaxConfig, "interaction">;
/**
 * `precheck/*` — `quality`, `execution`, `review` and `project` are read by
 * the command checks; `agent` by `checkAgentCLI` (MED-03: it
 * resolves the default agent via `resolveDefaultAgent`).
 *
 * US-1984 (model-resolution precheck) adds `models`, `plan`, `autoMode` and
 * `routing`: the check walks `models`, `plan.model`,
 * `autoMode.escalation.tierOrder[*]` and `routing.llm.model` literal pins.
 */
export type PrecheckConfig = Pick<
  NaxConfig,
  "precheck" | "quality" | "execution" | "review" | "project" | "agent" | "models" | "plan" | "autoMode" | "routing"
>;
/**
 * Test-pattern resolver — `resolveTestFilePatterns` reads
 * `execution.smartTestRunner` (root config patterns), `project` for language
 * and `quality`. One shape, shared by context-tool-runtime, semantic review and
 * verification.
 */
export type TestPatternConfig = Pick<NaxConfig, "execution" | "project" | "quality">;
export type ContextConfig = Pick<NaxConfig, "context">;
/**
 * Context-engine pull-tool runtime — reads `context.v2.pull.*` and forwards
 * `execution`/`project`/`quality` to `resolveTestFilePatterns`; one slice so
 * callers don't have to compose two.
 */
export type ContextToolRuntimeConfig = Pick<NaxConfig, "context" | "execution" | "project" | "quality">;
/**
 * LLM routing — `classifyWithLlm` / `routeBatch` / `callLlm` need `routing.llm`,
 * `models` + `agent` for resolution, `tdd` for strategy derivation, and
 * `execution` + `precheck` for the `agentManager.complete()` wiring layer.
 */
export type LlmRoutingConfig = Pick<NaxConfig, "routing" | "models" | "agent" | "tdd" | "execution" | "precheck">;

export type NonBlockingFixConfig = z.infer<typeof NonBlockingFixConfigSchema>;
/** US-001 (fix-review) — `review.fixReview` slice, beside `NonBlockingFixConfig`.
 *
 * Uses `z.infer` (the parsed shape, not the input shape) so `enabled` and
 * `timeoutMs` carry their schema defaults as required fields. Every parsed
 * `ReviewConfig.fixReview` has them; downstream readers (US-003 runner,
 * `resolveFixReviewModel`'s callers) should not need to re-default a value
 * that is never actually absent at runtime. The schema's `.optional().default(...)`
 * chain in `ReviewConfigSchema` guarantees the block is always present after
 * parse, so the required-field type is sound.
 */
export type FixReviewConfig = z.infer<typeof FixReviewConfigSchema>;

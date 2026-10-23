/**
 * `workflow` config schema (A5). Zod 4: nested objects use `.prefault({})` so their own
 * field defaults apply — `.default({})` would short-circuit to a bare `{}`.
 */
import { z } from "zod";
import type { ExecutionMode, WorkflowConfig } from "./runtime-types-workflow";
import { ConfiguredModelSchema } from "./schemas-model";

export const ExecutionModeSchema = z.enum(["pipeline", "workflow"]);

export const WorkflowConfigObjectSchema = z.object({
  models: z
    .object({
      storyReview: ConfiguredModelSchema.optional(),
      branchReview: ConfiguredModelSchema.optional(),
      branchFix: ConfiguredModelSchema.optional(),
    })
    .prefault({}),
  maxFixRounds: z.number().int().min(1).default(5),
  maxBranchFixRounds: z.number().int().min(0).default(2),
  finalGateRepairRounds: z.number().int().min(0).default(1),
  ciRepairRounds: z.number().int().min(0).default(1),
  preflight: z.boolean().default(true),
  publish: z.enum(["pr", "push", "none"]).default("pr"),
  // US-003: an implementer turn that hits its step limit gets a continue turn on the same warm
  // session, at `budgetMultiplier` of the limit it hit. `maxAttempts: 0` turns the continue off.
  interruptRetry: z
    .object({
      maxAttempts: z.number().int().min(0).default(1),
      budgetMultiplier: z.number().gt(0).max(1).default(0.5),
    })
    .prefault({}),
  timeouts: z
    .object({
      implementMs: z.number().int().positive().default(3_600_000),
      fixMs: z.number().int().positive().default(3_600_000),
      reportMs: z.number().int().positive().default(600_000),
      reviewMs: z.number().int().positive().default(1_800_000),
      ciWaitMs: z.number().int().positive().default(1_200_000),
      ciPollMs: z.number().int().positive().default(30_000),
    })
    .prefault({}),
});

export const WORKFLOW_DEFAULTS: WorkflowConfig = WorkflowConfigObjectSchema.parse({}) as WorkflowConfig;

/** The effective workflow config; an absent block (hand-built test configs) reads as the defaults. */
export function resolveWorkflowConfig(config: { workflow?: WorkflowConfig } | undefined): WorkflowConfig {
  return config?.workflow ?? WORKFLOW_DEFAULTS;
}

export function isWorkflowMode(config: { execution?: { mode?: ExecutionMode } } | undefined): boolean {
  // Direct runner callers can supply an unparsed config; omission still means the schema's default.
  return config !== undefined && (config.execution?.mode ?? "workflow") === "workflow";
}

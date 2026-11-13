/**
 * `workflow` config schema (A5). Zod 4: nested objects use `.prefault({})` so their own
 * field defaults apply — `.default({})` would short-circuit to a bare `{}`.
 */
import { z } from "zod";
import type { WorkflowConfig } from "./runtime-types-workflow";
import { ConfiguredModelSchema } from "./schemas-model";

export const ExecutionModeSchema = z.enum(["pipeline", "workflow"]);

/**
 * US-002 (nax#2858): the branch review's coverage retry budget. Split out so
 * `WORKFLOW_REVIEW_DEFAULTS` is the parsed form of exactly this object, and a consumer holding a
 * hand-built `workflow` block (which omits `review`) reads the same numbers.
 */
const WorkflowReviewConfigSchema = z
  .object({
    coverageRetries: z.number().int().min(0).default(3),
  })
  .prefault({});

/** The parsed defaults of `workflow.review`; read as `workflow.review ?? WORKFLOW_REVIEW_DEFAULTS`. */
export const WORKFLOW_REVIEW_DEFAULTS: NonNullable<WorkflowConfig["review"]> = WorkflowReviewConfigSchema.parse({});

/**
 * US-001 (item-publish-pacing): the pacing of the post-publish item-thread writes. Split out so
 * `WORKFLOW_ITEM_PUBLISH_DEFAULTS` is the parsed form of exactly this object, and a consumer holding
 * a hand-built `workflow` block (which omits `itemPublish`) reads the same numbers.
 */
const WorkflowItemPublishConfigSchema = z
  .object({
    writeGapMs: z.number().int().min(0).default(1000),
    retryBackoffMs: z.number().int().min(0).default(60000),
    maxRetries: z.number().int().min(0).default(2),
    maxWaitMs: z.number().int().min(0).default(300000),
  })
  .prefault({});

/** The parsed defaults of `workflow.itemPublish`; read as `workflow.itemPublish ?? WORKFLOW_ITEM_PUBLISH_DEFAULTS`. */
export const WORKFLOW_ITEM_PUBLISH_DEFAULTS: NonNullable<WorkflowConfig["itemPublish"]> =
  WorkflowItemPublishConfigSchema.parse({});

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
  review: WorkflowReviewConfigSchema,
  itemPublish: WorkflowItemPublishConfigSchema,
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

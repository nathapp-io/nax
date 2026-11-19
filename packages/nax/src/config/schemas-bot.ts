import { z } from "zod";
import {
  DEFAULT_BLOCKING_TRIGGERS,
  DEFAULT_CHAIN_NOTICE_GENERATION,
  FINDING_TRIGGERS,
} from "@/workflow/blocking-findings";
import { ConfiguredModelSchema } from "./schemas-model";

export const BotConfigSchema = z.object({
  gateRepairRounds: z.number().int().min(0).default(1),
  costLimit: z.number().positive().default(5),
  /** US-002: the trigger classes that can hold readiness; a writer PR comment may override it per PR. */
  blockingTriggers: z
    .array(z.enum(FINDING_TRIGGERS))
    .min(1, "at least one blocking trigger is required; omit the key to keep the default set")
    .default([...DEFAULT_BLOCKING_TRIGGERS]),
  /** US-002: the finding generation at which the fix summary reports a fix-induced chain. */
  chainNoticeGeneration: z.number().int().min(1).default(DEFAULT_CHAIN_NOTICE_GENERATION),
  models: z
    .object({
      review: ConfiguredModelSchema.optional(),
      fix: ConfiguredModelSchema.optional(),
      checks: ConfiguredModelSchema.optional(),
      rulings: ConfiguredModelSchema.optional(),
    })
    .prefault({}),
});

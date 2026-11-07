/**
 * `advisor` config schema (A1). Zod 4: nested objects use `.prefault({})` so their own
 * field defaults apply — `.default({})` would short-circuit to a bare `{}`.
 */
import { z } from "zod";
import type { AdvisorConfig } from "./runtime-types-advisor";
import { ConfiguredModelSchema } from "./schemas-model";

export const AdvisorConfigObjectSchema = z.object({
  enabled: z.boolean().default(false),
  model: ConfiguredModelSchema.default("powerful"),
  fallbackModels: z.array(ConfiguredModelSchema).default([]),
  memory: z.enum(["stateless", "warm"]).default("stateless"),
  callers: z
    .object({
      finishJudgment: z.boolean().default(false),
      fixCycleGiveUp: z.boolean().default(false),
      uncategorisedFailure: z.boolean().default(false),
      finishApproval: z.boolean().default(false),
    })
    .prefault({}),
  maxRulingsPerStory: z.number().int().min(0).default(2),
  notify: z.object({ headsUp: z.boolean().default(true) }).prefault({}),
  timeoutMs: z.number().int().positive().optional(),
});

export const ADVISOR_DEFAULTS: AdvisorConfig = AdvisorConfigObjectSchema.parse({}) as AdvisorConfig;

/** The effective advisor config; an absent block (hand-built test configs) reads as the defaults. */
export function resolveAdvisorConfig(config: { advisor?: AdvisorConfig } | undefined): AdvisorConfig {
  return config?.advisor ?? ADVISOR_DEFAULTS;
}

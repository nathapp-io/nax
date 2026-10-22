import { z } from "zod";
import { ConfiguredModelSchema } from "./schemas-model";

export const BotConfigSchema = z.object({
  gateRepairRounds: z.number().int().min(0).default(1),
  costLimit: z.number().positive().default(5),
  models: z
    .object({
      review: ConfiguredModelSchema.optional(),
      fix: ConfiguredModelSchema.optional(),
      checks: ConfiguredModelSchema.optional(),
      rulings: ConfiguredModelSchema.optional(),
    })
    .prefault({}),
});

import { z } from "zod";
import { ConfiguredModelSchema } from "./schemas-model";

export const BotConfigSchema = z.object({
  models: z
    .object({
      review: ConfiguredModelSchema.optional(),
      fix: ConfiguredModelSchema.optional(),
    })
    .prefault({}),
});

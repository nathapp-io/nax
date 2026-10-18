import { z } from "zod";

/** Opt-in per-story profile routing; profiles come from routing.agents.profiles. */
export const StoryRouterConfigSchema = z.object({
  mode: z.enum(["off", "shadow", "apply"]).default("off"),
  precedence: z.enum(["router", "plan"]).default("router"),
  timeoutMs: z.number().int().positive().default(5_000),
});

export type StoryRouterConfig = z.infer<typeof StoryRouterConfigSchema>;

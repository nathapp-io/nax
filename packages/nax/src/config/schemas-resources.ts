import { z } from "zod";

export const ResourcesConfigSchema = z.object({
  /** Read Claude Code skills, commands, agents, .mcp.json, hooks and enabled plugins. */
  claudeCode: z.boolean().default(true),
  /** Attach the skills provider to nax run stages as well as nax chat. */
  skillsInRun: z.boolean().default(false),
});

export type ResourcesConfig = z.infer<typeof ResourcesConfigSchema>;

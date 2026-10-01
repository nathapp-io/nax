import { z } from "zod";

export const AuthConfigSchema = z
  .object({
    source: z.enum(["file", "exec"]).default("file"),
    exec: z
      .object({
        command: z.array(z.string().min(1)).min(1),
        timeoutMs: z.number().int().min(1000).max(60000).default(10000),
      })
      .optional(),
    onChange: z.enum(["warn", "refuse"]).default("warn"),
  })
  .superRefine((config, ctx) => {
    if (config.source === "exec" && config.exec === undefined) {
      ctx.addIssue({ code: "custom", path: ["exec"], message: 'exec is required when auth.source is "exec"' });
    }
  });

export type AuthConfig = z.infer<typeof AuthConfigSchema>;

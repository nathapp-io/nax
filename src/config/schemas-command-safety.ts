/**
 * `execution.commandSafety` (P5): the shadow command classifier.
 *
 * Absent `shadow` = off, the default. The URL must be loopback unless
 * `allowRemote` is set, which keeps the master plan's "no network on the tool
 * path" true in nax's own code rather than by convention. `authEnv` is the
 * NAME of an environment variable; no secret is ever stored in config.
 */
import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export const CommandSafetyShadowSchema = z
  .object({
    url: z.string(),
    timeoutMs: z.number().int().min(200).max(30_000).default(3000),
    // Deliberately not named `tokenEnv`: `nax config` masks any key matching
    // SECRET_KEY_PATTERN (TOKEN, ...), which would hide the variable NAME.
    authEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/, "authEnv names an environment variable (e.g. NAX_COMMAND_SAFETY_AUTH)")
      .default("NAX_COMMAND_SAFETY_AUTH"),
    allowRemote: z.boolean().default(false),
  })
  .superRefine((shadow, ctx) => {
    let url: URL;
    try {
      url = new URL(shadow.url);
    } catch {
      ctx.addIssue({ code: "custom", path: ["url"], message: "commandSafety.shadow.url is not a valid URL" });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", path: ["url"], message: "commandSafety.shadow.url must be http or https" });
    }
    if (!shadow.allowRemote && !LOOPBACK_HOSTS.has(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message:
          "commandSafety.shadow.url must be loopback (127.0.0.1, [::1] or localhost); set allowRemote: true to accept network on the tool path",
      });
    }
  });

export const CommandSafetyConfigSchema = z.object({
  shadow: CommandSafetyShadowSchema.optional(),
});

export type CommandSafetyConfig = z.infer<typeof CommandSafetyConfigSchema>;

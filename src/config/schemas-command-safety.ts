/**
 * `execution.commandSafety` (P5): the shadow command classifier and the
 * opt-in flag-for-review guard that shares its cache.
 *
 * Absent `shadow` = off, the default. The URL must be loopback unless
 * `allowRemote` is set, which keeps the master plan's "no network on the tool
 * path" true in nax's own code rather than by convention. `authEnv` is the
 * NAME of an environment variable; no secret is ever stored in config.
 *
 * A `guard` block reuses the shadow's classifier — a guard without a shadow
 * is a validation error rather than a silently dead config. `threshold` is
 * the flag-for-review cut: a `scoreGuard` decision at or above it flags.
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

/**
 * The guard config (US-003). Threshold is the rule-or-mean score cut at
 * which a `GuardDecision.flags` becomes true; a score equal to the threshold
 * flags. Bounded to `(0, 1]`: 0 disables (anything scores > 0) and 1 only
 * flags when something fires with full confidence (rule hit or `blocked`).
 */
export const CommandSafetyGuardSchema = z.object({
  threshold: z
    .number()
    .refine((n) => n > 0, { message: "guard.threshold must be greater than 0" })
    .refine((n) => n <= 1, { message: "guard.threshold must be at most 1" })
    .default(0.75),
});

export const CommandSafetyConfigSchema = z
  .object({
    shadow: CommandSafetyShadowSchema.optional(),
    guard: CommandSafetyGuardSchema.optional(),
  })
  .superRefine((config, ctx) => {
    if (config.guard !== undefined && config.shadow === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["guard"],
        message: "commandSafety.guard requires commandSafety.shadow (the guard reuses its classifier)",
      });
    }
  });

export type CommandSafetyConfig = z.infer<typeof CommandSafetyConfigSchema>;

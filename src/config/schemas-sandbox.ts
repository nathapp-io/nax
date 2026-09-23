/**
 * `execution.sandbox` (P4, ADR-030 amendment): the OS sandbox around
 * agent-authored Bash and RunCommand Exec commands.
 *
 * Nested objects use `.prefault({})`, not `.default({})`: in zod 4 a
 * `.default()` value short-circuits parsing, so `{ filesystem: {} }` would
 * yield `filesystem: {}` with no `allowWrite`.
 */
import { z } from "zod";

export const SandboxConfigSchema = z.object({
  /** Opt-in until the P4 exit runs (spec S1). */
  enabled: z.boolean().default(false),
  /** One backend today; the interface admits a container backend later. */
  backend: z.enum(["srt"]).default("srt"),
  filesystem: z
    .object({
      /** Extra write roots, "~" expanded, relative paths resolved against the story root. */
      allowWrite: z.array(z.string()).default([]),
      /** Extra read denies, "~" expanded. */
      denyRead: z.array(z.string()).default([]),
    })
    .prefault({}),
  network: z
    .object({
      /** absent = unrestricted (spec S2); [] = no network; a list = allow-list. */
      allowedDomains: z.array(z.string()).optional(),
    })
    .prefault({}),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

/** BUG-20: derived, never hand-written at a second site. */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = SandboxConfigSchema.parse({});

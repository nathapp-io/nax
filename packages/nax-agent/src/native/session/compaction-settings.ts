/**
 * The compaction settings schema, shared by nax (`execution.compaction`) and the
 * facade's native backend (`NativeBackendOptions.compaction`). One definition,
 * so the two surfaces cannot drift on ranges, defaults or messages.
 *
 * Percentages of the model's window rather than absolute token counts:
 * nax-ai's catalog spans 4095 to 3.5M tokens, and an absolute reserve is
 * negative on the smallest windows -- compaction would fire every round trip
 * and shrink nothing.
 */
import { z } from "zod";
import type { ResolvedCompaction } from "./compaction.ts";

export const DEFAULT_COMPACTION: ResolvedCompaction = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

export const compactionSettingsSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_COMPACTION.enabled),
    compactAtPercent: z.number().int().min(50).max(99).default(DEFAULT_COMPACTION.compactAtPercent),
    keepRecentPercent: z.number().int().min(5).max(79).default(DEFAULT_COMPACTION.keepRecentPercent),
  })
  .refine((c) => c.keepRecentPercent <= c.compactAtPercent - 20, {
    message: "keepRecentPercent must be at least 20 points below compactAtPercent",
  })
  .default({ ...DEFAULT_COMPACTION });

/** Applies the defaults to a raw settings object. Throws a ZodError on an invalid one. */
export function resolveCompaction(input?: unknown): ResolvedCompaction {
  return compactionSettingsSchema.parse(input);
}

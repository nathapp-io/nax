/**
 * `memory` config block — the repository-wide memory settings.
 *
 * `.strict()` throughout, like `schemas-mcp.ts`: an unknown key must fail
 * loudly. The keys a later feature owns (`stages` for memory-run-stages, `koda`
 * for memory-koda-provider) are rejected until that feature widens this schema,
 * because a silently stripped key reads at runtime as "memory is broken" rather
 * than "this build does not have that feature yet".
 *
 * `NaxConfig.memory` is optional on the hand-written interface, so readers go
 * through `memoryConfigOf` rather than reaching for `config.memory` directly.
 *
 * `inRun` is the workflow-run switch, separate from `enabled`: chat keeps the
 * memory host and index either way, while `nax run` gets neither when it is
 * false. The design's `memory.stages` list is not built — the run tools always
 * attach to `run`-stage sessions only.
 */
import { z } from "zod";
import type { NaxConfig } from "./runtime-types";
import type { MemoryConfig } from "./runtime-types-memory";

/** Floor for the injected index's byte cap — small enough that omission is observable. */
export const MEMORY_INDEX_BYTES_MIN = 512;
/** Ceiling for the injected index's byte cap (256 KiB): the index is prompt text, not a corpus. */
export const MEMORY_INDEX_BYTES_MAX = 262_144;
/** Default index byte cap (24 KiB). */
export const MEMORY_INDEX_BYTES_DEFAULT = 24_576;

export const MemoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    provider: z.enum(["local"]).default("local"),
    writeMode: z.enum(["direct", "proposal"]).default("direct"),
    indexBytes: z
      .number()
      .int()
      .min(MEMORY_INDEX_BYTES_MIN)
      .max(MEMORY_INDEX_BYTES_MAX)
      .default(MEMORY_INDEX_BYTES_DEFAULT),
    askOnSave: z.boolean().default(true),
    inRun: z.boolean().default(true),
  })
  .strict();

/**
 * The memory block for a resolved config. `NaxConfig.memory` is optional, so
 * every reader resolves through here and the schema stays the single source of
 * the defaults.
 */
export function memoryConfigOf(config: Pick<NaxConfig, "memory">): MemoryConfig {
  return config.memory ?? MemoryConfigSchema.parse({});
}

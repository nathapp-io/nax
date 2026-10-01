/**
 * Tools appended to the declaration of every op that receives coding tools.
 *
 * Kept separate from DEFAULT_CODING_TOOLS (which is also the fallback
 * `resolveDeclaredTools` returns for an op that omits `tools`) so the append
 * can filter out the copies such a declaration already carries: advertising a
 * name twice puts two entries into `runtime.advertised()`'s output, and from
 * there a duplicate ToolDefinition in the provider request.
 */
import type { CodingToolName } from "@/tools";

export const UNIVERSAL_CODING_TOOLS: readonly CodingToolName[] = [
  "ScratchpadWrite",
  "ScratchpadRead",
  "ScratchpadList",
];

/**
 * US-003 — the native session's model-facing truncation, applied to every
 * genuine tool result before it enters the message array.
 *
 * WHY THIS IS NOT A REGISTERED `after_tool` HANDLER, despite the seam being the
 * right place for it conceptually: the dispatcher in `loop-events.ts` is
 * synchronous by design — US-002 pins that every handler returns a patch — while
 * applying the policy has to await the spill write. The marker may only name the
 * spill file when that write actually succeeded (US-003 AC8's fail-open
 * contract), so the write cannot be fired and forgotten and its outcome
 * discovered afterwards. The loop therefore calls this at the same chokepoint,
 * and the policy itself is `applyModelTruncationPolicy` — the one implementation
 * the coding-tool runtime applies too.
 *
 * The spill root is the session's scratchpad root, recorded at open from the
 * session's workdir so the marker's relative path resolves through
 * `ScratchpadRead`. A session driven without one (unit tests calling
 * `runNativeTurn` directly) falls back to its transcript directory, the one path
 * the session is known to own.
 */

import { applyModelTruncationPolicy, MODEL_MAX_BYTES } from "@/tools";
import { nativeSessionScratchpadRoots, nativeTranscriptDirs } from "./session";

/**
 * Where this session's spills belong, or `undefined` when the session is not
 * known to the runtime at all — in which case nothing is spilled and the marker
 * names no path, rather than naming a file written somewhere unreachable.
 */
export function spillRootFor(sessionId: string): string | undefined {
  return nativeSessionScratchpadRoots.get(sessionId) ?? nativeTranscriptDirs.get(sessionId);
}

/**
 * Shape one tool result for the model: within every cap it is returned
 * untouched (and nothing is spilled); over a cap it is cut, the untruncated
 * body is written under the scratchpad, and the content ends with the marker
 * naming the spill path and both byte counts.
 */
export async function truncateNativeToolResult(
  sessionId: string,
  body: string,
  opts: { readonly toolName: string; readonly callId: string; readonly reserveBytes?: number },
): Promise<string> {
  const root = spillRootFor(sessionId);
  // `reserveBytes` is what the CALLER will add to this result after the policy
  // has run -- today only the spin-breaker nudge, which the turn loop prepends.
  // Anything appended or prepended downstream has to be charged against the
  // same ceiling here, or the guarantee this chokepoint exists to give (the
  // model-facing content is at most MODEL_MAX_BYTES) is broken by exactly the
  // bytes the caller adds. Reserving is what keeps the ceiling unconditional.
  const reserved = Math.max(0, opts.reserveBytes ?? 0);
  return applyModelTruncationPolicy(body, {
    toolName: opts.toolName,
    callId: opts.callId,
    ...(root !== undefined ? { root } : {}),
    maxBytes: Math.max(0, MODEL_MAX_BYTES - reserved),
  });
}

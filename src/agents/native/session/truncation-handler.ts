/**
 * US-003 — the native session's model-facing truncation, applied to every
 * genuine tool result before it enters the message array.
 *
 * This IS a registered `after_tool` handler now: `createTruncationHandler`
 * builds it and `registerBuiltinLoopHandlers` registers it LAST, so it shapes
 * whatever earlier handlers produced — the same position the loop's hardcoded
 * call held before the seam carried it. It could not be registered while the
 * dispatcher was synchronous: the spill write has to be awaited, because AC8's
 * fail-open contract means the marker may only name the spill file when the
 * write actually succeeded, so the write cannot be fired and forgotten and its
 * outcome discovered afterwards. Dispatch is async now, so that documented
 * exception is deleted rather than restated. The policy itself remains
 * `applyModelTruncationPolicy` — the one implementation the coding-tool
 * runtime applies too.
 *
 * The spill root is the session's scratchpad root, recorded at open from the
 * session's workdir so the marker's relative path resolves through
 * `ScratchpadRead`. A session driven without one (unit tests calling
 * `runNativeTurn` directly) falls back to its transcript directory, the one path
 * the session is known to own.
 */

import { applyModelTruncationPolicy, MODEL_MAX_BYTES } from "@/tools";
import type { HandlerOf } from "./loop-events/types";
import { nudgeOverheadBytes } from "./nudge";
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
  opts: { readonly toolName?: string; readonly callId?: string; readonly reserveBytes?: number },
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
    toolName: opts.toolName ?? "",
    callId: opts.callId ?? "",
    ...(root !== undefined ? { root } : {}),
    maxBytes: Math.max(0, MODEL_MAX_BYTES - reserved),
  });
}

/**
 * The `after_tool` handler the loop registers: the same policy, at the same
 * chokepoint, reached through the seam instead of a hardcoded call. A nudge
 * riding on the payload reserves its own bytes out of the result's budget, so
 * the ceiling holds after `withNudge` prepends it.
 */
export function createTruncationHandler(sessionName: string): HandlerOf<"after_tool"> {
  return async (payload) => {
    const shaped = await truncateNativeToolResult(sessionName, payload.content, {
      toolName: payload.toolName,
      callId: payload.callId,
      ...(payload.nudgeText !== undefined ? { reserveBytes: nudgeOverheadBytes(payload.nudgeText) } : {}),
    });
    return { content: shaped };
  };
}

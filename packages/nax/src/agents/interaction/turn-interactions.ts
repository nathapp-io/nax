/**
 * The mid-turn interaction race shared by both ACP transports' turn loops:
 * the interaction handler's reply against the fixed human-reply timeout and
 * the run's abort signal.
 *
 * Moved out of agents/acp/adapter-send-turn.ts in S4b-1.
 */

import type { AdapterInteraction, InteractionHandler } from "@nathapp/nax-agent";
import { getSafeLogger } from "@/logger";
import { raceWithAbort } from "../turn";
import type { ContextToolCall } from "./output-parsing";

/** Time a human has to answer a mid-turn question or context-tool call. */
export const INTERACTION_TIMEOUT_MS = 5 * 60 * 1000;
export const INTERACTION_ABORT_MESSAGE = "Run aborted — shutdown in progress";

export type InteractionReply = { kind: "answered"; answer: string } | { kind: "aborted" } | { kind: "no-reply" };

export interface InteractionReplyContext {
  readonly interactionHandler: InteractionHandler;
  readonly signal?: AbortSignal;
  /** Logger stage for the failure warning; the acpx loop passes "acp-adapter". */
  readonly stage: string;
  /** Test seam only; production callers omit it and get INTERACTION_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/**
 * The interaction race shared by the context-tool and question branches:
 * handler reply vs. the fixed human-response timeout, with the abort check
 * and the failure warn. `warnSuffix` completes the warn message verbatim
 * (" for context-tool: ..." vs ": ...").
 */
export async function awaitInteractionReply(
  ctx: InteractionReplyContext,
  interaction: AdapterInteraction,
  warnSuffix: string,
): Promise<InteractionReply> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      raceWithAbort(ctx.interactionHandler.onInteraction(interaction), ctx.signal, INTERACTION_ABORT_MESSAGE),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), ctx.timeoutMs ?? INTERACTION_TIMEOUT_MS);
      }),
    ]);
    if (response) {
      return { kind: "answered", answer: response.answer };
    }
  } catch (err) {
    if (ctx.signal?.aborted) {
      return { kind: "aborted" };
    }
    getSafeLogger()?.warn(
      ctx.stage,
      `InteractionHandler.onInteraction failed${warnSuffix}${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
  return { kind: "no-reply" };
}

/** Shape a parsed `<nax_tool_call>` into the handler's context-tool interaction. */
export function toContextToolInteraction(toolCall: ContextToolCall): AdapterInteraction {
  return toolCall.error
    ? { kind: "context-tool", name: toolCall.name, error: toolCall.error }
    : { kind: "context-tool", name: toolCall.name, input: toolCall.input };
}

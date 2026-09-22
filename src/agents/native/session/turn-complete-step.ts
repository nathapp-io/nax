/**
 * The complete-with-recovery step of the native turn loop.
 *
 * `deps.complete` plus its two recoveries — the bounded transport-fault retry
 * (nax#1870) and the context-overflow compaction backstop — live here as one
 * site: one round trip is issued, and a throw gets exactly one of the two
 * recoveries. They were two branches of the loop's single try/catch; folding
 * them into a step is what will let one seam observe every round trip. P3
 * attaches `transform_context` and `before_request` here — `before_request`
 * fires per request attempt from the private `request()` wrapper below, and
 * `transform_context` joins it there (spec 6.5).
 *
 * The private `isContextOverflow` guard is this module's alone: it decides
 * which recovery a thrown round trip gets.
 */

import { getSafeLogger } from "@/logger";
import type { TranscriptMessage as NativeTranscriptMessage } from "./compaction";
import type { CompleteCallOptions, LoopEventRegistry } from "./loop-events";
import type { TurnAccumulator } from "./turn-accumulator";
import { runOverflowCompaction } from "./turn-compaction-step";
import { realSleep, retryTransportFault } from "./turn-retry";
import type { NativeTurnResponse, TurnDeps } from "./turn-types";

/**
 * Structural, matching adapter.ts's guard: nax-ai's error class is not importable
 * here and the kind is what matters.
 */
function isContextOverflow(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("protocolError" in err)) return false;
  const { protocolError } = err as { protocolError?: { kind?: unknown } };
  return protocolError?.kind === "context-overflow";
}

export interface CompleteStepResult {
  readonly res: NativeTurnResponse;
  /** The transcript after recovery; rebound only by the overflow branch. */
  readonly messages: readonly NativeTranscriptMessage[];
  /** True when the overflow branch ran: it always rebinds messages (and the caller clears lastUsage/anchorIndex). */
  readonly compacted: boolean;
}

export interface CompleteStepArgs {
  readonly messages: readonly NativeTranscriptMessage[];
  readonly tools: Parameters<TurnDeps["complete"]>[1];
  readonly usage: TurnAccumulator;
  /**
   * Set by the proactive step for this round trip: the summarizer already threw,
   * so the overflow retry must not try again.
   */
  readonly summarizeFailed: boolean;
  readonly sessionName: string;
  readonly lastUsage: { readonly promptTokens: number } | undefined;
  readonly anchorIndex: number | undefined;
  /**
   * The registry actually in use — the loop's local (`deps.loopEvents ??
   * createLoopEventRegistry()`), not `deps.loopEvents` itself, which is
   * usually absent and would dispatch to nothing.
   */
  readonly loopEvents: LoopEventRegistry;
  /** The round trip this request belongs to, as counted by the loop. */
  readonly roundTrip: number;
  /** The session's resolved model; undefined when driven without a modelDef. */
  readonly model?: string;
  readonly deps: TurnDeps;
  readonly signal?: AbortSignal;
}

export async function completeWithRecovery(args: CompleteStepArgs): Promise<CompleteStepResult> {
  const {
    tools,
    usage,
    summarizeFailed,
    sessionName,
    lastUsage,
    anchorIndex,
    loopEvents,
    roundTrip,
    model,
    deps,
    signal,
  } = args;
  let messages: readonly NativeTranscriptMessage[] = args.messages;
  let compacted = false;
  let res: NativeTurnResponse;
  // Model, thinking level and timeout are bound in the adapter's closure above
  // the loop (spec 6.3), so the bag this dispatches starts empty; a handler's
  // patch is the only thing that ever fills it.
  const baseOptions: CompleteCallOptions = {};
  // One wrapper, three call sites (spec 6.5). The wrapper owns `attempt`, so
  // the retry machinery reports 2..n without knowing an event exists.
  let attempt = 0;
  const request = async (msgs: readonly NativeTranscriptMessage[]): Promise<NativeTurnResponse> => {
    attempt += 1;
    const patch = await loopEvents.dispatch("before_request", {
      ...(model !== undefined ? { model } : {}),
      roundTrip,
      attempt,
      options: baseOptions,
    });
    const options = patch.options === undefined ? baseOptions : { ...baseOptions, ...patch.options };
    return deps.complete(msgs, tools, options);
  };
  try {
    res = await request(messages);
  } catch (err) {
    // Written as one guarded `if` (not a separate `canRetry` boolean) so
    // TypeScript's narrowing carries deps.summarize/contextWindow/compaction
    // as defined below — a boolean flag loses that narrowing.
    if (
      !isContextOverflow(err) ||
      summarizeFailed ||
      deps.summarize === undefined ||
      deps.contextWindow === undefined ||
      deps.compaction === undefined ||
      !deps.compaction.enabled
    ) {
      // nax#1870: not an overflow this branch can handle. One more
      // guarded branch beside the overflow backstop above, not a second
      // loop or a second try/catch here — the retry's own looping and
      // backoff live in retryTransportFault (./turn-retry), called once.
      if (deps.transportRetry === undefined) throw err;
      res = await retryTransportFault(err, {
        attempt: () => request(messages),
        config: deps.transportRetry,
        deadline: deps.deadline,
        signal,
        sleep: deps.sleep ?? realSleep,
        onRetry: (retryNumber, delayMs, fault) => {
          getSafeLogger()?.warn("native-adapter", `retrying after a ${fault.protocolError.kind} fault`, {
            sessionName,
            retryNumber,
            delayMs,
            kind: fault.protocolError.kind,
            message: fault.protocolError.message,
            ...(fault.protocolError.status !== undefined ? { status: fault.protocolError.status } : {}),
            ...(fault.protocolError.retryAfter !== undefined ? { retryAfter: fault.protocolError.retryAfter } : {}),
          });
          // Resets the watchdog's lastActivityAt so a call being retried
          // is not mistaken for an idle one — same mechanism the
          // compaction summary above uses. All-zero is honest, not
          // fabricated: a pre-first-event transport throw bills nothing
          // (see nax-ai's retry.ts), so this beat truly carries zero
          // tokens, not a guessed non-zero number.
          deps.onActivity?.({ kind: "usage", inputTokens: 0, outputTokens: 0, costUsd: 0 });
        },
      });
      // Falls through to the shared round-trip bookkeeping and tool
      // execution below, exactly like the overflow-retry branch's own
      // `res = await request(messages)` two lines down — one success
      // path, reached from either recovery, not a second copy of it.
    } else {
      const step = await runOverflowCompaction({
        messages,
        usage,
        sessionName,
        lastUsage,
        anchorIndex,
        deps: {
          summarize: deps.summarize,
          contextWindow: deps.contextWindow,
          compaction: deps.compaction,
          onActivity: deps.onActivity,
          deadline: deps.deadline,
        },
        error: err,
        ...(signal !== undefined ? { signal } : {}),
      });
      messages = [...step.messages];
      compacted = true;
      // Retried once. A second overflow propagates: compacting further would be
      // guessing, and the failure now carries a correct diagnosis.
      res = await request(messages);
    }
  }
  return { res, messages, compacted };
}

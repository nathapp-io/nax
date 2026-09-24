/**
 * The per-batch tool-call loop of the native turn loop.
 *
 * One assistant message may carry several tool calls; this module answers every
 * one of them, applying the six distinct rules the loop has accumulated. It is
 * the largest move out of `turn-loop.ts` and the one with the most invariants,
 * so it is extracted unchanged: the rules are the point, not the plumbing.
 *
 * The batch owns a mutable copy of the transcript for its duration and returns
 * the final array; `interactions` and `codingToolsCalled` accumulate locally and
 * come back as NEW entries, so the caller appends rather than the batch
 * mutating turn-lifetime arrays it does not own.
 *
 * `spinWarned` is a snapshot: it is set by the spin breaker's `onSpinStop`
 * callback during this batch only in tandem with a `terminate` outcome, which
 * breaks the batch immediately — so no later call in the same batch needs the
 * flipped value. The batch reports the resulting `spinStopped` back out.
 */

import type { ToolCall, ToolDefinition } from "@nathapp/nax-ai";
import type { InteractionExchange, SendTurnOpts } from "@/agents/session-types";
import type { SpinBreaker } from "@/runtime/spin-breaker";
import { ASK_HUMAN_TOOL_NAME } from "./ask-human";
import type { TranscriptMessage as NativeTranscriptMessage } from "./compaction";
import { type InvalidCallBudget, rewriteToolCallInput } from "./handle-invalid-tool-call";
import type { LoopEventRegistry } from "./loop-events";
import { withNudge } from "./nudge";
import { buildToolResult } from "./tool-result";
import { handleAskHumanCall } from "./turn-ask-human";
import type { TurnDeps } from "./turn-types";

export interface ToolBatchResult {
  readonly messages: readonly NativeTranscriptMessage[];
  /** Only the exchanges recorded in THIS batch; the caller appends them. */
  readonly interactions: readonly InteractionExchange[];
  /** Only the coding tools called in THIS batch; the caller appends them. */
  readonly codingToolsCalled: readonly string[];
  /** The caller breaks out of the while loop on either. */
  readonly spinStopped: boolean;
  readonly budgetExceeded: boolean;
}

export interface ToolBatchArgs {
  readonly messages: readonly NativeTranscriptMessage[];
  readonly toolCalls: readonly ToolCall[];
  readonly tools: readonly ToolDefinition[];
  readonly codingToolNames: ReadonlySet<string>;
  readonly roundTrips: number;
  readonly opts: SendTurnOpts;
  readonly deps: TurnDeps;
  readonly loopEvents: LoopEventRegistry;
  readonly invalidCallBudget: InvalidCallBudget;
  readonly spinBreaker: SpinBreaker | undefined;
  readonly maxInteractions: number;
  /** Snapshot of the loop's `spinWarned` at batch dispatch. */
  readonly spinWarned: boolean;
  /** Exchanges already recorded this turn, so the ask_human budget is turn-lifetime, not per-batch. */
  readonly interactionsSoFar: number;
}

export async function runToolBatch(args: ToolBatchArgs): Promise<ToolBatchResult> {
  const {
    toolCalls,
    tools,
    codingToolNames,
    roundTrips,
    opts,
    deps,
    loopEvents,
    invalidCallBudget,
    spinBreaker,
    maxInteractions,
    spinWarned,
    interactionsSoFar,
  } = args;

  let messages: NativeTranscriptMessage[] = [...args.messages];
  const interactions: InteractionExchange[] = [];
  const codingToolsCalled: string[] = [];
  // The ask_human budget counts exchanges across the whole turn, not this
  // batch: `interactionsSoFar` is the caller's count at dispatch, and each
  // successful exchange below advances `recorded` so a second ask in the same
  // batch sees the first one spent.
  let recorded = interactionsSoFar;
  let spinStopped = false;

  for (const [callIndex, call] of toolCalls.entries()) {
    if (spinWarned) {
      spinStopped = true;
      // The terminal round trip is answer-only. Any subsequent tool call
      // is neither executed nor answered; the fail-spin retry starts from
      // a fresh session and deliberately drops this unanswered request.
      break;
    }
    deps.onActivity?.({ kind: "tool", toolName: call.name });
    try {
      if (call.name === ASK_HUMAN_TOOL_NAME) {
        const question = String((call.input as { text?: unknown } | undefined)?.text ?? "");
        // These push sites — and the spin notice below — are answers to a call no
        // tool produced. They use the chokepoint and deliberately fire no
        // `after_tool` event: a policy that shapes tool output has nothing to
        // shape here.
        const outcome = await handleAskHumanCall({
          toolCallId: call.id,
          question,
          interactionsSoFar: recorded,
          maxInteractions,
          roundTrips,
          interactionHandler: opts.interactionHandler,
        });
        if (outcome.exchange !== undefined) {
          interactions.push(outcome.exchange);
          recorded += 1;
        }
        messages.push(outcome.result);
        continue;
      }
      const outcome = await loopEvents.dispatch("before_tool", { call, tools });
      // nax#2047 Task 4: a tripped invalid-call budget ends the batch with
      // NO result — "a result nobody reads only grows the transcript". None
      // of the four seam outcomes can express that (each answers the call),
      // so the halt is read from the budget the repair handler counts into,
      // and checked before the outcome is applied.
      if (invalidCallBudget.exceeded) break;
      // The spin breaker's stop is a batch-level outcome (nax#2120): every
      // OUTSTANDING call in this batch is answered, not just the triggering
      // one, or the next `complete()` is sent a tool_call with no matching
      // result, which strict providers reject. Answer-only — the loop
      // continues so the model can close the turn out — and synthetic, so
      // no `after_tool` handler sees it.
      if (outcome.kind === "terminate") {
        for (const outstanding of toolCalls.slice(callIndex)) {
          messages.push(
            buildToolResult({
              toolCallId: outstanding.id,
              content: outcome.content,
              isError: outcome.isError,
            }),
          );
        }
        break;
      }
      if (outcome.kind === "block") {
        // Answered on the tool's behalf: the call never runs. A blocked
        // call may still carry the input to record in its place (the
        // invalid-call repair's redacted call), written before the answer.
        if (outcome.input !== undefined) messages = rewriteToolCallInput(messages, call.id, outcome.input);
        messages.push(buildToolResult({ toolCallId: call.id, content: outcome.content, isError: outcome.isError }));
        continue;
      }
      // `allow` and `nudge` may rewrite the call's input; the rewritten value
      // is what the transcript records and what the tool is invoked with, so
      // the model's own history stays a truthful account of what ran.
      const rewritten = outcome.input;
      const input = rewritten ?? call.input;
      if (rewritten !== undefined) messages = rewriteToolCallInput(messages, call.id, rewritten);
      const nudgeText = outcome.kind === "nudge" ? outcome.text : undefined;
      const kind = codingToolNames.has(call.name) ? "coding-tool" : "context-tool";
      if (kind === "coding-tool") codingToolsCalled.push(call.name);
      const answer = await opts.interactionHandler.onInteraction(
        kind === "coding-tool"
          ? {
              kind,
              name: call.name,
              // MUST be `input`, NOT `call.input`. #2162's US-002 added a
              // `before_tool` `allow` outcome that may REWRITE the input;
              // the merged line is `input: (input ?? {}) as Record<...>`
              // where `input = rewritten ?? call.input` (turn-loop.ts:448).
              // Using `call.input` here runs the tool on the model's
              // original arguments while `rewriteToolCallInput` has already
              // recorded the corrected ones — execution and transcript
              // diverge, silently, with no test in this plan covering it.
              input: (input ?? {}) as Record<string, unknown>,
              ...(opts.turnId !== undefined ? { turnId: opts.turnId } : {}),
              roundTrips,
              toolCallId: call.id,
              deferModelTruncation: true,
            }
          : { kind, name: call.name, input },
      );
      const answerText = answer?.answer ?? "";
      // Genuine execution: the result is shaped by `after_tool` BEFORE it
      // enters the array, which is what makes the event safe by
      // construction (no handler can rewrite history). `denied` is threaded
      // through untouched — a refused Write is not a crashed Write
      // (ADR-029 s5) — and `nudge` prefixes the surviving content.
      // Model-facing truncation (US-003) is the LAST of those handlers, so it
      // shapes whatever earlier handlers produced; the payload carries the
      // tool identity and the pending nudge, whose bytes the handler reserves
      // out of this result's budget before `withNudge` prepends it below.
      const patch = await loopEvents.dispatch("after_tool", {
        content: answerText,
        denied: answer?.denied,
        toolName: call.name,
        callId: call.id,
        ...(nudgeText !== undefined ? { nudgeText } : {}),
      });
      const finalContent = withNudge(nudgeText, patch.content ?? answerText);
      answer?.finalizeAudit?.(finalContent);
      messages.push(
        buildToolResult({
          toolCallId: call.id,
          content: finalContent,
          isError: patch.isError,
          denied: answer?.denied,
        }),
      );
      // The breaker observed the call through the seam, i.e. with whatever
      // input a handler rewrote in place — so the result has to be noted
      // against that same input, or the key misses and result-based
      // repetition detection silently stops for rewritten calls.
      spinBreaker?.noteResult(call.name, input, answerText);
    } catch (err) {
      // A tool failure is data, not a turn failure: the existing pull-tool
      // contract already surfaces a handler throw as status "error". The
      // event still fires — a policy that bounds result size has to see the
      // results that arrive as errors too.
      const errorText = err instanceof Error ? err.message : String(err);
      const patch = await loopEvents.dispatch("after_tool", {
        content: errorText,
        isError: true,
        toolName: call.name,
        callId: call.id,
      });
      messages.push(
        buildToolResult({
          toolCallId: call.id,
          content: patch.content ?? errorText,
          isError: patch.isError ?? true,
        }),
      );
    }
  }

  return {
    messages,
    interactions,
    codingToolsCalled,
    spinStopped,
    budgetExceeded: invalidCallBudget.exceeded,
  };
}

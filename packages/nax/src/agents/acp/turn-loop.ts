/**
 * nax's turn loop on the ACP transport (S4b spec §6.2): the former acpx loop
 * (adapter-send-turn.ts, deleted in S4b-5) with the acpx prompt swapped for the
 * backend's single-prompt sendTurn. Kept from that loop:
 * - one deadline spans the loop; expiry aborts the prompt and returns
 *   TurnResult{ timedOut: true, output: "" } with the spend so far;
 * - a <nax_tool_call> or a trailing question goes to the interaction handler
 *   (5-minute reply race) and the reply is the next prompt; the agent's own ACP
 *   questions (ask-port.ts) draw on the same maxInteractions budget;
 * - the agent no longer knowing the session (AGENT_SESSION_NOT_FOUND, or a
 *   prompt-time TURN_FAILED not-found, D3-f) re-opens the session fresh once
 *   and resends, the dead attempt uncounted (acpx exit code 4);
 * - one TurnResult for the loop: last output, summed spend, round trips.
 * Any other failure throws SessionTurnError with the spend of every prompt
 * (BUG-57). promptRetries resends a prompt that failed before any turn event, on the same call (S4b-0 Ruling T1-1, D3-h).
 */
import { randomUUID } from "node:crypto";
import { createTurnDeadline, type InteractionExchange, type SendTurnOpts } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import {
  awaitInteractionReply,
  extractContextToolCall,
  extractQuestion,
  type InteractionReply,
  type InteractionReplyContext,
  toContextToolInteraction,
} from "../interaction";
import { assembleTurnResult, warnWallClockTimeout } from "../turn";
import type { TurnResult } from "../types";
import {
  classifyTurnFailure,
  isSessionGone,
  RunAborted,
  TurnDeadlineExpired,
  turnFailureError,
  WatchdogCancel,
} from "./failure-map";
import { addSpend, NO_SPEND, type Spend, spendOfError, spendOfResult } from "./pricing";
import { isRetryablePromptError, promptRetryDelayMs } from "./prompt-retry";
import { _acpDeps, type AcpSession, reopenFresh } from "./session";
import { type CallBridge, startCall } from "./stream-bridge";

const STAGE = "acp";
const DEFAULT_MAX_INTERACTIONS = 10;

type Deadline = ReturnType<typeof createTurnDeadline>;

interface LoopState {
  /** Backend prompts sent and counted: TurnResult.internalRoundTrips. */
  turnCount: number;
  /** ACP questions answered from the same budget (§6.3). */
  asked: number;
  spend: Spend;
  output: string;
  currentPrompt: string;
  recovered: boolean;
  timedOut: boolean;
  readonly interactions: InteractionExchange[];
}

interface Loop {
  readonly session: AcpSession;
  readonly opts: SendTurnOpts;
  readonly max: number;
  readonly deadline: Deadline;
  readonly state: LoopState;
}

type IterationOutcome =
  | { readonly kind: "ok"; readonly output: string }
  | { readonly kind: "timed-out" }
  | { readonly kind: "reopened" };

function used(state: LoopState): number {
  return state.turnCount + state.asked;
}

function failed(loop: Loop, err: unknown, cause: unknown): Error {
  return turnFailureError(classifyTurnFailure(err, cause), loop.state.spend, loop.session.rateCard);
}

function consumeInteraction(loop: Loop): boolean {
  if (used(loop.state) >= loop.max) return false;
  loop.state.asked++;
  return true;
}

function linkAborts(controller: AbortController, signals: readonly (AbortSignal | undefined)[]): () => void {
  const unlinks = signals
    .filter((signal): signal is AbortSignal => signal !== undefined)
    .map((signal) => {
      const onAbort = (): void => controller.abort(new RunAborted(signal.reason));
      if (signal.aborted) {
        onAbort();
        return () => {};
      }
      signal.addEventListener("abort", onAbort, { once: true });
      return () => signal.removeEventListener("abort", onAbort);
    });
  return () => {
    for (const unlink of unlinks) unlink();
  };
}

/** setTimeout, not Bun.sleep: the timer is cleared when the prompt settles. */
function armDeadline(
  controller: AbortController,
  remainingMs: number | undefined,
): ReturnType<typeof setTimeout> | undefined {
  if (remainingMs === undefined) return undefined;
  return setTimeout(() => controller.abort(new TurnDeadlineExpired()), remainingMs);
}

async function afterFailure(loop: Loop, err: unknown, cause: unknown): Promise<IterationOutcome> {
  if (cause instanceof TurnDeadlineExpired) return { kind: "timed-out" };
  if (cause !== undefined || !isSessionGone(err) || loop.state.recovered) throw failed(loop, err, cause);
  loop.state.recovered = true;
  getSafeLogger()?.info(STAGE, "ACP session not found mid-turn; re-opening it fresh", {
    sessionName: loop.session.name,
  });
  try {
    await reopenFresh(loop.session);
  } catch (reopenErr) {
    getSafeLogger()?.warn(STAGE, "Re-opening the ACP session failed", {
      sessionName: loop.session.name,
      error: reopenErr instanceof Error ? reopenErr.message : String(reopenErr),
    });
    throw failed(loop, err, undefined);
  }
  loop.state.turnCount--;
  return { kind: "reopened" };
}

type BackendResult = Awaited<ReturnType<AcpSession["opened"]["adapter"]["sendTurn"]>>;

interface Attempt {
  readonly controller: AbortController;
  readonly call: CallBridge;
  readonly turnId: string;
}

function sendOnce(session: AcpSession, prompt: string, attempt: Attempt): Promise<BackendResult> {
  return session.opened.adapter.sendTurn(session.opened.handle, prompt, {
    ...session.opened.turnOpts(),
    signal: attempt.controller.signal,
    turnId: attempt.turnId,
    onTurnEvent: attempt.call.sink,
  });
}

/**
 * Sends the iteration's prompt, resending on the same call while T1-1 allows
 * (D3-h). A resent attempt is not a turn; its failed spend is kept. The backoff
 * waits on the iteration signal, so an abort there rejects with the abort reason.
 */
async function sendWithRetries(loop: Loop, attempt: Attempt): Promise<BackendResult> {
  const retries = loop.session.opts.promptRetries ?? 0;
  for (let retryIndex = 0; retryIndex < retries; retryIndex++) {
    try {
      return await sendOnce(loop.session, loop.state.currentPrompt, attempt);
    } catch (err) {
      if (attempt.controller.signal.aborted || attempt.call.anyEvent() || !isRetryablePromptError(err)) throw err;
      loop.state.spend = addSpend(loop.state.spend, spendOfError(err));
      getSafeLogger()?.info(STAGE, "ACP prompt failed before any output; resending", {
        sessionName: loop.session.name,
        retry: retryIndex + 1,
        of: retries,
      });
      await _acpDeps.delay(promptRetryDelayMs(retryIndex), attempt.controller.signal);
    }
  }
  return sendOnce(loop.session, loop.state.currentPrompt, attempt);
}

async function runIteration(loop: Loop): Promise<IterationOutcome> {
  const { session, opts, state } = loop;
  const controller = new AbortController();
  const unlink = linkAborts(controller, [opts.signal, session.closer.signal]);
  if (controller.signal.aborted) {
    unlink();
    throw failed(loop, undefined, controller.signal.reason);
  }
  // armDeadline and startCall cannot throw; everything that can is inside the try, so the
  // finally always clears the timer, the abort links and the slot, and call_ended is emitted.
  const timer = armDeadline(controller, loop.deadline.remainingMs());
  const call = startCall(session.stream);
  const turnId = opts.turnId ?? randomUUID();
  try {
    session.opts.onActiveCall?.(call.callId, async () => controller.abort(new WatchdogCancel()));
    session.slot.set({
      signal: controller.signal,
      turnId,
      interactionHandler: opts.interactionHandler,
      call,
      consumeInteraction: () => consumeInteraction(loop),
      recordExchange: (question, reply) => {
        state.interactions.push({ turnIndex: state.turnCount, question, reply });
      },
    });
    const result = await sendWithRetries(loop, { controller, call, turnId });
    call.end("success");
    state.spend = addSpend(state.spend, spendOfResult(result));
    return { kind: "ok", output: result.output };
  } catch (err) {
    call.end("error");
    state.spend = addSpend(state.spend, spendOfError(err));
    return await afterFailure(loop, err, controller.signal.aborted ? controller.signal.reason : undefined);
  } finally {
    clearTimeout(timer);
    unlink();
    session.slot.clear();
  }
}

function replyContext(loop: Loop): InteractionReplyContext {
  return { interactionHandler: loop.opts.interactionHandler, signal: loop.opts.signal, stage: STAGE };
}

function answerOf(loop: Loop, reply: InteractionReply): string | undefined {
  if (reply.kind === "answered") return reply.answer;
  if (reply.kind === "aborted") throw failed(loop, undefined, new RunAborted(loop.opts.signal?.reason));
  return undefined;
}

/** The next prompt: a context-tool result or a human reply; undefined ends the loop. */
async function nextPrompt(loop: Loop, output: string): Promise<string | undefined> {
  const toolCall = extractContextToolCall(output);
  if (toolCall !== null) {
    const reply = await awaitInteractionReply(
      replyContext(loop),
      toContextToolInteraction(toolCall),
      " for context-tool: ",
    );
    return answerOf(loop, reply);
  }
  const question = extractQuestion(output);
  if (question === null) return undefined;
  const answer = answerOf(
    loop,
    await awaitInteractionReply(replyContext(loop), { kind: "question", text: question }, ": "),
  );
  if (answer !== undefined) loop.state.interactions.push({ turnIndex: loop.state.turnCount, question, reply: answer });
  return answer;
}

function markTimedOut(loop: Loop): void {
  loop.state.timedOut = true;
  warnWallClockTimeout(loop.session.name, loop.session.opts.timeoutSeconds, STAGE);
}

async function runLoop(loop: Loop): Promise<TurnResult> {
  const { state } = loop;
  while (used(state) < loop.max) {
    if (loop.deadline.expired()) {
      markTimedOut(loop);
      break;
    }
    if (loop.opts.signal?.aborted) throw failed(loop, undefined, new RunAborted(loop.opts.signal.reason));
    state.turnCount++;
    const outcome = await runIteration(loop);
    if (outcome.kind === "reopened") continue;
    if (outcome.kind === "timed-out") {
      markTimedOut(loop);
      break;
    }
    state.output = outcome.output;
    const next = await nextPrompt(loop, outcome.output);
    if (next === undefined) break;
    state.currentPrompt = next;
  }
  if (used(state) >= loop.max && !state.timedOut && loop.max > 1) {
    getSafeLogger()?.warn(STAGE, "Interaction budget spent", {
      sessionName: loop.session.name,
      maxInteractions: loop.max,
    });
  }
  return assembleTurnResult({
    output: state.output,
    totalTokenUsage: state.spend.tokenUsage,
    totalExactCostUsd: state.spend.exactCostUsd,
    turnCount: state.turnCount,
    interactions: state.interactions,
    timedOut: state.timedOut,
    rateCard: loop.session.rateCard,
  });
}

export async function runTurnLoop(session: AcpSession, prompt: string, opts: SendTurnOpts): Promise<TurnResult> {
  if (session.running !== undefined) {
    throw new NaxError(`ACP session "${session.name}" already has a turn in flight`, "ACP_SDK_TURN_IN_FLIGHT", {
      stage: STAGE,
      sessionName: session.name,
    });
  }
  const run = runLoop({
    session,
    opts,
    max: opts.maxInteractions ?? DEFAULT_MAX_INTERACTIONS,
    deadline: createTurnDeadline(session.opts.timeoutSeconds),
    state: {
      turnCount: 0,
      asked: 0,
      spend: NO_SPEND,
      output: "",
      currentPrompt: prompt,
      recovered: false,
      timedOut: false,
      interactions: [],
    },
  });
  // shutdownSession waits on this, so the backend's last baseline save lands before the delete.
  session.running = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await run;
  } finally {
    session.running = undefined;
  }
}

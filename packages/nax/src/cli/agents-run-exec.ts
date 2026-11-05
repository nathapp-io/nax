/**
 * US-003: run one agent task and derive the run's terminal status, output and priced cost.
 * US-004: the asks nobody is there to answer, the `--timeout` timer and the caller's signal.
 *
 * The command gives the agent a guarded, unattended nested session and no resume: every run
 * opens a fresh memory-only session through `runSubagent` and closes it after one turn. The
 * status follows the turn's own `turn_end` — `timed_out` reports as `timeout`, `errored` and
 * `interrupted` as `failed` — and a run whose turn never ended (a refused profile, or a session
 * that failed to open) is `failed`. Cost is reported only when the turn was priced: an unpriced
 * turn, and a run that never reached a turn, omit it rather than claim zero.
 *
 * With no interaction chain attached, the run answers every ask itself: a denial for an
 * approval, {@link AGENTS_RUN_NO_ANSWER} for a question, each recorded in `deniedAsks`. The
 * command's own `--timeout` and the caller's signal both abort the nested session, and each
 * outranks whatever the turn then reported.
 */
import type {
  AgentSession,
  AnswerReply,
  LoopHandlerSet,
  SessionEvent,
  ToolProvider,
  TurnEndStatus,
} from "@nathapp/nax-agent";
import { runSubagent } from "@/chat";
import type { NaxConfig } from "@/config";
import type { AgentResource } from "@/resources";

/** The parent session every `nax agents run` turn names; there is one run, never a resume. */
export const AGENTS_RUN_PARENT_SESSION_ID = "nax-agents-run";

/** What an unattended run says when the agent asks it something: nobody is there to answer. */
export const AGENTS_RUN_NO_ANSWER =
  "No one is attached to answer. Continue without an answer, or stop and say what you need.";

export type AgentsRunStatus = "completed" | "failed" | "cancelled" | "timeout";

export type DeniedAsk =
  | { readonly kind: "approval"; readonly tool: string; readonly summary: string }
  | { readonly kind: "question"; readonly text: string };

export interface AgentsRunResult {
  /** The agent's `qualifiedName`. */
  readonly agent: string;
  readonly model: string;
  readonly status: AgentsRunStatus;
  /** The text `runSubagent` returned: the final text on completion, the error text otherwise. */
  readonly output: string;
  readonly deniedAsks: readonly DeniedAsk[];
  /** Present only when the turn ended with a priced `turn_end`; never `0` to mean unknown. */
  readonly costUsd?: number;
}

export interface AgentsRunTaskInput {
  readonly agent: AgentResource;
  /** Already expanded by `resolveAgentsRunTask`. */
  readonly task: string;
  /** Already resolved by `resolveAgentsRunModel`. */
  readonly model: string;
  readonly allowedTools?: readonly string[];
  readonly toolProviders: readonly ToolProvider[];
  readonly loopHandlers: LoopHandlerSet;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly config: NaxConfig;
  readonly timeoutSeconds?: number;
  /** Aborted by the command on SIGINT or SIGTERM (US-004 arms it). */
  readonly signal?: AbortSignal;
}

type TimerHandle = ReturnType<typeof setTimeout> | number;

export const _agentsRunExecDeps = {
  runSubagent,
  // The `--timeout` limit must be cleared the moment the turn ends instead, and Bun.sleep cannot
  // be cancelled — so this is the permitted `setTimeout` exception in `src/` (forbidden-patterns-source).
  setTimeout: (callback: () => void, delayMs: number): TimerHandle => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: TimerHandle): void => globalThis.clearTimeout(handle),
};

type TurnEndEvent = Extract<SessionEvent, { type: "turn_end" }>;

/** An event that waits for an answer; `answerable: false` means the profile already decided it. */
type AskEvent = Extract<SessionEvent, { type: "approval_requested" | "question" }>;

function isAsk(event: SessionEvent): event is AskEvent {
  return event.type === "approval_requested" || event.type === "question";
}

/** What the run records for an ask nobody was there to answer. */
function deniedAsk(event: AskEvent): DeniedAsk {
  return event.type === "approval_requested"
    ? { kind: "approval", tool: event.tool, summary: event.summary }
    : { kind: "question", text: event.text };
}

/** The reply the run gives: a denial, or the text that tells the agent nobody answered. */
function unattendedReply(event: AskEvent): AnswerReply {
  return event.type === "approval_requested" ? { decision: "deny" } : { text: AGENTS_RUN_NO_ANSWER };
}

/**
 * The asks of one run, answered on the nested session the moment they arrive.
 *
 * A reply lands in `deniedAsks` in arrival order whatever `answer` returns, and a reply the
 * session refuses cannot fail the run: the ask is already recorded and the turn goes on. An
 * ask that arrives before `onSession` (which `runSubagent` never does) is recorded and left
 * unanswered rather than dropped.
 */
function askAnswerer(deniedAsks: DeniedAsk[]): {
  onSession: (session: AgentSession) => void;
  onAsk: (event: AskEvent) => void;
} {
  let session: AgentSession | undefined;
  return {
    onSession: (opened) => {
      session = opened;
    },
    onAsk: (event) => {
      deniedAsks.push(deniedAsk(event));
      try {
        session?.answer(event.requestId, unattendedReply(event));
      } catch {
        // The ask is recorded already; a session that refuses the reply changes nothing for the run.
      }
    },
  };
}

/** Every terminal turn status, mapped to what the command reports and exits on. */
const STATUS_OF_TURN_END: Record<TurnEndStatus, AgentsRunStatus> = {
  completed: "completed",
  cancelled: "cancelled",
  timed_out: "timeout",
  errored: "failed",
  interrupted: "failed",
};

/** A run whose turn never ended: the session refused to start, or creating it failed. */
const STATUS_WITHOUT_TURN_END: AgentsRunStatus = "failed";

/**
 * The two ways the command itself stops a run, each remembered so that the status it reports
 * outranks whatever the turn then said — rules 1 and 2 of the status mapping.
 */
interface Supervision {
  /** The signal the nested session is given; aborting it cancels the turn. */
  readonly controller: AbortController;
  /** The `--timeout` timer fired. */
  timedOut: boolean;
  /** The caller's signal aborted (SIGINT or SIGTERM; US-009 registers those). */
  cancelled: boolean;
  /** Clear the timer and unlink the caller's signal. */
  dispose(): void;
}

/**
 * Link the caller's signal to an internal controller and arm the run's own timeout, if it has one.
 *
 * The nested session is always given the internal signal, so either reason reaches it. The
 * caller's signal may already be aborted (a signal that arrived before the run started), and
 * aborting an already aborted controller changes nothing, so a second signal is harmless.
 */
function superviseRun(input: AgentsRunTaskInput, deps: typeof _agentsRunExecDeps): Supervision {
  const signal = input.signal;
  let timer: TimerHandle | undefined;
  const onAbort = () => {
    supervision.cancelled = true;
    supervision.controller.abort();
  };
  const supervision: Supervision = {
    controller: new AbortController(),
    timedOut: false,
    cancelled: false,
    dispose() {
      if (timer !== undefined) deps.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  if (input.timeoutSeconds !== undefined) {
    timer = deps.setTimeout(() => {
      supervision.timedOut = true;
      supervision.controller.abort();
    }, input.timeoutSeconds * 1000);
  }
  return supervision;
}

/** What the command reports: its own limits first, then the turn's, then a turn that never came. */
function statusOf(supervision: Supervision, end: TurnEndEvent | undefined): AgentsRunStatus {
  if (supervision.timedOut) return "timeout";
  if (supervision.cancelled) return "cancelled";
  return end === undefined ? STATUS_WITHOUT_TURN_END : STATUS_OF_TURN_END[end.status];
}

/**
 * The turn's own spend, or undefined when it is not a real cost. An unpriced `turn_end` carries
 * `costUsd: 0` as a placeholder, so reporting it would claim a free turn.
 */
function pricedCost(end: TurnEndEvent | undefined): number | undefined {
  if (end === undefined || end.costSource === "unpriced") return undefined;
  return end.costUsd;
}

/** The result the command reports, with `costUsd` left out rather than set to an unknown 0. */
function resultOf(args: {
  input: AgentsRunTaskInput;
  end: TurnEndEvent | undefined;
  content: string;
  deniedAsks: readonly DeniedAsk[];
  supervision: Supervision;
}): AgentsRunResult {
  const costUsd = pricedCost(args.end);
  return {
    agent: args.input.agent.qualifiedName,
    model: args.input.model,
    status: statusOf(args.supervision, args.end),
    output: args.content,
    deniedAsks: args.deniedAsks,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Run one task in a guarded, unattended nested session and map it to the run's result.
 *
 * No interaction chain is attached, so the run answers every answerable ask itself and records
 * it (US-004). Its own `--timeout` timer and the caller's signal both abort the nested session,
 * and each outranks whatever the turn then reported. A rejected `runSubagent` is not caught
 * here: it is a failure before a result exists, so it propagates unchanged for the command to
 * report as a usage/config error (exit 2).
 */
export async function runAgentTask(
  input: AgentsRunTaskInput,
  deps: typeof _agentsRunExecDeps = _agentsRunExecDeps,
): Promise<AgentsRunResult> {
  let end: TurnEndEvent | undefined;
  const deniedAsks: DeniedAsk[] = [];
  const asks = askAnswerer(deniedAsks);
  const supervision = superviseRun(input, deps);
  try {
    const { content } = await deps.runSubagent({
      agent: input.agent,
      task: input.task,
      mode: "guarded",
      model: input.model,
      ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
      toolProviders: input.toolProviders,
      loopHandlers: input.loopHandlers,
      cwd: input.cwd,
      repoRoot: input.repoRoot,
      config: input.config,
      parentSessionId: AGENTS_RUN_PARENT_SESSION_ID,
      unattended: true,
      signal: supervision.controller.signal,
      // `runSubagent` calls this before the turn's first event, so every ask lands on a session.
      onSession: asks.onSession,
      // `turn_end` is always the last event of a turn, so the last one seen is the terminal one.
      onEvent: (event) => {
        if (event.type === "turn_end") end = event;
        else if (isAsk(event) && event.answerable !== false) asks.onAsk(event);
      },
    });
    return resultOf({ input, end, content, deniedAsks, supervision });
  } finally {
    supervision.dispose();
  }
}

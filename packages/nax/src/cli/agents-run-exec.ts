/**
 * US-003: run one agent task and derive the run's terminal status, output and priced cost.
 *
 * The command gives the agent a guarded, unattended nested session and no resume: every run
 * opens a fresh memory-only session through `runSubagent` and closes it after one turn. The
 * status follows the turn's own `turn_end` — `timed_out` reports as `timeout`, `errored` and
 * `interrupted` as `failed` — and a run whose turn never ended (a refused profile, or a session
 * that failed to open) is `failed`. Cost is reported only when the turn was priced: an unpriced
 * turn, and a run that never reached a turn, omit it rather than claim zero.
 *
 * US-004 adds the `--timeout` timer, the ask answers and the SIGINT/SIGTERM rules on top of this
 * seam; those take precedence over the mapping below.
 */
import type { LoopHandlerSet, SessionEvent, ToolProvider, TurnEndStatus } from "@nathapp/nax-agent";
import { runSubagent } from "@/chat";
import type { NaxConfig } from "@/config";
import type { AgentResource } from "@/resources";

/** The parent session every `nax agents run` turn names; there is one run, never a resume. */
export const AGENTS_RUN_PARENT_SESSION_ID = "nax-agents-run";

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

export const _agentsRunExecDeps = { runSubagent };

type TurnEndEvent = Extract<SessionEvent, { type: "turn_end" }>;

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
 * The turn's own spend, or undefined when it is not a real cost. An unpriced `turn_end` carries
 * `costUsd: 0` as a placeholder, so reporting it would claim a free turn.
 */
function pricedCost(end: TurnEndEvent | undefined): number | undefined {
  if (end === undefined || end.costSource === "unpriced") return undefined;
  return end.costUsd;
}

/** The result the command reports, with `costUsd` left out rather than set to an unknown 0. */
function resultOf(input: AgentsRunTaskInput, end: TurnEndEvent | undefined, content: string): AgentsRunResult {
  const costUsd = pricedCost(end);
  return {
    agent: input.agent.qualifiedName,
    model: input.model,
    status: end === undefined ? STATUS_WITHOUT_TURN_END : STATUS_OF_TURN_END[end.status],
    output: content,
    deniedAsks: [],
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Run one task in a guarded, unattended nested session and map it to the run's result.
 *
 * A rejected `runSubagent` is not caught here: it is a failure before a result exists, so it
 * propagates unchanged for the command to report as a usage/config error (exit 2).
 */
export async function runAgentTask(
  input: AgentsRunTaskInput,
  deps: typeof _agentsRunExecDeps = _agentsRunExecDeps,
): Promise<AgentsRunResult> {
  let end: TurnEndEvent | undefined;
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
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    // US-004 answers asks on this session; until it does, the hook only carries it.
    onSession: () => undefined,
    // `turn_end` is always the last event of a turn, so the last one seen is the terminal one.
    onEvent: (event) => {
      if (event.type === "turn_end") end = event;
    },
  });
  return resultOf(input, end, content);
}

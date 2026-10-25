/**
 * Host-side state for running nested subagent sessions (chat-subagents US-009).
 *
 * Resolves each run's model and tools, starts the nested session and routes its asks
 * to the chat's ask controller while remembering which nested session owns each request,
 * so the host can answer on the right session. It also attributes nested usage to the
 * chat ledger, accumulates nested spend and forwards nested tool activity (US-010).
 */
import type { AgentSession, LoopHandlerSet, SessionEvent, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import type { NaxConfig } from "@/config";
import type { AgentResource, ResourceCatalog } from "@/resources";
import type { ChatAskController } from "./ask-controller";
import type { ChatLedger } from "./chat-ledger";
import type { ChatMode } from "./chat-mode";
import { resolveSubagentModel } from "./subagent-model";
import { runSubagent } from "./subagent-session";
import { mapSubagentTools } from "./subagent-tools";

export interface SubagentRunsCurrent {
  readonly sessionId: string;
  readonly mode: ChatMode;
  readonly model: string;
}

export interface SubagentRunsDeps {
  /** The chat session's identity; called only inside `run`, because it throws before a session is open. */
  readonly current: () => SubagentRunsCurrent;
  readonly catalog: ResourceCatalog;
  readonly config: NaxConfig;
  readonly cwd: string;
  readonly repoRoot: string;
  /** The chat resources' providers, never the agents provider. */
  readonly toolProviders: readonly ToolProvider[];
  readonly loopHandlers: LoopHandlerSet;
  readonly asks: Pick<ChatAskController, "handle">;
  /** A getter: the host creates its ledger lazily when the first session opens. */
  readonly ledger: () => ChatLedger | undefined;
  /** The running send's `onEvent`, or undefined between sends. */
  readonly turnListener: () => ((event: SessionEvent) => void) | undefined;
}

export interface SubagentRuns {
  /** Run one agent task for the chat session; wires asks, usage, cost and tool events. */
  run(agent: AgentResource, task: string, signal?: AbortSignal): Promise<ToolResult>;
  /** The nested session that issued this request id, if one is still running. */
  sessionFor(requestId: string): AgentSession | undefined;
  /** Spend of nested turns since the last call; resets to 0. */
  takeCost(): number;
  cancelAll(): void;
  closeAll(): Promise<void>;
}

/** The ask text a person sees names the agent that is asking. */
function attributed(event: SessionEvent, agent: AgentResource): SessionEvent {
  const prefix = `[agent ${agent.qualifiedName}] `;
  if (event.type === "approval_requested") return { ...event, reason: `${prefix}${event.reason}` };
  if (event.type === "question") return { ...event, text: `${prefix}${event.text}` };
  return event;
}

/** Per-invocation timing: the nested turn's start, then the previous usage's time. */
interface NestedUsage {
  previousAt?: string;
}

export function createSubagentRuns(deps: SubagentRunsDeps): SubagentRuns {
  const owners = new Map<string, AgentSession>();
  const active = new Set<AgentSession>();
  let spentUsd = 0;

  function release(session: AgentSession): void {
    active.delete(session);
    for (const [requestId, owner] of [...owners]) {
      if (owner !== session) continue;
      owners.delete(requestId);
      // A timed-out or cancelled native ask emits no resolution; without this the ask
      // would stay pending and its answer would fall through to the chat session.
      deps.asks.handle({
        type: "approval_resolved",
        sessionId: session.id,
        turnId: "",
        at: new Date().toISOString(),
        metadata: {},
        requestId,
        decision: "deny",
        decidedBy: "cancelled",
      });
    }
  }

  function routeAsk(event: SessionEvent, session: AgentSession, agent: AgentResource): void {
    if (event.type === "approval_resolved") {
      owners.delete(event.requestId);
      deps.asks.handle(event);
      return;
    }
    if (event.type !== "approval_requested" && event.type !== "question") return;
    // Register before handling: full mode answers synchronously inside `handle`.
    if (event.answerable !== false) owners.set(event.requestId, session);
    deps.asks.handle(attributed(event, agent));
  }

  /** Usage rows and spend; only tool activity is shown in the chat transcript. */
  function routeActivity(event: SessionEvent, nested: NestedUsage, current: SubagentRunsCurrent, model: string): void {
    if (event.type === "turn_start") nested.previousAt = event.at;
    else if (event.type === "usage") {
      deps
        .ledger()
        ?.record({ ...event, sessionId: current.sessionId }, nested.previousAt ?? event.at, model, "subagent");
      nested.previousAt = event.at;
    } else if (event.type === "turn_end") spentUsd += event.costUsd;
    else if (event.type === "tool_call" || event.type === "tool_result") deps.turnListener()?.(event);
  }

  async function run(agent: AgentResource, task: string, signal?: AbortSignal): Promise<ToolResult> {
    const current = deps.current();
    const { model } = resolveSubagentModel({
      ...(agent.model !== undefined ? { requested: agent.model } : {}),
      parentModel: current.model,
      aliases: deps.config.agent?.modelAliases ?? {},
      tiers: deps.config.models.native,
    });
    const { allowedTools } = mapSubagentTools(agent.tools);
    let nested: AgentSession | undefined;
    const usage: NestedUsage = {};
    try {
      return await runSubagent({
        agent,
        task,
        mode: current.mode,
        model,
        ...(allowedTools !== undefined ? { allowedTools } : {}),
        toolProviders: deps.toolProviders,
        loopHandlers: deps.loopHandlers,
        cwd: deps.cwd,
        repoRoot: deps.repoRoot,
        config: deps.config,
        parentSessionId: current.sessionId,
        ...(signal !== undefined ? { signal } : {}),
        onSession: (session) => {
          nested = session;
          active.add(session);
        },
        onEvent: (event) => {
          routeActivity(event, usage, current, model);
          if (nested !== undefined) routeAsk(event, nested, agent);
        },
      });
    } finally {
      if (nested !== undefined) release(nested);
    }
  }

  return {
    run,
    sessionFor: (requestId) => owners.get(requestId),
    takeCost() {
      const taken = spentUsd;
      spentUsd = 0;
      return taken;
    },
    cancelAll() {
      for (const session of active) session.cancel();
    },
    async closeAll() {
      await Promise.all([...active].map((session) => session.close()));
    },
  };
}

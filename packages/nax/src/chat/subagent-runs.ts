/**
 * Host-side state for running nested subagent sessions (chat-subagents US-009).
 *
 * Resolves each run's model and tools, starts the nested session and routes its asks
 * to the chat's ask controller while remembering which nested session owns each request,
 * so the host can answer on the right session.
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

export function createSubagentRuns(deps: SubagentRunsDeps): SubagentRuns {
  const owners = new Map<string, AgentSession>();
  const active = new Set<AgentSession>();

  function release(session: AgentSession): void {
    active.delete(session);
    for (const [requestId, owner] of owners) if (owner === session) owners.delete(requestId);
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
    // Usage and cost forwarding arrive with US-010; nothing accrues yet.
    takeCost: () => 0,
    cancelAll() {
      for (const session of active) session.cancel();
    },
    async closeAll() {
      await Promise.all([...active].map((session) => session.close()));
    },
  };
}

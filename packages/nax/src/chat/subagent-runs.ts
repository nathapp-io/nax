/**
 * Host-side state for running nested subagent sessions (chat-subagents US-009).
 *
 * Resolves each run's model and tools, starts the nested session and routes its asks
 * to the chat's ask controller while remembering which nested session owns each request,
 * so the host can answer on the right session. It also attributes nested usage to the
 * chat ledger, accumulates nested spend and forwards nested tool activity (US-010).
 *
 * A run started with `runInBackground` is deliberately outside that lifecycle (US-007): it
 * is adopted as a chat task, kept out of the turn's own set, and its tool calls go to its
 * task log instead of the transcript, so only stopping the task ends it. Its spend is kept
 * in its own accumulator, because it belongs to no turn: it waits for a metadata write to
 * carry it, and survives a send that throws and a write that is still in flight.
 */
import type { AgentSession, LoopHandlerSet, SessionEvent, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "@/config";
import type { AgentResource, ResourceCatalog } from "@/resources";
import type { ChatAskController } from "./ask-controller";
import type { BackgroundAgentEnd, BackgroundAgentHandle, BackgroundAgentSink, ChatBackgroundTasks } from "./background";
import { agentNamed, generalAgent } from "./builtin-agent";
import type { ChatLedger } from "./chat-ledger";
import type { ChatMode } from "./chat-mode";
import {
  resolveSubagentModel,
  type SubagentModelLabel,
  type SubagentModelSource,
  subagentModelLabel,
} from "./subagent-model";
import { runSubagent } from "./subagent-session";
import { mapSubagentTools } from "./subagent-tools";

export const _subagentRunsDeps = { runSubagent };

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
  /** The parent session's rendered memory index; read per run, so a subagent sees the open's snapshot. */
  readonly memoryIndex?: () => string | undefined;
  /** The chat's background task registry, read per call; undefined when the chat has none. */
  readonly backgroundTasks?: () => ChatBackgroundTasks | undefined;
}

export interface SubagentRuns {
  /** Run one agent task for the chat session; wires asks, usage, cost and tool events. */
  run(agent: AgentResource, task: string, signal?: AbortSignal, model?: string): Promise<ToolResult>;
  /**
   * Start `agent` in the background and return at once with the task it was adopted as.
   *
   * The run outlives the turn that started it: it is kept out of `inFlight`, so neither
   * `cancelAll` nor `settle` (turn end, Esc) reaches it. Its tool calls are written to its
   * task log rather than the transcript, and its spend joins the chat's nested spend on the
   * next turn's cost row. Stopping the task, or closing the chat, ends it.
   */
  runInBackground(agent: AgentResource, task: string, model?: string): Promise<ToolResult>;
  /**
   * The model `run` would use for this agent and override, with the label naming where
   * it came from, or undefined for an unknown agent or a refused override. Opens no
   * session. An absent `agentName` is the built-in general agent, never a catalog lookup;
   * `general` is that agent too, unless the catalog has an agent of that name.
   */
  modelFor(agentName: string | undefined, override?: string): { model: string; label: SubagentModelLabel } | undefined;
  /** The nested session that issued this request id, if one is still running. */
  sessionFor(requestId: string): AgentSession | undefined;
  /**
   * Spend of *foreground* nested turns since the last call; resets to 0. Background spend
   * never appears here: it belongs to no turn, and a send that threw must not discard it.
   */
  takeCost(): number;
  /**
   * What a turn's metadata write should carry: this turn's foreground nested spend (taken
   * now) plus every background spend no write has carried yet. The background part is only
   * a snapshot — {@link SubagentRuns.commitCost} retires exactly that much once the write
   * resolved, so spend that landed mid-write stays pending for the next one.
   */
  costForTurn(): number;
  /** Retire the background spend `costForTurn` reported; call only after its write persisted. */
  commitCost(): void;
  cancelAll(): void;
  /**
   * Cancel every run still in flight, including one whose session is still opening, and
   * resolve once each has closed its session. A tool batch may abandon a run on abort, so
   * the parent send waits here before it releases its listener and spend accounting.
   */
  settle(): Promise<void>;
  /**
   * Close every session a run still owns — a stopped background run's included, which stays
   * owned until its own turn ends — and abort a background run that has not opened one yet,
   * so nothing opens a session after the chat's resources are gone. A run aborted mid-open is
   * then drained: it owes the chat the cleanup its own open had already started.
   */
  closeAll(): Promise<void>;
}

/**
 * The spend hooks `runChatTurn` needs, in one place: the host passes the runs it built, or
 * nothing. Kept here rather than open-coded at the host's call site, which sits at its own
 * file-size cap, and so the two halves (take, then commit) stay one decision.
 */
export function turnSpendHooks(runs: SubagentRuns | undefined): {
  readonly extraCostUsd?: () => number;
  readonly commitExtraCost?: () => void;
  readonly settleNested?: () => Promise<void>;
} {
  if (runs === undefined) return {};
  return {
    extraCostUsd: () => runs.costForTurn(),
    commitExtraCost: () => runs.commitCost(),
    settleNested: () => runs.settle(),
  };
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

/**
 * Tag forwarded tool activity with the agent and task that produced it (US-003),
 * merged over the event's own metadata so nothing the nested session set is lost.
 * Non-activity events pass through untouched; the turn listener only ever
 * receives `tool_call` and `tool_result` today, and a future addition would be
 * forwarded without a task tag rather than mislabelled as one.
 */
function taggedActivity(event: SessionEvent, agent: AgentResource, task: string): SessionEvent {
  if (event.type !== "tool_call" && event.type !== "tool_result") return event;
  return { ...event, metadata: { ...event.metadata, subagent: agent.qualifiedName, subagentTask: task } };
}

/**
 * An override that resolved to the parent model is refused: it named a model no alias,
 * tier or provider-qualified id answers for, and silently inheriting would hide the typo.
 */
function refused(override: string | undefined, source: SubagentModelSource): boolean {
  return override !== undefined && source === "fallback";
}

/** The refusal `run` and `runInBackground` both return for an override nothing answers for. */
function unknownModelRefusal(override: string | undefined): ToolResult {
  return {
    isError: true,
    content: `[chat] unknown model ${override}; pass provider/model (a nax native model such as openai-codex/gpt-6-luna), acp:<agent>, or a configured alias`,
  };
}

/** The refusal a chat whose composition carries no background registry answers with. */
function noBackgroundRuns(): ToolResult {
  return { isError: true, content: "[chat] runInBackground is not available in this chat" };
}

/** One nested run's abort handle and the session it opened, if it has opened one yet. */
interface RunEntry {
  readonly controller: AbortController;
  session?: AgentSession;
}

/** What one nested run was started with, beyond the agent and task. */
interface NestedTarget {
  readonly entry: RunEntry;
  readonly override?: string;
  /** Set for a background run: its tool calls go to the task log, never the transcript. */
  readonly background?: BackgroundAgentSink;
}

/** Where one nested run's usage, spend and tool activity go. */
interface ActivityRouting {
  readonly current: SubagentRunsCurrent;
  readonly model: string;
  /** The parent turn's listener; absent for a background run. */
  readonly forward?: (event: SessionEvent) => void;
  /** A background run's log: each `tool_call` appends one line. */
  readonly onToolCall?: (name: string) => void;
  /** Set for a background run: its spend joins the pending pool, never the turn's. */
  readonly background?: boolean;
}

/** A finished background run's end state: an error result and a plain one differ in the outcome alone. */
function endOf(result: ToolResult): BackgroundAgentEnd {
  return { outcome: result.isError === true ? "failed" : "succeeded", text: result.content };
}

export function createSubagentRuns(deps: SubagentRunsDeps): SubagentRuns {
  const owners = new Map<string, AgentSession>();
  const active = new Set<AgentSession>();
  /** Every foreground run in flight, from before its session opens until it has closed it. */
  const inFlight = new Map<Promise<unknown>, RunEntry>();
  /** Every background run in flight: not the turn's to cancel, but the chat's to tear down. */
  const background = new Map<Promise<unknown>, RunEntry>();
  /** This turn's foreground nested spend, dropped when a send ends without persisting it. */
  let spentUsd = 0;
  /** Background spend no metadata write has carried yet; it outlives every turn. */
  let pendingBackgroundUsd = 0;
  /** The background spend `costForTurn` reported, retired only once its write persisted. */
  let accountedUsd = 0;

  function resolveFor(agent: AgentResource, current: SubagentRunsCurrent, override?: string) {
    const requested = override ?? agent.model;
    return resolveSubagentModel({
      ...(requested !== undefined ? { requested } : {}),
      parentModel: current.model,
      aliases: deps.config.agent?.modelAliases ?? {},
      tiers: deps.config.models.native,
    });
  }

  /**
   * Deny every ask `session` still owns, now: a stopped or finished run must not leave a
   * pending ask that only the approval timeout would answer. The session itself stays owned
   * — `release` is what gives up its lifecycle.
   */
  function releaseAsks(session: AgentSession): void {
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

  /** The run is over: its session is no longer the chat's to close, and its asks are answered. */
  function release(session: AgentSession): void {
    active.delete(session);
    releaseAsks(session);
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

  /** Usage rows and spend; tool activity is shown to the parent turn or written to a task log. */
  function routeActivity(event: SessionEvent, nested: NestedUsage, routing: ActivityRouting): void {
    if (event.type === "turn_start") nested.previousAt = event.at;
    else if (event.type === "usage") {
      deps
        .ledger()
        ?.record(
          { ...event, sessionId: routing.current.sessionId },
          nested.previousAt ?? event.at,
          routing.model,
          "subagent",
        );
      nested.previousAt = event.at;
    } else if (event.type === "turn_end") {
      // Background spend waits for a metadata write; foreground spend belongs to this turn.
      if (routing.background === true) pendingBackgroundUsd += event.costUsd;
      else spentUsd += event.costUsd;
    } else if (event.type === "tool_call") {
      routing.onToolCall?.(event.name);
      routing.forward?.(event);
    } else if (event.type === "tool_result") routing.forward?.(event);
  }

  /** Run under a controller the host can abort, linked to the tool's own signal. */
  function run(agent: AgentResource, task: string, signal?: AbortSignal, model?: string): Promise<ToolResult> {
    const entry: RunEntry = { controller: new AbortController() };
    const onParentAbort = () => entry.controller.abort();
    if (signal?.aborted) onParentAbort();
    else signal?.addEventListener("abort", onParentAbort, { once: true });
    const promise = runNested(agent, task, { entry, ...(model !== undefined ? { override: model } : {}) }).finally(
      () => {
        signal?.removeEventListener("abort", onParentAbort);
        inFlight.delete(promise);
      },
    );
    inFlight.set(promise, entry);
    return promise;
  }

  async function runNested(agent: AgentResource, task: string, target: NestedTarget): Promise<ToolResult> {
    const { entry, override, background } = target;
    const current = deps.current();
    // Late nested tool events belong to the send that started this run, never a later one.
    // A background run has no turn to belong to: its activity is its task log alone.
    const listener = background === undefined ? deps.turnListener() : undefined;
    const forward =
      listener === undefined ? undefined : (event: SessionEvent) => listener(taggedActivity(event, agent, task));
    const { model, source } = resolveFor(agent, current, override);
    if (refused(override, source)) return unknownModelRefusal(override);
    const routing: ActivityRouting = {
      current,
      model,
      ...(forward !== undefined ? { forward } : {}),
      ...(background !== undefined
        ? { background: true, onToolCall: (name: string) => background.appendLine(`[tool] ${name}`) }
        : {}),
    };
    const { allowedTools } = mapSubagentTools(agent.tools);
    const memoryIndex = deps.memoryIndex?.();
    let nested: AgentSession | undefined;
    const usage: NestedUsage = {};
    try {
      return await _subagentRunsDeps.runSubagent({
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
        signal: entry.controller.signal,
        ...(memoryIndex !== undefined ? { memoryIndex } : {}),
        onSession: (session) => {
          nested = session;
          entry.session = session;
          active.add(session);
        },
        onEvent: (event) => {
          routeActivity(event, usage, routing);
          if (nested !== undefined) routeAsk(event, nested, agent);
        },
      });
    } finally {
      if (nested !== undefined) {
        release(nested);
        // A run that has closed its session is no longer stop()'s to cancel in the background.
        if (entry.session === nested) entry.session = undefined;
      }
    }
  }

  /**
   * Start a run that outlives the turn that started it and adopt it as a chat task.
   *
   * The run is deliberately absent from `inFlight`: nothing the parent turn does — ending,
   * Esc, its tool batch being abandoned — may cancel it. Its own controller is linked to no
   * parent signal, and it ends only when it finishes or its task (or the chat) is stopped.
   * `ended` always resolves: an error result and a thrown error are both failures, and a
   * stop wins over whatever the run does afterwards. The promise itself is tracked in
   * `background` until `runNested` has released its session, so the chat can still reach a
   * run whose task already reported itself stopped.
   */
  async function runInBackground(agent: AgentResource, task: string, model?: string): Promise<ToolResult> {
    const tasks = deps.backgroundTasks?.();
    if (tasks === undefined) return noBackgroundRuns();
    const { source } = resolveFor(agent, deps.current(), model);
    if (refused(model, source)) return unknownModelRefusal(model);
    const entry: RunEntry = { controller: new AbortController() };
    const ended = Promise.withResolvers<BackgroundAgentEnd>();
    let stopped = false;
    const handle: BackgroundAgentHandle = {
      agent: agent.qualifiedName,
      task,
      ended: ended.promise,
      stop() {
        if (stopped) return;
        stopped = true;
        ended.resolve({ outcome: "stopped", text: "" });
        // Before the session opens its signal is the only handle on the run; after, the
        // session's own cancel ends the turn so its transport can close. Only the asks are
        // released here: the session stays owned until its turn really ends, so closeAll
        // still closes it rather than tearing the chat's resources down beneath it.
        if (entry.session === undefined) entry.controller.abort();
        else {
          entry.session.cancel();
          releaseAsks(entry.session);
        }
      },
    };
    const sink = tasks.adoptAgent(handle);
    const promise = runNested(agent, task, {
      entry,
      background: sink,
      ...(model !== undefined ? { override: model } : {}),
    }).then(
      (result) => ended.resolve(endOf(result)),
      (cause: unknown) => ended.resolve({ outcome: "failed", text: errorMessage(cause) }),
    );
    background.set(promise, entry);
    void promise.then(() => background.delete(promise));
    return { isError: false, content: `started in the background as ${sink.id}` };
  }

  const runs: SubagentRuns = {
    run,
    runInBackground,
    modelFor(agentName, override) {
      // An absent name is the general agent: a call with no agent has no agent file, and
      // `general` resolves to the built-in one unless the catalog has an agent of that name.
      const agent = agentName === undefined ? generalAgent() : agentNamed(deps.catalog, agentName);
      if (agent === undefined) return undefined;
      const { model, source } = resolveFor(agent, deps.current(), override);
      if (refused(override, source)) return undefined;
      return { model, label: subagentModelLabel(source, override !== undefined) };
    },
    sessionFor: (requestId) => owners.get(requestId),
    takeCost() {
      const taken = spentUsd;
      spentUsd = 0;
      return taken;
    },
    costForTurn() {
      // Snapshot the background share before handing the total over: a run that finishes
      // while the write is in flight then stays pending for the next turn, instead of being
      // retired as if this write had carried it.
      accountedUsd = pendingBackgroundUsd;
      return runs.takeCost() + accountedUsd;
    },
    commitCost() {
      pendingBackgroundUsd -= accountedUsd;
      accountedUsd = 0;
    },
    cancelAll() {
      for (const { controller, session } of inFlight.values()) {
        // A run whose session is not open yet is cancelled through its signal; one with a
        // session is cancelled on the session, whose turn then ends `cancelled`.
        if (session === undefined) controller.abort();
        else session.cancel();
      }
    },
    async settle() {
      runs.cancelAll();
      await Promise.allSettled([...inFlight.keys()]);
    },
    async closeAll() {
      // A run still opening has no session to close, and must not open one once the chat's
      // resources are gone: its signal is the only handle on it.
      const opening: Promise<unknown>[] = [];
      for (const [promise, entry] of background) {
        if (entry.session !== undefined) continue;
        entry.controller.abort();
        opening.push(promise);
      }
      // The abort is only the reach: the run still has to unwind what its open had already
      // started — a backend, a transport, an in-flight session creation — and that cleanup
      // outlives the abort. The chat releases its shared resources once this returns, so the
      // run's own cleanup is drained first. A run with a session is not waited on: its turn
      // ends through `session.close()` below, and its cleanup belongs to that path.
      await Promise.allSettled(opening);
      await Promise.all([...active].map((session) => session.close()));
    },
  };
  return runs;
}

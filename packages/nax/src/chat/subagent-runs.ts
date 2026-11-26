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
import type { ChatHostState } from "./chat-host-types";
import type { ChatLedger } from "./chat-ledger";
import type { ChatMode } from "./chat-mode";
import {
  resolveSubagentModel,
  type SubagentModelLabel,
  type SubagentModelSource,
  subagentModelLabel,
} from "./subagent-model";
import {
  deliverActivity,
  foregroundRoute,
  moveRouteToTask,
  type RunRoute,
  taskRoute,
  untrackedRoute,
} from "./subagent-route";
import { runSubagent } from "./subagent-session";
import { createNestedSpend } from "./subagent-spend";
import { mapSubagentTools } from "./subagent-tools";

export const _subagentRunsDeps = { runSubagent };

export interface SubagentRunsCurrent {
  readonly webGuard?: ChatHostState["webGuard"];
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
  /**
   * Run one agent task for the chat session; wires asks, usage, cost and tool events. While it
   * runs in the foreground, the chat's `ctrl+b` moves it to the background: the call then
   * returns at once with the task it was adopted as, and the run keeps going under the registry.
   */
  run(agent: AgentResource, task: string, signal?: AbortSignal, model?: string): Promise<ToolResult>;
  /** True when `runInBackground` can adopt a run now: the chat has a background task registry. */
  backgroundAvailable(): boolean;
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
  /** Begin a parent turn, making spend from earlier turns' background runs eligible. */
  beginTurn(): void;
  /**
   * What a turn's metadata write should carry: this turn's foreground nested spend (taken
   * now) plus unpersisted background spend from runs started before this turn. The background
   * part is only a snapshot — {@link SubagentRuns.commitCost} retires exactly that much once
   * the write resolved, so spend that landed mid-write stays pending for the next one.
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
  readonly beginNestedTurn?: () => void;
  readonly extraCostUsd?: () => number;
  readonly commitExtraCost?: () => void;
  readonly settleNested?: () => Promise<void>;
} {
  if (runs === undefined) return {};
  return {
    beginNestedTurn: () => runs.beginTurn(),
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
  /** Set when the host cancelled the run through its open session; a cancelled run is never moved. */
  cancelled?: boolean;
}

/** What one nested run was started with, beyond the agent and task. */
interface NestedTarget {
  readonly entry: RunEntry;
  readonly override?: string;
  /** Where the run's events go; a background run (or one moved to the background) records on its task. */
  readonly route: RunRoute;
}

/** Where one nested run's usage, spend and tool activity go. */
interface ActivityRouting {
  readonly current: SubagentRunsCurrent;
  readonly model: string;
  /** The parent turn's listener; absent for a run that started in the background. */
  readonly forward?: (event: SessionEvent) => void;
  readonly route: RunRoute;
}

/** A finished background run's end state: an error result and a plain one differ in the outcome alone. */
function endOf(result: ToolResult): BackgroundAgentEnd {
  return { outcome: result.isError === true ? "failed" : "succeeded", text: result.content };
}

/** What `withMoveToBackground` needs to hand a running foreground call to the registry. */
interface MovableRun {
  readonly tasks: ChatBackgroundTasks;
  readonly agent: AgentResource;
  readonly task: string;
  readonly model: string | undefined;
  readonly entry: RunEntry;
  readonly route: RunRoute;
  readonly promise: Promise<ToolResult>;
  /** Cut the run's ties to the parent turn: its abort link and its `inFlight` slot. */
  readonly detach: () => void;
}

/** What a run is adopted as a task with. */
interface AdoptInput {
  readonly agent: AgentResource;
  readonly task: string;
  readonly model: string;
  readonly entry: RunEntry;
}

interface AdoptedRun {
  readonly sink: BackgroundAgentSink;
  /** Settle the task from the run's outcome, and keep the run reachable by `closeAll`. */
  track(run: Promise<ToolResult>): void;
}

export function createSubagentRuns(deps: SubagentRunsDeps): SubagentRuns {
  const owners = new Map<string, AgentSession>();
  const active = new Set<AgentSession>();
  /** Every foreground run in flight, from before its session opens until it has closed it. */
  const inFlight = new Map<Promise<unknown>, RunEntry>();
  /** Every background run in flight: not the turn's to cancel, but the chat's to tear down. */
  const background = new Map<Promise<unknown>, RunEntry>();
  const spend = createNestedSpend();

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
      // A run that belongs to a task cannot charge its starting turn, regardless of when it finishes.
      const { backgroundTurn, sink } = routing.route;
      if (sink === undefined || backgroundTurn === undefined) spend.chargeForeground(event.costUsd);
      else spend.chargeBackground(backgroundTurn, event.costUsd);
    }
    deliverActivity(event, routing.route, routing.forward);
  }

  /**
   * Run under a controller the host can abort, linked to the tool's own signal. With a
   * background registry the run is also offered to `ctrl+b`: moving it detaches it from the
   * parent turn and returns the tool call at once, with the run still going as a task.
   */
  function run(agent: AgentResource, task: string, signal?: AbortSignal, model?: string): Promise<ToolResult> {
    const entry: RunEntry = { controller: new AbortController() };
    const tasks = deps.backgroundTasks?.();
    // Only a run a registry can adopt needs the event log its move would replay.
    const route = tasks === undefined ? untrackedRoute() : foregroundRoute();
    const onParentAbort = () => entry.controller.abort();
    if (signal?.aborted) onParentAbort();
    else signal?.addEventListener("abort", onParentAbort, { once: true });
    const target: NestedTarget = { entry, route, ...(model !== undefined ? { override: model } : {}) };
    const promise = runNested(agent, task, target).finally(() => {
      signal?.removeEventListener("abort", onParentAbort);
      inFlight.delete(promise);
    });
    inFlight.set(promise, entry);
    if (tasks === undefined) return promise;
    const detach = () => {
      // A moved run is no longer the parent turn's: its signal and `settle` must not reach it.
      signal?.removeEventListener("abort", onParentAbort);
      inFlight.delete(promise);
    };
    return withMoveToBackground({ tasks, agent, task, model, entry, route, promise, detach });
  }

  /** Offer a running foreground run to `ctrl+b`; resolves with the run's result, or with the move's. */
  function withMoveToBackground(input: MovableRun): Promise<ToolResult> {
    const { tasks, agent, task, entry, route, promise } = input;
    const released = Promise.withResolvers<ToolResult>();
    let settled = false;
    let moved = false;
    let unregister: () => void = () => {};
    unregister = tasks.foreground({
      command: `${agent.qualifiedName}: ${task.split(/\r?\n/)[0] ?? ""}`,
      moveToBackground() {
        // A run already cancelled is ending: reporting it as moved would hand the model a task
        // that is about to be reported stopped.
        if (settled || moved || entry.cancelled === true || entry.controller.signal.aborted) return;
        moved = true;
        unregister();
        input.detach();
        const model = resolveFor(agent, deps.current(), input.model).model;
        const adopted = adoptRun(tasks, { agent, task, model, entry });
        moveRouteToTask(route, adopted.sink, spend.turn());
        adopted.track(promise);
        released.resolve({ isError: false, content: `moved to the background as ${adopted.sink.id}` });
      },
    });
    const done = promise.finally(() => {
      settled = true;
      unregister();
    });
    return Promise.race([done, released.promise]);
  }

  async function runNested(agent: AgentResource, task: string, target: NestedTarget): Promise<ToolResult> {
    const { entry, override, route } = target;
    const current = deps.current();
    // Late nested tool events belong to the send that started this run, never a later one.
    // A run that started in the background has no turn to belong to: its activity is its task alone.
    const listener = route.sink === undefined ? deps.turnListener() : undefined;
    const forward =
      listener === undefined ? undefined : (event: SessionEvent) => listener(taggedActivity(event, agent, task));
    const { model, source } = resolveFor(agent, current, override);
    if (refused(override, source)) return unknownModelRefusal(override);
    const routing: ActivityRouting = { current, model, route, ...(forward !== undefined ? { forward } : {}) };
    const { allowedTools } = mapSubagentTools(agent.tools);
    const memoryIndex = deps.memoryIndex?.();
    let nested: AgentSession | undefined;
    const usage: NestedUsage = {};
    try {
      return await _subagentRunsDeps.runSubagent({
        agent,
        task,
        mode: current.mode,
        ...(current.webGuard ? { webExposure: current.webGuard } : {}),
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
   * Adopt a run as a chat task and return its sink plus the tracker that settles the task.
   *
   * `ended` always resolves: an error result and a thrown error are both failures, and a stop
   * wins over whatever the run does afterwards. The run's promise is tracked in `background`
   * until `runNested` has released its session, so the chat can still reach a run whose task
   * already reported itself stopped.
   */
  function adoptRun(tasks: ChatBackgroundTasks, input: AdoptInput): AdoptedRun {
    const { agent, task, model, entry } = input;
    const ended = Promise.withResolvers<BackgroundAgentEnd>();
    let stopped = false;
    const handle: BackgroundAgentHandle = {
      agent: agent.qualifiedName,
      task,
      model,
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
    return {
      sink,
      track(run) {
        const promise = run.then(
          (result) => ended.resolve(endOf(result)),
          (cause: unknown) => ended.resolve({ outcome: "failed", text: errorMessage(cause) }),
        );
        background.set(promise, entry);
        void promise.then(() => background.delete(promise));
      },
    };
  }

  /**
   * Start a run that outlives the turn that started it and adopt it as a chat task.
   *
   * The run is deliberately absent from `inFlight`: nothing the parent turn does — ending,
   * Esc, its tool batch being abandoned — may cancel it. Its own controller is linked to no
   * parent signal, and it ends only when it finishes or its task (or the chat) is stopped.
   */
  async function runInBackground(agent: AgentResource, task: string, model?: string): Promise<ToolResult> {
    const tasks = deps.backgroundTasks?.();
    if (tasks === undefined) return noBackgroundRuns();
    const resolved = resolveFor(agent, deps.current(), model);
    if (refused(model, resolved.source)) return unknownModelRefusal(model);
    const entry: RunEntry = { controller: new AbortController() };
    const adopted = adoptRun(tasks, { agent, task, model: resolved.model, entry });
    const route = taskRoute(adopted.sink, spend.turn());
    adopted.track(runNested(agent, task, { entry, route, ...(model !== undefined ? { override: model } : {}) }));
    return { isError: false, content: `started in the background as ${adopted.sink.id}` };
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
    takeCost: spend.takeCost,
    beginTurn: spend.beginTurn,
    costForTurn: spend.costForTurn,
    commitCost: spend.commitCost,
    backgroundAvailable: () => deps.backgroundTasks?.() !== undefined,
    cancelAll() {
      for (const entry of inFlight.values()) {
        // A run whose session is not open yet is cancelled through its signal; one with a
        // session is cancelled on the session, whose turn then ends `cancelled`.
        entry.cancelled = true;
        if (entry.session === undefined) entry.controller.abort();
        else entry.session.cancel();
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

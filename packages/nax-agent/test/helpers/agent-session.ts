/**
 * Shared harness for the agent session facade tests: a scripted streaming
 * provider behind _clientDeps.build, manual timers on _agentSessionDeps, and
 * readers over a send()'s events. Imported by path, not through the helpers
 * barrel, which nearly every suite loads.
 */
import type { CreateAgentSessionOptions, NativeBackendOptions, SessionBackend, SessionEvent } from "@nathapp/nax-agent";
import type { Client, ClientRequest, ProtocolEvent, ResolvedModel } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { nativeBackend } from "#src/session/native-backend";

export const MODEL = "openai/gpt-5.4-mini";

const RESOLVED: ResolvedModel = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
};

const REAL_BUILD = _clientDeps.build;

export type Round = readonly ProtocolEvent[] | ((req: ClientRequest) => AsyncIterable<ProtocolEvent>);

export interface ScriptedProvider {
  readonly requests: ClientRequest[];
  /** Replies, one per round-trip request, in order. */
  push(...rounds: Round[]): void;
}

export function textRound(text: string): ProtocolEvent[] {
  return [
    { type: "text-delta", text },
    { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } },
    { type: "done", stopReason: "stop" },
  ];
}

export function toolRound(
  calls: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>,
): ProtocolEvent[] {
  return [
    ...calls.map((call): ProtocolEvent => ({ type: "tool-call", call })),
    { type: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
    { type: "done", stopReason: "tool_use" },
  ];
}

/**
 * A round that streams `text`, then fails with a retryable `kind` fault. It
 * sets `retryAfter: 0`, so the loop's retry waits zero ms and tests never sleep.
 */
export function faultRound(text: string, kind: "transport" | "overloaded" = "transport"): Round {
  return async function* fault(): AsyncGenerator<ProtocolEvent> {
    yield { type: "text-delta", text };
    yield { type: "error", error: { kind, message: `scripted ${kind} fault`, retryAfter: 0 } };
  };
}

export function installScriptedProvider(): ScriptedProvider {
  const requests: ClientRequest[] = [];
  let queue: readonly Round[] = [];
  const client: Client = {
    model: async () => RESOLVED,
    listModels: async () => [RESOLVED],
    pricing: () => RESOLVED.pricing,
    stream(_model, req) {
      requests.push(req);
      const [round, ...rest] = queue;
      queue = rest;
      if (round === undefined) throw new Error(`no scripted reply for request ${requests.length}`);
      if (typeof round === "function") return round(req);
      return (async function* replay() {
        yield* round;
      })();
    },
    complete: async () => {
      throw new Error("round trips must stream");
    },
    validate: () => {},
  };
  _resetNativeClient();
  _clientDeps.build = async () => client;
  return {
    requests,
    push: (...rounds) => {
      queue = [...queue, ...rounds];
    },
  };
}

/** Pair with afterEach: restores the preload's client builder and drops the memoised client. */
export function resetScriptedProvider(): void {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
}

export interface ManualTimers {
  /** Fires every pending timer armed with exactly `ms`; returns how many fired. */
  fire(ms: number): number;
  pendingDelays(): number[];
}

/** Replaces the facade's timers. Pair with withDepsRestore(_agentSessionDeps). */
export function installManualTimers(): ManualTimers {
  const pending = new Map<number, { readonly fn: () => void; readonly ms: number }>();
  let nextId = 1;
  _agentSessionDeps.setTimeout = (fn: () => void, ms: number): unknown => {
    const id = nextId++;
    pending.set(id, { fn, ms });
    return id;
  };
  _agentSessionDeps.clearTimeout = (handle: unknown): void => {
    pending.delete(Number(handle));
  };
  return {
    fire(ms) {
      let fired = 0;
      for (const [id, timer] of [...pending]) {
        if (timer.ms !== ms) continue;
        pending.delete(id);
        timer.fn();
        fired += 1;
      }
      return fired;
    },
    pendingDelays: () => [...pending.values()].map((timer) => timer.ms),
  };
}

export type SessionTestOptions = Partial<Omit<CreateAgentSessionOptions, "backend">> &
  Partial<NativeBackendOptions> & { readonly backend?: SessionBackend };

/** Shared options, with native-only keys routed into nativeBackend() (S4: the 0.3.0 options shape). */
export function sessionOptions(extra: SessionTestOptions = {}): CreateAgentSessionOptions {
  const {
    backend,
    model,
    credentials,
    catalogOverrides,
    loopHandlers,
    hostPorts,
    bashApproval,
    allowUnsandboxed,
    ...shared
  } = extra;
  return {
    backend:
      backend ??
      nativeBackend({
        model: model ?? MODEL,
        ...(credentials !== undefined ? { credentials } : {}),
        ...(catalogOverrides !== undefined ? { catalogOverrides } : {}),
        ...(loopHandlers !== undefined ? { loopHandlers } : {}),
        ...(hostPorts !== undefined ? { hostPorts } : {}),
        ...(bashApproval !== undefined ? { bashApproval } : {}),
        ...(allowUnsandboxed !== undefined ? { allowUnsandboxed } : {}),
      }),
    sessionId: shared.sessionId,
    profile: shared.profile ?? "none",
    workdir: shared.workdir,
    instructions: shared.instructions,
    tools: shared.tools,
    transcriptStore: shared.transcriptStore ?? createMemoryTranscriptStore(),
    approvalTimeoutMs: shared.approvalTimeoutMs,
    turnTimeoutSeconds: shared.turnTimeoutSeconds,
    metadata: shared.metadata,
  };
}

export async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

export interface EventReader {
  /** Reads up to and including the first event of `type`. */
  until(type: SessionEvent["type"]): Promise<SessionEvent[]>;
  /** Reads everything that is left. */
  rest(): Promise<SessionEvent[]>;
}

export function reader(iterable: AsyncIterable<SessionEvent>): EventReader {
  const iterator = iterable[Symbol.asyncIterator]();
  return {
    async until(type) {
      const seen: SessionEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          throw new Error(`stream ended before a ${type} event; saw ${seen.map((event) => event.type).join(", ")}`);
        }
        seen.push(next.value);
        if (next.value.type === type) return seen;
      }
    },
    async rest() {
      const out: SessionEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return out;
        out.push(next.value);
      }
    },
  };
}

export function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type);
}

export function eventsOf<T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

export function turnEndOf(events: readonly SessionEvent[]): Extract<SessionEvent, { type: "turn_end" }> {
  const [end] = eventsOf(events, "turn_end");
  if (end === undefined) throw new Error(`no turn_end in ${types(events).join(", ")}`);
  return end;
}

/** Waits (macrotask turns, no sleeping) until `lastTurn` changes from `before`, for at most `timeoutMs` of wall time. */
export async function untilSettled(
  session: { readonly lastTurn: unknown },
  before: unknown,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.lastTurn !== before) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the turn did not settle");
}

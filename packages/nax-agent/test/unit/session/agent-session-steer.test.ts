/**
 * US-001: the facade's per-turn steering (spec "Steering (native)").
 *
 * The facade owns each session's pending steers: `steer()` refuses what it
 * cannot do (closed session, empty text, a backend that is not `steerable`, no
 * TURN claim), and otherwise appends the text to the active turn's channel.
 * The channel is the turn's own: `take()` hands the pending texts to the loop
 * in arrival order and resolves each `applied` `true`; the channel closes when
 * the turn claim settles, resolving everything still pending `false` so a steer
 * never carries into the next `send()`.
 *
 * Driven against stub backends, because what these criteria are about is the
 * facade's bookkeeping — the native loop's injection points are covered by
 * test/integration/session/native-steering.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionAdapter,
  createAgentSession,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SendTurnOpts,
  type SessionBackend,
  type SessionEvent,
  type SteerChannel,
  type SteerResult,
} from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { eventsOf, reader, turnEndOf } from "#test/helpers/agent-session";
import { assertDefined, assertNaxError } from "#test/helpers/index";

const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function openSession(backend: SessionBackend): Promise<AgentSession> {
  const session = await createAgentSession({
    backend,
    profile: "none",
    transcriptStore: createMemoryTranscriptStore(),
  });
  sessions.push(session);
  return session;
}

/** The facade always supplies `steer`; the type keeps it optional for other backends. */
function steer(session: AgentSession): (text: string) => SteerResult {
  assertDefined(session.steer, "steer");
  return session.steer.bind(session);
}

interface SteerStub {
  readonly backend: SessionBackend;
  /** The sendTurn options the backend was handed, one entry per turn. */
  readonly turns: SendTurnOpts[];
  /** What the stub's sendTurn got from `steers.take()`, per turn. */
  readonly taken: (readonly string[])[];
  /** Releases the gated sendTurn and the gated runCommand, ending each `completed`. */
  finish(): void;
}

interface SteerStubOptions {
  /** false: a backend without the capability, the way the ACP backend is. */
  readonly steerable?: boolean;
  /** true: the stub takes the channel inside sendTurn, as the native loop does at a boundary. */
  readonly take?: boolean;
}

function steerStub(options: SteerStubOptions = {}): SteerStub {
  const turns: SendTurnOpts[] = [];
  const taken: (readonly string[])[] = [];
  const gates: (() => void)[] = [];
  let finished = false;
  // A gate opened after finish() must not block: claimCommand dispatches its run
  // on a later microtask, so a test can finish before the gate even exists.
  const gate = (): Promise<void> =>
    finished
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          gates.push(resolve);
        });
  const backend: SessionBackend = {
    kind: "acp:stub",
    async open(): Promise<OpenedBackend> {
      const handle = { id: "h", agentName: "stub" };
      const adapter: AgentSessionAdapter = {
        openSession: async () => handle,
        sendTurn: async (_handle, _prompt, opts) => {
          turns.push(opts);
          taken.push(options.take === true ? (opts.steers?.take() ?? []) : []);
          await gate();
          return {
            output: "done",
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
            estimatedCostUsd: 0,
            internalRoundTrips: 1,
          };
        },
        closeSession: async () => {},
      };
      return {
        adapter,
        handle,
        info: { kind: "acp:stub", capabilities: {} },
        ...(options.steerable === false ? {} : { steerable: true }),
        turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
        runCommand: async () => {
          await gate();
          return { content: "ok", isError: false };
        },
        close: async () => {},
      };
    },
  };
  return {
    backend,
    turns,
    taken,
    finish: () => {
      finished = true;
      for (const release of gates.splice(0)) release();
    },
  };
}

/** The channel a stub turn was handed. */
function channelOf(stub: SteerStub): SteerChannel {
  const opts = stub.turns[0];
  assertDefined(opts, "the turn's sendTurn options");
  assertDefined(opts.steers, "the turn's steers channel");
  return opts.steers;
}

function accepted(result: SteerResult): { readonly steerId: string; readonly applied: Promise<boolean> } {
  if (result.status !== "accepted") throw new Error(`expected an accepted steer, got "${result.status}"`);
  return result;
}

describe("AgentSession.steer: refusals and acceptance", () => {
  test("AC-1: a steer while a turn is in flight is accepted with a non-empty steerId", async () => {
    const stub = steerStub();
    const session = await openSession(stub.backend);
    const stream = reader(session.send("hi"));
    await stream.until("turn_start");
    const result = accepted(steer(session)("also check b.ts"));
    expect(result.steerId).toBeString();
    expect(result.steerId.length).toBeGreaterThan(0);
    stub.finish();
    await stream.rest();
  });

  test("AC-2: with no turn in flight the steer is refused no_turn", async () => {
    const stub = steerStub();
    const session = await openSession(stub.backend);
    expect(steer(session)("x")).toEqual({ status: "no_turn" });
  });

  test("AC-3: a runCommand in flight is not a turn, so the steer is refused no_turn", async () => {
    const stub = steerStub();
    const session = await openSession(stub.backend);
    assertDefined(session.runCommand, "runCommand");
    const command = session.runCommand.bind(session)("echo hi", () => {});
    expect(steer(session)("x")).toEqual({ status: "no_turn" });
    stub.finish();
    await command;
  });

  test("AC-4: a backend that is not steerable answers unsupported, even during a turn", async () => {
    const stub = steerStub({ steerable: false });
    const session = await openSession(stub.backend);
    const stream = reader(session.send("hi"));
    await stream.until("turn_start");
    expect(steer(session)("x")).toEqual({ status: "unsupported" });
    // The channel is not even built for such a backend: the loop is handed none.
    expect(stub.turns[0]?.steers).toBeUndefined();
    stub.finish();
    await stream.rest();
  });

  test.each([["   "], [""]])("AC-5, AC-27: steer(%p) throws AGENT_SESSION_INVALID_OPTIONS", async (text) => {
    const stub = steerStub();
    const session = await openSession(stub.backend);
    let caught: unknown;
    try {
      steer(session)(text);
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
  });

  test("AC-6: steer after close throws AGENT_SESSION_CLOSED", async () => {
    const stub = steerStub();
    const session = await openSession(stub.backend);
    await session.close();
    let caught: unknown;
    try {
      steer(session)("x");
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_CLOSED");
  });
});

describe("AgentSession.steer: the turn's channel", () => {
  test("AC-7, AC-8: take() hands over the pending texts in arrival order and both resolve true", async () => {
    const stub = steerStub({ take: true });
    const session = await openSession(stub.backend);
    // send() claims the turn synchronously; the turn itself starts on the first
    // next(), so both steers land before the loop is ever handed the channel.
    const stream = reader(session.send("hi"));
    const a = accepted(steer(session)("a"));
    const b = accepted(steer(session)("b"));
    const seen = await stream.until("turn_start");
    stub.finish();
    const events = [...seen, ...(await stream.rest())];
    expect(stub.taken).toEqual([["a", "b"]]);
    await expect(a.applied).resolves.toBe(true);
    await expect(b.applied).resolves.toBe(true);
    expect(turnEndOf(events).status).toBe("completed");
  });

  test("AC-9, AC-10: a steer pending at settle resolves false before turn_end arrives, and take() then gives []", async () => {
    const stub = steerStub();
    const session = await openSession(stub.backend);
    const stream = reader(session.send("hi"));
    await stream.until("turn_start");
    const result = accepted(steer(session)("late"));
    let appliedResolved = false;
    const applied = result.applied.then((value) => {
      appliedResolved = true;
      return value;
    });
    stub.finish();
    // `until` resumes the moment turn_end is DELIVERED to the iterator, so the
    // flag is a real ordering assertion rather than a coincidence of timing.
    const upTo = await stream.until("turn_end");
    expect(appliedResolved).toBe(true);
    expect(eventsOf(upTo, "turn_end")).toHaveLength(1);
    await expect(applied).resolves.toBe(false);
    const channel = channelOf(stub);
    expect(channel.take()).toEqual([]);
  });

  test("AC-11: a steer accepted before sendTurn runs, on a cancelled turn, resolves false exactly once", async () => {
    const stub = steerStub();
    const session = await openSession(stub.backend);
    const iterable = session.send("hi");
    const result = accepted(steer(session)("gone"));
    const resolutions: boolean[] = [];
    const applied = result.applied.then((value) => {
      resolutions.push(value);
      return value;
    });
    session.cancel();
    await expect(applied).resolves.toBe(false);
    // The turn never started, so the backend never saw sendTurn or a channel.
    expect(stub.turns).toEqual([]);
    const events: SessionEvent[] = [];
    for await (const event of iterable) events.push(event);
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(resolutions).toEqual([false]);
  });
});

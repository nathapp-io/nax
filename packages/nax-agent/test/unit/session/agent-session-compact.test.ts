/**
 * US-002: the facade's manual compaction (spec "Manual compaction (native)").
 *
 * `compact()` refuses, in order: `AGENT_SESSION_CLOSED`, `AGENT_SESSION_BUSY`
 * (a turn, command, configure or compact in flight), then
 * `AGENT_SESSION_CAPABILITY_UNSUPPORTED` (a backend with no `compact`). While it
 * runs it holds the session's single slot, so `send()` refuses BUSY, and it
 * hands the backend a signal that aborts on the session's `turnTimeoutSeconds`
 * deadline or on `close()`.
 *
 * Driven against a stub backend: what these criteria are about is the facade's
 * bookkeeping. The native half (transcript load, summarizer, persistence) is
 * covered by test/integration/session/native-manual-compaction.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionAdapter,
  type CompactResult,
  createAgentSession,
  type NaxError,
  NO_OP_INTERACTION_HANDLER,
  type OpenedBackend,
  type SessionBackend,
} from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { installManualTimers, reader } from "#test/helpers/agent-session";
import { assertDefined, assertNaxError, withDepsRestore } from "#test/helpers/index";

/** The stub backend's fixed answer: the facade must pass it through unchanged. */
const COMPACTED: CompactResult = {
  compacted: true,
  tokensBefore: 120,
  tokensAfter: 40,
  usage: { inputTokens: 7, outputTokens: 3 },
  costUsd: 0.000066,
};

const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function openSession(backend: SessionBackend, turnTimeoutSeconds?: number): Promise<AgentSession> {
  const session = await createAgentSession({
    backend,
    profile: "none",
    transcriptStore: createMemoryTranscriptStore(),
    ...(turnTimeoutSeconds !== undefined ? { turnTimeoutSeconds } : {}),
  });
  sessions.push(session);
  return session;
}

/** The facade always supplies `compact`; the contract keeps it optional for other backends. */
function compact(session: AgentSession): () => Promise<CompactResult> {
  assertDefined(session.compact, "compact");
  return session.compact.bind(session);
}

/** The error `promise` rejected with, as a `NaxError` — so every refusal names its code. */
async function refusalOf(promise: Promise<unknown>): Promise<NaxError> {
  const caught = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  assertNaxError(caught);
  return caught;
}

interface StubOptions {
  /** false: a backend with no `compact`, the way the ACP backend is. */
  readonly withCompact?: boolean;
  /** false: a backend with no `runCommand`. */
  readonly withRunCommand?: boolean;
  /** false: a backend with no `configure`. */
  readonly withConfigure?: boolean;
}

interface CompactStub {
  readonly backend: SessionBackend;
  /** The signal each `compact()` call handed the backend, in call order. */
  readonly signals: AbortSignal[];
  /** Releases every gated backend call, so the stubs' promises settle. */
  finish(): void;
  /** Releases only after `finish()` has been observed as "not yet": see `gates`. */
  readonly gates: (() => void)[];
}

/**
 * A backend whose turn, command, configure and compact all block on the same
 * gate: that is what lets a test hold a claim open, assert the refusal, and then
 * let everything settle.
 */
function compactStub(options: StubOptions = {}): CompactStub {
  const signals: AbortSignal[] = [];
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
    kind: "acp:fake",
    async open(): Promise<OpenedBackend> {
      const handle = { id: "h", agentName: "stub" };
      const adapter: AgentSessionAdapter = {
        openSession: async () => handle,
        sendTurn: async () => {
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
        info: { kind: "acp:fake", capabilities: {} },
        turnOpts: () => ({ interactionHandler: NO_OP_INTERACTION_HANDLER }),
        ...(options.withCompact === false
          ? {}
          : {
              compact: async ({ signal }: { signal: AbortSignal }): Promise<CompactResult> => {
                signals.push(signal);
                await gate();
                return COMPACTED;
              },
            }),
        ...(options.withRunCommand === false
          ? {}
          : {
              runCommand: async () => {
                await gate();
                return { content: "ok", isError: false };
              },
            }),
        ...(options.withConfigure === false
          ? {}
          : {
              configure: async () => {
                await gate();
              },
            }),
        close: async () => {},
      };
    },
  };
  return {
    backend,
    signals,
    gates,
    finish: () => {
      finished = true;
      for (const release of gates.splice(0)) release();
    },
  };
}

describe("AgentSession.compact: refusals", () => {
  test("AC-8: compact() while a turn is in flight throws AGENT_SESSION_BUSY", async () => {
    const stub = compactStub();
    const session = await openSession(stub.backend);
    const stream = reader(session.send("hi"));
    await stream.until("turn_start");

    const caught = await refusalOf(compact(session)());

    expect(caught.code).toBe("AGENT_SESSION_BUSY");
    // The refusal came before the backend: no signal was ever handed over.
    expect(stub.signals).toEqual([]);
    stub.finish();
    await stream.rest();
  });

  test("AC-18: compact() while a runCommand is in flight throws AGENT_SESSION_BUSY", async () => {
    const stub = compactStub();
    const session = await openSession(stub.backend);
    assertDefined(session.runCommand, "runCommand");
    const command = session.runCommand.bind(session)("echo hi", () => {});
    // claimCommand dispatches its run on a microtask; the slot is claimed first.
    await Promise.resolve();

    const caught = await refusalOf(compact(session)());

    expect(caught.code).toBe("AGENT_SESSION_BUSY");
    stub.finish();
    await command;
  });

  test("AC-19: compact() while configure is in flight throws AGENT_SESSION_BUSY", async () => {
    const stub = compactStub();
    const session = await openSession(stub.backend);
    assertDefined(session.configure, "configure");
    const configuring = session.configure({ model: "other/model" });

    const caught = await refusalOf(compact(session)());

    expect(caught.code).toBe("AGENT_SESSION_BUSY");
    stub.finish();
    await configuring;
  });

  test("AC-10: compact() on a backend with no compact throws AGENT_SESSION_CAPABILITY_UNSUPPORTED", async () => {
    const stub = compactStub({ withCompact: false });
    const session = await openSession(stub.backend);

    const caught = await refusalOf(compact(session)());

    expect(caught.code).toBe("AGENT_SESSION_CAPABILITY_UNSUPPORTED");
  });

  test("AC-11: compact() after close() throws AGENT_SESSION_CLOSED", async () => {
    const stub = compactStub();
    const session = await openSession(stub.backend);
    await session.close();

    const caught = await refusalOf(compact(session)());

    expect(caught.code).toBe("AGENT_SESSION_CLOSED");
    expect(stub.signals).toEqual([]);
  });

  test("the closed refusal wins over the capability refusal", async () => {
    // Documented order: the session's own state first, the backend's capability
    // last, so a closed session reports what the caller cannot fix.
    const stub = compactStub({ withCompact: false });
    const session = await openSession(stub.backend);
    await session.close();

    const caught = await refusalOf(compact(session)());

    expect(caught.code).toBe("AGENT_SESSION_CLOSED");
  });
});

describe("AgentSession.compact: the single slot and the signal", () => {
  test("AC-9: send() while a compact() is pending throws AGENT_SESSION_BUSY", async () => {
    const stub = compactStub();
    const session = await openSession(stub.backend);
    const compacting = compact(session)();
    // The slot is claimed synchronously, so the send need not race the backend.
    let caught: unknown;
    try {
      session.send("hi");
    } catch (err) {
      caught = err;
    }
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_BUSY");

    stub.finish();
    await compacting;
    // Released: the same session accepts a turn afterwards.
    const stream = reader(session.send("hi"));
    stub.finish();
    await stream.rest();
    expect(session.lastTurn?.status).toBe("completed");
  });

  test("resolves with the backend's result unchanged and releases the slot", async () => {
    const stub = compactStub();
    const session = await openSession(stub.backend);

    const compacting = compact(session)();
    stub.finish();
    const result = await compacting;

    expect(result).toEqual(COMPACTED);
    // The slot is free again: the same session accepts a turn, which a pending
    // or leaked compact claim would refuse the turn as busy.
    const stream = reader(session.send("hi"));
    await stream.rest();
    expect(session.lastTurn?.status).toBe("completed");
  });

  withDepsRestore(_agentSessionDeps);

  test("AC-12: the signal the backend receives aborts when turnTimeoutSeconds elapses", async () => {
    const timers = installManualTimers();
    const stub = compactStub();
    const session = await openSession(stub.backend, 30);
    const compacting = compact(session)();
    await Promise.resolve();
    const [signal] = stub.signals;
    assertDefined(signal, "the signal handed to the backend");
    expect(signal.aborted).toBe(false);

    // The deadline the facade armed for this compact() call: 30s, in milliseconds.
    expect(timers.fire(30_000)).toBe(1);

    expect(signal.aborted).toBe(true);
    stub.finish();
    await compacting;
  });

  test("close() aborts the signal a pending compact() was handed", async () => {
    const stub = compactStub();
    const session = await openSession(stub.backend);
    const compacting = compact(session)();
    await Promise.resolve();
    const [signal] = stub.signals;
    assertDefined(signal, "the signal handed to the backend");
    expect(signal.aborted).toBe(false);

    const closing = session.close();
    stub.finish();
    await compacting;
    await closing;

    expect(signal.aborted).toBe(true);
  });

  test("the compact deadline timer is cleared once compact() settles", async () => {
    const timers = installManualTimers();
    const stub = compactStub();
    const session = await openSession(stub.backend, 30);
    const compacting = compact(session)();
    expect(timers.pendingDelays()).toEqual([30_000]);

    stub.finish();
    await compacting;

    // Nothing is left armed: a settled compact must not keep a timer alive.
    expect(timers.pendingDelays()).toEqual([]);
  });
});

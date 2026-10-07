import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionAdapter,
  attachTurnSpend,
  type BackendOpenContext,
  createAgentSession,
  nativeBackend,
  type OpenedBackend,
  resumeAgentSession,
  type SendTurnOpts,
  type SessionBackend,
  type SessionEvent,
} from "@nathapp/nax-agent";
import { NaxError } from "#src/infra/nax-error";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { collect, MODEL, resetScriptedProvider, turnEndOf } from "#test/helpers/agent-session";
import { assertNaxError } from "#test/helpers/index";

afterEach(resetScriptedProvider);

interface StubState {
  opened: BackendOpenContext[];
  closes: number;
  adapterCloseThrows: boolean;
}

function stubBackend(kind: string, state: StubState): SessionBackend {
  return {
    kind,
    async open(ctx) {
      state.opened.push(ctx);
      const adapter: AgentSessionAdapter = {
        openSession: async () => ({ id: "h", agentName: "stub" }),
        sendTurn: async () => ({
          output: "pong",
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
          estimatedCostUsd: 0,
          costSource: "unpriced",
          internalRoundTrips: 1,
        }),
        closeSession: async () => {
          if (state.adapterCloseThrows) throw new Error("adapter close failed");
        },
      };
      const opened: OpenedBackend = {
        adapter,
        handle: { id: "h", agentName: "stub" },
        info: { kind, capabilities: { resume: true } },
        turnOpts: () => ({ interactionHandler: { onInteraction: async () => null } }),
        close: async () => {
          state.closes += 1;
        },
      };
      return opened;
    },
  };
}

function fresh(): StubState {
  return { opened: [], closes: 0, adapterCloseThrows: false };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<unknown> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assertNaxError(caught);
  expect(caught.code).toBe(code);
  return caught;
}

describe("agent session: backend seam", () => {
  test("a stub backend drives a turn; backend info is public; turn_end carries costSource", async () => {
    const state = fresh();
    const session = await createAgentSession({
      backend: stubBackend("acp:fake", state),
      profile: "none",
      transcriptStore: createMemoryTranscriptStore(),
    });
    expect(session.backend).toEqual({ kind: "acp:fake", capabilities: { resume: true } });
    expect(Object.isFrozen(session.backend)).toBe(true);
    expect(Object.isFrozen(session.backend.capabilities)).toBe(true);
    const end = turnEndOf(await collect(session.send("ping")));
    expect(end).toMatchObject({ status: "completed", output: "pong", costSource: "unpriced" });
    expect(state.opened[0]?.workdir).toBeString();
    await session.close();
  });

  test("close aborts openSignal and closes the backend once, even when the adapter close throws", async () => {
    const state = fresh();
    state.adapterCloseThrows = true;
    const session = await createAgentSession({
      backend: stubBackend("acp:fake", state),
      profile: "none",
      transcriptStore: createMemoryTranscriptStore(),
    });
    await session.close().catch(() => undefined);
    await session.close().catch(() => undefined);
    expect(state.opened[0]?.openSignal.aborted).toBe(true);
    expect(state.closes).toBe(1);
  });

  test("a native-only option at the top level is refused by name", async () => {
    const options = {
      backend: nativeBackend({ model: MODEL }),
      profile: "none" as const,
      transcriptStore: createMemoryTranscriptStore(),
    };
    // Object.assign adds a key the type does not declare: the runtime shape is what this test pins.
    Object.assign(options, { model: MODEL });
    await rejectsWith(createAgentSession(options), "AGENT_SESSION_INVALID_OPTIONS");
  });

  test("backend must be a SessionBackend", async () => {
    const backend: SessionBackend = nativeBackend({ model: MODEL });
    // Object.assign lets a non-backend slip past the type, for the runtime validator to refuse.
    Object.assign(backend, { open: undefined });
    await rejectsWith(
      createAgentSession({ backend, profile: "none", transcriptStore: createMemoryTranscriptStore() }),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });

  test('a non-object backend (the primitive "native") is refused', async () => {
    const options = {
      backend: nativeBackend({ model: MODEL }),
      profile: "none" as const,
      transcriptStore: createMemoryTranscriptStore(),
    };
    // Object.assign swaps in a primitive the type does not declare: the runtime shape is what this test pins.
    Object.assign(options, { backend: "native" });
    await rejectsWith(createAgentSession(options), "AGENT_SESSION_INVALID_OPTIONS");
  });

  test("a backend with an empty kind is refused", async () => {
    const backend: SessionBackend = {
      kind: "",
      open: async () => {
        throw new Error("unreachable: validation must reject before open");
      },
    };
    await rejectsWith(
      createAgentSession({ backend, profile: "none", transcriptStore: createMemoryTranscriptStore() }),
      "AGENT_SESSION_INVALID_OPTIONS",
    );
  });

  test("a 0.2.0 document (no backend) resumes with the native backend kind only", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("old", { savedAt: new Date(0).toISOString(), messages: [] });
    const err = await rejectsWith(
      resumeAgentSession("old", { backend: stubBackend("acp:fake", fresh()), profile: "none", transcriptStore: store }),
      "AGENT_SESSION_BACKEND_MISMATCH",
    );
    expect(err).toBeDefined();
    const state = fresh();
    const session = await resumeAgentSession("old", {
      backend: stubBackend("native", state),
      profile: "none",
      transcriptStore: store,
    });
    expect(state.opened[0]?.resume?.doc.messages).toEqual([]);
    await session.close();
  });

  test("a document written by one backend kind is refused by another before open", async () => {
    const store = createMemoryTranscriptStore();
    await store.save("s", { savedAt: new Date(0).toISOString(), messages: [], backend: "acp:claude" });
    const state = fresh();
    await rejectsWith(
      resumeAgentSession("s", { backend: stubBackend("native", state), profile: "none", transcriptStore: store }),
      "AGENT_SESSION_BACKEND_MISMATCH",
    );
    expect(state.opened).toEqual([]);
  });
});

const FAILED_SPEND = {
  tokenUsage: { inputTokens: 4, outputTokens: 5 },
  costUsd: 0.0133,
  costSource: "reported",
} as const;

/** A backend whose sendTurn runs `turn`; everything else is inert. */
function turnBackend(turn: (opts: SendTurnOpts) => Promise<never>): SessionBackend {
  return {
    kind: "acp:fake",
    async open() {
      const handle = { id: "h", agentName: "stub" };
      return {
        adapter: {
          openSession: async () => handle,
          sendTurn: (_h, _m, opts) => turn(opts),
          closeSession: async () => {},
        },
        handle,
        info: { kind: "acp:fake", capabilities: {} },
        turnOpts: () => ({ interactionHandler: { onInteraction: async () => null } }),
        close: async () => {},
      };
    },
  };
}

const withSpend = (message: string): Error => {
  const err = new Error(message);
  attachTurnSpend(err, FAILED_SPEND);
  return err;
};

/** Resolves once the turn signal aborts; at once when cancel() already aborted it. */
const abortOf = (opts: SendTurnOpts): Promise<void> =>
  new Promise((resolve) => {
    if (opts.signal?.aborted === true) resolve();
    else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
  });

async function sessionOn(
  turn: (opts: SendTurnOpts) => Promise<never>,
  turnTimeoutSeconds?: number,
): Promise<AgentSession> {
  return createAgentSession({
    backend: turnBackend(turn),
    profile: "none",
    transcriptStore: createMemoryTranscriptStore(),
    ...(turnTimeoutSeconds === undefined ? {} : { turnTimeoutSeconds }),
  });
}

describe("turn_end keeps a failed turn's attached spend (#2367)", () => {
  const realSetTimeout = _agentSessionDeps.setTimeout;
  afterEach(() => {
    _agentSessionDeps.setTimeout = realSetTimeout;
  });

  test("errored: usage, cost and costSource come from the attached spend; the error code is kept", async () => {
    const session = await sessionOn(async () => {
      const err = new NaxError("stopped", "ACP_STOP_CANCELLED", { stage: "acp" });
      attachTurnSpend(err, FAILED_SPEND);
      throw err;
    });
    expect(turnEndOf(await collect(session.send("go")))).toMatchObject({
      status: "errored",
      error: { code: "ACP_STOP_CANCELLED" },
      usage: { inputTokens: 4, outputTokens: 5 },
      costUsd: 0.0133,
      costSource: "reported",
    });
    await session.close();
  });

  test("cancelled: the spend survives a cancel", async () => {
    const session = await sessionOn(async (opts) => {
      await abortOf(opts);
      throw withSpend("aborted");
    });
    const events: SessionEvent[] = [];
    for await (const event of session.send("go")) {
      events.push(event);
      if (event.type === "turn_start") session.cancel();
    }
    expect(turnEndOf(events)).toMatchObject({ status: "cancelled", costUsd: 0.0133, costSource: "reported" });
    await session.close();
  });

  test("timed_out: the spend survives the turn deadline", async () => {
    _agentSessionDeps.setTimeout = (fn: () => void) => realSetTimeout(fn, 5);
    const session = await sessionOn(async (opts) => {
      await abortOf(opts);
      throw withSpend("deadline");
    }, 1);
    expect(turnEndOf(await collect(session.send("go")))).toMatchObject({
      status: "timed_out",
      usage: { inputTokens: 4, outputTokens: 5 },
      costUsd: 0.0133,
      costSource: "reported",
    });
    await session.close();
  });

  test("an unpriced failed turn says so", async () => {
    const session = await sessionOn(async () => {
      const err = new Error("x");
      attachTurnSpend(err, { tokenUsage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, costSource: "unpriced" });
      throw err;
    });
    expect(turnEndOf(await collect(session.send("go")))).toMatchObject({ costUsd: 0, costSource: "unpriced" });
    await session.close();
  });

  test("no attached spend: zero usage and no costSource, as before", async () => {
    const session = await sessionOn(async () => {
      throw new Error("plain");
    });
    const end = turnEndOf(await collect(session.send("go")));
    expect(end).toMatchObject({ status: "errored", costUsd: 0, usage: { inputTokens: 0, outputTokens: 0 } });
    expect("costSource" in end).toBe(false);
    await session.close();
  });
});

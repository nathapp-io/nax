import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type AgentSessionAdapter,
  AgentSessionError,
  type CommandRunResult,
  createAgentSession,
  type OpenedBackend,
  type SessionBackend,
  type SessionConfigureInput,
} from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { collect, reader, turnEndOf } from "#test/helpers/agent-session";
import { assertDefined } from "#test/helpers/index";

interface Stub {
  readonly configureCalls: SessionConfigureInput[];
  /** Replaces the backend's configure behavior; defaults to resolving at once. */
  onConfigure: (input: SessionConfigureInput) => Promise<void>;
  /** Awaited by sendTurn, runCommand and closeSession before they finish. */
  turnGate: Promise<void>;
  commandGate: Promise<void>;
  closeGate: Promise<void>;
}

interface StubOptions {
  readonly withConfigure?: boolean;
  readonly withRunCommand?: boolean;
}

function stubBackend(stub: Stub, options: StubOptions = {}): SessionBackend {
  const { withConfigure = true, withRunCommand = false } = options;
  return {
    kind: "acp:fake",
    async open() {
      const adapter: AgentSessionAdapter = {
        openSession: async () => ({ id: "h", agentName: "stub" }),
        sendTurn: async () => {
          await stub.turnGate;
          return {
            output: "pong",
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
            estimatedCostUsd: 0,
            costSource: "unpriced",
            internalRoundTrips: 1,
          };
        },
        closeSession: async () => {
          await stub.closeGate;
        },
      };
      const opened: OpenedBackend = {
        adapter,
        handle: { id: "h", agentName: "stub" },
        info: { kind: "acp:fake", capabilities: {} },
        turnOpts: () => ({ interactionHandler: { onInteraction: async () => null } }),
        close: async () => {},
        ...(withConfigure
          ? {
              configure: async (input: SessionConfigureInput) => {
                stub.configureCalls.push(input);
                await stub.onConfigure(input);
              },
            }
          : {}),
        ...(withRunCommand
          ? {
              runCommand: async (): Promise<CommandRunResult> => {
                await stub.commandGate;
                return { content: "ok", isError: false };
              },
            }
          : {}),
      };
      return opened;
    },
  };
}

function makeStub(): Stub {
  return {
    configureCalls: [],
    onConfigure: async () => {},
    turnGate: Promise.resolve(),
    commandGate: Promise.resolve(),
    closeGate: Promise.resolve(),
  };
}

const sessions: AgentSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close().catch(() => undefined)));
});

async function setup(options: StubOptions = {}) {
  const stub = makeStub();
  const session = await createAgentSession({
    backend: stubBackend(stub, options),
    profile: "none",
    transcriptStore: createMemoryTranscriptStore(),
  });
  sessions.push(session);
  return { stub, session };
}

function configureOf(session: AgentSession): (input: SessionConfigureInput) => Promise<void> {
  assertDefined(session.configure, "the facade always provides configure");
  return session.configure.bind(session);
}

/** A promise settled from outside: the gate a stub waits on. */
function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

function expectCode(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(AgentSessionError);
  expect(err).toMatchObject({ code });
}

describe("AgentSession.configure", () => {
  test("AC-1: delegates to the backend's configure once with the input", async () => {
    const { stub, session } = await setup();
    await configureOf(session)({ effort: "high" });
    expect(stub.configureCalls).toEqual([{ effort: "high" }]);
  });

  test("AC-2: model and effort reach the backend unchanged", async () => {
    const { stub, session } = await setup();
    await configureOf(session)({ model: "m2", effort: "low" });
    expect(stub.configureCalls).toEqual([{ model: "m2", effort: "low" }]);
  });

  test("AC-3: a backend without configure rejects CAPABILITY_UNSUPPORTED with capability context", async () => {
    const { session } = await setup({ withConfigure: false });
    const err = await rejectionOf(configureOf(session)({ effort: "high" }));
    expectCode(err, "AGENT_SESSION_CAPABILITY_UNSUPPORTED");
    expect(err).toMatchObject({ context: { capability: "configure" } });
  });

  test("AC-4: an empty input rejects INVALID_OPTIONS and never reaches the backend", async () => {
    const { stub, session } = await setup();
    expectCode(await rejectionOf(configureOf(session)({})), "AGENT_SESSION_INVALID_OPTIONS");
    expect(stub.configureCalls).toEqual([]);
  });

  test("AC-5: an empty model rejects INVALID_OPTIONS", async () => {
    const { stub, session } = await setup();
    expectCode(await rejectionOf(configureOf(session)({ model: "" })), "AGENT_SESSION_INVALID_OPTIONS");
    expect(stub.configureCalls).toEqual([]);
  });

  test("AC-19: an empty effort rejects INVALID_OPTIONS", async () => {
    const { stub, session } = await setup();
    expectCode(await rejectionOf(configureOf(session)({ effort: "" })), "AGENT_SESSION_INVALID_OPTIONS");
    expect(stub.configureCalls).toEqual([]);
  });

  test("AC-5: an empty model beside a valid effort is still invalid", async () => {
    const { stub, session } = await setup();
    expectCode(await rejectionOf(configureOf(session)({ model: "", effort: "high" })), "AGENT_SESSION_INVALID_OPTIONS");
    expect(stub.configureCalls).toEqual([]);
  });

  test("AC-6: the input is checked before backend support", async () => {
    const { session } = await setup({ withConfigure: false });
    expectCode(await rejectionOf(configureOf(session)({})), "AGENT_SESSION_INVALID_OPTIONS");
  });

  test("AC-7: a closed session rejects CLOSED", async () => {
    const { stub, session } = await setup();
    await session.close();
    expectCode(await rejectionOf(configureOf(session)({ effort: "high" })), "AGENT_SESSION_CLOSED");
    expect(stub.configureCalls).toEqual([]);
  });

  test("AC-17: a closing session rejects CLOSED", async () => {
    const { stub, session } = await setup();
    const closeGate = gate();
    stub.closeGate = closeGate.promise;
    const closing = session.close();
    expectCode(await rejectionOf(configureOf(session)({ effort: "high" })), "AGENT_SESSION_CLOSED");
    closeGate.open();
    await closing;
  });

  test("AC-8: a turn in flight rejects BUSY and the backend is not called", async () => {
    const { stub, session } = await setup();
    const turnGate = gate();
    stub.turnGate = turnGate.promise;
    const stream = reader(session.send("hi"));
    await stream.until("turn_start");
    expectCode(await rejectionOf(configureOf(session)({ effort: "high" })), "AGENT_SESSION_BUSY");
    expect(stub.configureCalls).toEqual([]);
    turnGate.open();
    await stream.rest();
  });

  test("AC-18: a command in flight rejects BUSY", async () => {
    const { stub, session } = await setup({ withRunCommand: true });
    const commandGate = gate();
    stub.commandGate = commandGate.promise;
    assertDefined(session.runCommand);
    const command = session.runCommand("ls", () => {});
    expectCode(await rejectionOf(configureOf(session)({ effort: "high" })), "AGENT_SESSION_BUSY");
    expect(stub.configureCalls).toEqual([]);
    commandGate.open();
    await command;
  });

  describe("while the backend's configure is pending", () => {
    async function pending(options: StubOptions = {}) {
      const ctx = await setup(options);
      const release = gate();
      let fail: (err: unknown) => void = () => {};
      ctx.stub.onConfigure = () =>
        new Promise<void>((resolve, reject) => {
          fail = reject;
          release.promise.then(resolve);
        });
      const first = configureOf(ctx.session)({ effort: "high" });
      return { ...ctx, first, release: release.open, fail: (err: unknown) => fail(err) };
    }

    test("AC-9: send throws BUSY", async () => {
      const { session, first, release } = await pending();
      expect(() => session.send("hi")).toThrow(expect.objectContaining({ code: "AGENT_SESSION_BUSY" }));
      release();
      await first;
    });

    test("AC-10: a second configure rejects BUSY", async () => {
      const { stub, session, first, release } = await pending();
      expectCode(await rejectionOf(configureOf(session)({ effort: "low" })), "AGENT_SESSION_BUSY");
      expect(stub.configureCalls).toEqual([{ effort: "high" }]);
      release();
      await first;
    });

    test("AC-11: runCommand rejects BUSY", async () => {
      const { session, first, release } = await pending({ withRunCommand: true });
      assertDefined(session.runCommand);
      expectCode(await rejectionOf(session.runCommand("ls", () => {})), "AGENT_SESSION_BUSY");
      release();
      await first;
    });

    test("AC-15: close resolves and leaves the session closed", async () => {
      const { session, first, release } = await pending();
      await session.close();
      expect(() => session.send("hi")).toThrow(expect.objectContaining({ code: "AGENT_SESSION_CLOSED" }));
      release();
      await first;
    });

    test("AC-12 and AC-13: a backend error propagates as the same object and frees the session", async () => {
      const { session, first, fail } = await pending();
      const error = new AgentSessionError("agent gone", "AGENT_SESSION_BACKEND_UNAVAILABLE");
      fail(error);
      expect(await rejectionOf(first)).toBe(error);
      expect(turnEndOf(await collect(session.send("hi"))).status).toBe("completed");
    });

    test("AC-14: after a resolved configure, send starts a turn", async () => {
      const { session, first, release } = await pending();
      release();
      await first;
      expect(turnEndOf(await collect(session.send("hi"))).status).toBe("completed");
    });
  });

  test("a synchronous throw from the backend's configure rejects and frees the session", async () => {
    const { stub, session } = await setup();
    const error = new AgentSessionError("sync failure", "AGENT_SESSION_BACKEND_UNAVAILABLE");
    stub.onConfigure = () => {
      throw error;
    };
    expect(await rejectionOf(configureOf(session)({ effort: "high" }))).toBe(error);
    expect(turnEndOf(await collect(session.send("hi"))).status).toBe("completed");
  });

  test("AC-16: SessionConfigureInput is exported and accepts model and effort", () => {
    const input: SessionConfigureInput = { model: "m", effort: "e" };
    expect(input).toEqual({ model: "m", effort: "e" });
  });
});

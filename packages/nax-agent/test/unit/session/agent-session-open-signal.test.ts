import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  AgentSessionError,
  type BackendOpenContext,
  type CreateAgentSessionOptions,
  createAgentSession,
  type OpenedBackend,
  resumeAgentSession,
} from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import { collect, turnEndOf } from "#test/helpers/agent-session";

const realDeps = { ..._agentSessionDeps };
afterEach(() => Object.assign(_agentSessionDeps, realDeps));

function fixture() {
  const controller = new AbortController();
  const store = createMemoryTranscriptStore();
  const load = mock(store.load.bind(store));
  store.load = load;
  const close = mock(async () => {});
  const opened: OpenedBackend = {
    adapter: {
      openSession: async () => ({ id: "h", agentName: "stub" }),
      sendTurn: async () => ({
        output: "pong",
        tokenUsage: { inputTokens: 1, outputTokens: 1 },
        estimatedCostUsd: 0,
        costSource: "unpriced",
        internalRoundTrips: 1,
      }),
      closeSession: async () => {},
    },
    handle: { id: "h", agentName: "stub" },
    info: { kind: "acp:stub", capabilities: { resume: true } },
    turnOpts: () => ({ interactionHandler: { onInteraction: async () => null } }),
    close,
  };
  const started = Promise.withResolvers<BackendOpenContext>();
  const open = mock(async (ctx: BackendOpenContext) => {
    started.resolve(ctx);
    return opened;
  });
  const options: CreateAgentSessionOptions = {
    backend: { kind: "acp:stub", open },
    profile: "none",
    transcriptStore: store,
    openSignal: controller.signal,
  };
  return { controller, store, load, close, opened, started, open, options };
}

async function closed(pending: Promise<unknown>) {
  const error = await pending.catch((err: unknown) => err);
  expect(error).toBeInstanceOf(AgentSessionError);
  expect(error).toMatchObject({ code: "AGENT_SESSION_CLOSED" });
}

// Surface an early rejection instead of hanging while waiting for a backend that never opened.
function reached<T>(started: Promise<T>, pending: Promise<unknown>): Promise<T> {
  return Promise.race([
    started,
    pending.then(() => {
      throw new Error("open finished before checkpoint");
    }),
  ]);
}

describe("createAgentSession openSignal", () => {
  test("AC-1 accepts a live signal and supplies a live backend signal", async () => {
    const f = fixture();
    const session = await createAgentSession(f.options);
    expect((await f.started.promise).openSignal.aborted).toBe(false);
    await session.close();
  });

  test("AC-2/3/4 pre-abort refuses before backend, store or root work", async () => {
    const f = fixture();
    const root = mock(realDeps.makeScratchRoot);
    _agentSessionDeps.makeScratchRoot = root;
    f.controller.abort();
    await closed(createAgentSession(f.options));
    expect(f.open).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
    expect(root).not.toHaveBeenCalled();
  });

  test("AC-7/8 abort during directory check refuses before backend open", async () => {
    const f = fixture();
    const checking = Promise.withResolvers<void>();
    const directory = Promise.withResolvers<boolean>();
    _agentSessionDeps.isDirectory = () => {
      checking.resolve();
      return directory.promise;
    };
    const pending = createAgentSession({ ...f.options, workdir: "/work" });
    await reached(checking.promise, pending);
    f.controller.abort();
    directory.resolve(true);
    await closed(pending);
    expect(f.open).not.toHaveBeenCalled();
  });

  test("AC-9/10 pending open receives abort and preserves the recorded rejection", async () => {
    const f = fixture();
    const recorded = new Error("backend recorded failure");
    f.open.mockImplementation((ctx) => {
      f.started.resolve(ctx);
      return new Promise((_resolve, reject) => {
        ctx.openSignal.addEventListener("abort", () => reject(recorded), { once: true });
      });
    });
    const pending = createAgentSession(f.options);
    const ctx = await reached(f.started.promise, pending);
    f.controller.abort();
    expect(ctx.openSignal.aborted).toBe(true);
    expect(await pending.catch((err: unknown) => err)).toBe(recorded);
    expect(f.close).not.toHaveBeenCalled();
  });

  test("AC-11/12 an ignoring backend is closed exactly once after late resolution", async () => {
    const f = fixture();
    const result = Promise.withResolvers<OpenedBackend>();
    f.open.mockImplementation((ctx) => {
      f.started.resolve(ctx);
      return result.promise;
    });
    const pending = createAgentSession(f.options);
    await reached(f.started.promise, pending);
    f.controller.abort();
    result.resolve(f.opened);
    await closed(pending);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  test("AC-13/14 abort after resolution leaves backend signal live and turns complete", async () => {
    const f = fixture();
    const session = await createAgentSession(f.options);
    f.controller.abort();
    expect((await f.started.promise).openSignal.aborted).toBe(false);
    expect(turnEndOf(await collect(session.send("ping")))).toMatchObject({ type: "turn_end", status: "completed" });
    await session.close();
  });

  test("AC-15 invalid signal reports its option path", async () => {
    const f = fixture();
    Object.assign(f.options, { openSignal: "stop" });
    const error = await createAgentSession(f.options).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AgentSessionError);
    expect(error).toMatchObject({ code: "AGENT_SESSION_INVALID_OPTIONS", context: { path: "openSignal" } });
    expect(f.load).not.toHaveBeenCalled();
  });
});

describe("resumeAgentSession openSignal", () => {
  test("AC-5/6 pre-abort refuses a stored session before load", async () => {
    const f = fixture();
    await f.store.save("stored", { savedAt: new Date(0).toISOString(), messages: [], backend: "acp:stub" });
    f.controller.abort();
    await closed(resumeAgentSession("stored", f.options));
    expect(f.load).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
});

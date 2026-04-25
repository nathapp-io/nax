import { describe, expect, mock, test } from "bun:test";
import { NO_OP_INTERACTION_HANDLER } from "../../../src/agents/interaction-handler";
import type { OpenSessionOpts, SendTurnOpts, SessionHandle, TurnResult } from "../../../src/agents/types";
import { SessionManager } from "../../../src/session/manager";
import type { NameForRequest, OpenSessionRequest, RunInSessionOpts } from "../../../src/session/types";
import { makeAgentAdapter } from "../../helpers/mock-agent-adapter";
import { makeMockAgentManager } from "../../helpers/mock-agent-manager";
import { makeNaxConfig } from "../../helpers/mock-nax-config";

const WORKDIR = "/tmp/nax-phase-b-test";

const MOCK_TURN: TurnResult = {
  output: "hello world",
  tokenUsage: { inputTokens: 10, outputTokens: 5 },
  internalRoundTrips: 1,
};

function makeOpenRequest(overrides: Partial<OpenSessionRequest> = {}): OpenSessionRequest {
  return {
    agentName: "claude",
    workdir: WORKDIR,
    pipelineStage: "run",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

function makeRunOpts(overrides: Partial<RunInSessionOpts> = {}): RunInSessionOpts {
  return {
    agentName: "claude",
    workdir: WORKDIR,
    pipelineStage: "run",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

// ─── nameFor() ────────────────────────────────────────────────────────────────

describe("nameFor()", () => {
  test("produces nax-<hash8> prefix for workdir", () => {
    const sm = new SessionManager();
    const name = sm.nameFor({ workdir: WORKDIR });
    expect(name).toMatch(/^nax-[0-9a-f]{8}$/);
  });

  test("includes featureName when provided", () => {
    const sm = new SessionManager();
    const name = sm.nameFor({ workdir: WORKDIR, featureName: "My Feature" });
    expect(name).toContain("my-feature");
  });

  test("includes storyId when provided", () => {
    const sm = new SessionManager();
    const name = sm.nameFor({ workdir: WORKDIR, storyId: "us-001" });
    expect(name).toContain("us-001");
  });

  test("omits stage suffix for default stage 'run'", () => {
    const sm = new SessionManager();
    const withRun = sm.nameFor({ workdir: WORKDIR, pipelineStage: "run" });
    const withoutStage = sm.nameFor({ workdir: WORKDIR });
    expect(withRun).toBe(withoutStage);
  });

  test("includes stage suffix for non-run stages", () => {
    const sm = new SessionManager();
    const name = sm.nameFor({ workdir: WORKDIR, pipelineStage: "review" });
    expect(name).toContain("review");
  });

  test("produces stable output for same inputs", () => {
    const sm = new SessionManager();
    const req: NameForRequest = { workdir: WORKDIR, featureName: "feat", storyId: "us-001" };
    expect(sm.nameFor(req)).toBe(sm.nameFor(req));
  });

  test("different workdirs produce different names", () => {
    const sm = new SessionManager();
    const a = sm.nameFor({ workdir: "/repo/a" });
    const b = sm.nameFor({ workdir: "/repo/b" });
    expect(a).not.toBe(b);
  });
});

// ─── descriptor() ─────────────────────────────────────────────────────────────

describe("descriptor()", () => {
  test("returns null when no descriptor with that handle", () => {
    const sm = new SessionManager();
    expect(sm.descriptor("nax-unknown-session")).toBeNull();
  });

  test("returns descriptor when handle matches a created session", () => {
    const sm = new SessionManager();
    const name = "nax-aabbccdd-feat";
    sm.create({ role: "main", agent: "claude", workdir: WORKDIR, handle: name });
    const result = sm.descriptor(name);
    expect(result).not.toBeNull();
    expect(result?.handle).toBe(name);
    expect(result?.agent).toBe("claude");
  });

  test("returns a copy, not the internal reference", () => {
    const sm = new SessionManager();
    const name = "nax-aabbccdd";
    sm.create({ role: "main", agent: "claude", workdir: WORKDIR, handle: name });
    const a = sm.descriptor(name);
    const b = sm.descriptor(name);
    expect(a).not.toBe(b);
  });
});

// ─── openSession() ────────────────────────────────────────────────────────────

describe("openSession()", () => {
  test("throws ADAPTER_NOT_FOUND when no adapter injected", async () => {
    const sm = new SessionManager();
    await expect(sm.openSession("nax-test", makeOpenRequest())).rejects.toMatchObject({
      code: "ADAPTER_NOT_FOUND",
    });
  });

  test("calls adapter.openSession with resolved permissions", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "claude" } satisfies SessionHandle;
      }),
    });
    const config = makeNaxConfig({ execution: { permissionProfile: "safe" } });
    const sm = new SessionManager({ getAdapter: () => adapter, config });

    await sm.openSession("nax-aabbccdd", makeOpenRequest());

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].resolvedPermissions.mode).toBe("approve-reads");
    expect(capturedOpts[0].resolvedPermissions.skipPermissions).toBe(false);
  });

  test("passes resume=false when no descriptor exists", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "claude" } satisfies SessionHandle;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    await sm.openSession("nax-new", makeOpenRequest());
    expect(capturedOpts[0].resume).toBe(false);
  });

  test("passes resume=true when a descriptor with that handle already exists", async () => {
    const capturedOpts: OpenSessionOpts[] = [];
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string, opts: OpenSessionOpts) => {
        capturedOpts.push(opts);
        return { id: name, agentName: "claude" } satisfies SessionHandle;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const sessionName = "nax-existing";
    sm.create({ role: "main", agent: "claude", workdir: WORKDIR, handle: sessionName });

    await sm.openSession(sessionName, makeOpenRequest());
    expect(capturedOpts[0].resume).toBe(true);
  });

  test("creates a descriptor for the session name", async () => {
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const name = "nax-aabbccdd-story";
    await sm.openSession(name, makeOpenRequest({ storyId: "us-001" }));
    expect(sm.descriptor(name)).not.toBeNull();
  });
});

// ─── closeSession() ───────────────────────────────────────────────────────────

describe("closeSession()", () => {
  test("calls adapter.closeSession", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-close-test", makeOpenRequest());
    await sm.closeSession(handle);
    expect(closeCalled).toBe(true);
  });

  test("is a no-op when no adapter is configured", async () => {
    const sm = new SessionManager();
    const handle: SessionHandle = { id: "nax-no-adapter", agentName: "claude" };
    await expect(sm.closeSession(handle)).resolves.toBeUndefined();
  });

  test("transitions descriptor to COMPLETED", async () => {
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      closeSession: mock(async () => {}),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const name = "nax-complete-test";
    const handle = await sm.openSession(name, makeOpenRequest());
    await sm.closeSession(handle);
    expect(sm.descriptor(name)?.state).toBe("COMPLETED");
  });

  test("clears busy flag so a post-close sendPrompt does not throw SESSION_BUSY", async () => {
    let resolveFirst!: () => void;
    let callCount = 0;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        callCount++;
        if (callCount === 1) {
          await new Promise<void>((res) => {
            resolveFirst = res;
          });
        }
        return MOCK_TURN;
      }),
      closeSession: mock(async () => {}),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-cleanup-test", makeOpenRequest());

    const firstTurn = sm.sendPrompt(handle, "first");
    await sm.closeSession(handle); // must clear the busy flag
    resolveFirst();
    await firstTurn;

    // Busy guard cleared — second sendPrompt must not throw SESSION_BUSY
    const second = await sm.sendPrompt(handle, "second");
    expect(second.output).toBe("hello world");
  });
});

// ─── sendPrompt() ─────────────────────────────────────────────────────────────

describe("sendPrompt()", () => {
  test("delegates to adapter.sendTurn and returns result", async () => {
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => MOCK_TURN),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-send-test", makeOpenRequest());

    const result = await sm.sendPrompt(handle, "write a function");
    expect(result.output).toBe("hello world");
  });

  test("forwards NO_OP_INTERACTION_HANDLER when opts omitted", async () => {
    let capturedHandler: unknown;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async (_h: SessionHandle, _p: string, opts: SendTurnOpts) => {
        capturedHandler = opts.interactionHandler;
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-handler-test", makeOpenRequest());
    await sm.sendPrompt(handle, "test");
    expect(capturedHandler).toBe(NO_OP_INTERACTION_HANDLER);
  });

  test("throws SESSION_BUSY on concurrent sendPrompt for same handle", async () => {
    let resolveFirst!: () => void;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return MOCK_TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-busy-test", makeOpenRequest());

    const first = sm.sendPrompt(handle, "first");
    await expect(sm.sendPrompt(handle, "second")).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });
    resolveFirst();
    await first;
  });

  test("throws SESSION_CANCELLED after signal abort during turn", async () => {
    const controller = new AbortController();
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    const handle = await sm.openSession("nax-cancel-test", makeOpenRequest());

    await expect(sm.sendPrompt(handle, "cancelled", { signal: controller.signal })).rejects.toThrow();
    await expect(sm.sendPrompt(handle, "after cancel")).rejects.toMatchObject({
      code: "SESSION_CANCELLED",
    });
  });

  test("throws ADAPTER_NOT_FOUND when sendPrompt called without adapter", async () => {
    const sm = new SessionManager();
    const fakeHandle: SessionHandle = { id: "nax-noadapter", agentName: "claude" };
    await expect(sm.sendPrompt(fakeHandle, "test")).rejects.toMatchObject({
      code: "ADAPTER_NOT_FOUND",
    });
  });
});

// ─── runInSession() — prompt form ─────────────────────────────────────────────

describe("runInSession() — prompt form", () => {
  test("opens, sends prompt, and closes session (try/finally)", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => MOCK_TURN),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    const result = await sm.runInSession("nax-prompt-form", "write a test", makeRunOpts());
    expect(result.output).toBe("hello world");
    expect(closeCalled).toBe(true);
  });

  test("closes session even when sendPrompt throws", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      sendTurn: mock(async () => {
        throw new Error("turn failed");
      }),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    await expect(sm.runInSession("nax-throw-form", "bad prompt", makeRunOpts())).rejects.toThrow("turn failed");
    expect(closeCalled).toBe(true);
  });
});

// ─── runInSession() — callback form ───────────────────────────────────────────

describe("runInSession() — callback form", () => {
  test("opens, runs callback with live handle, closes session (try/finally)", async () => {
    let closeCalled = false;
    let capturedHandle: SessionHandle | undefined;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    const result = await sm.runInSession(
      "nax-callback-form",
      async (handle) => {
        capturedHandle = handle;
        return 42;
      },
      makeRunOpts(),
    );

    expect(result).toBe(42);
    expect(capturedHandle?.id).toBe("nax-callback-form");
    expect(closeCalled).toBe(true);
  });

  test("closes session even when callback throws", async () => {
    let closeCalled = false;
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" }) as SessionHandle),
      closeSession: mock(async () => {
        closeCalled = true;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });

    await expect(
      sm.runInSession(
        "nax-callback-throw",
        async () => {
          throw new Error("callback failed");
        },
        makeRunOpts(),
      ),
    ).rejects.toThrow("callback failed");
    expect(closeCalled).toBe(true);
  });
});

// ─── runInSession() — legacy dispatch preserved ───────────────────────────────

describe("runInSession() — legacy form preserved", () => {
  test("IAgentManager second-arg dispatches to legacy path (no ADAPTER_NOT_FOUND)", async () => {
    const sm = new SessionManager();
    sm.create({ role: "main", agent: "claude", workdir: WORKDIR });
    const active = sm.listActive();
    expect(active.length).toBeGreaterThan(0);
    const sessionId = active[0].id;

    const agentManager = makeMockAgentManager();

    // The legacy path routes through _runInSessionLegacy — it throws SESSION_NOT_FOUND
    // only if the session id is wrong, not ADAPTER_NOT_FOUND (which is Phase B only).
    // Use a real id so the dispatch gate passes — agentManager.run() is called.
    await expect(
      sm.runInSession(sessionId, agentManager, {
        runOptions: {
          prompt: "test",
          workdir: WORKDIR,
          modelTier: "balanced",
          modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
          timeoutSeconds: 30,
          config: makeNaxConfig(),
        },
      }),
    ).resolves.toBeDefined();
  });
});

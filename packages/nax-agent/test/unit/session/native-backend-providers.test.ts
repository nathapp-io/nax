import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type {
  AgentSessionProfile,
  BackendOpenContext,
  ProviderTool,
  SessionEventBody,
  ToolProvider,
} from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { getSafeLogger, setAgentLogger } from "#src/infra/agent-logger";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { AgentSessionError } from "#src/session/agent-session-errors";
import { nativeBackend } from "#src/session/native-backend";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import type { OpenedBackend } from "#src/session/session-backend";
import { MODEL } from "#test/helpers/agent-session";
import {
  assertDefined,
  assertNaxError,
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  waitForCondition,
  withDepsRestore,
  withSessionSandboxSeam,
} from "#test/helpers/index";

const dirs: string[] = [];
const openedBackends: OpenedBackend[] = [];
const openSession = spyOn(NativeSessionAdapter.prototype, "openSession");
const IDLE = new AbortController().signal;

function provider(overrides: Partial<ToolProvider> = {}): ToolProvider {
  return {
    id: "skills",
    kind: "static",
    stages: ["*"],
    tools: async () => [
      {
        localName: "load",
        description: "Load a skill",
        inputSchema: { type: "object" },
        run: async () => ({ content: "loaded" }),
      },
    ],
    ...overrides,
  };
}

async function open(
  options: Parameters<typeof nativeBackend>[0],
  extra: Partial<BackendOpenContext> = {},
): Promise<OpenedBackend> {
  const workdir = makeTempDir("nax-session-providers-");
  dirs.push(workdir);
  const table = createPendingAskTable(30_000);
  const context: BackendOpenContext = {
    sessionId: "providers",
    workdir,
    profile: "read",
    instructions: undefined,
    tools: [],
    transcriptStore: createMemoryTranscriptStore(),
    resume: undefined,
    asks: createSessionAskPort({ table, emit: () => {}, turn: () => undefined }),
    turnSignal: () => IDLE,
    currentTurnId: () => undefined,
    turnTimeoutSeconds: 60,
    metadata: {},
    openSignal: IDLE,
    ...extra,
  };
  const opened = await nativeBackend(options).open(context);
  openedBackends.push(opened);
  return opened;
}

function names(opened: OpenedBackend): readonly string[] {
  return (opened.turnOpts().codingTools ?? []).map((tool) => tool.name);
}

afterEach(async () => {
  try {
    for (const opened of openedBackends.splice(0)) {
      await opened.adapter.closeSession(opened.handle);
      await opened.close();
    }
  } finally {
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
    openSession.mockClear();
  }
});

// The spy calls the real adapter; restore it after this file, not between cases.
afterAll(() => openSession.mockRestore());

describe("nativeBackend tool providers", () => {
  test("AC-1: advertises the static provider tool exactly once alongside embedder descriptors", async () => {
    const opened = await open(
      { model: MODEL, toolProviders: [provider()] },
      {
        tools: [
          {
            name: "lookup",
            description: "Lookup",
            inputSchema: { type: "object" },
            approval: "never",
            run: async () => ({ content: "found" }),
          },
        ],
      },
    );
    expect(names(opened).filter((name) => name === "skills__load")).toEqual(["skills__load"]);
    expect(names(opened).at(-1)).toBe("lookup");
  });

  test("AC-2: grants the provider tool in the adapter open options", async () => {
    await open({ model: MODEL, toolProviders: [provider()] });
    expect(openSession.mock.calls.at(-1)?.[1].resolvedPermissions.toolGrants).toContainEqual({
      tool: "skills__load",
      patterns: ["*"],
    });
  });

  test("AC-3: the interaction handler invokes the provider with the call input", async () => {
    const run = mock(async (_input: Record<string, unknown>) => ({ content: "skill body" }));
    const tools = await provider().tools("unused");
    const supplied = provider({ tools: async () => tools.map((tool) => ({ ...tool, run })) });
    const opened = await open({ model: MODEL, toolProviders: [supplied] });
    const input = { name: "brainstorm" };
    const response = await opened.turnOpts().interactionHandler?.onInteraction({
      kind: "coding-tool",
      name: "skills__load",
      input,
      toolCallId: "load-1",
    });
    expect(response).toEqual({ answer: "skill body" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual(input);
  });

  test("AC-4: forwards rendered provider instructions to the adapter", async () => {
    await open({ model: MODEL, toolProviders: [provider({ instructions: async () => "use skills" })] });
    expect(openSession.mock.calls.at(-1)?.[1].providerInstructions).toContain("use skills");
  });

  test("AC-5: absent and explicitly undefined providers preserve the profile tool names", async () => {
    const baseline = await open({ model: MODEL });
    const absent = await open({ model: MODEL, toolProviders: undefined });
    expect(names(absent)).toEqual(names(baseline));
    expect(names(absent)).toContain("Read");
    expect(names(absent)).not.toContain("skills__load");
    expect(openSession.mock.calls.at(-1)?.[1]).not.toHaveProperty("providerInstructions");
  });

  test("AC-6: profile none never resolves or advertises providers", async () => {
    const tools = mock(provider().tools);
    const opened = await open({ model: MODEL, toolProviders: [provider({ tools })] }, { profile: "none" });
    expect(names(opened)).not.toContain("skills__load");
    expect(tools).not.toHaveBeenCalled();
  });

  test("AC-7: a rejected provider does not hide the next provider's tool", async () => {
    const broken = provider({
      id: "broken",
      tools: async () => {
        throw new Error("offline");
      },
    });
    const previous = getSafeLogger();
    const warn = mock(() => {});
    setAgentLogger({ warn, info: () => {}, debug: () => {}, error: () => {} });
    try {
      const opened = await open({ model: MODEL, toolProviders: [broken, provider()] });
      expect(names(opened)).toContain("skills__load");
      expect(names(opened)).not.toContain("broken__load");
      expect(warn).toHaveBeenCalledWith("session", "Tool provider skipped", {
        sessionId: "providers",
        providerId: "broken",
        reason: "Error: offline",
      });
    } finally {
      setAgentLogger(previous);
    }
  });

  test.each([
    ["AC-8", ["run"], false],
    ["AC-9", ["session"], true],
  ])("%s: stage %j controls session attachment", async (_ac, stages, attached) => {
    const tools = mock(provider().tools);
    const opened = await open({ model: MODEL, toolProviders: [provider({ stages, tools })] });
    expect(names(opened).includes("skills__load")).toBe(attached);
    expect(tools).toHaveBeenCalledTimes(attached ? 1 : 0);
    if (attached) {
      const workdir = openSession.mock.calls.at(-1)?.[1].workdir;
      assertDefined(workdir);
      expect(tools.mock.calls[0]?.[0]).toBe(workdir);
    }
  });

  test("AC-10: a discovered provider is accepted at construction", () => {
    expect(() => nativeBackend({ model: MODEL, toolProviders: [provider({ kind: "discovered" })] })).not.toThrow();
  });

  test("AC-11: malformed providers are rejected by option validation", () => {
    for (const toolProviders of [[{ id: "x" }], [{ id: "x", kind: "other", stages: ["*"], tools: async () => [] }]]) {
      let caught: unknown;
      try {
        // Exercise the public JavaScript boundary with deliberately untyped options.
        Reflect.apply(nativeBackend, undefined, [{ model: MODEL, toolProviders }]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AgentSessionError);
      assertNaxError(caught);
      expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
      expect(caught.context).toMatchObject({ path: "backend.toolProviders" });
      expect(caught.message).toContain("must be an array of tool providers with id, kind, stages and tools()");
    }
  });

  test("AC-12: an embedder cannot shadow a provider tool", async () => {
    await expect(
      open(
        { model: MODEL, toolProviders: [provider()] },
        {
          tools: [
            {
              name: "skills__load",
              description: "Collision",
              inputSchema: { type: "object" },
              approval: "never",
              run: async () => ({ content: "shadow" }),
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_SESSION_TOOL_NAME_RESERVED" });
  });
});

describe("nativeBackend allowedTools with a static provider (chat-subagents US-001)", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  function acmeStatic(): ToolProvider {
    const tool = (localName: string): ProviderTool => ({
      localName,
      description: localName,
      inputSchema: { type: "object" },
      run: async () => ({ content: localName }),
    });
    return { id: "acme", kind: "static", stages: ["*"], tools: async () => [tool("get"), tool("put")] };
  }

  async function acmeNames(allowedTools?: readonly string[]): Promise<readonly string[]> {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const opened = await open(
      { model: MODEL, toolProviders: [acmeStatic()], ...(allowedTools !== undefined ? { allowedTools } : {}) },
      { profile: "full" },
    );
    return names(opened);
  }

  test("AC-9/AC-10: an exact name admits that tool and withholds its sibling", async () => {
    const declared = await acmeNames(["acme__get"]);
    expect(declared).toContain("acme__get");
    expect(declared).not.toContain("acme__put");
  });

  test("AC-11: <provider>__* admits every tool of the provider", async () => {
    const declared = await acmeNames(["acme__*"]);
    expect(declared).toContain("acme__get");
    expect(declared).toContain("acme__put");
  });

  test("AC-12: an allow-list naming only built-ins declares no provider tool", async () => {
    const declared = await acmeNames(["Read"]);
    expect(declared.filter((name) => name.startsWith("acme__"))).toEqual([]);
  });

  test("AC-13: without allowedTools both provider tools are declared", async () => {
    const declared = await acmeNames();
    expect(declared).toContain("acme__get");
    expect(declared).toContain("acme__put");
  });

  test("a provider tool that is not admitted is not granted either", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    await open({ model: MODEL, toolProviders: [acmeStatic()], allowedTools: ["acme__get"] }, { profile: "full" });
    const grants = openSession.mock.calls.at(-1)?.[1].resolvedPermissions.toolGrants ?? [];
    expect(grants.map((grant) => grant.tool)).toContain("acme__get");
    expect(grants.map((grant) => grant.tool)).not.toContain("acme__put");
  });
});

describe("nativeBackend discovered providers under the ask profile", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  function acme(runs: { get: ReturnType<typeof mock>; put: ReturnType<typeof mock> }): ToolProvider {
    const tool = (localName: string, run: ReturnType<typeof mock>, readOnly?: true): ProviderTool => ({
      localName,
      description: localName,
      inputSchema: { type: "object" },
      ...(readOnly === true ? { readOnly } : {}),
      run: async (input) => run(input),
    });
    return {
      id: "acme",
      kind: "discovered",
      stages: ["*"],
      tools: async () => [tool("get", runs.get, true), tool("put", runs.put)],
    };
  }

  /** Opens `providers` under `profile` with an ask port whose emit records every event. */
  async function openWith(profile: AgentSessionProfile, providers: readonly ToolProvider[]) {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const table = createPendingAskTable(30_000);
    const events: SessionEventBody[] = [];
    const opened = await open(
      { model: MODEL, toolProviders: providers },
      {
        profile,
        asks: createSessionAskPort({
          table,
          emit: (body) => events.push(body),
          turn: () => ({ turnId: "t1", signal: IDLE }),
        }),
      },
    );
    const interact = (name: string) =>
      opened.turnOpts().interactionHandler?.onInteraction({ kind: "coding-tool", name, input: {}, toolCallId: "c1" });
    const approvals = () => events.filter((event) => event.type === "approval_requested");
    return { opened, table, interact, approvals };
  }

  function runs() {
    return {
      get: mock(async (_input: Record<string, unknown>) => ({ content: "got" })),
      put: mock(async (_input: Record<string, unknown>) => ({ content: "put" })),
    };
  }

  test("AC-11: profile read advertises the discovered mutating tool", async () => {
    const { opened } = await openWith("read", [acme(runs())]);
    expect(names(opened)).toContain("acme__put");
  });

  test("AC-12/AC-13: ask asks for acme__put before running it", async () => {
    const r = runs();
    const { interact, approvals, table } = await openWith("ask", [acme(r)]);
    const pending = interact("acme__put");
    await waitForCondition(() => approvals().length > 0);
    expect(approvals()).toMatchObject([{ type: "approval_requested", tool: "acme__put" }]);
    expect(r.put).not.toHaveBeenCalled();
    const [request] = approvals();
    table.answer(request?.type === "approval_requested" ? request.requestId : "", { decision: "allow" });
    expect(await pending).toEqual({ answer: "put" });
    expect(r.put).toHaveBeenCalledTimes(1);
  });

  test("AC-14/AC-15: ask runs the readOnly acme__get without asking", async () => {
    const r = runs();
    const { interact, approvals } = await openWith("ask", [acme(r)]);
    expect(await interact("acme__get")).toEqual({ answer: "got" });
    expect(r.get).toHaveBeenCalledTimes(1);
    expect(approvals()).toEqual([]);
  });

  test("AC-16: full never asks for acme__put", async () => {
    const r = runs();
    const { interact, approvals } = await openWith("full", [acme(r)]);
    expect(await interact("acme__put")).toEqual({ answer: "put" });
    expect(approvals()).toEqual([]);
  });

  test("AC-17: ask never asks for a static provider's tool", async () => {
    const { interact, approvals } = await openWith("ask", [provider()]);
    expect(await interact("skills__load")).toEqual({ answer: "loaded" });
    expect(approvals()).toEqual([]);
  });
});

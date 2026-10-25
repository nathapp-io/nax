import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BackendOpenContext, ToolProvider } from "@nathapp/nax-agent";
import { createMemoryTranscriptStore } from "#src/native/session/memory-transcript-store";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { AgentSessionError } from "#src/session/agent-session-errors";
import { nativeBackend } from "#src/session/native-backend";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import type { OpenedBackend } from "#src/session/session-backend";
import { MODEL } from "#test/helpers/agent-session";
import { assertDefined, assertNaxError, cleanupTempDir, makeTempDir } from "#test/helpers/index";

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
    const opened = await open({ model: MODEL, toolProviders: [broken, provider()] });
    expect(names(opened)).toContain("skills__load");
    expect(names(opened)).not.toContain("broken__load");
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

  test("AC-10: discovered providers are rejected at construction with the providers path", () => {
    let caught: unknown;
    try {
      nativeBackend({ model: MODEL, toolProviders: [provider({ kind: "discovered" })] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentSessionError);
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(caught.context).toMatchObject({ path: "backend.toolProviders" });
  });

  test("AC-11: malformed providers are rejected by option validation", () => {
    let caught: unknown;
    try {
      // Exercise the public JavaScript boundary with deliberately untyped options.
      Reflect.apply(nativeBackend, undefined, [{ model: MODEL, toolProviders: [{ id: "x" }] }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentSessionError);
    assertNaxError(caught);
    expect(caught.code).toBe("AGENT_SESSION_INVALID_OPTIONS");
    expect(caught.context).toMatchObject({ path: "backend.toolProviders" });
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

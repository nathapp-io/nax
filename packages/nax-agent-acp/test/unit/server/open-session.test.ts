import { describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createMemoryTranscriptStore,
  type EmbedderTool,
  type NativeBackendOptions,
  type SessionBackend,
} from "@nathapp/nax-agent";
import { catalogOverridesFrom, nativeOpenSession } from "#src/server/open-session";
import { fakeAgentSession } from "#test/helpers/fake-agent-session";
import { recordingLogger } from "#test/helpers/recording-logger";

const unusedBackend = (): SessionBackend => ({
  kind: "native",
  open: async () => Promise.reject(new Error("unused")),
});

describe("catalogOverridesFrom (M-17)", () => {
  test("keeps entries with a provider and a models array; drops the rest with one warning", () => {
    const { logger, lines } = recordingLogger();
    const kept = catalogOverridesFrom(
      [{ provider: "minimax", models: [{ id: "m" }] }, { provider: "x" }, { models: [] }, "nope", null],
      logger,
    );
    expect(kept.map((entry) => entry.provider)).toEqual(["minimax"]);
    expect(JSON.stringify(kept)).toBe(JSON.stringify([{ provider: "minimax", models: [{ id: "m" }] }]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "warn", data: { dropped: 4 } });
  });

  test("no warning when every entry is usable", () => {
    const { logger, lines } = recordingLogger();
    catalogOverridesFrom([], logger);
    expect(lines).toEqual([]);
  });
});

function recorder() {
  const backendCalls: NativeBackendOptions[] = [];
  const created: CreateAgentSessionOptions[] = [];
  const resumed: { id: string; options: CreateAgentSessionOptions }[] = [];
  const backend = (options: NativeBackendOptions): SessionBackend => {
    backendCalls.push(options);
    return unusedBackend();
  };
  const create = async (options: CreateAgentSessionOptions): Promise<AgentSession> => {
    created.push(options);
    return fakeAgentSession(options.sessionId ?? "x", []).session;
  };
  const resume = async (id: string, options: CreateAgentSessionOptions): Promise<AgentSession> => {
    resumed.push({ id, options });
    return fakeAgentSession(id, []).session;
  };
  return { backendCalls, created, resumed, backend, create, resume };
}

const REQUEST = {
  sessionId: "s-1",
  cwd: "/w",
  model: "anthropic/claude-sonnet-5-5",
  profile: "ask" as const,
  bashApproval: "gated" as const,
  tools: [],
};

describe("nativeOpenSession (S5-3 M-21, M-22)", () => {
  test("no stored document: creates, with carryHistoryAcrossModels and the turn limit", async () => {
    const r = recorder();
    const transcripts = createMemoryTranscriptStore();
    const open = nativeOpenSession({ transcripts, catalogOverrides: [], turnTimeoutSeconds: 3600, ...r });
    const opened = await open(REQUEST);
    expect(opened.doc).toBeNull();
    expect(opened.session.id).toBe("s-1");
    expect(r.resumed).toEqual([]);
    expect(r.backendCalls).toEqual([
      { model: "anthropic/claude-sonnet-5-5", carryHistoryAcrossModels: true, bashApproval: "gated" },
    ]);
    expect(r.created[0]).toMatchObject({
      sessionId: "s-1",
      profile: "ask",
      workdir: "/w",
      transcriptStore: transcripts,
      turnTimeoutSeconds: 3600,
    });
  });

  test("a stored document: resumes that session and returns the document", async () => {
    const r = recorder();
    const transcripts = createMemoryTranscriptStore();
    await transcripts.save("s-1", { savedAt: "2026-10-09T00:00:00.000Z", messages: [{ role: "user", content: "hi" }] });
    const open = nativeOpenSession({ transcripts, catalogOverrides: [], turnTimeoutSeconds: 3600, ...r });
    const opened = await open(REQUEST);
    expect(opened.doc?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(r.created).toEqual([]);
    expect(r.resumed[0]?.id).toBe("s-1");
  });

  test("modes none and read pass no bashApproval; none passes no workdir", async () => {
    const r = recorder();
    const open = nativeOpenSession({
      transcripts: createMemoryTranscriptStore(),
      catalogOverrides: [],
      turnTimeoutSeconds: 3600,
      ...r,
    });
    await open({ ...REQUEST, profile: "read" });
    await open({ ...REQUEST, sessionId: "s-2", profile: "none" });
    expect(r.backendCalls.map((c) => "bashApproval" in c)).toEqual([false, false]);
    expect(r.created[0]).toMatchObject({ workdir: "/w" });
    expect(r.created[1]).not.toHaveProperty("workdir");
  });

  test("catalog overrides are passed only when there are some", async () => {
    const r = recorder();
    const open = nativeOpenSession({
      transcripts: createMemoryTranscriptStore(),
      catalogOverrides: [{ provider: "minimax", models: [] }],
      turnTimeoutSeconds: 3600,
      ...r,
    });
    await open(REQUEST);
    expect(r.backendCalls[0]).toMatchObject({ catalogOverrides: [{ provider: "minimax", models: [] }] });
  });

  test("compaction settings from the config are passed to the backend as given; absent passes none", async () => {
    const r = recorder();
    const base = { transcripts: createMemoryTranscriptStore(), catalogOverrides: [], turnTimeoutSeconds: 3600, ...r };
    await nativeOpenSession({ ...base, compaction: { compactAtPercent: 80 } })(REQUEST);
    await nativeOpenSession(base)({ ...REQUEST, sessionId: "s-2" });
    expect(r.backendCalls[0]).toMatchObject({ compaction: { compactAtPercent: 80 } });
    expect(r.backendCalls[1]).not.toHaveProperty("compaction");
  });

  test("defaults to the real facade: an invalid model is rejected by nativeBackend", async () => {
    const open = nativeOpenSession({
      transcripts: createMemoryTranscriptStore(),
      catalogOverrides: [],
      turnTimeoutSeconds: 3600,
    });
    await expect(open({ ...REQUEST, model: "" })).rejects.toMatchObject({ code: "AGENT_SESSION_INVALID_OPTIONS" });
  });

  test("passes MCP tools to the facade only when there are some", async () => {
    const r = recorder();
    const open = nativeOpenSession({
      transcripts: createMemoryTranscriptStore(),
      catalogOverrides: [],
      turnTimeoutSeconds: 60,
      create: r.create,
      resume: r.resume,
      backend: r.backend,
    });
    const tool: EmbedderTool = {
      name: "a__b",
      description: "[a] b",
      inputSchema: { type: "object", properties: {} },
      approval: "always",
      run: async () => ({ content: "" }),
    };
    await open({ sessionId: "s1", cwd: "/w", model: "m/x", profile: "ask", bashApproval: "gated", tools: [tool] });
    await open({ sessionId: "s2", cwd: "/w", model: "m/x", profile: "ask", bashApproval: "gated", tools: [] });
    expect(r.created[0]?.tools).toEqual([tool]);
    expect(r.created[1] !== undefined && "tools" in r.created[1]).toBe(false);
  });
});

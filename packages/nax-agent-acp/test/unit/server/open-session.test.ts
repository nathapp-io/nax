import { describe, expect, test } from "bun:test";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createMemoryTranscriptStore,
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

describe("nativeOpenSession", () => {
  test("opens the native backend with the request, a file store in the sessions dir and the turn limit", async () => {
    const backendCalls: NativeBackendOptions[] = [];
    const storeDirs: string[] = [];
    const created: CreateAgentSessionOptions[] = [];
    const stubBackend = unusedBackend();
    const open = nativeOpenSession({
      sessionsDir: "/cfg/.agent-server/sessions",
      catalogOverrides: [{ provider: "minimax", models: [] }],
      turnTimeoutSeconds: 3600,
      backend: (options) => {
        backendCalls.push(options);
        return stubBackend;
      },
      store: (dir) => {
        storeDirs.push(dir);
        return createMemoryTranscriptStore();
      },
      create: async (options): Promise<AgentSession> => {
        created.push(options);
        return fakeAgentSession(options.sessionId ?? "x", []).session;
      },
    });
    const session = await open({
      sessionId: "s-1",
      cwd: "/w",
      model: "anthropic/claude-sonnet-5-5",
      profile: "ask",
      bashApproval: "gated",
    });
    expect(session.id).toBe("s-1");
    expect(backendCalls).toEqual([
      {
        model: "anthropic/claude-sonnet-5-5",
        bashApproval: "gated",
        catalogOverrides: [{ provider: "minimax", models: [] }],
      },
    ]);
    expect(storeDirs).toEqual(["/cfg/.agent-server/sessions"]);
    expect(created[0]).toMatchObject({
      backend: stubBackend,
      sessionId: "s-1",
      profile: "ask",
      workdir: "/w",
      turnTimeoutSeconds: 3600,
    });
  });

  test("omits catalogOverrides when there are none", async () => {
    const backendCalls: NativeBackendOptions[] = [];
    const open = nativeOpenSession({
      sessionsDir: "/s",
      catalogOverrides: [],
      turnTimeoutSeconds: 3600,
      backend: (options) => {
        backendCalls.push(options);
        return unusedBackend();
      },
      store: () => createMemoryTranscriptStore(),
      create: async (options) => fakeAgentSession(options.sessionId ?? "x", []).session,
    });
    await open({ sessionId: "s", cwd: "/w", model: "m/x", profile: "read", bashApproval: "gated" });
    expect(backendCalls[0]).toEqual({ model: "m/x", bashApproval: "gated" });
  });

  test("defaults to the real facade: an invalid model is rejected by nativeBackend", async () => {
    const open = nativeOpenSession({ sessionsDir: "/s", catalogOverrides: [], turnTimeoutSeconds: 3600 });
    await expect(
      open({ sessionId: "s", cwd: "/w", model: "", profile: "read", bashApproval: "gated" }),
    ).rejects.toMatchObject({ code: "AGENT_SESSION_INVALID_OPTIONS" });
  });
});

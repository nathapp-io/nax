import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type AgentSession, createAgentSession, type SessionEvent } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import type { CommandShadow } from "#src/command-safety/types";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { nativeBackend } from "#src/session/native-backend";
import type { NativeBackendOptions } from "#src/session/native-backend-options";
import {
  installScriptedProvider,
  MODEL,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
  turnEndOf,
} from "#test/helpers/agent-session";
import {
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "#test/helpers/index";

describe("native backend opt-in asks", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);
  const sessions: AgentSession[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    try {
      await Promise.all(sessions.splice(0).map((session) => session.close()));
    } finally {
      for (const dir of dirs.splice(0)) cleanupTempDir(dir);
      resetScriptedProvider();
    }
  });
  async function open(options: Partial<NativeBackendOptions>) {
    const root = makeTempDir("nax-asks-");
    dirs.push(root);
    const provider = installScriptedProvider();
    const session = await createAgentSession(
      sessionOptions({
        profile: "full",
        workdir: root,
        backend: nativeBackend({ model: MODEL, bashApproval: "raw", ...options }),
      }),
    );
    sessions.push(session);
    return { provider, session };
  }
  async function bash({ provider, session }: Awaited<ReturnType<typeof open>>, input: Record<string, unknown>) {
    provider.push(
      toolRound([{ id: "bash1", name: "Bash", input: { command: "printf posture-ok", ...input } }]),
      textRound("done"),
    );
    const asks: Extract<SessionEvent, { type: "approval_requested" }>[] = [];
    const events: SessionEvent[] = [];
    for await (const event of session.send("run")) {
      events.push(event);
      if (event.type === "approval_requested") {
        asks.push(event);
        session.answer(event.requestId, { decision: "allow" });
      }
    }
    expect(turnEndOf(events).status).toBe("completed");
    expect(provider.requests.at(-1)?.messages.findLast((message) => message.role === "tool-result")).toMatchObject({
      toolCallId: "bash1",
      content: expect.stringContaining("posture-ok"),
    });
    return asks;
  }
  test("AC-5/6: escape asks under raw with reason, ordinary Bash in the same session does not", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const opened = await open({ allowUnsandboxedCommands: true, askOnUnsandboxed: true });
    expect(opened.session.backend.sandbox?.kind).toBe("available");
    const asks = await bash(opened, { unsandboxed: true, unsandboxedReason: "needs network" });
    expect(asks).toHaveLength(1);
    expect(asks[0]?.reason).toContain("needs network");
    expect(await bash(opened, {})).toEqual([]);
  });
  test("AC-7: without opt-in the raw escape never asks", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const opened = await open({ allowUnsandboxedCommands: true });
    expect(await bash(opened, { unsandboxed: true })).toEqual([]);
  });
  test.each(["unavailable", "disabled"] as const)(
    "AC-15/16/17: sandbox %s gates Bash and adapter permissions",
    async (kind) => {
      stubSessionSandboxDeps(_sessionSandboxDeps);
      _sessionSandboxDeps.probe = async () => ({ available: false, reason: "stub unavailable" });
      const spy = spyOn(NativeSessionAdapter.prototype, "openSession");
      try {
        const opened = await open({
          allowUnsandboxed: true,
          askWhenSandboxDown: true,
          ...(kind === "disabled" ? { sandbox: { enabled: false } } : {}),
        });
        expect((await bash(opened, {})).map((ask) => ask.tool)).toEqual(["Bash"]);
        expect(spy.mock.calls[0]?.[1].resolvedPermissions?.bashApproval).toBe("gated");
      } finally {
        spy.mockRestore();
      }
    },
  );
  test("AC-20/21: shadow flags an allowed raw Bash and observes it exactly once", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const observed: string[] = [];
    const shadow: CommandShadow = {
      observe(_key, obs) {
        observed.push(obs.command);
      },
      settle() {},
      async drain() {},
      guard: {
        threshold: 0.5,
        async assess() {
          return { flagged: true, score: 1, threshold: 0.5, basis: "rules" };
        },
      },
    };
    const opened = await open({ hostPorts: { commandShadow: shadow } });
    expect((await bash(opened, {})).map((ask) => ask.tool)).toEqual(["Bash"]);
    expect(observed).toEqual(["printf posture-ok"]);
  });
});

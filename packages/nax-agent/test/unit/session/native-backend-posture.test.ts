import { afterEach, describe, expect, test } from "bun:test";
import { type AgentSession, createAgentSession, type SessionEvent } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "#src/config/schemas-sandbox";
import { nativeBackend } from "#src/session/native-backend";
import type { NativeBackendOptions } from "#src/session/native-backend-options";
import {
  eventsOf,
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

describe("native backend posture in assembled sessions", () => {
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

  async function open(options: Partial<NativeBackendOptions> = {}) {
    const root = makeTempDir("nax-posture-");
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
    return { root, provider, session };
  }

  test("AC-1/2: matching Write asks before writing; unmatched Write in the same raw session does not", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const { root, provider, session } = await open({ askRules: ["Write(notes/**)"] });
    for (const [path, asks] of [
      ["notes/a.md", 1],
      ["src/a.ts", 0],
    ] as const) {
      provider.push(toolRound([{ id: path, name: "Write", input: { path, content: "saved" } }]), textRound("ok"));
      let asked = 0;
      const events: SessionEvent[] = [];
      for await (const event of session.send("write")) {
        events.push(event);
        if (event.type === "approval_requested") {
          asked++;
          expect(event.tool).toBe("Write");
          expect(await Bun.file(`${root}/${path}`).exists()).toBe(false);
          expect(session.answer(event.requestId, { decision: "allow" })).toBe("accepted");
        }
      }
      expect(asked).toBe(asks);
      expect(turnEndOf(events).status).toBe("completed");
      expect(await Bun.file(`${root}/${path}`).text()).toBe("saved");
    }
  });

  test.each([
    { ac: "AC-3", name: "Delete", input: { path: "keep/a.txt" }, options: { denyRules: ["Delete(keep/**)"] } },
    {
      ac: "AC-5",
      name: "Write",
      input: { path: "keep/a.txt", content: "changed" },
      options: { askRules: ["Write(keep/**)"], denyRules: ["Write(keep/**)"] },
    },
  ])("$ac: $name is denied before asking or mutating", async ({ name, input, options }) => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const { root, provider, session } = await open(options);
    await Bun.write(`${root}/keep/a.txt`, "original");
    provider.push(toolRound([{ id: "c1", name, input }]), textRound("ok"));
    const events: SessionEvent[] = [];
    for await (const event of session.send("try")) {
      events.push(event);
      if (event.type === "approval_requested") session.answer(event.requestId, { decision: "deny" });
    }
    expect(eventsOf(events, "approval_requested")).toEqual([]);
    expect(turnEndOf(events).status).toBe("completed");
    expect(provider.requests[1]?.messages.find((message) => message.role === "tool-result")).toMatchObject({
      toolCallId: "c1",
      denied: { breach: false },
    });
    expect(await Bun.file(`${root}/keep/a.txt`).text()).toBe("original");
  });

  test("AC-4: model-issued Bash receives a denial under raw while remaining unadvertised", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const { provider, session } = await open({ denyRules: ["Bash"] });
    provider.push(toolRound([{ id: "denied-bash", name: "Bash", input: { command: "echo never" } }]), textRound("ok"));
    const events: SessionEvent[] = [];
    for await (const event of session.send("try bash")) {
      events.push(event);
      if (event.type === "approval_requested") session.answer(event.requestId, { decision: "deny" });
    }
    expect(turnEndOf(events).status).toBe("completed");
    expect(eventsOf(events, "approval_requested")).toEqual([]);
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).not.toContain("Bash");
    expect(provider.requests[1]?.messages.find((message) => message.role === "tool-result")).toMatchObject({
      toolCallId: "denied-bash",
      content: expect.stringContaining("Denied:"),
      denied: { breach: false },
    });
    expect(seam.backend.calls).toEqual([]);
  });

  test("unknown model tool names remain errors rather than policy denials", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const { provider, session } = await open({ denyRules: ["Bash"] });
    provider.push(toolRound([{ id: "unknown", name: "NotADeclaredTool", input: {} }]), textRound("ok"));
    const events: SessionEvent[] = [];
    for await (const event of session.send("try unknown tool")) events.push(event);
    expect(turnEndOf(events).status).toBe("completed");
    expect(eventsOf(events, "approval_requested")).toEqual([]);
    const result = provider.requests[1]?.messages.find((message) => message.role === "tool-result");
    expect(result).toMatchObject({ toolCallId: "unknown", isError: true, content: 'Unknown tool "NotADeclaredTool"' });
    expect(result).not.toHaveProperty("denied");
  });

  test("host runCommand: unconditional Bash deny holds under raw without asking", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const { session } = await open({ denyRules: ["Bash"] });
    const asked: string[] = [];
    const result = await session.runCommand?.("echo never", (event) => {
      if (event.type === "approval_requested") {
        asked.push(event.tool);
        session.answer(event.requestId, { decision: "deny" });
      }
    });
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining("Denied") });
    expect(asked).toEqual([]);
  });

  test("AC-6: configured Write asks do not replace the gated profile Bash ask", async () => {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    const { provider, session } = await open({ bashApproval: "gated", askRules: ["Write(notes/**)"] });
    provider.push(toolRound([{ id: "b1", name: "Bash", input: { command: "echo never" } }]), textRound("ok"));
    const asked: string[] = [];
    for await (const event of session.send("try bash")) {
      if (event.type === "approval_requested") {
        asked.push(event.tool);
        session.answer(event.requestId, { decision: "deny" });
      }
    }
    expect(asked).toEqual(["Bash"]);
  });

  test("AC-19: partial sandbox is parsed/default-filled before reaching backendFor", async () => {
    const seam = stubSessionSandboxDeps(_sessionSandboxDeps);
    const configs: SandboxConfig[] = [];
    _sessionSandboxDeps.backendFor = (config) => {
      configs.push(config);
      return seam.backend;
    };
    await open({ sandbox: { network: { allowedDomains: ["registry.npmjs.org"] } }, allowUnsandboxed: true });
    expect(configs).toHaveLength(1);
    expect(configs[0]?.enabled).toBe(DEFAULT_SANDBOX_CONFIG.enabled);
    expect(configs[0]?.network.allowedDomains).toEqual(["registry.npmjs.org"]);
  });
});

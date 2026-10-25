import { afterEach, describe, expect, test } from "bun:test";
import { type AgentSession, createAgentSession, type SessionEvent } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { displayToolInput } from "#src/native/session/turn-event-emitter";
import {
  collect,
  eventsOf,
  installScriptedProvider,
  reader,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
} from "#test/helpers/agent-session";
import {
  assertDefined,
  cleanupTempDir,
  makeTempDir,
  stubSessionSandboxDeps,
  withDepsRestore,
  withSessionSandboxSeam,
} from "#test/helpers/index";

const sessions: AgentSession[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  resetScriptedProvider();
});

describe("AgentSession.runCommand", () => {
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);
  async function setup(ask = false, unsupported = false) {
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "unit test" });
    const provider = installScriptedProvider();
    const workdir = makeTempDir("run-command-");
    dirs.push(workdir);
    const options = sessionOptions({
      profile: "full",
      workdir,
      allowUnsandboxed: true,
      bashApproval: ask ? "gated" : "raw",
    });
    const backend = options.backend;
    const session = await createAgentSession({
      ...options,
      backend: unsupported
        ? {
            kind: backend.kind,
            async open(ctx) {
              const { runCommand: _ignored, ...rest } = await backend.open(ctx);
              return rest;
            },
          }
        : backend,
    });
    sessions.push(session);
    assertDefined(session.runCommand);
    return { session, run: session.runCommand.bind(session), provider, store: options.transcriptStore };
  }

  test("AC1-6,14,17: native command emits paired tools without model or transcript writes", async () => {
    const { session, run, provider, store } = await setup();
    expect(typeof session.runCommand).toBe("function");
    const before = await store.load(session.id);
    const events: SessionEvent[] = [];
    const result = await run("echo hi", (event) => events.push(event));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hi");
    const call = eventsOf(events, "tool_call")[0];
    assertDefined(call);
    expect(call).toMatchObject({ name: "Bash", input: { command: "echo hi" }, sessionId: session.id });
    expect(eventsOf(events, "tool_result")[0]).toMatchObject({ callId: call.callId, isError: false });
    expect(events.filter((e) => ["turn_start", "usage", "turn_end"].includes(e.type))).toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(await store.load(session.id)).toEqual(before);
    provider.push(textRound("hello"));
    expect(eventsOf(await collect(session.send("hi")), "turn_end")[0]?.status).toBe("completed");
  });

  test.each(["allow", "deny", "cancel", "close"] as const)("AC7-9,11,15,16: pending approval %s", async (action) => {
    const { session, run } = await setup(true);
    const asked = Promise.withResolvers<SessionEvent & { type: "approval_requested" }>();
    let settled = false;
    const command = run("echo hi", (event) => {
      if (event.type === "approval_requested" && event.answerable !== false) asked.resolve(event);
    }).then((result) => {
      settled = true;
      return result;
    });
    const event = await asked.promise;
    expect(event.tool).toBe("Bash");
    expect(() => session.send("hi")).toThrow(expect.objectContaining({ code: "AGENT_SESSION_BUSY" }));
    if (action === "cancel") session.cancel();
    else if (action === "close") {
      expect(settled).toBe(false);
      await session.close();
      expect(settled).toBe(true);
    } else expect(session.answer(event.requestId, { decision: action })).toBe("accepted");
    expect((await command).isError).toBe(action !== "allow");
  });

  test("AC10: a running send rejects commands", async () => {
    const { session, run, provider } = await setup(true);
    provider.push(toolRound([{ id: "bash", name: "Bash", input: { command: "echo hi" } }]));
    const stream = reader(session.send("hi"));
    expect(eventsOf(await stream.until("approval_requested"), "approval_requested")).toHaveLength(1);
    await expect(run("echo hi", () => {})).rejects.toMatchObject({ code: "AGENT_SESSION_BUSY" });
    session.cancel();
    await stream.rest();
  });
  test("AC12: backend without command capability rejects", async () => {
    const { run } = await setup(false, true);
    await expect(run("ls", () => {})).rejects.toMatchObject({ code: "AGENT_SESSION_CAPABILITY_UNSUPPORTED" });
  });
  test("AC13: closed session rejects commands", async () => {
    const { session, run } = await setup();
    await session.close();
    await expect(run("ls", () => {})).rejects.toMatchObject({ code: "AGENT_SESSION_CLOSED" });
  });
  test("AC18: command input uses model-call redaction", async () => {
    const { run } = await setup();
    const command = `echo sk-${"a".repeat(48)}`;
    const events: SessionEvent[] = [];
    await run(command, (e) => events.push(e));
    const input = eventsOf(events, "tool_call")[0]?.input;
    expect(input).toEqual(displayToolInput({ command }));
    expect(input).not.toEqual({ command });
  });
});

/**
 * S4-0: the "ask" profile through a live session (spec 4.5, 6.3). Every
 * mutating path tool is put to the person, Bash is forced "gated" so it asks
 * too, and the sandbox floor applies to "ask" exactly as it does to "full".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@nathapp/nax-agent";
import { _sessionSandboxDeps } from "#src/coding-tools/coding-tool-sandbox";
import { _agentSessionDeps } from "#src/session/agent-session-deps";
import {
  collect,
  eventsOf,
  installManualTimers,
  installScriptedProvider,
  reader,
  resetScriptedProvider,
  sessionOptions,
  textRound,
  toolRound,
  turnEndOf,
} from "#test/helpers/agent-session";
import { stubSessionSandboxDeps, withDepsRestore, withSessionSandboxSeam } from "#test/helpers/index";

afterEach(resetScriptedProvider);

describe("agent session: the ask profile", () => {
  withDepsRestore(_agentSessionDeps);
  withDepsRestore(_sessionSandboxDeps);
  withSessionSandboxSeam(_sessionSandboxDeps);

  async function askSession(workdir: string) {
    return createAgentSession(sessionOptions({ profile: "ask", workdir, allowUnsandboxed: true }));
  }

  function noSandbox(): void {
    installManualTimers();
    stubSessionSandboxDeps(_sessionSandboxDeps);
    _sessionSandboxDeps.probe = async () => ({ available: false, reason: "no sandbox in unit tests" });
  }

  test("a Write is put to the person and lands on disk only after allow", async () => {
    noSandbox();
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "w1", name: "Write", input: { path: "a.txt", content: "hi" } }]), textRound("done"));
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    const session = await askSession(workdir);
    const events = reader(session.send("write a.txt"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(request).toMatchObject({ callId: "w1", tool: "Write" });
    expect(existsSync(join(workdir, "a.txt"))).toBe(false);
    session.answer(request?.requestId ?? "", { decision: "allow" });
    const rest = await events.rest();
    expect(turnEndOf(rest).status).toBe("completed");
    expect(readFileSync(join(workdir, "a.txt"), "utf8")).toBe("hi");
    await session.close();
  });

  test("a denied Edit does not change the file", async () => {
    noSandbox();
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    writeFileSync(join(workdir, "b.txt"), "old");
    const provider = installScriptedProvider();
    provider.push(
      toolRound([{ id: "e1", name: "Edit", input: { path: "b.txt", old_string: "old", new_string: "new" } }]),
      textRound("done"),
    );
    const session = await askSession(workdir);
    const events = reader(session.send("edit b.txt"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(request).toMatchObject({ callId: "e1", tool: "Edit" });
    session.answer(request?.requestId ?? "", { decision: "deny" });
    const rest = await events.rest();
    expect(eventsOf(rest, "tool_result")[0]?.preview).toContain("Denied");
    expect(readFileSync(join(workdir, "b.txt"), "utf8")).toBe("old");
    await session.close();
  });

  test("a Delete asks and a denied Delete keeps the file", async () => {
    noSandbox();
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    writeFileSync(join(workdir, "c.txt"), "keep");
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "d1", name: "Delete", input: { path: "c.txt" } }]), textRound("done"));
    const session = await askSession(workdir);
    const events = reader(session.send("delete c.txt"));
    const [request] = eventsOf(await events.until("approval_requested"), "approval_requested");
    expect(request).toMatchObject({ callId: "d1", tool: "Delete" });
    session.answer(request?.requestId ?? "", { decision: "deny" });
    await events.rest();
    expect(existsSync(join(workdir, "c.txt"))).toBe(true);
    await session.close();
  });

  test("a Bash command asks before any tool result", async () => {
    noSandbox();
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "b1", name: "Bash", input: { command: "echo hi" } }]), textRound("done"));
    const session = await askSession(workdir);
    const events = reader(session.send("say hi"));
    const seen = await events.until("approval_requested");
    expect(eventsOf(seen, "tool_result")).toEqual([]);
    const [request] = eventsOf(seen, "approval_requested");
    expect(request).toMatchObject({ callId: "b1", tool: "Bash" });
    session.answer(request?.requestId ?? "", { decision: "deny" });
    expect(turnEndOf(await events.rest()).status).toBe("completed");
    await session.close();
  });

  test("full does not ask for a Write", async () => {
    noSandbox();
    const workdir = await mkdtemp(join(tmpdir(), "nax-agent-ask-"));
    const provider = installScriptedProvider();
    provider.push(toolRound([{ id: "w2", name: "Write", input: { path: "f.txt", content: "x" } }]), textRound("done"));
    const session = await createAgentSession(sessionOptions({ profile: "full", workdir, allowUnsandboxed: true }));
    const all = await collect(session.send("write f.txt"));
    expect(eventsOf(all, "approval_requested")).toEqual([]);
    expect(readFileSync(join(workdir, "f.txt"), "utf8")).toBe("x");
    await session.close();
  });
});

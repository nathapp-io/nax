import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession, SessionEvent, SessionMeta } from "@nathapp/nax-agent";
import { makeLogger, makeNaxConfig } from "@test/helpers";
import { createChatHost, createChatStorage } from "@/chat";

const hosts: ReturnType<typeof createChatHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});
const approval: SessionEvent = {
  sessionId: "command-session",
  turnId: "command",
  at: "now",
  metadata: {},
  type: "approval_requested",
  requestId: "ask-1",
  tool: "Bash",
  command: "git status",
  reason: "approve",
  summary: "status",
  expiresAt: "later",
};
function fixture() {
  const result = { isError: false, content: "clean" };
  const runCommand = mock(async (_command: string, onEvent: (event: SessionEvent) => void) => {
    onEvent(approval);
    return result;
  });
  const send = mock(() => (async function* () {})());
  const session: AgentSession = {
    id: "command-session",
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    send,
    runCommand,
    answer: () => "accepted",
    cancel() {},
    close: async () => {},
  };
  const meta: SessionMeta = {
    schemaVersion: 1,
    sessionId: session.id,
    cwd: "/r",
    mode: "ask",
    model: "model",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
  };
  const storage = createChatStorage({ pid: process.pid, now: () => new Date(), logger: makeLogger() });
  const writeMeta = mock(storage.writeMeta);
  storage.writeMeta = writeMeta;
  const host = createChatHost({
    config: makeNaxConfig(),
    cwd: "/r",
    repoRoot: "/r",
    chain: null,
    storage,
    now: () => new Date(),
    logger: makeLogger(),
    open: async () => ({ session, meta, release: async () => {} }),
  });
  hosts.push(host);
  return { host, session, runCommand, result, send, writeMeta };
}
describe("ChatHost.runCommand", () => {
  test("AC-1 delegates once and returns the session result without a model turn or metadata write", async () => {
    const f = fixture();
    await f.host.start({ mode: "guarded", model: "model" });
    const onEvent = mock((_event: SessionEvent) => {});
    expect(await f.host.runCommand?.("git status", onEvent)).toBe(f.result);
    expect(f.runCommand).toHaveBeenCalledTimes(1);
    expect(f.runCommand).toHaveBeenCalledWith("git status", expect.any(Function));
    expect(onEvent).toHaveBeenCalledWith(approval);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.writeMeta).not.toHaveBeenCalled();
  });
  test("AC-2 routes an approval to the pending asks", async () => {
    const f = fixture();
    await f.host.start({ mode: "guarded", model: "model" });
    await f.host.runCommand?.("git status", () => {});
    expect(f.host.asks.pending()).toEqual([expect.objectContaining({ requestId: "ask-1" })]);
  });
  test("reports an unsupported session capability", async () => {
    const f = fixture();
    delete f.session.runCommand;
    await f.host.start({ mode: "guarded", model: "model" });
    expect(await f.host.runCommand?.("git status", () => {})).toEqual({
      isError: true,
      content: "this session cannot run commands",
    });
  });
});

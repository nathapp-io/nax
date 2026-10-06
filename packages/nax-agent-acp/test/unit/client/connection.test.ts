import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PROTOCOL_VERSION, RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { type AcpLink, type InboundHandlers, openConnection } from "#src/client/connection";
import { type LaunchedAgent, launchAgent } from "#src/client/launch";
import { rejectLocally } from "#src/client/permissions";
import { race } from "#src/client/race";
import { buildFakeAgent } from "#test/fixtures/fake-agent/agent";
import type { FakeRecord, FakeScript } from "#test/fixtures/fake-agent/script";
import { FAKE_MAIN, fakeEnv } from "#test/helpers/fake-process";

const links: AcpLink[] = [];
const agents: LaunchedAgent[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const link of links.splice(0)) link.close();
  for (const agent of agents.splice(0)) agent.kill();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function pair(script: FakeScript, handlers: Partial<InboundHandlers> = {}) {
  const calls: FakeRecord[] = [];
  const updates: SessionNotification[] = [];
  const app = buildFakeAgent(script, {
    record: (method, params) => {
      calls.push({ method, params });
    },
    exit: () => {
      throw new Error("no exit in process");
    },
  });
  const link = openConnection(
    { kind: "app", agent: app },
    { onUpdate: (n) => updates.push(n), onPermission: async (r) => rejectLocally(r), ...handlers },
  );
  links.push(link);
  const callsTo = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);
  return { link, updates, callsTo };
}

// The SDK's agent-side param parsing fills clientCapabilities defaults, so the
// exact object we assert on must already carry them.
const INIT = {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } },
};

describe("openConnection: outbound requests (spec §6.1 connection)", () => {
  test("initialize, session/new, set_config_option and session/close reach the agent", async () => {
    const { link, callsTo } = pair({
      agentInfo: { name: "fake", version: "1.0.0" },
      configOptions: [
        { id: "mode", name: "Mode", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }] },
      ],
    });
    expect(await link.initialize(INIT)).toMatchObject({ protocolVersion: 1, agentInfo: { name: "fake" } });
    expect(callsTo("initialize")).toEqual([INIT]);
    expect((await link.newSession({ cwd: "/w", mcpServers: [] })).sessionId).toBe("fake-session-1");
    const set = await link.setConfigOption({ sessionId: "fake-session-1", configId: "mode", value: "a" });
    expect(set.configOptions).toHaveLength(1);
    await link.closeSession("fake-session-1");
    expect(callsTo("session/close")).toEqual([{ sessionId: "fake-session-1" }]);
  });

  test("session/update reaches onUpdate before the prompt resolves", async () => {
    const { link, updates } = pair({
      turns: [
        {
          steps: [
            { kind: "text", text: "a" },
            { kind: "text", text: "b" },
          ],
        },
      ],
    });
    await link.initialize(INIT);
    await link.newSession({ cwd: "/w", mcpServers: [] });
    const response = await link.prompt({ sessionId: "fake-session-1", prompt: [{ type: "text", text: "hi" }] });
    expect(response.stopReason).toBe("end_turn");
    expect(updates.map((u) => u.update.sessionUpdate)).toEqual(["agent_message_chunk", "agent_message_chunk"]);
  });

  test("a permission request reaches onPermission and its answer reaches the agent", async () => {
    const { link, callsTo } = pair({
      turns: [{ steps: [{ kind: "permission", options: ["allow_once", "reject_once"] }] }],
    });
    await link.initialize(INIT);
    await link.newSession({ cwd: "/w", mcpServers: [] });
    await link.prompt({ sessionId: "fake-session-1", prompt: [{ type: "text", text: "x" }] });
    expect(callsTo("permission-outcome")).toEqual([{ outcome: "selected", optionId: "opt-reject_once" }]);
  });

  test("session/cancel reaches the agent", async () => {
    const { link, callsTo } = pair({ turns: [{ steps: [{ kind: "waitForCancel" }] }] });
    await link.initialize(INIT);
    await link.newSession({ cwd: "/w", mcpServers: [] });
    const prompt = link.prompt({ sessionId: "fake-session-1", prompt: [{ type: "text", text: "x" }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await link.cancel("fake-session-1");
    expect((await prompt).stopReason).toBe("cancelled");
    expect(callsTo("session/cancel")).toEqual([{ sessionId: "fake-session-1" }]);
  });

  test("an agent's JSON-RPC error arrives as a RequestError with its code", async () => {
    const { link } = pair({ initializeFailure: { code: -32000, message: "login first" } });
    const raced = await race(link.initialize(INIT), { timeoutMs: 2_000 });
    if (raced.kind !== "failed") throw new Error(`expected failed, got ${raced.kind}`);
    expect(raced.error).toBeInstanceOf(RequestError);
    expect(raced.error instanceof RequestError ? raced.error.code : 0).toBe(-32000);
  });

  test("close() rejects a pending request and resolves closed", async () => {
    const { link } = pair({ hangInitialize: true });
    const pending = race(link.initialize(INIT), { timeoutMs: 2_000 });
    link.close();
    expect((await pending).kind).toBe("failed");
    expect((await race(link.closed, { timeoutMs: 2_000 })).kind).toBe("ok");
  });
});

describe("openConnection over a real subprocess", () => {
  function spawnFake(script: FakeScript, maxMessageBytes?: number): AcpLink {
    const dir = makeTempDir("acp-conn-");
    dirs.push(dir);
    const agent = launchAgent({
      command: process.execPath,
      args: [FAKE_MAIN],
      cwd: dir,
      env: fakeEnv(script, join(dir, "record.jsonl")),
      ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
    });
    agents.push(agent);
    const link = openConnection(agent.target, { onUpdate: () => {}, onPermission: async (r) => rejectLocally(r) });
    links.push(link);
    return link;
  }

  test("a line that is not JSON is skipped", async () => {
    const link = spawnFake({ startup: { garbageLine: true } });
    expect((await race(link.initialize(INIT), { timeoutMs: 10_000 })).kind).toBe("ok");
  });

  test("a frame over maxMessageBytes ends the connection: the pending request fails", async () => {
    const link = spawnFake({ startup: { oversizedLineBytes: 4_096 } }, 1_024);
    expect((await race(link.initialize(INIT), { timeoutMs: 10_000 })).kind).toBe("failed");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition } from "@nathapp/nax-test-kit/bun/timeout";
import type { ConnectSessionMcp } from "#src/server/mcp/connect";
import { createMcpSessionTools } from "#src/server/mcp/session-tools";
import type { OpenSessionRequest } from "#src/server/open-session";
import { type Script, turnEnd } from "#test/helpers/fake-agent-session";
import { OPTIONS, setupRegistry } from "#test/helpers/registry-setup";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-registry-mode-");
});
afterEach(() => cleanupTempDir(dir));

const connectGit: ConnectSessionMcp = async (input) => {
  const connection = {
    kind: "stdio" as const,
    pid: null,
    tools: [],
    call: async () => ({ text: "ok", isError: false, bytesBeforeCap: 2 }),
    onClose: () => {},
    close: async () => {},
  };
  const tools = createMcpSessionTools({
    servers: input.parsed.servers.map((s) => ({ name: s.name, connection })),
    tools: input.parsed.servers.map((s) => ({
      modelName: `${s.name}__t`,
      server: s.name,
      tool: "t",
      description: "t",
      inputSchema: { type: "object", properties: {} },
    })),
    scrub: (t) => t,
    onDisconnect: input.onDisconnect,
  });
  return { tools, noticeLines: [], scrub: (t) => t };
};

const SERVERS = [{ name: "git", command: "git-mcp", args: [], env: [] }];
const FULL = { ...OPTIONS, defaultMode: "full" as const, bashApproval: "raw" as const };
const metaOf = async (id: string) => JSON.parse(await readFile(join(dir, `${id}.session.json`), "utf8"));
const codeOf = (e: unknown) => (e instanceof RequestError ? e.code : 0);
const kinds = (updates: readonly SessionUpdate[]) => updates.map((u) => u.sessionUpdate);

const openedOf = (s: { opened: readonly OpenSessionRequest[] }) => {
  const { tools, ...rest } = s.opened.at(-1) ?? { tools: [] };
  return { ...rest, tools: tools.map((t) => t.name) };
};

async function viaSetMode(mode: string) {
  const s = setupRegistry(dir, FULL, { connectMcp: connectGit });
  const { sessionId } = await s.registry.create(s.input("/w", SERVERS));
  await s.registry.setMode(sessionId, mode);
  return { s, sessionId, meta: await metaOf(sessionId) };
}

async function viaConfig(mode: string) {
  const s = setupRegistry(dir, FULL, { connectMcp: connectGit });
  const { sessionId } = await s.registry.create(s.input("/w", SERVERS));
  const returned = await s.registry.setConfigOption(sessionId, "mode", mode);
  return { s, sessionId, returned, meta: await metaOf(sessionId) };
}

describe("mode as a config option", () => {
  test("session/new lists the mode option first, with the current mode", async () => {
    const s = setupRegistry(dir, FULL);
    const created = await s.registry.create(s.input());
    expect(created.configOptions[0]).toMatchObject({ id: "mode", category: "mode", currentValue: "full" });
    expect(created.modes.currentModeId).toBe("full");
  });

  for (const mode of ["read", "ask", "none"]) {
    test(`switching to ${mode} through the option equals set_mode`, async () => {
      const a = await viaSetMode(mode);
      const b = await viaConfig(mode);
      expect(openedOf(b.s)).toEqual(openedOf(a.s));
      expect(b.meta).toEqual(a.meta);
      expect(b.s.port.updates).toEqual(a.s.port.updates);
      expect(kinds(b.s.port.updates)).toContain("current_mode_update");
      expect(kinds(b.s.port.updates)).toContain("config_option_update");
      expect(b.returned[0]).toMatchObject({ id: "mode", currentValue: mode });
    });
  }

  test("ask forces bash approval gated, through the option too", async () => {
    const { s, sessionId } = await viaConfig("ask");
    expect(s.opened.at(-1)).toMatchObject({ profile: "ask", bashApproval: "gated" });
    expect((await metaOf(sessionId)).bashApproval).toBe("gated");
    const update = s.port.updates.find((u) => u.sessionUpdate === "config_option_update");
    expect(update).toMatchObject({
      configOptions: expect.arrayContaining([
        expect.objectContaining({ id: "mode", currentValue: "ask" }),
        expect.objectContaining({ id: "bashApproval", currentValue: "gated" }),
      ]),
    });
  });

  test("switching into read sends the MCP notice, and back to ask restores the tools", async () => {
    const { s, sessionId } = await viaConfig("read");
    const titles = s.port.updates.flatMap((u) => (u.sessionUpdate === "notice" ? [u.title] : []));
    expect(titles).toEqual(["MCP tools are off in read mode"]);
    expect(s.opened.at(-1)?.tools).toEqual([]);
    await s.registry.setConfigOption(sessionId, "mode", "ask");
    expect(s.opened.at(-1)?.tools.map((t) => t.name)).toEqual(["git__t"]);
  });

  test("an unknown mode value is invalid_params and changes nothing", async () => {
    const s = setupRegistry(dir, FULL);
    const { sessionId } = await s.registry.create(s.input());
    const error = await s.registry.setConfigOption(sessionId, "mode", "yolo").catch((e: unknown) => e);
    expect(codeOf(error)).toBe(-32602);
    expect(s.opened).toHaveLength(1);
  });

  test("an unchanged mode does not reopen or announce", async () => {
    const s = setupRegistry(dir, FULL);
    const { sessionId } = await s.registry.create(s.input());
    await s.registry.setConfigOption(sessionId, "mode", "full");
    expect(s.opened).toHaveLength(1);
    expect(s.port.updates).toEqual([]);
  });

  test("a change while a turn runs is rejected", async () => {
    const slow: Script = async function* ({ cancelled }) {
      yield { type: "turn_start" };
      await cancelled;
      yield turnEnd("cancelled");
    };
    const s = setupRegistry(dir, FULL, { scripts: [slow] });
    const { sessionId } = await s.registry.create(s.input());
    const running = s.registry.get(sessionId).prompt([{ type: "text", text: "go" }]);
    await waitForCondition(() => s.registry.get(sessionId).running);
    const error = await s.registry.setConfigOption(sessionId, "mode", "read").catch((e: unknown) => e);
    expect(error instanceof RequestError ? error.message : "").toContain("turn in progress");
    expect(s.opened).toHaveLength(1);
    s.registry.get(sessionId).cancel();
    await running;
  });
});

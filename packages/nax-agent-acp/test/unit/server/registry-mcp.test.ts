import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { EmbedderTool } from "@nathapp/nax-agent";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import type { ConnectSessionMcp, ConnectSessionMcpInput } from "#src/server/mcp/connect";
import { createMcpSessionTools } from "#src/server/mcp/session-tools";
import { OPTIONS, type RegistrySetupExtra, setupRegistry } from "#test/helpers/registry-setup";

let dir: string;
beforeEach(() => {
  dir = makeTempDir("acp-registry-mcp-");
});
afterEach(() => cleanupTempDir(dir));

const setup = (options = OPTIONS, extra: RegistrySetupExtra = {}) => setupRegistry(dir, options, extra);

interface McpRecord {
  readonly inputs: ConnectSessionMcpInput[];
  closes: number;
  disconnect?: (server: string, reason: string) => void;
}

function scriptedConnector(record: McpRecord, lines: string[] = []): ConnectSessionMcp {
  return async (input) => {
    record.inputs.push(input);
    record.disconnect = input.onDisconnect;
    const connection = {
      kind: "stdio" as const,
      pid: null,
      tools: [],
      call: async () => ({ text: "ok", isError: false, bytesBeforeCap: 2 }),
      onClose: () => {},
      close: async () => {
        record.closes += 1;
      },
    };
    const tools = createMcpSessionTools({
      servers: input.parsed.servers.map((s) => ({ name: s.name, connection })),
      tools: input.parsed.servers.map((s) => ({
        modelName: `${s.name}__t`,
        server: s.name,
        tool: "t",
        description: `[${s.name}] t`,
        inputSchema: { type: "object", properties: {} },
      })),
      scrub: (t) => t,
      onDisconnect: input.onDisconnect,
    });
    return { tools, noticeLines: lines, scrub: (t) => t };
  };
}

const SERVERS = [{ name: "git", command: "git-mcp", args: [], env: [] }];
const toolNames = (tools: readonly EmbedderTool[]) => tools.map((t) => `${t.name}:${t.approval}`);

describe("registry MCP", () => {
  test("session/new connects after the lock with the session cwd, and passes ask-mode tools", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup(OPTIONS, { connectMcp: scriptedConnector(record) });
    await s.registry.create(s.input("/w", SERVERS));
    expect(record.inputs[0]?.cwd).toBe("/w");
    expect(record.inputs[0]?.parsed.servers.map((x) => x.name)).toEqual(["git"]);
    expect(toolNames(s.opened[0]?.tools ?? [])).toEqual(["git__t:always"]);
  });

  test("structurally invalid mcpServers fail before credentials, lock or connect", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup(OPTIONS, { connectMcp: scriptedConnector(record) });
    await expect(s.registry.create(s.input("/w", [{ name: 1 }]))).rejects.toThrow("mcpServers[0]");
    expect(record.inputs).toEqual([]);
    expect(s.opened).toEqual([]);
  });

  test("the open notice and (read mode) the mode notice are queued for the first turn (M-37)", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup({ ...OPTIONS, defaultMode: "read" }, { connectMcp: scriptedConnector(record, ["`x`: failed"]) });
    const { sessionId } = await s.registry.create(s.input("/w", SERVERS));
    expect(s.port.updates).toEqual([]); // nothing before the response
    await s.registry.get(sessionId).prompt([{ type: "text", text: "hi" }]);
    const notices = s.port.updates.filter((u: SessionUpdate) => u.sessionUpdate === "notice");
    expect(notices.map((n) => (n as { title: string }).title)).toEqual([
      "Some MCP servers or tools are not available",
      "MCP tools are off in read mode",
    ]);
    expect(s.opened[0]?.tools).toEqual([]);
  });

  test("read -> ask switch keeps the same connection and offers the tools", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup({ ...OPTIONS, defaultMode: "read" }, { connectMcp: scriptedConnector(record) });
    const { sessionId } = await s.registry.create(s.input("/w", SERVERS));
    await s.registry.setMode(sessionId, "ask");
    expect(record.inputs).toHaveLength(1); // no reconnect
    expect(record.closes).toBe(0);
    expect(toolNames(s.opened[1]?.tools ?? [])).toEqual(["git__t:always"]);
    await s.registry.setMode(sessionId, "full");
    expect(toolNames(s.opened[2]?.tools ?? [])).toEqual(["git__t:never"]);
  });

  test("switching into read sends the mode notice immediately", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup(OPTIONS, { connectMcp: scriptedConnector(record) });
    const { sessionId } = await s.registry.create(s.input("/w", SERVERS));
    await s.registry.setMode(sessionId, "read");
    expect(
      s.port.updates.some(
        (u) => u.sessionUpdate === "notice" && (u as { title: string }).title === "MCP tools are off in read mode",
      ),
    ).toBe(true);
  });

  test("a disconnect sends one notice immediately", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup(OPTIONS, { connectMcp: scriptedConnector(record) });
    await s.registry.create(s.input("/w", SERVERS));
    record.disconnect?.("git", "the server process exited");
    await new Promise((r) => setTimeout(r, 0));
    expect(
      s.port.updates.filter((u) => u.sessionUpdate === "notice").map((n) => (n as { title: string }).title),
    ).toEqual(["MCP server `git` disconnected"]);
  });

  test("close, delete and shutdown close the connections", async () => {
    for (const end of ["close", "delete", "closeAll"] as const) {
      const record: McpRecord = { inputs: [], closes: 0 };
      const s = setup(OPTIONS, { connectMcp: scriptedConnector(record) });
      const { sessionId } = await s.registry.create(s.input("/w", SERVERS));
      if (end === "closeAll") await s.registry.closeAll();
      else await s.registry[end](sessionId);
      expect(record.closes).toBe(1);
    }
  });

  test("a failed facade open closes the connections and releases the lock", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup(OPTIONS, { connectMcp: scriptedConnector(record), failOpens: [1] });
    await expect(s.registry.create(s.input("/w", SERVERS))).rejects.toThrow("open 1 failed");
    expect(record.closes).toBe(1);
    await expect(s.registry.create(s.input("/w", SERVERS))).resolves.toBeDefined(); // lock was released
  });

  test("a failed switch restores the old mode's tools without reconnecting", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup(OPTIONS, { connectMcp: scriptedConnector(record), failOpens: [2] });
    const { sessionId } = await s.registry.create(s.input("/w", SERVERS));
    await expect(s.registry.setMode(sessionId, "full")).rejects.toThrow("open 2 failed");
    expect(toolNames(s.opened[1]?.tools ?? [])).toEqual(["git__t:never"]); // the attempt
    expect(toolNames(s.opened[2]?.tools ?? [])).toEqual(["git__t:always"]); // the restore
    expect(record.inputs).toHaveLength(1);
    expect(record.closes).toBe(0);
  });

  test("a metadata-write failure on create closes the connections", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup(OPTIONS, { connectMcp: scriptedConnector(record), failWriteMeta: true });
    await expect(s.registry.create(s.input("/w", SERVERS))).rejects.toThrow("disk full");
    expect(record.closes).toBe(1);
  });

  test("a replay failure on load closes the connections", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    // lastTurn "interrupted" makes load send a notice; failUpdates makes that send throw.
    const s = setup(OPTIONS, {
      connectMcp: scriptedConnector(record),
      lastTurn: { turnId: "t9", status: "interrupted" },
      failUpdates: true,
    });
    const { sessionId } = await s.registry.create(s.input("/w", SERVERS));
    await s.registry.close(sessionId);
    await expect(s.registry.load(sessionId, s.input("/w", SERVERS))).rejects.toThrow();
    expect(record.closes).toBe(2); // once for close, once for the failed load
  });

  test("shutdown while the facade opens closes the connections and refuses the open", async () => {
    let release: () => void = () => {};
    const openGate = new Promise<void>((r) => {
      release = r;
    });
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup(OPTIONS, { connectMcp: scriptedConnector(record), openGate });
    const pending = s.registry.create(s.input("/w", SERVERS));
    await new Promise((r) => setTimeout(r, 0));
    const closing = s.registry.closeAll();
    release();
    await expect(pending).rejects.toThrow("shutting down");
    await closing;
    expect(record.closes).toBe(1);
  });

  test("shutdown during connect aborts it and refuses the open", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const record: McpRecord = { inputs: [], closes: 0 };
    const inner = scriptedConnector(record);
    const s = setup(OPTIONS, {
      connectMcp: async (input) => {
        await gate;
        expect(input.signal.aborted).toBe(true);
        return inner(input);
      },
    });
    const pending = s.registry.create(s.input("/w", SERVERS));
    const closing = s.registry.closeAll();
    release();
    await expect(pending).rejects.toThrow("shutting down");
    await closing;
    expect(record.closes).toBe(1);
  });

  test("load of a closed session reconnects from the request's list; of an open one ignores it", async () => {
    const record: McpRecord = { inputs: [], closes: 0 };
    const s = setup(OPTIONS, { connectMcp: scriptedConnector(record) });
    const { sessionId } = await s.registry.create(s.input("/w", SERVERS));
    await s.registry.load(sessionId, s.input("/w", [{ name: "other", command: "o" }]));
    expect(record.inputs).toHaveLength(1); // open: ignored
    await s.registry.close(sessionId);
    await s.registry.load(sessionId, s.input("/w", [{ name: "other", command: "o" }]));
    expect(record.inputs[1]?.parsed.servers.map((x) => x.name)).toEqual(["other"]);
  });

  test("mcpServers are never written to session metadata", async () => {
    const s = setup(OPTIONS, { connectMcp: scriptedConnector({ inputs: [], closes: 0 }) });
    const { sessionId } = await s.registry.create(
      s.input("/w", [{ name: "g", command: "c", env: [{ name: "API_TOKEN", value: "tok-secret-123" }] }]),
    );
    const raw = await readFile(join(s.dir, `${sessionId}.session.json`), "utf8");
    expect(raw).not.toContain("tok-secret-123");
    expect(raw).not.toContain("mcp");
  });
});

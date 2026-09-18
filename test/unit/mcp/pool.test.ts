import { afterEach, describe, expect, test } from "bun:test";
import { withTimerSpy } from "@test/helpers";
import type { McpServerConfig } from "@/config";
import { _mcpClientDeps } from "@/mcp/client";
import { createMcpPool } from "@/mcp/pool";

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

interface Spawn {
  cwd: string;
  pid: number;
}

function fakeSdk(opts: { failFirst?: number; gate?: Promise<void>; listToolsFails?: number } = {}) {
  const spawns: Spawn[] = [];
  const closes: number[] = [];
  let attempts = 0;
  let listToolsAttempts = 0;
  let nextPid = 100;
  Object.assign(_mcpClientDeps, {
    createTransport: (params: { cwd: string }) => {
      const pid = nextPid++;
      spawns.push({ cwd: params.cwd, pid });
      return { pid, close: async () => void closes.push(pid) };
    },
    createClient: () => ({
      connect: async () => {
        attempts++;
        // A gate the test opens explicitly. A fixed sleep is banned in tests
        // (.nax/rules/forbidden-patterns-tests.md): flaky under load, and
        // additive on a suite Bun runs serially.
        if (await opts.gate) await opts.gate;
        if (opts.failFirst !== undefined && attempts <= opts.failFirst) throw new Error("ENOENT");
      },
      listTools: async () => {
        if (opts.listToolsFails !== undefined && listToolsAttempts++ < opts.listToolsFails) throw new Error("boom");
        return { tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] };
      },
      callTool: async (p: { name: string }) => ({ content: [{ type: "text", text: `ran ${p.name}` }] }),
      close: async () => {},
    }),
  });
  return { spawns, closes, attemptCount: () => attempts };
}

const servers: Record<string, McpServerConfig> = {
  memory: { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true },
};

describe("createMcpPool", () => {
  test("two workdirs against one server id produce two connections", async () => {
    const sdk = fakeSdk();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/work/a");
    await pool.listTools("memory", "/work/b");
    expect(sdk.spawns.map((s) => s.cwd)).toEqual(["/work/a", "/work/b"]);
    await pool.close();
  });

  test("repeated use of one key connects once and caches tools/list", async () => {
    const sdk = fakeSdk();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/w");
    await pool.listTools("memory", "/w");
    await pool.call("memory", "/w", "t", {}, { timeoutMs: 100, maxBytes: 1000 });
    expect(sdk.spawns.length).toBe(1);
    await pool.close();
  });

  test("concurrent first use of one key awaits a single in-flight connect", async () => {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const sdk = fakeSdk({ gate });
    const pool = createMcpPool({ servers });
    const all = Promise.all([
      pool.listTools("memory", "/w"),
      pool.listTools("memory", "/w"),
      pool.listTools("memory", "/w"),
    ]);
    open();
    await all;
    expect(sdk.spawns.length).toBe(1);
    await pool.close();
  });

  test("every spawned pid is registered, and unregistered on close", async () => {
    fakeSdk();
    const registered: number[] = [];
    const unregistered: number[] = [];
    const pool = createMcpPool({
      servers,
      pidRegistry: {
        register: async (pid) => void registered.push(pid),
        unregister: async (pid) => void unregistered.push(pid),
      },
    });
    await pool.listTools("memory", "/w");
    expect(registered.length).toBe(1);
    await pool.close();
    expect(unregistered).toEqual(registered);
  });

  test("close() twice is a no-op the second time", async () => {
    const sdk = fakeSdk();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/w");
    await pool.close();
    await pool.close();
    expect(sdk.closes.length).toBe(1);
  });

  test("a failing connect degrades: empty tool list, no throw, event recorded", async () => {
    fakeSdk({ failFirst: 99 });
    const pool = createMcpPool({ servers, retry: { maxAttempts: 2, baseDelayMs: 0 } });
    expect(await pool.listTools("memory", "/w")).toEqual([]);
    expect(pool.events().filter((e) => e.kind === "connect-failed").length).toBeGreaterThan(0);
    await pool.close();
  });

  test("connect is retried up to maxAttempts and then not retried again for that key", async () => {
    const sdk = fakeSdk({ failFirst: 99 });
    const pool = createMcpPool({ servers, retry: { maxAttempts: 2, baseDelayMs: 0 } });
    await pool.listTools("memory", "/w");
    await pool.listTools("memory", "/w");
    expect(sdk.attemptCount()).toBe(2);
    await pool.close();
  });

  test("a transient failure recovers within the attempt budget", async () => {
    fakeSdk({ failFirst: 1 });
    const pool = createMcpPool({ servers, retry: { maxAttempts: 3, baseDelayMs: 0 } });
    expect((await pool.listTools("memory", "/w")).map((t) => t.name)).toEqual(["t"]);
    await pool.close();
  });

  test("an unknown or disabled server yields no tools and never spawns", async () => {
    const sdk = fakeSdk();
    const pool = createMcpPool({ servers: { off: { ...servers.memory, enabled: false } } });
    expect(await pool.listTools("off", "/w")).toEqual([]);
    expect(await pool.listTools("nope", "/w")).toEqual([]);
    expect(sdk.spawns.length).toBe(0);
    await pool.close();
  });

  test("a call against an unreachable server returns an error result, not a throw", async () => {
    fakeSdk({ failFirst: 99 });
    const pool = createMcpPool({ servers, retry: { maxAttempts: 1, baseDelayMs: 0 } });
    const result = await pool.call("memory", "/w", "t", {}, { timeoutMs: 100, maxBytes: 1000 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable");
    await pool.close();
  });

  // MEM-5: the deadline timer must be cleared when callTool wins the race. The
  // prior inline `setTimeout(...).unref?.()` discarded the handle, so every
  // call — including this instant return — left a timer armed for the full
  // timeoutMs. `.unref()` does not release the allocation.
  test("the per-call deadline timer is cleared when the call wins the race", async () => {
    fakeSdk();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", "/w");
    const { leaked } = await withTimerSpy(() =>
      pool.call("memory", "/w", "t", {}, { timeoutMs: 60_000, maxBytes: 1000 }),
    );
    expect(leaked).toEqual([]);
    await pool.close();
  });

  test("a tools/list failure after connect reaps the connection, so no orphan survives", async () => {
    const sdk = fakeSdk({ listToolsFails: 1 });
    const registered: number[] = [];
    const unregistered: number[] = [];
    const pool = createMcpPool({
      servers,
      pidRegistry: {
        register: async (pid) => void registered.push(pid),
        unregister: async (pid) => void unregistered.push(pid),
      },
      retry: { maxAttempts: 2, baseDelayMs: 0 },
    });
    expect((await pool.listTools("memory", "/w")).map((t) => t.name)).toEqual(["t"]);
    expect(sdk.spawns.length).toBe(2);
    expect(sdk.closes.length).toBe(1);
    expect(unregistered).toEqual(registered.slice(0, 1));
    await pool.close();
    expect(sdk.closes.length).toBe(2);
    expect(unregistered).toEqual(registered);
  });
});

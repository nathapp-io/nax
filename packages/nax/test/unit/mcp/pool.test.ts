import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectMcpOptions, McpConnection, McpTransportConfig } from "@nathapp/nax-agent/mcp";
import { cleanupTempDir, makeTempDir, useUntrustedRegistry, withTimerSpy } from "@test/helpers";

/** nax run only ever configures stdio servers; this is the variant the fakes receive. */
type StdioConfig = Extract<McpTransportConfig, { kind: "stdio" }>;

import type { McpServerConfig } from "@/config";
import { _mcpClientDeps } from "@/mcp/client";
import { createMcpPool, redactMcpReason, redactMcpUrl } from "@/mcp/pool";
import { markTrusted } from "@/trust";

const original = { ..._mcpClientDeps };
afterEach(() => Object.assign(_mcpClientDeps, original));

interface Spawn {
  cwd: string;
  pid: number;
}

/** Fake of the SHARED connection handed back by `_mcpClientDeps.connect`; spawns are `connect(config)` calls. */
function cannedConnection(pid: number, closes: number[]): McpConnection {
  return {
    kind: "stdio",
    pid,
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    call: async (name: string) => ({ text: `ran ${name}`, isError: false, bytesBeforeCap: 0 }),
    onClose: () => {},
    close: async () => void closes.push(pid),
  };
}

function fakeSdk(opts: { failFirst?: number; gate?: Promise<void> } = {}) {
  const spawns: Spawn[] = [];
  const closes: number[] = [];
  let attempts = 0;
  let nextPid = 100;
  Object.assign(_mcpClientDeps, {
    connect: async (config: StdioConfig, options: ConnectMcpOptions) => {
      attempts++;
      // The spawn is recorded BEFORE the failure check, matching the real
      // layer: the transport is constructed (process started), then the
      // handshake may fail — a failed connect still started a subprocess.
      const pid = nextPid++;
      spawns.push({ cwd: config.cwd, pid });
      options.onSpawn?.(pid);
      // A gate the test opens explicitly. A fixed sleep is banned in tests
      // (.nax/rules/forbidden-patterns-tests.md): flaky under load, and
      // additive on a suite Bun runs serially.
      if (await opts.gate) await opts.gate;
      if (opts.failFirst !== undefined && attempts <= opts.failFirst) throw new Error("ENOENT");
      return cannedConnection(pid, closes);
    },
  });
  return { spawns, closes, attemptCount: () => attempts };
}

const servers: Record<string, McpServerConfig> = {
  memory: { command: "fake", args: [], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true },
};

describe("createMcpPool — US-005 trust backstop", () => {
  useUntrustedRegistry();
  let project = "";
  afterEach(() => cleanupTempDir(project));

  test("US-005 AC12: listTools rejects untrusted MCP with surface mcp", async () => {
    project = makeTempDir();
    fakeSdk();
    const pool = createMcpPool({ servers });
    await expect(pool.listTools("memory", project)).rejects.toMatchObject({
      code: "PROJECT_UNTRUSTED",
      context: { surface: "mcp" },
    });
  });

  test("US-005 AC13: listTools refuses before connecting", async () => {
    project = makeTempDir();
    let connects = 0;
    Object.assign(_mcpClientDeps, {
      connect: async (): Promise<McpConnection> => {
        connects++;
        throw new Error("must not be called");
      },
    });
    const pool = createMcpPool({ servers });
    await expect(pool.listTools("memory", project)).rejects.toMatchObject({ code: "PROJECT_UNTRUSTED" });
    expect(connects).toBe(0);
  });

  test("US-005 AC14: call rejects when the project is untrusted", async () => {
    project = makeTempDir();
    fakeSdk();
    const pool = createMcpPool({ servers });
    await expect(pool.call("memory", project, "t", {}, { timeoutMs: 1000, maxBytes: 1000 })).rejects.toMatchObject({
      code: "PROJECT_UNTRUSTED",
    });
  });

  test("US-005 AC15: trusted listTools creates one transport", async () => {
    project = makeTempDir();
    markTrusted(project);
    const sdk = fakeSdk();
    const pool = createMcpPool({ servers });
    await pool.listTools("memory", project);
    expect(sdk.spawns).toHaveLength(1);
    await pool.close();
  });
});

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

  test("a failed connect retries, registers every spawn and unregisters the failed pid", async () => {
    // tools/list now happens INSIDE the shared connect, so a mid-connect failure
    // rejects `connectMcpServer` itself: the shared layer has already closed the
    // half-open transport (pinned by nax-agent's connect tests) and the pool is
    // handed no connection to reap — the retry starts a fresh subprocess.
    const sdk = fakeSdk({ failFirst: 1 });
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
    expect(sdk.closes.length).toBe(0);
    expect(registered).toEqual([100, 101]);
    expect(unregistered).toEqual([100]);
    await pool.close();
    expect(sdk.closes.length).toBe(1);
    expect(unregistered).toEqual(registered);
  });
});

describe("US-007 MCP shutdown", () => {
  test("AC14-16,19: close aborts an in-flight open promptly, without retries or throwing", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    let attempts = 0;
    _mcpClientDeps.connect = async (_config, options) => {
      attempts++;
      started.resolve(options.signal);
      // A bounded watchdog lets the old, non-cancelling implementation finish;
      // this is not synchronization by sleep. The new path rejects on abort.
      const watchdog = AbortSignal.timeout(250);
      await new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        watchdog.addEventListener("abort", () => reject(new Error("watchdog")), { once: true });
      });
      throw new Error("unreachable");
    };
    const pool = createMcpPool({ servers, retry: { maxAttempts: 3, baseDelayMs: 0 } });
    const tools = pool.listTools("memory", "/w");
    const signal = await started.promise;
    const before = performance.now();
    await pool.close();
    const elapsed = performance.now() - before;
    expect({ aborted: signal.aborted, attempts, tools: await tools, prompt: elapsed < 200 }).toEqual({
      aborted: true,
      attempts: 1,
      tools: [],
      prompt: true,
    });
    expect(pool.events()).toContainEqual(expect.objectContaining({ kind: "connect-failed", serverId: "memory" }));
    expect(await pool.instructions?.("memory", "/w")).toBeUndefined();
    expect((await pool.call("memory", "/w", "t", {}, { timeoutMs: 100, maxBytes: 100 })).isError).toBe(true);
  });

  test("AC17-18: onSpawn registers synchronously during handshake; rejection unregisters afterwards", async () => {
    const started = Promise.withResolvers<ConnectMcpOptions>();
    const handshake = Promise.withResolvers<never>();
    const registered: number[] = [];
    const unregistered: number[] = [];
    _mcpClientDeps.connect = async (config, options) => {
      expect(config.kind).toBe("stdio");
      started.resolve(options);
      return handshake.promise;
    };
    const pool = createMcpPool({
      servers,
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      pidRegistry: {
        register: async (pid) => {
          registered.push(pid);
        },
        unregister: async (pid) => {
          unregistered.push(pid);
        },
      },
    });
    const tools = pool.listTools("memory", "/w");
    const options = await started.promise;
    const hasOnSpawn = typeof options.onSpawn === "function";
    options.onSpawn?.(4242);
    const during = { registered: [...registered], unregistered: [...unregistered] };
    handshake.reject(new Error("initialize failed"));
    expect(await tools).toEqual([]);
    expect({ hasOnSpawn, during, unregistered }).toEqual({
      hasOnSpawn: true,
      during: { registered: [4242], unregistered: [] },
      unregistered: [4242],
    });
    await pool.close();
  });
});

/** HTTP fakes: the connect seam records configs, hands back a pid-less connection, or rejects. */
function httpConnection(over: { callTool?: McpConnection["call"] } = {}): McpConnection {
  return {
    kind: "http",
    pid: null,
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    call: over.callTool ?? (async () => ({ text: "ok", isError: false, bytesBeforeCap: 2 })),
    onClose: () => {},
    close: async () => {},
  };
}

const HTTP_URL = "https://u:pw9@H/mcp?key=s3cret";

function httpServer(over: Partial<McpServerConfig> = {}): Record<string, McpServerConfig> {
  return { a: { url: HTTP_URL, args: [], env: {}, stages: ["*"], timeoutMs: 1000, enabled: true, ...over } };
}

function rejectingConnect(message: string): void {
  Object.assign(_mcpClientDeps, {
    connect: async (): Promise<McpConnection> => {
      throw new Error(message);
    },
  });
}

async function failedReason(servers: Record<string, McpServerConfig>, message: string): Promise<string> {
  rejectingConnect(message);
  const pool = createMcpPool({ servers, retry: { maxAttempts: 1, baseDelayMs: 0 } });
  await pool.listTools("a", "/w");
  const failed = pool.events().find((event) => event.kind === "connect-failed");
  await pool.close();
  return failed?.kind === "connect-failed" ? failed.reason : "";
}

describe("createMcpPool — HTTP servers (US-002)", () => {
  test("AC-16: the url is passed to the client connect seam", async () => {
    const configs: McpTransportConfig[] = [];
    Object.assign(_mcpClientDeps, {
      connect: async (config: McpTransportConfig) => {
        configs.push(config);
        return httpConnection();
      },
    });
    const pool = createMcpPool({ servers: httpServer({ url: "https://h/mcp", headers: { k: "v" } }) });
    await pool.listTools("a", "/w");
    await pool.close();
    expect(configs).toEqual([{ kind: "http", url: "https://h/mcp", headers: { k: "v" } }]);
  });

  test("AC-17: a pid-less connection records a connected event with pid null", async () => {
    Object.assign(_mcpClientDeps, { connect: async () => httpConnection() });
    const pool = createMcpPool({ servers: httpServer({ url: "https://h/mcp" }) });
    await pool.listTools("a", "/w");
    await pool.close();
    expect(pool.events()).toContainEqual(expect.objectContaining({ kind: "connected", pid: null, toolCount: 1 }));
  });

  test("AC-18: the pid registry's register is never called", async () => {
    Object.assign(_mcpClientDeps, { connect: async () => httpConnection() });
    const registered: number[] = [];
    const pool = createMcpPool({
      servers: httpServer({ url: "https://h/mcp" }),
      pidRegistry: {
        register: async (pid) => void registered.push(pid),
        unregister: async () => {},
      },
    });
    await pool.listTools("a", "/w");
    await pool.close();
    expect(registered).toEqual([]);
  });

  test("AC-20: a failure naming the url's href does not leak the query secret", async () => {
    const reason = await failedReason(httpServer(), `cannot reach ${new URL(HTTP_URL).href}`);
    expect(reason).not.toContain("s3cret");
  });

  test("AC-21: a failure naming only the query pair does not leak the query secret", async () => {
    const reason = await failedReason(httpServer(), "bad param key=s3cret");
    expect(reason).not.toContain("s3cret");
  });

  test("AC-22: a failure naming the url password does not leak it", async () => {
    const reason = await failedReason(httpServer(), "auth failed for pw9");
    expect(reason).not.toContain("pw9");
  });

  test("AC-23: a failure naming a header token does not leak it", async () => {
    const servers = httpServer({ url: "https://h/mcp", headers: { Authorization: "Bearer tok123" } });
    const reason = await failedReason(servers, "rejected tok123");
    expect(reason).not.toContain("tok123");
  });

  test("AC-24: an error thrown by callTool does not leak the header token into call() content", async () => {
    Object.assign(_mcpClientDeps, {
      connect: async () =>
        httpConnection({
          callTool: async () => {
            throw new Error("upstream rejected tok123");
          },
        }),
    });
    const servers = httpServer({ url: "https://h/mcp", headers: { Authorization: "Bearer tok123" } });
    const pool = createMcpPool({ servers });
    const result = await pool.call("a", "/w", "t", {}, { timeoutMs: 1000, maxBytes: 1000 });
    await pool.close();
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("tok123");
  });
});

describe("redactMcpReason", () => {
  test("covers raw, decoded and encoded forms of every secret part", () => {
    const server = httpServer({ url: "https://us%40r:p%20w@h/mcp?k=a%26b#frag%21", headers: { X: "a b/c" } }).a;
    if (server === undefined) throw new Error("fixture");
    const text = "us%40r us@r p%20w p w a%26b a&b frag%21 frag! a%20b%2Fc a b/c";
    expect(redactMcpReason(text, server)).not.toMatch(/us%40r|us@r|p%20w|a%26b|frag|b\/c/);
  });

  test("F2: redacts the percent-encoded form of a raw secret that already contains percent signs", () => {
    const server = httpServer({ url: "https://h/mcp", headers: { Authorization: "Bearer tok%2F123" } }).a;
    if (server === undefined) throw new Error("fixture");
    const out = redactMcpReason("rejected tok%2F123 / tok/123 / tok%252F123", server);
    expect(out).not.toMatch(/tok%2F123|tok\/123|tok%252F123/);
  });

  test("F2: redacts the encoded form of a url secret that contains percent signs", () => {
    const server = httpServer({ url: "https://h/mcp?k=a%2Fb" }).a;
    if (server === undefined) throw new Error("fixture");
    expect(redactMcpReason("bad a%252Fb and a%2Fb and a/b", server)).not.toMatch(/a%252Fb|a%2Fb|a\/b/);
  });

  test("leaves text alone for a server with nothing secret", () => {
    const server = httpServer({ url: "https://h/mcp" }).a;
    if (server === undefined) throw new Error("fixture");
    expect(redactMcpReason("connection refused", server)).toBe("connection refused");
  });
});

describe("redactMcpUrl", () => {
  test("F5: keeps the endpoint and hides credentials, query values and fragment", () => {
    const out = redactMcpUrl("https://u:pw9@docs.example/mcp?key=s3cret&b=2#frag");
    expect(out).toContain("docs.example/mcp");
    expect(out).not.toMatch(/pw9|s3cret|frag|u:/);
  });

  test("F5: a url with nothing secret is unchanged", () => {
    expect(redactMcpUrl("https://docs.example/mcp")).toBe("https://docs.example/mcp");
  });

  test("F5: an unparseable url is not echoed", () => {
    expect(redactMcpUrl("not a url s3cret")).not.toContain("s3cret");
  });
});

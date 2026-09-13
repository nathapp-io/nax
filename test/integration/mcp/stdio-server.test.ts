import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertDefined } from "@test/helpers";
import { runMcpLockCommand } from "@/cli/mcp";
import type { McpServerConfig } from "@/config";
import type { McpLockFile } from "@/mcp/lock";
import { schemaHash } from "@/mcp/lock";
import { createMcpPool } from "@/mcp/pool";
import { createMcpProviders } from "@/mcp/provider";
import type { ToolRunContext } from "@/tools";

const FIXTURE = resolve(import.meta.dir, "../../fixtures/mcp/fake-server.ts");
const dirs: string[] = [];
const pools: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map((p) => p.close()));
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "nax-mcp-it-"));
  dirs.push(dir);
  return dir;
};

const serverConfig = (env: Record<string, string> = {}, over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  command: "bun",
  args: [FIXTURE],
  env,
  stages: ["*"],
  timeoutMs: 3_000,
  enabled: true,
  ...over,
});

/** Lock the tool set the fixture currently advertises, so `applyLock` admits it. */
async function lockFor(
  p: ReturnType<typeof createMcpPool>,
  dir: string,
  ids: string[] = ["memory"],
): Promise<McpLockFile> {
  const servers: McpLockFile["servers"] = {};
  for (const id of ids) {
    const tools = await p.listTools(id, dir);
    servers[id] = Object.fromEntries(tools.map((tool) => [tool.name, schemaHash(tool.inputSchema)]));
  }
  return { version: 1, servers };
}

function pool(env: Record<string, string> = {}) {
  const created = createMcpPool({ servers: { memory: serverConfig(env) }, retry: { maxAttempts: 1, baseDelayMs: 0 } });
  pools.push(created);
  return created;
}

const ctx = (root: string, maxBytes = 40_000): ToolRunContext => ({
  root,
  resolvedPaths: [],
  maxBytes,
  maxFileBytes: 1,
});

describe("real stdio MCP server", () => {
  test("discovers the advertised tool set over the real protocol", async () => {
    const tools = await pool().listTools("memory", await tempDir());
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  test("R7: two workdirs get two subprocesses, each answering from ITS OWN cwd", async () => {
    const [a, b] = [await tempDir(), await tempDir()];
    const p = pool();
    const lock = await lockFor(p, a);
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig() } },
      pool: p,
      projectRoot: a,
      readLock: async () => lock,
    });
    const [provider] = providers;
    assertDefined(provider, "provider");

    const [toolA] = await provider.tools(a);
    const [toolB] = await provider.tools(b);
    assertDefined(toolA, "toolA");
    assertDefined(toolB, "toolB");
    const resultA = await toolA.run({ q: "1" }, ctx(a));
    const resultB = await toolB.run({ q: "2" }, ctx(b));

    // The whole point of R7: a cwd-scoped server must answer per worktree.
    expect(resultA.content).toContain(a);
    expect(resultB.content).toContain(b);
    expect(resultA.content).not.toContain(b);
  });

  test("a server that dies on call yields an error result and the run continues", async () => {
    const dir = await tempDir();
    const p = pool({ FAKE_MCP_DIE_ON_CALL: "1" });
    const lock = await lockFor(p, dir);
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig({ FAKE_MCP_DIE_ON_CALL: "1" }) } },
      pool: p,
      projectRoot: dir,
      readLock: async () => lock,
    });
    const [provider] = providers;
    assertDefined(provider, "provider");
    const [tool] = await provider.tools(dir);
    assertDefined(tool, "tool");
    expect((await tool.run({}, ctx(dir))).isError).toBe(true);
  }, 20_000);

  test("a hanging call is bounded by timeoutMs", async () => {
    const dir = await tempDir();
    const p = pool({ FAKE_MCP_HANG_ON_CALL: "1" });
    const lock = await lockFor(p, dir);
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig({ FAKE_MCP_HANG_ON_CALL: "1" }, { timeoutMs: 500 }) } },
      pool: p,
      projectRoot: dir,
      readLock: async () => lock,
    });
    const [provider] = providers;
    assertDefined(provider, "provider");
    const [tool] = await provider.tools(dir);
    assertDefined(tool, "tool");
    const started = Date.now();
    expect((await tool.run({}, ctx(dir))).isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  test("a large result is truncated to maxBytes and reports its true size", async () => {
    const dir = await tempDir();
    const p = pool({ FAKE_MCP_BIG_RESULT: "500000" });
    const lock = await lockFor(p, dir);
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig({ FAKE_MCP_BIG_RESULT: "500000" }) } },
      pool: p,
      projectRoot: dir,
      readLock: async () => lock,
    });
    const [provider] = providers;
    assertDefined(provider, "provider");
    const [tool] = await provider.tools(dir);
    assertDefined(tool, "tool");
    const result = await tool.run({}, ctx(dir, 1_000));
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(1_000);
    expect(result.resultBytesPreTruncation).toBe(500_000);
  }, 20_000);

  test("nax mcp lock writes a lock, and a server upgrade is then withheld", async () => {
    const dir = await tempDir();
    await Bun.write(
      join(dir, ".nax", "config.json"),
      JSON.stringify({
        name: "probe",
        mcp: { servers: { memory: { command: "bun", args: [FIXTURE], stages: ["*"] } } },
      }),
    );
    await runMcpLockCommand(dir);
    const locked = JSON.parse(await Bun.file(join(dir, ".nax", "mcp-lock.json")).text());
    expect(Object.keys(locked.servers.memory)).toEqual(["echo"]);

    // The server now advertises a second tool. It must NOT be grantable.
    const p = pool({ FAKE_MCP_TOOL_SUFFIX: "danger" });
    const providers = createMcpProviders({
      config: { servers: { memory: serverConfig({ FAKE_MCP_TOOL_SUFFIX: "danger" }) } },
      pool: p,
      projectRoot: dir,
    });
    const [provider] = providers;
    assertDefined(provider, "provider");
    expect((await provider.tools(dir)).map((t) => t.localName)).toEqual(["echo"]);
  }, 30_000);
});

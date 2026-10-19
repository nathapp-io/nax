/**
 * SEAM-3: `resolveMcpLock` is `createMcpProviders`' default lock read.
 *
 * Every provider here is constructed with NO `readLock` override, so the lock
 * comes off the real filesystem: the project's `.nax/mcp-lock.json` if there is
 * one, otherwise the global lock the operator wrote with `nax mcp lock --global`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ToolProvider } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import type { McpServerConfig } from "@/config";
import type { McpLockFile } from "@/mcp/lock";
import { readMcpLock, schemaHash } from "@/mcp/lock";
import type { McpPool } from "@/mcp/pool";
import { createMcpProviders, type McpWithheldEntry } from "@/mcp/provider";
import type { McpToolDescriptor } from "@/mcp/types";

const schema = { type: "object", properties: { q: { type: "string" } } };
const descriptors: McpToolDescriptor[] = [
  { name: "search_graph", description: "Search the graph", inputSchema: schema },
  { name: "delete_project", description: "Danger", inputSchema: schema },
];

const server: McpServerConfig = {
  command: "fake",
  args: [],
  env: {},
  stages: ["run"],
  timeoutMs: 1234,
  enabled: true,
};

const pool: McpPool = {
  listTools: async () => descriptors,
  call: async () => ({ content: "ok", isError: false, bytesPreTruncation: 2 }),
  events: () => [],
  close: async () => {},
};

let projectRoot: string;
let globalDir: string;
let previousGlobalDir: string | undefined;

beforeEach(() => {
  projectRoot = makeTempDir("nax-mcp-global-lock-project-");
  globalDir = makeTempDir("nax-mcp-global-lock-global-");
  previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
});

afterEach(() => {
  if (previousGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
  cleanupTempDir(projectRoot);
  cleanupTempDir(globalDir);
});

/** The global lock pins ONLY `search_graph`, so `delete_project` must be withheld. */
async function writeGlobalLock(): Promise<void> {
  await Bun.write(
    join(globalDir, "mcp-lock.json"),
    JSON.stringify({ version: 1, servers: { memory: { search_graph: schemaHash(schema) } } }),
  );
}

function build(readLock?: (projectRoot: string) => Promise<McpLockFile | undefined>): {
  provider: ToolProvider;
  withheld: McpWithheldEntry[];
} {
  const withheld: McpWithheldEntry[] = [];
  const [provider] = createMcpProviders({
    config: { servers: { memory: server } },
    pool,
    projectRoot,
    ...(readLock === undefined ? {} : { readLock }),
    onWithheld: (entry) => withheld.push(entry),
  });
  assertDefined(provider, "provider");
  return { provider, withheld };
}

describe("createMcpProviders default lock read", () => {
  test("AC-7: admits a tool pinned by the global lock when the project has no lock", async () => {
    await writeGlobalLock();

    const { provider } = build();

    expect((await provider.tools(projectRoot)).map((t) => t.localName)).toEqual(["search_graph"]);
  });

  test("AC-8: reports a tool absent from the global lock with lockSource global", async () => {
    await writeGlobalLock();

    const { provider, withheld } = build();
    await provider.tools(projectRoot);

    expect(withheld).toEqual([
      { serverId: "memory", name: "delete_project", reason: "absent-from-lock", lockSource: "global" },
    ]);
  });

  test("the project-only reader alone withholds everything under the same fixture", async () => {
    // Not an AC: the contrast that makes AC-7 discriminating. `readMcpLock` is
    // the pre-US-002 default and reads the project path only, so the same global
    // lock that AC-7 admits through buys nothing when it is passed explicitly.
    await writeGlobalLock();

    const { provider, withheld } = build(readMcpLock);
    expect(await provider.tools(projectRoot)).toEqual([]);
    expect(withheld.map((entry) => entry.lockSource)).toEqual(["none", "none"]);
  });
});

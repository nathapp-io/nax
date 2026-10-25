import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMockRuntime, makeNaxConfig, makePRD, withDepsRestore, withTempDir } from "@test/helpers";
import type { McpServerConfig, NaxConfig } from "@/config";
import { _runSetupDeps, type RunSetupOptions, setupRun } from "@/execution/lifecycle/run-setup";
import type { McpLockFile } from "@/mcp";
import { buildResourceCatalog, type loadResourceCatalog, type ResourcePackage } from "@/resources";
import type { NaxRuntime } from "@/runtime";

const PROJECT = { kind: "claude-project" } as const;

const catalogPackage: ResourcePackage = {
  id: "claude-project",
  origin: PROJECT,
  root: "/repo",
  skills: [],
  commands: [],
  agents: [],
  mcpServers: [
    {
      kind: "mcp",
      name: "ctx",
      transport: "stdio",
      scope: "project",
      server: { transport: "stdio", command: "npx", args: [], env: {} },
      path: "/repo/.mcp.json",
      origin: PROJECT,
    },
  ],
  hooks: [],
  diagnostics: [],
};

const configuredServer: McpServerConfig = {
  command: "mine",
  args: [],
  env: {},
  headers: {},
  stages: ["run"],
  timeoutMs: 5,
  enabled: true,
};

describe("setupRun → resources.mcpInRun", () => {
  withDepsRestore(_runSetupDeps);

  const runtimes: NaxRuntime[] = [];
  afterEach(async () => {
    await Promise.allSettled(runtimes.map((r) => r.close()));
    runtimes.length = 0;
  });

  let received: NaxConfig[];
  let catalogLoads: number;

  async function drive(
    config: NaxConfig,
    lock: McpLockFile | null = { version: 1, servers: { ctx: { t: "h" } } },
  ): Promise<void> {
    received = [];
    catalogLoads = 0;
    await withTempDir(async (workdir) => {
      const prdPath = join(workdir, "prd.json");
      writeFileSync(prdPath, JSON.stringify(makePRD({ feature: "mcp-in-run", userStories: [] })), "utf8");
      _runSetupDeps.createRuntime = ((cfg: NaxConfig, dir: string) => {
        received.push(cfg);
        const rt = makeMockRuntime({ workdir: dir });
        runtimes.push(rt);
        return rt;
      }) as typeof _runSetupDeps.createRuntime;
      _runSetupDeps.installCrashHandlers = (() => () => {}) as typeof _runSetupDeps.installCrashHandlers;
      _runSetupDeps.detectProjectProfile = (async () => ({})) as typeof _runSetupDeps.detectProjectProfile;
      _runSetupDeps.loadResourceCatalog = (async () => {
        catalogLoads++;
        return buildResourceCatalog([catalogPackage]);
      }) as typeof loadResourceCatalog;
      _runSetupDeps.readMcpLock = async () => (lock === null ? undefined : { ...lock, source: "project" });
      const options: RunSetupOptions = {
        prdPath,
        workdir,
        config,
        hooks: { hooks: {} },
        feature: "mcp-in-run",
        dryRun: false,
        statusFile: join(workdir, "status.json"),
        runId: `run-mcp-${Date.now()}`,
        startedAt: new Date().toISOString(),
        startTime: Date.now(),
        skipPrecheck: true,
        headless: true,
        formatterMode: "quiet",
        getTotalCost: () => 0,
        getIterations: () => 0,
        getStoriesCompleted: () => 0,
        getTotalStories: () => 0,
      };
      // setupRun may fail at a later step; createRuntime is called before it.
      await setupRun(options).catch(() => {});
    });
  }

  test("AC-12 attaches a locked catalog server to the runtime config at every stage", async () => {
    await drive(makeNaxConfig({ resources: { mcpInRun: true } }));

    expect(received[0]?.mcp?.servers.ctx).toBeDefined();
    expect(received[0]?.mcp?.servers.ctx?.stages).toEqual(["*"]);
  });

  test("AC-13 withholds a catalog server the lock does not list", async () => {
    await drive(makeNaxConfig({ resources: { mcpInRun: true } }), { version: 1, servers: { other: {} } });

    expect(received[0]?.mcp?.servers.ctx).toBeUndefined();
  });

  test("a catalog server is withheld when there is no lock at all", async () => {
    await drive(makeNaxConfig({ resources: { mcpInRun: true } }), null);

    expect(received[0]?.mcp?.servers.ctx).toBeUndefined();
  });

  test("configured servers survive the merge whatever the lock says", async () => {
    const config = makeNaxConfig({ resources: { mcpInRun: true }, mcp: { servers: { a: configuredServer } } });
    await drive(config, { version: 1, servers: {} });

    expect(received[0]?.mcp?.servers.a).toEqual(configuredServer);
  });

  test("AC-14 passes the very config object it was given when mcpInRun is false", async () => {
    const config = makeNaxConfig({ resources: { mcpInRun: false } });
    await drive(config);

    expect(received[0]).toBe(config);
  });

  test("AC-15 never loads the catalog when mcpInRun is false", async () => {
    await drive(makeNaxConfig({ resources: { mcpInRun: false } }));

    expect(catalogLoads).toBe(0);
  });

  test("AC-17 keeps only configured servers when mcpInRun is true and claudeCode is false", async () => {
    const config = makeNaxConfig({
      resources: { mcpInRun: true, claudeCode: false },
      mcp: { servers: { a: configuredServer } },
    });
    await drive(config);

    expect(Object.keys(received[0]?.mcp?.servers ?? {})).toEqual(["a"]);
    expect(catalogLoads).toBe(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpRollup, writeMcpRollup } from "@/mcp/rollup";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.allSettled(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const at = "2026-09-13T00:00:00.000Z";

describe("buildMcpRollup", () => {
  test("answers 'was this server actually attached?' per server", () => {
    const rollup = buildMcpRollup({
      runId: "r1",
      withheld: [{ serverId: "memory", name: "delete_project", reason: "absent-from-lock" }],
      events: [
        { kind: "connected", serverId: "memory", workdir: "/a", at, pid: 1, toolCount: 3 },
        { kind: "connected", serverId: "memory", workdir: "/b", at, pid: 2, toolCount: 3 },
        { kind: "connect-failed", serverId: "docs", workdir: "/a", at, reason: "ENOENT", attempt: 1 },
      ],
    });
    expect(rollup.servers).toEqual([
      { serverId: "memory", workdirs: 2, connected: 2, failed: 0, toolsAdvertised: 3 },
      { serverId: "docs", workdirs: 1, connected: 0, failed: 1, toolsAdvertised: 0 },
    ]);
    expect(rollup.withheld.length).toBe(1);
  });

  test("an empty run rolls up to nothing", () => {
    expect(buildMcpRollup({ runId: "r1", events: [], withheld: [] }).servers).toEqual([]);
  });
});

describe("writeMcpRollup", () => {
  test("writes <outputDir>/mcp/<runId>-servers.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nax-mcp-rollup-"));
    dirs.push(dir);
    await writeMcpRollup(
      dir,
      buildMcpRollup({
        runId: "r1",
        withheld: [{ serverId: "memory", name: "delete_project", reason: "absent-from-lock" }],
        events: [],
      }),
    );
    expect(await Bun.file(join(dir, "mcp", "r1-servers.json")).exists()).toBe(true);
  });

  test("writes nothing when there is nothing to say", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nax-mcp-rollup-"));
    dirs.push(dir);
    await writeMcpRollup(dir, { runId: "r1", servers: [], withheld: [], events: [] });
    expect(await Bun.file(join(dir, "mcp", "r1-servers.json")).exists()).toBe(false);
  });
});

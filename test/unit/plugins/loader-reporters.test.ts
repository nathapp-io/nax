import { afterEach, describe, expect, test } from "bun:test";
import { loadPlugins } from "@/plugins";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("loadPlugins — built-in reporters", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await cleanupTempDir(dir);
    dir = "";
  });

  const enabled = {
    webhook: { enabled: true, url: "https://h/x", headers: {}, timeoutMs: 5000 },
    otel: {
      enabled: false,
      headers: {},
      serviceName: "nax",
      timeoutMs: 5000,
      detail: "counts",
      heartbeatIntervalMs: 0,
      maxBatchSize: 64,
      flushIntervalMs: 5000,
      maxQueueSize: 2048,
      logs: { enabled: false, level: "info" },
    },
  } as const;

  test("registers webhook-reporter when enabled, exposed via getReporters()", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, [], undefined, enabled);
    const names = reg.getReporters().map((r) => r.name);
    expect(names).toContain("webhook-reporter");
    expect(names).not.toContain("otel-reporter");
  });

  test("does not register a reporter that is disabled in config", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, [], undefined, {
      webhook: { enabled: false, headers: {}, timeoutMs: 5000 },
      otel: {
        enabled: false,
        headers: {},
        serviceName: "nax",
        timeoutMs: 5000,
        detail: "counts",
        heartbeatIntervalMs: 0,
        maxBatchSize: 64,
        flushIntervalMs: 5000,
        maxQueueSize: 2048,
        logs: { enabled: false, level: "info" },
      },
    });
    expect(reg.getReporters()).toHaveLength(0);
  });

  test("disabledPlugins overrides enabled config", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, ["webhook-reporter"], undefined, enabled);
    expect(reg.getReporters().map((r) => r.name)).not.toContain("webhook-reporter");
  });

  test("registers nothing when reporters arg is omitted", async () => {
    dir = await makeTempDir();
    const reg = await loadPlugins(dir, dir, [], dir, []);
    expect(reg.getReporters()).toHaveLength(0);
  });
});

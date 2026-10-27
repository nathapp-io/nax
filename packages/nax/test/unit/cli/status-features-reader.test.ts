import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeTempDir } from "@test/helpers";
import { _statusFeaturesDeps, displayFeatureStatus } from "@/cli/status-features";

describe("displayFeatureStatus — shared status reader", () => {
  let dir: string;
  let featureDir: string;
  let log: ReturnType<typeof spyOn<typeof console, "log">>;
  const originalOutputDir = _statusFeaturesDeps.projectOutputDir;

  beforeEach(async () => {
    dir = makeTempDir("status-display-reader-");
    featureDir = join(dir, ".nax", "features", "f1");
    mkdirSync(featureDir, { recursive: true });
    _statusFeaturesDeps.projectOutputDir = () => join(dir, ".nax");
    log = spyOn(console, "log").mockImplementation(() => {});
    await Bun.write(join(dir, ".nax", "config.json"), "{}");
    await Bun.write(join(featureDir, "prd.json"), JSON.stringify(makePRD({ feature: "f1" })));
  });

  afterEach(() => {
    log.mockRestore();
    _statusFeaturesDeps.projectOutputDir = originalOutputDir;
    cleanupTempDir(dir);
  });

  async function writeStatus(version: number, id: string): Promise<void> {
    await Bun.write(
      join(featureDir, "status.json"),
      JSON.stringify({
        version,
        run: { id, feature: "f1", status: "completed", pid: 123, startedAt: "2026-01-01T00:00:00.000Z", dryRun: false },
        cost: { spent: 1, limit: null },
        progress: { passed: 1, total: 1, failed: 0, paused: 0, blocked: 0, pending: 0 },
        current: null,
        iterations: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 1000,
      }),
    );
  }

  test("AC-9 resolves without throwing for version 2", async () => {
    await writeStatus(2, "r-drift");
    await expect(displayFeatureStatus({ dir, feature: "f1" })).resolves.toBeUndefined();
  });

  test("AC-10 does not print the rejected run id", async () => {
    await writeStatus(2, "r-drift");
    await displayFeatureStatus({ dir, feature: "f1" });
    expect(log.mock.calls.flat().join("\n")).not.toContain("r-drift");
    expect(log.mock.calls.flat().join("\n")).toContain("f1");
  });

  test("AC-11 prints the valid run id", async () => {
    await writeStatus(1, "r-ok");
    await displayFeatureStatus({ dir, feature: "f1" });
    expect(log.mock.calls.flat().join("\n")).toContain("r-ok");
  });
});

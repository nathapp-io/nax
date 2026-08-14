import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { appendProgress } from "@/execution";
import { getLogger, initLogger, resetLogger } from "@/logger";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("appendProgress", () => {
  test("creates progress.txt and appends entry", async () => {
    const tmpDir = `/tmp/nax-progress-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    await appendProgress(tmpDir, "US-001", "passed", "Add login endpoint — Cost: $0.0200");

    const content = await Bun.file(`${tmpDir}/progress.txt`).text();
    expect(content).toContain("US-001");
    expect(content).toContain("PASSED");
    expect(content).toContain("Add login endpoint");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("appends multiple entries", async () => {
    const tmpDir = `/tmp/nax-progress-multi-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    await appendProgress(tmpDir, "US-001", "passed", "First story done");
    await appendProgress(tmpDir, "US-002", "failed", "Second story failed");

    const content = await Bun.file(`${tmpDir}/progress.txt`).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("PASSED");
    expect(lines[1]).toContain("FAILED");

    await rm(tmpDir, { recursive: true, force: true });
  });
});

describe("appendProgress — unwritable featureDir (BUG-09)", () => {
  let workdir: string;
  let logFile: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-progress-unwritable-");
    logFile = join(workdir, "audit.jsonl");
    initLogger({ level: "silent", filePath: logFile });
  });

  afterEach(() => {
    resetLogger();
    cleanupTempDir(workdir);
  });

  test("does not throw when featureDir cannot be created (parent is read-only)", async () => {
    // Deny write on workdir so mkdir(featureDir, { recursive: true }) fails
    // with a real EACCES — no monkeypatching of globals required.
    chmodSync(workdir, 0o555);
    const featureDir = join(workdir, "nested", "feature");

    try {
      await expect(appendProgress(featureDir, "US-001", "failed", "All tiers exhausted")).resolves.toBeUndefined();
    } finally {
      chmodSync(workdir, 0o755);
    }
  });

  test("logs a warning instead of propagating the write failure", async () => {
    chmodSync(workdir, 0o555);
    const featureDir = join(workdir, "nested", "feature");

    try {
      await appendProgress(featureDir, "US-001", "failed", "Max attempts reached");
    } finally {
      chmodSync(workdir, 0o755);
    }

    await getLogger().flush();
    const lines = (await Bun.file(logFile).text()).trim().split("\n").filter(Boolean);
    const warns = lines.map((l) => JSON.parse(l)).filter((e) => e.level === "warn");
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0].stage).toBe("execution");
    expect(warns[0].message.toLowerCase()).toContain("progress");
  });
});

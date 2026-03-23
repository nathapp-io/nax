import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { appendProgress } from "../../../src/execution/progress";

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

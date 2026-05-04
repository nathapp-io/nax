// test/unit/commands/migrate.test.ts
import { describe, expect, it } from "bun:test";
import path from "node:path";
import { withTempDir } from "../../helpers/temp";
import { detectGeneratedContent, migrateCommand, type MigrateCandidate } from "../../../src/commands/migrate";

describe("detectGeneratedContent", () => {
  it("detects runs/ directory", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(path.join(naxDir, "runs", "run-1", "log.jsonl"), "{}");

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates.some((c) => c.name === "runs")).toBe(true);
    });
  });

  it("detects metrics.json", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(path.join(naxDir, "metrics.json"), "{}");

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates.some((c) => c.name === "metrics.json")).toBe(true);
    });
  });

  it("returns empty array when nothing to migrate", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(path.join(naxDir, "config.json"), "{}");

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates).toEqual([]);
    });
  });

  it("is idempotent — already-migrated state returns empty", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(path.join(naxDir, "config.json"), JSON.stringify({ name: "koda" }));

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates).toEqual([]);
    });
  });
});

describe("migrateCommand --reclaim", () => {
  it("throws when name does not exist in ~/.nax/", async () => {
    await expect(
      migrateCommand({ workdir: "/tmp", reclaim: "__nonexistent_test_9999__" }),
    ).rejects.toThrow("Nothing to reclaim");
  });
});

describe("migrateCommand --merge", () => {
  it("throws when identity does not exist", async () => {
    await expect(
      migrateCommand({ workdir: "/tmp", merge: "__nonexistent_test_9999__" }),
    ).rejects.toThrow("Cannot merge");
  });
});

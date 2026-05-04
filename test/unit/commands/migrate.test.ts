// test/unit/commands/migrate.test.ts
import { describe, expect, it } from "bun:test";
import path from "node:path";
import { NaxError } from "../../../src/errors";
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
    const err = await migrateCommand({ workdir: "/tmp", reclaim: "nonexistent-test-9999" }).catch((e) => e);
    expect(err).toBeInstanceOf(NaxError);
    expect((err as NaxError).code).toBe("MIGRATE_RECLAIM_NOT_FOUND");
  });

  it("throws MIGRATE_INVALID_NAME when name contains path traversal characters", async () => {
    const err = await migrateCommand({ workdir: "/tmp", reclaim: "../etc" }).catch((e) => e);
    expect(err).toBeInstanceOf(NaxError);
    expect((err as NaxError).code).toBe("MIGRATE_INVALID_NAME");
  });
});

describe("migrateCommand --merge", () => {
  it("throws when identity does not exist", async () => {
    const err = await migrateCommand({ workdir: "/tmp", merge: "nonexistent-test-9999" }).catch((e) => e);
    expect(err).toBeInstanceOf(NaxError);
    expect((err as NaxError).code).toBe("MIGRATE_MERGE_NOT_FOUND");
  });

  it("throws MIGRATE_INVALID_NAME when name contains path traversal characters", async () => {
    const err = await migrateCommand({ workdir: "/tmp", merge: "../etc" }).catch((e) => e);
    expect(err).toBeInstanceOf(NaxError);
    expect((err as NaxError).code).toBe("MIGRATE_INVALID_NAME");
  });
});

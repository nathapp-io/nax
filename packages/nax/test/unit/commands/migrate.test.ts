// test/unit/commands/migrate.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { assertNaxError, withTempDir } from "@test/helpers";
import { detectGeneratedContent, migrateCommand } from "@/commands/migrate";
import { globalConfigDir } from "@/config/paths";
import { readProjectIdentity, writeProjectIdentity } from "@/runtime";

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

  it("returns empty array when the .nax dir does not exist at all", async () => {
    await withTempDir(async (dir) => {
      const candidates = await detectGeneratedContent(path.join(dir, ".nax"));
      expect(candidates).toEqual([]);
    });
  });

  it("detects generated per-feature subentries (runs, sessions, status.json)", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(path.join(naxDir, "features", "feat-1", "runs", "run-1.jsonl"), "{}");
      await Bun.write(path.join(naxDir, "features", "feat-1", "sessions", "s1.json"), "{}");
      await Bun.write(path.join(naxDir, "features", "feat-1", "status.json"), "{}");
      // A source-controlled sibling that must NOT be picked up.
      await Bun.write(path.join(naxDir, "features", "feat-1", "spec.md"), "# spec");

      const candidates = await detectGeneratedContent(naxDir);
      const names = candidates.map((c) => c.name);
      expect(names).toContain(path.join("features", "feat-1", "runs"));
      expect(names).toContain(path.join("features", "feat-1", "sessions"));
      expect(names).toContain(path.join("features", "feat-1", "status.json"));
      expect(names).not.toContain(path.join("features", "feat-1", "spec.md"));
    });
  });

  it("detects context-manifest-*.json files under a feature's stories/<storyId>/", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(
        path.join(naxDir, "features", "feat-1", "stories", "US-001", "context-manifest-abc123.json"),
        "{}",
      );
      // A non-matching file in the same story dir must be ignored.
      await Bun.write(path.join(naxDir, "features", "feat-1", "stories", "US-001", "notes.md"), "notes");

      const candidates = await detectGeneratedContent(naxDir);
      const names = candidates.map((c) => c.name);
      expect(names).toContain(path.join("features", "feat-1", "stories", "US-001", "context-manifest-abc123.json"));
      expect(names).not.toContain(path.join("features", "feat-1", "stories", "US-001", "notes.md"));
    });
  });

  it("returns empty candidates when features/ exists but is empty", async () => {
    await withTempDir(async (dir) => {
      const naxDir = path.join(dir, ".nax");
      await Bun.write(path.join(naxDir, "config.json"), "{}");
      await mkdir(path.join(naxDir, "features"), { recursive: true });

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates).toEqual([]);
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
      await Bun.write(path.join(naxDir, "config.json"), JSON.stringify({ name: "demo-app" }));

      const candidates = await detectGeneratedContent(naxDir);
      expect(candidates).toEqual([]);
    });
  });
});

describe("migrateCommand --reclaim", () => {
  it("throws when name does not exist in ~/.nax/", async () => {
    const err = await migrateCommand({ workdir: "/tmp", reclaim: "nonexistent-test-9999" }).catch((e) => e);
    assertNaxError(err);
    expect(err.code).toBe("MIGRATE_RECLAIM_NOT_FOUND");
  });

  it("throws MIGRATE_INVALID_NAME when name contains path traversal characters", async () => {
    const err = await migrateCommand({ workdir: "/tmp", reclaim: "../etc" }).catch((e) => e);
    assertNaxError(err);
    expect(err.code).toBe("MIGRATE_INVALID_NAME");
  });

  it("archives ~/.nax/<name>/ to ~/.nax/_archive/<name>-<ts>/ and removes the original", async () => {
    const name = "reclaim-test-project";
    const src = path.join(globalConfigDir(), name);
    await Bun.write(path.join(src, "config.json"), JSON.stringify({ name }));

    await migrateCommand({ workdir: "/tmp", reclaim: name });

    expect(existsSync(src)).toBe(false);
    const archiveBase = path.join(globalConfigDir(), "_archive");
    const archived = await readdir(archiveBase);
    expect(archived.some((entry) => entry.startsWith(`${name}-`))).toBe(true);
  });
});

describe("migrateCommand --merge", () => {
  it("throws when identity does not exist", async () => {
    const err = await migrateCommand({ workdir: "/tmp", merge: "nonexistent-test-9999" }).catch((e) => e);
    assertNaxError(err);
    expect(err.code).toBe("MIGRATE_MERGE_NOT_FOUND");
  });

  it("throws MIGRATE_INVALID_NAME when name contains path traversal characters", async () => {
    const err = await migrateCommand({ workdir: "/tmp", merge: "../etc" }).catch((e) => e);
    assertNaxError(err);
    expect(err.code).toBe("MIGRATE_INVALID_NAME");
  });

  it("rewrites the identity's workdir/remoteUrl/lastSeen to the current workdir", async () => {
    const name = "merge-test-project";
    await writeProjectIdentity(name, {
      name,
      workdir: "/old/workdir",
      remoteUrl: "https://example.com/old.git",
      createdAt: "2020-01-01T00:00:00.000Z",
      lastSeen: "2020-01-01T00:00:00.000Z",
    });

    await withTempDir(async (dir) => {
      await migrateCommand({ workdir: dir, merge: name });
      const updated = await readProjectIdentity(name);
      expect(updated?.workdir).toBe(dir);
      expect(updated?.createdAt).toBe("2020-01-01T00:00:00.000Z");
      expect(updated?.lastSeen).not.toBe("2020-01-01T00:00:00.000Z");
    });
  });
});

describe("migrateCommand — full migration flow", () => {
  it("throws MIGRATE_NO_CONFIG when .nax/config.json is absent", async () => {
    await withTempDir(async (dir) => {
      const err = await migrateCommand({ workdir: dir }).catch((e) => e);
      assertNaxError(err);
      expect(err.code).toBe("MIGRATE_NO_CONFIG");
    });
  });

  it("throws MIGRATE_CONFIG_READ_FAILED when config.json is malformed", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(path.join(dir, ".nax", "config.json"), "{not valid json");
      const err = await migrateCommand({ workdir: dir }).catch((e) => e);
      assertNaxError(err);
      expect(err.code).toBe("MIGRATE_CONFIG_READ_FAILED");
    });
  });

  it("logs and returns without touching disk when there is nothing to migrate", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      await Bun.write(path.join(dir, ".nax", "config.json"), JSON.stringify({ name: "demo", outputDir }));
      await migrateCommand({ workdir: dir });
      expect(existsSync(outputDir)).toBe(false);
    });
  });

  it("dry-run reports intended moves without moving anything", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      await Bun.write(path.join(dir, ".nax", "config.json"), JSON.stringify({ name: "demo", outputDir }));
      await Bun.write(path.join(dir, ".nax", "metrics.json"), "{}");

      await migrateCommand({ workdir: dir, dryRun: true });

      expect(existsSync(path.join(dir, ".nax", "metrics.json"))).toBe(true);
      expect(existsSync(outputDir)).toBe(false);
    });
  });

  it("moves generated content to outputDir and writes .migrated-from", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      await Bun.write(path.join(dir, ".nax", "config.json"), JSON.stringify({ name: "demo", outputDir }));
      await Bun.write(path.join(dir, ".nax", "metrics.json"), '{"x":1}');
      await Bun.write(path.join(dir, ".nax", "runs", "run-1", "log.jsonl"), "{}");

      await migrateCommand({ workdir: dir });

      expect(existsSync(path.join(dir, ".nax", "metrics.json"))).toBe(false);
      expect(existsSync(path.join(outputDir, "metrics.json"))).toBe(true);
      expect(existsSync(path.join(outputDir, "runs", "run-1", "log.jsonl"))).toBe(true);
      const marker = await Bun.file(path.join(outputDir, ".migrated-from")).json();
      expect(marker.from).toBe(dir);
      expect(typeof marker.migratedAt).toBe("string");
    });
  });

  it("falls back to the workdir basename as projectKey when config.name is blank", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      await Bun.write(path.join(dir, ".nax", "config.json"), JSON.stringify({ name: "  ", outputDir }));
      await Bun.write(path.join(dir, ".nax", "metrics.json"), "{}");

      await migrateCommand({ workdir: dir });

      expect(existsSync(path.join(outputDir, "metrics.json"))).toBe(true);
    });
  });

  it("throws MIGRATE_CONFLICT when the destination already exists", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      await Bun.write(path.join(dir, ".nax", "config.json"), JSON.stringify({ name: "demo", outputDir }));
      await Bun.write(path.join(dir, ".nax", "metrics.json"), "{}");
      await Bun.write(path.join(outputDir, "metrics.json"), "already here");

      const err = await migrateCommand({ workdir: dir }).catch((e) => e);
      assertNaxError(err);
      expect(err.code).toBe("MIGRATE_CONFLICT");
    });
  });

  it("throws MIGRATE_MOVE_FAILED (non-EXDEV) when rename fails for another reason", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      await Bun.write(path.join(dir, ".nax", "config.json"), JSON.stringify({ name: "demo", outputDir }));
      await Bun.write(path.join(dir, ".nax", "metrics.json"), "{}");
      // Pre-create outputDir read-only so the rename into it fails with EACCES,
      // exercising the generic (non-EXDEV) move-failure branch.
      await mkdir(outputDir, { recursive: true });
      await chmod(outputDir, 0o555);

      try {
        const err = await migrateCommand({ workdir: dir }).catch((e) => e);
        assertNaxError(err);
        expect(err.code).toBe("MIGRATE_MOVE_FAILED");
      } finally {
        await chmod(outputDir, 0o755);
      }
    });
  });
});

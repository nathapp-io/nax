// test/unit/commands/migrate.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertNaxError, withTempDir } from "@test/helpers";
import * as commandsBarrel from "@/commands";
import * as migrateModule from "@/commands/migrate";
import { migrateCommand } from "@/commands/migrate";
import { globalConfigDir } from "@/config/paths";
import { readProjectIdentity, writeProjectIdentity } from "@/runtime";

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

describe("migrateCommand — no mode", () => {
  it("rejects with MIGRATE_NO_MODE when neither reclaim nor merge is set", async () => {
    await withTempDir(async (dir) => {
      const err = await migrateCommand({ workdir: dir }).catch((e) => e);
      assertNaxError(err);
      expect(err.code).toBe("MIGRATE_NO_MODE");
    });
  });

  it("names both flags in the rejection message", async () => {
    await withTempDir(async (dir) => {
      const err = await migrateCommand({ workdir: dir }).catch((e) => e);
      assertNaxError(err);
      expect(err.message).toBe("nax migrate needs --reclaim <name> or --merge <name>");
    });
  });

  it("leaves .nax/metrics.json in place and never creates the configured outputDir", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const metricsPath = path.join(dir, ".nax", "metrics.json");
      await Bun.write(path.join(dir, ".nax", "config.json"), JSON.stringify({ name: "demo", outputDir }));
      await Bun.write(metricsPath, '{"x":1}');

      await migrateCommand({ workdir: dir }).catch(() => undefined);

      expect(existsSync(metricsPath)).toBe(true);
      expect(await Bun.file(metricsPath).text()).toBe('{"x":1}');
      expect(existsSync(outputDir)).toBe(false);
    });
  });

  it("rejects with MIGRATE_NO_MODE (not MIGRATE_NO_CONFIG) when .nax/config.json is absent", async () => {
    await withTempDir(async (dir) => {
      const err = await migrateCommand({ workdir: dir }).catch((e) => e);
      assertNaxError(err);
      expect(err.code).toBe("MIGRATE_NO_MODE");
    });
  });
});

/**
 * The deleted helpers must be unreachable through both entry points. `in` is
 * deliberate: it reads the runtime module object rather than the compile-time
 * type, so a surviving export fails here even though TypeScript would have
 * flagged it first.
 */
describe("migrate — exported surface after the helper deletion", () => {
  it("US-003 AC1: importing @/commands yields migrateCommand and no migration helper", () => {
    expect(typeof commandsBarrel.migrateCommand).toBe("function");
    expect("autoMigrateGeneratedContent" in commandsBarrel).toBe(false);
    expect("detectGeneratedContent" in commandsBarrel).toBe(false);
    expect("partitionTrackedCandidates" in commandsBarrel).toBe(false);
  });

  it("US-003 AC2: importing @/commands/migrate yields no helper and no _gitDeps re-export", () => {
    expect(typeof migrateModule.migrateCommand).toBe("function");
    expect("_gitDeps" in migrateModule).toBe(false);
    expect("detectGeneratedContent" in migrateModule).toBe(false);
    expect("partitionTrackedCandidates" in migrateModule).toBe(false);
    expect("autoMigrateGeneratedContent" in migrateModule).toBe(false);
  });
});

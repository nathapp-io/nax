/**
 * US-005 — project names that collide with nax's own `~/.nax` directories are
 * reserved.
 *
 * One static list (`RESERVED_PROJECT_NAMES`, `src/config/paths/index.ts`)
 * backs both `validateProjectName` and the `NaxConfigSchema` `name` refine,
 * so `nax init`, config validation and `nax migrate --reclaim` / `--merge`
 * refuse the same names.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir, withEnvVars, withTempDir } from "@test/helpers";
import { initProject, validateProjectName } from "@/cli/init";
import { migrateCommand } from "@/commands/migrate";
import { NaxConfigSchema } from "@/config";
import { RESERVED_PROJECT_NAMES } from "@/config/paths";

describe("RESERVED_PROJECT_NAMES", () => {
  it("US-005 AC1: lists every global directory nax owns, in order", () => {
    expect(RESERVED_PROJECT_NAMES).toEqual([
      "global",
      "profiles",
      "runs",
      "events",
      "plugins",
      "acp",
      "memory",
      "hooks",
      "_archive",
    ]);
  });
});

describe("validateProjectName — reserved names", () => {
  it("US-005 AC2: rejects 'profiles' with the reserved error", () => {
    expect(validateProjectName("profiles")).toEqual({ valid: false, error: "name 'profiles' is reserved" });
  });

  it.each(["runs", "events", "plugins", "acp", "memory", "hooks"])(
    "US-005 AC3: rejects '%s' and names it in the error",
    (name) => {
      const result = validateProjectName(name);
      expect(result.valid).toBe(false);
      expect(result.error).toContain(name);
      expect(result.error).toContain("reserved");
    },
  );

  it.each(["global", "_archive"])("US-005 AC4: rejects '%s' as reserved", (name) => {
    const result = validateProjectName(name);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("reserved");
  });

  it("US-005 AC5: accepts 'my-profiles'", () => {
    expect(validateProjectName("my-profiles")).toEqual({ valid: true });
  });
});

describe("NaxConfigSchema — reserved names", () => {
  it("US-005 AC6: rejects name 'runs' with an issue on the name path", () => {
    const result = NaxConfigSchema.safeParse({ name: "runs" });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected the reserved name to be rejected");
    const issue = result.error.issues.find((entry) => entry.path[0] === "name");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("runs");
    expect(issue?.message).toContain("reserved");
  });

  it("US-005 AC7: accepts name 'my-runs'", () => {
    expect(NaxConfigSchema.safeParse({ name: "my-runs" }).success).toBe(true);
  });
});

describe("nax init — reserved project names", () => {
  it("refuses a reserved name with INIT_INVALID_NAME", async () => {
    await withTempDir(async (repo) => {
      const err = await initProject(repo, { name: "profiles" }).catch((e) => e);
      assertNaxError(err);
      expect(err.code).toBe("INIT_INVALID_NAME");
      expect(err.message).toContain("reserved");
    });
  });
});

describe("migrateCommand — reserved project names", () => {
  it("US-005 AC8/AC9/AC10: refuses to reclaim a reserved name and leaves the global dir untouched", async () => {
    const globalDir = makeTempDir("nax-reserved-global-");
    try {
      await Bun.write(path.join(globalDir, "profiles", "a.json"), JSON.stringify({ name: "a" }));
      await withTempDir(async (repo) => {
        await withEnvVars({ NAX_GLOBAL_CONFIG_DIR: globalDir }, async () => {
          const err = await migrateCommand({ workdir: repo, reclaim: "profiles" }).catch((e) => e);
          assertNaxError(err);
          expect(err.code).toBe("MIGRATE_INVALID_NAME");
          expect(existsSync(path.join(globalDir, "profiles", "a.json"))).toBe(true);
          expect(existsSync(path.join(globalDir, "_archive"))).toBe(false);
          // The migration must leave the protected global directory untouched.
          expect((await readdir(globalDir)).sort()).toEqual(["profiles"]);
        });
      });
    } finally {
      cleanupTempDir(globalDir);
    }
  });

  it("US-005 AC11: refuses to merge a reserved name", async () => {
    await withTempDir(async (repo) => {
      const err = await migrateCommand({ workdir: repo, merge: "events" }).catch((e) => e);
      assertNaxError(err);
      expect(err.code).toBe("MIGRATE_INVALID_NAME");
    });
  });
});

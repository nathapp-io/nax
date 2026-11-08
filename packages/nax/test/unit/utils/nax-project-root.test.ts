import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withTempDir } from "@test/helpers";
import { findNaxProjectRoot } from "@/utils/nax-project-root";

describe("findNaxProjectRoot", () => {
  test("returns startDir when it directly contains .nax/config.json", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".nax"), { recursive: true });
      await Bun.write(join(dir, ".nax", "config.json"), "{}");

      const result = await findNaxProjectRoot(dir);

      expect(result).toBe(dir);
    });
  });

  test("walks up through ancestors to find .nax/config.json", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, ".nax"), { recursive: true });
      await Bun.write(join(dir, ".nax", "config.json"), "{}");
      const nested = join(dir, "apps", "api", "src");
      await mkdir(nested, { recursive: true });

      const result = await findNaxProjectRoot(nested);

      expect(result).toBe(dir);
    });
  });

  test("falls back to startDir when no ancestor within the walk depth has .nax/config.json", async () => {
    await withTempDir(async (dir) => {
      const result = await findNaxProjectRoot(dir);

      expect(result).toBe(dir);
    });
  });

  test("stops walking once it reaches the filesystem root instead of looping forever", async () => {
    // "/" has no parent (dirname("/") === "/"), which is the loop's break
    // condition. It is exceedingly unlikely to contain .nax/config.json, so
    // this exercises the fallback-to-startDir path at the top of the walk.
    const result = await findNaxProjectRoot("/");

    expect(result).toBe("/");
  });
});

describe("findNaxProjectRoot skips the global config dir (#2827)", () => {
  let home: string;
  let savedGlobalEnv: string | undefined;

  beforeEach(() => {
    home = makeTempDir("nax-2827-root-");
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(home, ".nax");
  });

  afterEach(() => {
    cleanupTempDir(home);
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
  });

  test("falls back to startDir instead of returning the global dir's parent", async () => {
    await mkdir(join(home, ".nax"), { recursive: true });
    await Bun.write(join(home, ".nax", "config.json"), "{}");
    const start = join(home, "scratch", "deep");
    await mkdir(start, { recursive: true });

    expect(await findNaxProjectRoot(start)).toBe(start);
  });
});

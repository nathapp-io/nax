import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
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

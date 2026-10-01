import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadPackageOverride } from "@/config";

// NOTE: makeTempDir/cleanupTempDir are SYNCHRONOUS — do NOT await them.
let tmp: string | undefined;
afterEach(() => {
  cleanupTempDir(tmp);
  tmp = undefined;
});

describe("loadPackageOverride", () => {
  test("returns the parsed mono config.json for a package", async () => {
    tmp = makeTempDir("lpo");
    const dir = join(tmp, ".nax", "mono", "packages", "agent");
    await Bun.write(
      join(dir, "config.json"),
      JSON.stringify({ quality: { commands: { lint: "ruff check packages/agent" } } }),
    );
    const override = await loadPackageOverride(tmp, "packages/agent");
    expect(override?.quality?.commands?.lint).toBe("ruff check packages/agent");
  });

  test("returns null when no per-package config exists", async () => {
    tmp = makeTempDir("lpo");
    expect(await loadPackageOverride(tmp, "packages/missing")).toBeNull();
  });
});

import { describe, expect, test, afterEach } from "bun:test";
import { loadPackageOverride } from "@/config";
import { makeTempDir, cleanupTempDir } from "@test/helpers/temp";
import { join } from "node:path";

// NOTE: makeTempDir/cleanupTempDir are SYNCHRONOUS — do NOT await them.
let tmp: string | undefined;
afterEach(() => { cleanupTempDir(tmp); tmp = undefined; });

describe("loadPackageOverride", () => {
  test("returns the parsed mono config.json for a package", async () => {
    tmp = makeTempDir("lpo");
    const dir = join(tmp, ".nax", "mono", "packages", "agent");
    await Bun.write(join(dir, "config.json"), JSON.stringify({ quality: { commands: { lint: "ruff check packages/agent" } } }));
    const override = await loadPackageOverride(tmp, "packages/agent");
    expect(override?.quality?.commands?.lint).toBe("ruff check packages/agent");
  });

  test("returns null when no per-package config exists", async () => {
    tmp = makeTempDir("lpo");
    expect(await loadPackageOverride(tmp, "packages/missing")).toBeNull();
  });
});

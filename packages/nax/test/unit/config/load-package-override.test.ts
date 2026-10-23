import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadPackageOverride } from "@/config";
import { NaxError } from "@/errors";

// NOTE: makeTempDir/cleanupTempDir are SYNCHRONOUS — do NOT await them.
let tmp: string | undefined;
afterEach(() => {
  cleanupTempDir(tmp);
  tmp = undefined;
});

describe("loadPackageOverride", () => {
  const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  beforeEach(() => {
    tmp = makeTempDir("lpo-profiles");
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tmp, "global");
  });
  afterEach(() => {
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  });

  test.each([
    ["AC-1 profile supplies lint", "package-checks", undefined, "false"],
    ["AC-3 profile wins over overlay", "package-checks", "x", "false"],
    ["AC-4 later profile wins", "a,b", undefined, "b"],
    ["AC-5 default preserves overlay", "default", "x", "x"],
  ])("%s", async (_label, profile, lint, expected) => {
    if (!tmp) throw new Error("fixture missing");
    await Bun.write(
      join(tmp, ".nax/mono/packages/api/config.json"),
      JSON.stringify({
        profile,
        quality: { commands: { lint } },
      }),
    );
    for (const [name, command] of [
      ["package-checks", "false"],
      ["a", "a"],
      ["b", "b"],
    ]) {
      await Bun.write(
        join(tmp, "packages/api/.nax/profiles", `${name}.json`),
        JSON.stringify({
          quality: { commands: { lint: command } },
        }),
      );
    }
    const override = await loadPackageOverride(tmp, "packages/api");
    expect(override?.quality?.commands?.lint).toBe(expected);
    expect(override).not.toHaveProperty("profile"); // AC-2
  });

  test("AC-6 missing named profile rejects with PROFILE_NOT_FOUND NaxError", async () => {
    if (!tmp) throw new Error("fixture missing");
    await Bun.write(join(tmp, ".nax/mono/packages/api/config.json"), JSON.stringify({ profile: "missing" }));
    const result = loadPackageOverride(tmp, "packages/api");
    await expect(result).rejects.toBeInstanceOf(NaxError);
    await expect(result).rejects.toHaveProperty("code", "PROFILE_NOT_FOUND");
  });
  test("returns the parsed mono config.json for a package", async () => {
    if (!tmp) throw new Error("fixture missing");
    const dir = join(tmp, ".nax", "mono", "packages", "agent");
    await Bun.write(
      join(dir, "config.json"),
      JSON.stringify({ quality: { commands: { lint: "ruff check packages/agent" } } }),
    );
    const override = await loadPackageOverride(tmp, "packages/agent");
    expect(override?.quality?.commands?.lint).toBe("ruff check packages/agent");
  });

  test("returns null when no per-package config exists", async () => {
    if (!tmp) throw new Error("fixture missing");
    expect(await loadPackageOverride(tmp, "packages/missing")).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { createConfigWarnDedupe } from "@/config/compat-shims";
import { loadPackageProfileLayers } from "@/config/package-profile";

describe("loadPackageProfileLayers", () => {
  let repo: string;
  const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  beforeEach(() => {
    repo = makeTempDir("package-profile");
    process.env.NAX_GLOBAL_CONFIG_DIR = join(repo, "global");
  });
  afterEach(() => {
    cleanupTempDir(repo);
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  });
  const load = (profile?: string) =>
    loadPackageProfileLayers({
      profile,
      repoRoot: repo,
      packageDir: "packages/api",
      logger: null,
      warnDedupe: createConfigWarnDedupe(),
    });

  test("AC-7/8 returns the chain and layers in order", async () => {
    for (const name of ["a", "b"]) {
      await Bun.write(
        join(repo, "packages/api/.nax/profiles", `${name}.json`),
        JSON.stringify({ quality: { commands: { lint: name } } }),
      );
    }
    const result = await load("a,b");
    expect(result.chain).toEqual(["a", "b"]);
    expect(result.layers).toEqual([{ quality: { commands: { lint: "a" } } }, { quality: { commands: { lint: "b" } } }]);
  });

  test("resolves companion env, applies compat shims, and deduplicates warnings per resolution", async () => {
    const warnings: string[] = [];
    const ambientLint = process.env.PACKAGE_LINT;
    for (const name of ["a", "b"]) {
      await Bun.write(
        join(repo, "packages/api/.nax/profiles", `${name}.json`),
        JSON.stringify({
          routing: { strategy: "manual" },
          quality: { commands: { lint: "$PACKAGE_LINT" } },
        }),
      );
      await Bun.write(join(repo, "packages/api/.nax/profiles", `${name}.env`), "PACKAGE_LINT=false && true");
    }
    const result = await loadPackageProfileLayers({
      profile: "a,b",
      repoRoot: repo,
      packageDir: "packages/api",
      logger: null,
      warnDedupe: createConfigWarnDedupe((message) => warnings.push(message)),
    });
    expect(result.layers).toEqual(
      ["a", "b"].map(() => ({
        routing: { strategy: "keyword" },
        quality: { commands: { lint: "false && true" } },
      })),
    );
    expect(warnings.filter((message) => message.includes("routing.strategy"))).toHaveLength(1);
    expect(warnings.filter((message) => message.includes("&&"))).toHaveLength(1);
    expect(process.env.PACKAGE_LINT).toBe(ambientLint);
  });

  test.each([undefined, "", "default", " ,default, "])("AC-9/10 no layers for %s", async (profile) => {
    expect(await load(profile)).toEqual({ chain: [], layers: [] });
  });
});

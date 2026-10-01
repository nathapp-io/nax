/**
 * Regression guard: per-package config resolution must inherit the run's --profile chain.
 *
 * nax#2126 — `loadConfigForWorkdir` takes its CLI overrides as an optional trailing
 * argument. The acceptance-setup stage omitted it, so in a monorepo every non-root
 * group resolved a PROFILE-LESS root config. That was invisible while such a config
 * only fed data fields, and fatal once #2070 handed it to `callOp` as `ctx.config`:
 * the model map lives in the profile, so `native` dispatch threw
 * `No model entry found for agent "native" ... at tier "fast"`.
 *
 * These tests pin the invariant at the resolver (`loadConfigForPackage`) and at both
 * group-config call sites. `scripts/check-config-profile-threading.ts` covers any
 * future site that calls `loadConfigForWorkdir` directly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { loadConfigForPackage } from "@/config";
import { _clearRootConfigCache, loadConfigForWorkdir } from "@/config/loader";

const PKG = "packages/core";

/**
 * Mirrors the monorepo shape that surfaced the defect: the repo config declares
 * only `models.claude`, and everything `native` arrives from the profile.
 */
function writeRepo(root: string): void {
  mkdirSync(join(root, ".nax", "profiles"), { recursive: true });
  mkdirSync(join(root, PKG), { recursive: true });
  writeFileSync(
    join(root, ".nax", "config.json"),
    JSON.stringify({ models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "sonnet" } } }),
  );
  writeFileSync(
    join(root, ".nax", "profiles", "fixture-native.json"),
    JSON.stringify({
      // protocol "hybrid" is required by the schema for a `models.native` entry.
      agent: { default: "native", protocol: "hybrid" },
      models: {
        claude: { fast: "haiku", balanced: "sonnet", powerful: "sonnet" },
        native: { fast: "minimax/MiniMax-M2.7", balanced: "minimax/MiniMax-M2.7", powerful: "minimax/MiniMax-M3" },
      },
    }),
  );
}

describe("loadConfigForPackage — profile chain survives per-package resolution (nax#2126)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-pkg-profile-");
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    writeRepo(tempDir);
    _clearRootConfigCache();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    // Assigning `undefined` would store the STRING "undefined" and leak a bogus
    // path into every later test in this process.
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    _clearRootConfigCache();
  });

  test("carries the profile's model map onto a package with no per-package override", async () => {
    const runConfig = makeNaxConfig({ profileChain: ["fixture-native"] });

    const effective = await loadConfigForPackage(tempDir, PKG, runConfig);

    expect(effective.models.native?.fast).toBe("minimax/MiniMax-M2.7");
    expect(effective.agent?.default).toBe("native");
  });

  test("carries it onto the root frame too (packageDir '.' and undefined)", async () => {
    const runConfig = makeNaxConfig({ profileChain: ["fixture-native"] });

    for (const pkg of [".", undefined]) {
      _clearRootConfigCache();
      const effective = await loadConfigForPackage(tempDir, pkg, runConfig);
      expect(effective.models.native?.fast).toBe("minimax/MiniMax-M2.7");
    }
  });

  test("back-compat: inherits a single `profile` string when no chain is present", async () => {
    const runConfig = makeNaxConfig({ profile: "fixture-native", profileChain: [] });

    const effective = await loadConfigForPackage(tempDir, PKG, runConfig);

    expect(effective.models.native?.fast).toBe("minimax/MiniMax-M2.7");
  });

  // Negative control: without this the assertions above could pass vacuously. The
  // built-in `models.native` is always present, so the control asserts the profile's
  // id is gone — dropping the profile is exactly what the two broken call sites did.
  test("control — omitting the overrides drops the profile, leaving the built-in native map", async () => {
    const rootConfigPath = join(tempDir, ".nax", "config.json");

    const profileLess = await loadConfigForWorkdir(rootConfigPath, PKG);

    expect(profileLess.models.native?.fast).toBe("anthropic/claude-haiku-4-5");
    expect(profileLess.models.claude?.fast).toBe("haiku");
  });
});

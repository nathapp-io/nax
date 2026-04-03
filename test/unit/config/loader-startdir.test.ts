/**
 * Tests for loadConfig startDir auto-detection
 *
 * loadConfig(startDir) previously expected startDir to be the .nax/ directory
 * path. Callers that passed the project root (workdir) got silently wrong results
 * because loadJsonFile(join(workdir, "config.json")) found nothing and the project
 * config layer was skipped entirely.
 *
 * Fix: loadConfig now auto-detects the argument type:
 *   - basename(startDir) === ".nax"  → treat as the nax dir, use directly
 *   - anything else                  → treat as project root, call findProjectDir(startDir)
 *   - undefined                      → findProjectDir(process.cwd())
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/loader";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

const PROJECT_CONFIG = JSON.stringify({ quality: { commands: { test: "jest --watch=false" } } });

describe("loadConfig — startDir auto-detection", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-loader-startdir-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    writeFileSync(join(tempDir, ".nax", "config.json"), PROJECT_CONFIG);
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (originalGlobalDir === undefined) {
      process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  test("loadConfig(workdir) correctly loads project config", async () => {
    // Pass the project root — NOT the .nax dir. This was the buggy path before.
    const config = await loadConfig(tempDir);
    expect(config.quality.commands.test).toBe("jest --watch=false");
  });

  test("loadConfig(naxDir) still works (backward compat)", async () => {
    // Pass the .nax dir directly — existing callers like loadConfigForWorkdir use this.
    const config = await loadConfig(join(tempDir, ".nax"));
    expect(config.quality.commands.test).toBe("jest --watch=false");
  });

  test("loadConfig(workdir) from a subdirectory walks up to find .nax", async () => {
    // Create a subdirectory inside the project — loadConfig should still find .nax/
    const subDir = join(tempDir, "packages", "api");
    mkdirSync(subDir, { recursive: true });

    const config = await loadConfig(subDir);
    expect(config.quality.commands.test).toBe("jest --watch=false");
  });

  test("loadConfig(workdir) where no .nax exists returns defaults", async () => {
    // A dir with no .nax anywhere above it falls back to defaults
    const isolated = makeTempDir("nax-no-config-");
    try {
      const config = await loadConfig(isolated);
      // Defaults are always loaded — just verify no crash and version is correct
      expect(config.version).toBe(1);
    } finally {
      cleanupTempDir(isolated);
    }
  });
});

/**
 * `loadGlobalConfig` (the global side of `nax config --diff`) reads the whole
 * global layer: `config.json` with the per-machine `config.local.json` over it (#2827).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadGlobalConfig, loadProjectConfig } from "@/cli/config-get";

let globalDir: string;
let savedGlobalEnv: string | undefined;

beforeEach(() => {
  globalDir = makeTempDir("nax-config-get-global-");
  savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
});

afterEach(() => {
  cleanupTempDir(globalDir);
  if (savedGlobalEnv === undefined) {
    delete process.env.NAX_GLOBAL_CONFIG_DIR;
  } else {
    process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
  }
});

function costLimitOf(config: Record<string, unknown>): unknown {
  const execution = config.execution;
  return typeof execution === "object" && execution !== null ? Reflect.get(execution, "costLimit") : undefined;
}

describe("loadProjectConfig — AC-3: start directory", () => {
  test("loads the project config beneath the supplied directory, not cwd", async () => {
    const selectedRoot = realpathSync(makeTempDir("nax-config-selected-"));
    const cwdRoot = realpathSync(makeTempDir("nax-config-cwd-"));
    const originalCwd = process.cwd();
    try {
      mkdirSync(join(selectedRoot, ".nax"), { recursive: true });
      mkdirSync(join(cwdRoot, ".nax"), { recursive: true });
      writeFileSync(join(selectedRoot, ".nax", "config.json"), JSON.stringify({ name: "proj-a" }), "utf8");
      writeFileSync(join(cwdRoot, ".nax", "config.json"), JSON.stringify({ name: "proj-b" }), "utf8");
      process.chdir(cwdRoot);

      expect(await loadProjectConfig(selectedRoot)).toEqual({ name: "proj-a" });
    } finally {
      process.chdir(originalCwd);
      cleanupTempDir(selectedRoot);
      cleanupTempDir(cwdRoot);
    }
  });
});

describe("loadGlobalConfig", () => {
  test("merges config.local.json over config.json", async () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ execution: { costLimit: 3 } }), "utf8");
    writeFileSync(join(globalDir, "config.local.json"), JSON.stringify({ execution: { costLimit: 7 } }), "utf8");

    expect(costLimitOf(await loadGlobalConfig())).toBe(7);
  });

  test("applies config.local.json when config.json is absent", async () => {
    writeFileSync(join(globalDir, "config.local.json"), JSON.stringify({ execution: { costLimit: 9 } }), "utf8");

    expect(costLimitOf(await loadGlobalConfig())).toBe(9);
  });

  test("uses config.json alone when there is no config.local.json", async () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ execution: { costLimit: 4 } }), "utf8");

    expect(costLimitOf(await loadGlobalConfig())).toBe(4);
  });
});
